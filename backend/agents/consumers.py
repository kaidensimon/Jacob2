"""LessonConsumer — the async WebSocket brain for Voice Tutor Mode.

It owns the whole voice loop: it plans lessons (per-section), CONDUCTS them
(reveal + Rime TTS timed together), listens to the mic via Deepgram STT, and
handles barge-in (pause → answer → resume). The browser is a thin player:
renders shapes into the existing Excalidraw canvas, plays audio, streams the mic.
The whiteboard itself never moves here — only the reveal orchestration does,
because it must be co-timed with the speech (audio is the master clock).

Voice: Rime `marlu` (arcana) — a chill Aussie tutor persona (see lesson_planner).

Protocol
────────
client → consumer (JSON):
  {"type":"voiceOn"} / {"type":"voiceOff"}     # start/stop the mic → STT
  {"type":"startLesson","topic":"..."}          # typed trigger (voice also triggers)
  {"type":"utterance","text":"..."}             # typed input, routed like speech
  {"type":"audioEnded"}                          # browser finished playing a clip
  {"type":"snapshot","image":"<dataURL|null>"}   # reply to getSnapshot
  {"type":"stop"}
client → consumer (binary): PCM16 16kHz mono mic frames → Deepgram

consumer → client (JSON):
  {"type":"ready"} {"type":"listening"} {"type":"thinking"}
  {"type":"lessonStarted","title":...,"sections":[...]}
  {"type":"loadShapes","shapes":[...],"origin":{...}}
  {"type":"reveal","ids":[...],"camera":true}  {"type":"emphasize","ids":[...]}
  {"type":"beat","index":i,"say":"..."}         # caption
  {"type":"answer","text":"..."}                # spoken barge-in reply (caption)
  {"type":"audioStart","mime":...} …binary… {"type":"audioEnd"}
  {"type":"speak","text":"..."}                 # fallback TTS (no Rime key)
  {"type":"getSnapshot"}                         # ask for a whiteboard PNG
  {"type":"animate","prompt":"..."}              # forward to the chat/Manim agent
  {"type":"transcript","text":"...","final":bool}
  {"type":"paused"} {"type":"sectionDone"} {"type":"lessonDone"} {"type":"error",...}
"""

import asyncio
import json
import os
import random
from urllib.parse import parse_qs

import httpx
from channels.generic.websocket import AsyncWebsocketConsumer

from .lesson_planner import (lesson_outline, plan_section, decide_voice_intent,
                             elaborate_reply, summarize_elaboration, fix_section,
                             critique_board)

RIME_URL = 'https://users.rime.ai/v1/rime-tts'
RIME_SPEAKER = os.environ.get('RIME_SPEAKER', 'marlu')
RIME_MODEL = os.environ.get('RIME_MODEL', 'arcana')

DEEPGRAM_WS = (
    'wss://api.deepgram.com/v1/listen'
    '?model=nova-2&encoding=linear16&sample_rate=16000&channels=1'
    '&interim_results=true&punctuate=true&endpointing=350&smart_format=true'
)

BEAT_TIMEOUT = 45
MIN_BARGE_WORDS = 2  # ignore tiny/noise transcripts so playback echo can't false-trigger

# Canned lines to cover the (rare) gap when a section ends before the next one
# has finished planning. No LLM — picked at random, fed straight to Rime, and a
# line that starts always FINISHES before the next section may begin.
FILLER_LINES = [
    "Righto, gimme a tick — just chalking up the next bit.",
    "One sec mate, sketching out the next board.",
    "Hang tight a mo', next part's nearly ready.",
    "Bear with us a tick, lining up the next section.",
    "Almost sorted mate, two shakes.",
    "Just puttin' the finishing touches on the next bit, won't be a mo'.",
]
# Post-section cleanup lines — same rules: canned, cached, no LLM tokens.
APOLOGY_LINES = [
    "Ah hang on, that's come out a bit wonky — lemme tidy it up real quick, my bad.",
    "Hmm, that drawing's gone a bit dodgy. Give us a tick to clean it up.",
    "Sorry mate, that's messier than I wanted — quick tidy-up and we're sweet.",
]
DIGEST_LINES = [
    "Righto, cleaned that up a bit. Take a minute to let it sink in — hit ready whenever you wanna crack on.",
    "There we go, much tidier. Have a squiz for a bit, and smack that ready button when you're good to go.",
    "All fixed up mate. Sit with it for a tick, and hit ready when it's clicked.",
]
# Digest lines for the LAST section — the lesson is over, don't imply more.
FINAL_DIGEST_LINES = [
    "Tidied that up — and that's the whole lesson done and dusted, mate. Take a last squiz, then hit end lesson whenever you're ready.",
    "All cleaned up, and that wraps the lesson! Sit with the board a moment, then smack end lesson when you're good.",
]
# Spoken the moment a lesson is requested — a human reply, NOT the mid-lesson filler.
INTRO_LINES = [
    "For sure mate — lemme plan out a proper lesson on that. Gimme a tick.",
    "Too easy. I'll map this one out real quick — hang tight.",
    "Righto, good pick. Give us a moment to sketch out how I'll teach it.",
]
DIGEST_SECONDS = 30
_filler_audio: dict = {}  # text -> cached Rime mp3 chunks (survives across lessons)


def _key(name):
    return os.environ.get(name, '')


# One shared HTTP client so each beat doesn't pay a fresh TLS handshake to Rime.
_rime_http = None


def _rime_client() -> httpx.AsyncClient:
    global _rime_http
    if _rime_http is None:
        _rime_http = httpx.AsyncClient(timeout=60)
    return _rime_http


def _tidy_shapes(shapes):
    """Deterministic cleanup of LLM shape quirks: models sometimes emit the two
    characters backslash-n inside labels, which renders literally on the board."""
    for s in shapes:
        if isinstance(s.get('text'), str) and '\\n' in s['text']:
            s['text'] = s['text'].replace('\\n', '\n')
    return shapes


class LessonConsumer(AsyncWebsocketConsumer):
    async def connect(self):
        if not self._authed():
            await self.close(code=4001)
            return
        self._lesson_task = None
        self._ack = asyncio.Event()
        self._interrupt = asyncio.Event()
        self._questions: asyncio.Queue = asyncio.Queue()
        self._topic = None
        self._prior = []
        self._in_lesson = False
        self._history = []               # spoken conversation, for context
        self._context_future = None      # pending selection fetch from the client
        self._snapshot_future = None     # pending whiteboard PNG from the client
        self._issues_future = None       # pending detectIssues run from the client
        self._move_on = asyncio.Event()  # "ready to move on" button pressed
        self._elaborating = False        # ellaborating_status: sidebar mode flag
        self._elab_queue = asyncio.Queue()  # learner's turns during a sidebar
        self._side_drawn = 0             # sidebar drawings placed so far
        self._current_section = None
        self._dg = None
        self._dg_task = None
        await self.accept()
        await self.send_json({'type': 'ready'})

    async def disconnect(self, code):
        await self._cancel_lesson()
        await self._close_dg()

    def _authed(self) -> bool:
        qs = parse_qs(self.scope.get('query_string', b'').decode())
        token = (qs.get('token') or [''])[0]
        if not token:
            return False
        try:
            from rest_framework_simplejwt.tokens import AccessToken
            AccessToken(token)
            return True
        except Exception:
            return False

    # ── inbound ───────────────────────────────────────────────────────────────
    async def receive(self, text_data=None, bytes_data=None):
        if bytes_data is not None:
            await self._ensure_dg()
            if self._dg is not None:
                try:
                    await self._dg.send(bytes_data)
                except Exception:
                    pass
            return
        try:
            msg = json.loads(text_data or '{}')
        except json.JSONDecodeError:
            return
        t = msg.get('type')
        if t == 'voiceOn':
            await self._ensure_dg()
            await self.send_json({'type': 'listening'})
        elif t == 'voiceOff':
            await self._close_dg()
        elif t == 'startLesson':
            self._begin_lesson((msg.get('topic') or '').strip())
        elif t == 'context':
            if self._context_future and not self._context_future.done():
                self._context_future.set_result(msg.get('selection') or {})
        elif t == 'snapshot':
            if self._snapshot_future and not self._snapshot_future.done():
                self._snapshot_future.set_result(msg.get('image'))
        elif t == 'issues':
            if self._issues_future and not self._issues_future.done():
                self._issues_future.set_result(msg.get('issues') or [])
        elif t == 'moveOn':
            self._move_on.set()
        elif t == 'utterance':
            # Typed input, routed exactly like a final voice transcript.
            txt = (msg.get('text') or '').strip()
            if txt:
                await self._handle_speech(txt, True)
        elif t == 'audioEnded':
            self._ack.set()
        elif t == 'stop':
            await self._cancel_lesson()

    # ── intent routing (orchestrator-style, selection-aware) ─────────────────────
    async def _resolve_context(self):
        """Ask the browser for the current canvas selection and wait briefly."""
        loop = asyncio.get_event_loop()
        self._context_future = loop.create_future()
        await self.send_json({'type': 'getContext'})
        try:
            return await asyncio.wait_for(self._context_future, timeout=2.5)
        except asyncio.TimeoutError:
            return {}
        finally:
            self._context_future = None

    async def _route_utterance(self, text):
        """Decide what a spoken request means and act: teach / solve / ask / chat."""
        self._history.append({'role': 'user', 'text': text})
        selection = await self._resolve_context()
        try:
            decision = await asyncio.to_thread(
                decide_voice_intent, text, selection, self._history, _key('OPENAI_API_KEY')
            )
        except Exception as e:
            await self._speak_and_wait(f"Ah bugger, my brain glitched: {e}")
            return
        action = decision.get('action')
        topic = (decision.get('topic') or '').strip()
        say = (decision.get('say') or '').strip()
        if action in ('teach', 'solve') and topic:
            self._history.append({'role': 'assistant', 'text': f'(teaching: {topic})'})
            self._begin_lesson(topic)
        elif action == 'animate' and topic:
            # Forward to the chat orchestrator's Manim pipeline via the client.
            self._history.append({'role': 'assistant', 'text': f'(animating: {topic})'})
            say = say or "Righto mate, cooking up an animation for ya — takes a few ticks, hang tight."
            await self.send_json({'type': 'answer', 'text': say})
            await self.send_json({'type': 'animate', 'prompt': topic})
            await self._speak_and_wait(say)
        elif say:
            self._history.append({'role': 'assistant', 'text': say})
            await self.send_json({'type': 'answer', 'text': say})
            await self._speak_and_wait(say)

    async def _speak_and_wait(self, text, prefetched=None):
        self._ack.clear()
        await self._speak(text, prefetched=prefetched)
        ack = asyncio.create_task(self._ack.wait())
        _, pending = await asyncio.wait({ack}, timeout=BEAT_TIMEOUT)
        for p in pending:
            p.cancel()

    # ── lesson orchestration ─────────────────────────────────────────────────────
    def _begin_lesson(self, topic):
        if not topic:
            return
        asyncio.create_task(self._restart_lesson(topic))

    async def _restart_lesson(self, topic):
        await self._cancel_lesson()
        self._lesson_task = asyncio.create_task(self._run_lesson(topic))

    async def _run_lesson(self, topic):
        self._topic, self._prior, self._in_lesson = topic, [], True
        key = _key('OPENAI_API_KEY')
        try:
            await self.send_json({'type': 'thinking'})
            # Plan the outline WHILE speaking a human acknowledgement — no
            # generic "hang tight" filler at the start of a lesson.
            outline_task = asyncio.create_task(asyncio.to_thread(lesson_outline, topic, key))
            self._warm_fillers()
            await self._speak_canned(random.choice(INTRO_LINES))
            outline = await outline_task
            sections = outline.get('sections', [])
            await self.send_json({'type': 'lessonStarted', 'title': outline.get('title', topic),
                                  'sections': [s.get('title') for s in sections]})
            # Pipeline: section i+1 is planned (and its first beat's TTS fetched)
            # WHILE section i is being narrated, so there's no dead air between
            # sections. Priors for i+1 are sections[:i+1] — known in advance.
            next_plan = (self._plan_ahead(topic, sections[0], [], key, len(sections) == 1)
                         if sections else None)
            for i, section in enumerate(sections):
                # The intro already covered the first wait — no filler there.
                plan, first_audio = await self._await_plan(next_plan, use_filler=(i > 0))
                next_plan = (self._plan_ahead(topic, sections[i + 1], sections[:i + 1], key,
                                              i + 1 == len(sections) - 1)
                             if i + 1 < len(sections) else None)
                if not plan.get('shapes'):
                    continue
                self._current_section = section
                origin = {'x': 0, 'y': i * 760}
                await self._conduct(plan, origin, first_audio)
                # Light visual correction pass — blocks the next section until
                # any oopsies are fixed and the learner's had time to digest.
                await self._review_section(plan, origin, final=(i == len(sections) - 1))
                self._prior.append(section)
            self._current_section = None
            await self.send_json({'type': 'lessonDone'})
        except asyncio.CancelledError:
            raise
        except Exception as e:
            await self.send_json({'type': 'error', 'message': str(e)})
        finally:
            self._in_lesson = False

    async def _await_plan(self, plan_task, use_filler=True):
        """Await the backgrounded next-section plan. If it isn't ready when the
        previous section ends, cover the silence with canned filler lines. A
        filler that starts always FINISHES — the plan-ready check only happens
        BETWEEN lines, never mid-clip. With use_filler=False (lesson start,
        already covered by the intro), just wait quietly."""
        if not use_filler:
            return await plan_task
        done, _ = await asyncio.wait({plan_task}, timeout=2.0)  # sub-2s gap: stay quiet
        order = random.sample(FILLER_LINES, len(FILLER_LINES))
        n = 0
        while not done:
            await self._speak_canned(order[n % len(order)])
            n += 1
            done, _ = await asyncio.wait({plan_task}, timeout=6.0)  # a beat of natural silence
        return await plan_task

    # ── post-section visual correction (apology → fix → digest timer) ────────────
    async def _review_section(self, plan, origin, final=False):
        """Ask the browser's detector whether this section's board has readability
        issues. If so: canned apology → LLM fix pass (the agent decides where
        things move) → board replaced → canned digest line → 30s timer the
        learner can skip with the button ('End lesson' on the final section)."""
        shapes = plan.get('shapes') or []
        ids = [s.get('id') for s in shapes if s.get('id')]
        if not ids:
            return
        issues, board = await self._gather_problems(ids)
        if not issues:
            return
        await self._speak_canned(random.choice(APOLOGY_LINES))
        # Bounded verify-fix loop: each round the fixer SEES the rendered board
        # (snapshot) plus everything the detector AND the vision critic found.
        # Up to 3 rounds; a plateau may try again, getting WORSE ends it.
        current = shapes
        replaced = False
        for _ in range(3):
            try:
                fixed = await asyncio.to_thread(
                    fix_section, current, issues, _key('OPENAI_API_KEY'), board_image=board)
                new_shapes = _tidy_shapes(fixed.get('shapes') or [])
            except Exception as e:
                await self.send_json({'type': 'error', 'message': f'cleanup failed: {e}'})
                break
            if not new_shapes:
                break  # fix pass failed — don't fake a cleanup
            current = new_shapes
            replaced = True
            await self.send_json({'type': 'replaceShapes', 'shapes': new_shapes, 'origin': origin})
            remaining, board = await self._gather_problems(ids)
            if not remaining or len(remaining) > len(issues):
                break
            issues = remaining
        if not replaced:
            return
        await self._speak_canned(random.choice(FINAL_DIGEST_LINES if final else DIGEST_LINES))
        self._move_on.clear()
        await self.send_json({'type': 'digest', 'seconds': DIGEST_SECONDS, 'final': final})
        ready = asyncio.create_task(self._move_on.wait())
        _, pending = await asyncio.wait({ready}, timeout=DIGEST_SECONDS)
        for p in pending:
            p.cancel()
        await self.send_json({'type': 'digestDone'})

    async def _gather_problems(self, ids):
        """Everything wrong with the board right now: the deterministic
        detector's enumerated classes PLUS a vision critic pass over the
        rendered PNG — so failure modes nobody predicted still get caught.
        Returns (problems, board_png) so the fixer can reuse the snapshot."""
        det = await self._resolve_issues(ids)
        board = await self._resolve_snapshot()
        vis = []
        if board:
            try:
                res = await asyncio.to_thread(critique_board, board, _key('OPENAI_API_KEY'))
                vis = [p for p in (res.get('problems') or []) if isinstance(p, str) and p.strip()][:6]
            except Exception:
                pass  # the critic is a net, not a dependency — detector still stands
        return det + vis, board

    async def _resolve_issues(self, ids):
        """Have the browser run the real detectIssues pass on this section."""
        loop = asyncio.get_event_loop()
        self._issues_future = loop.create_future()
        await self.send_json({'type': 'getIssues', 'ids': ids})
        try:
            return await asyncio.wait_for(self._issues_future, timeout=5)
        except asyncio.TimeoutError:
            return []
        finally:
            self._issues_future = None

    def _warm_fillers(self):
        """Pre-fetch every canned line's TTS into the module cache so fillers,
        apologies and digest lines start instantly when needed."""
        if not _key('RIME_API_KEY'):
            return
        async def warm():
            for text in INTRO_LINES + FILLER_LINES + APOLOGY_LINES + DIGEST_LINES + FINAL_DIGEST_LINES:
                if text not in _filler_audio:
                    _filler_audio[text] = await self._fetch_tts(text)
        task = asyncio.create_task(warm())
        task.add_done_callback(lambda t: t.cancelled() or t.exception())

    async def _speak_canned(self, text):
        """Speak one canned line in full, from the cache when it's warm."""
        chunks = _filler_audio.get(text)
        if chunks is None and _key('RIME_API_KEY'):
            try:
                chunks = _filler_audio[text] = await self._fetch_tts(text)
            except Exception:
                chunks = None
        pre = None
        if chunks is not None:
            pre = asyncio.get_event_loop().create_future()
            pre.set_result(chunks)
        await self.send_json({'type': 'answer', 'text': text})
        await self._speak_and_wait(text, prefetched=pre)

    def _plan_ahead(self, topic, section, priors, key, is_last=False):
        """Plan a section in the background and pre-fetch its first beat's TTS,
        so the section can start speaking the moment the previous one ends."""
        async def go():
            plan = await asyncio.to_thread(plan_section, topic, section, priors, key,
                                           is_last=is_last)
            _tidy_shapes(plan.get('shapes') or [])
            beats = plan.get('beats') or []
            audio = self._prefetch(beats[0].get('say', '')) if beats else None
            return plan, audio
        task = asyncio.create_task(go())
        # Retrieve failures quietly; awaiting the task re-raises them in the loop.
        task.add_done_callback(lambda t: t.cancelled() or t.exception())
        return task

    async def _conduct(self, section, origin, first_audio=None):
        await self.send_json({'type': 'loadShapes', 'shapes': section.get('shapes', []), 'origin': origin})
        beats = section.get('beats', [])
        # Pipeline the TTS: beat i+1's audio is fetched from Rime while beat i is
        # still playing, so every beat after the first starts the moment its
        # caption appears (and beat 0's audio was already fetched by _plan_ahead).
        next_audio = first_audio or (self._prefetch(beats[0].get('say', '')) if beats else None)
        for i, beat in enumerate(beats):
            await self._drain_questions()  # answer anything asked before this beat
            say = beat.get('say', '')
            audio = next_audio
            next_audio = self._prefetch(beats[i + 1].get('say', '')) if i + 1 < len(beats) else None
            await self.send_json({'type': 'beat', 'index': i, 'say': say})
            if beat.get('reveal'):
                await self.send_json({'type': 'reveal', 'ids': beat['reveal'], 'camera': True})
            if beat.get('emphasize'):
                await self.send_json({'type': 'emphasize', 'ids': beat['emphasize']})
            self._ack.clear()
            self._interrupt.clear()
            await self._speak(say, prefetched=audio)
            await self._wait_ack_or_interrupt()
            if self._interrupt.is_set():
                await self.send_json({'type': 'stopAudio'})
                self._interrupt.clear()
                # The interim transcript already cut the audio; wait briefly for
                # the FINAL transcript of what they actually said.
                try:
                    q = await asyncio.wait_for(self._questions.get(), timeout=6)
                except asyncio.TimeoutError:
                    q = None  # noise / false trigger — just carry on
                if q is not None:
                    await self._elaborate(q)
                await self._drain_questions()
        await self.send_json({'type': 'sectionDone'})

    async def _wait_ack_or_interrupt(self):
        ack = asyncio.create_task(self._ack.wait())
        intr = asyncio.create_task(self._interrupt.wait())
        _, pending = await asyncio.wait({ack, intr}, timeout=BEAT_TIMEOUT,
                                        return_when=asyncio.FIRST_COMPLETED)
        for p in pending:
            p.cancel()

    async def _drain_questions(self):
        while not self._questions.empty():
            await self._elaborate(self._questions.get_nowait())

    # ── sidebar elaboration (fresh agent, verbal-first, state-gated) ─────────────
    async def _elaborate(self, confusion):
        """Mid-lesson sidebar. `_elaborating` (the ellaborating_status flag) stays
        True until the learner says they've got it, so the agent can't veer back
        into the lesson mid-explanation. Each turn uses a FRESH LLM context —
        whiteboard snapshot + lesson summary + the sidebar convo — never the
        lesson's whole chat history. Verbal-only unless the learner explicitly
        asks to visualize. Afterwards only a one-line summary goes to history."""
        self._elaborating = True
        await self.send_json({'type': 'thinking'})
        board = await self._resolve_snapshot()
        summary = self._lesson_summary()
        convo = [{'role': 'user', 'text': confusion}]
        real_sidebar = False  # did any actual explaining happen?
        try:
            while True:
                reply = None
                try:
                    reply = await asyncio.to_thread(
                        elaborate_reply, summary, board, convo, _key('OPENAI_API_KEY'))
                except Exception as e:
                    reply = {'say': f"Ah bugger, my brain glitched: {e}", 'satisfied': True}
                say = (reply.get('say') or '').strip()
                convo.append({'role': 'assistant', 'text': say})
                shapes = reply.get('shapes') or []
                if shapes:
                    # Sidebar drawings get their own column, right of the lesson.
                    origin = {'x': 1150, 'y': self._side_drawn * 700}
                    self._side_drawn += 1
                    await self.send_json({'type': 'loadShapes', 'shapes': shapes, 'origin': origin})
                    ids = [s.get('id') for s in shapes if s.get('id')]
                    await self.send_json({'type': 'reveal', 'ids': ids, 'camera': True})
                if say:
                    await self.send_json({'type': 'answer', 'text': say})
                    await self._speak_and_wait(say)
                if reply.get('offtopic'):
                    break  # not a real question — quip's been fired, back to it
                real_sidebar = True
                if reply.get('satisfied'):
                    break
                try:
                    nxt = await asyncio.wait_for(self._elab_queue.get(), timeout=90)
                except asyncio.TimeoutError:
                    break  # they've gone quiet — assume sorted, back to the lesson
                convo.append({'role': 'user', 'text': nxt})
        finally:
            self._elaborating = False
        if not real_sidebar:
            return  # pure banter — nothing worth remembering
        # Save ONE summary line instead of the whole sidebar transcript.
        note = ''
        try:
            res = await asyncio.to_thread(summarize_elaboration, convo, _key('OPENAI_API_KEY'))
            note = (res.get('summary') or '').strip()
        except Exception:
            pass
        self._history.append({'role': 'assistant',
                              'text': f"(mid-lesson sidebar: {note or 'cleared up: ' + confusion})"})

    async def _resolve_snapshot(self):
        """Ask the browser for a PNG (dataURL) of the whole whiteboard."""
        loop = asyncio.get_event_loop()
        self._snapshot_future = loop.create_future()
        await self.send_json({'type': 'getSnapshot'})
        try:
            return await asyncio.wait_for(self._snapshot_future, timeout=6)
        except asyncio.TimeoutError:
            return None
        finally:
            self._snapshot_future = None

    def _lesson_summary(self):
        parts = [f'Lesson topic: {self._topic}']
        for s in self._prior:
            parts.append(f"Covered already: {s.get('title')} — {s.get('goal', '')}")
        if self._current_section:
            parts.append(f"Currently teaching: {self._current_section.get('title')} — "
                         f"{self._current_section.get('goal', '')}")
        return '\n'.join(parts)

    # ── Rime TTS (marlu / arcana) ────────────────────────────────────────────────
    def _rime_stream(self, text):
        headers = {'Authorization': f"Bearer {_key('RIME_API_KEY')}", 'Accept': 'audio/mp3',
                   'Content-Type': 'application/json'}
        body = {'speaker': RIME_SPEAKER, 'text': text, 'modelId': RIME_MODEL, 'samplingRate': 24000}
        return _rime_client().stream('POST', RIME_URL, headers=headers, json=body)

    def _prefetch(self, text):
        """Start fetching a beat's TTS ahead of time. Returns a task (or None)."""
        if not text.strip() or not _key('RIME_API_KEY'):
            return None
        task = asyncio.create_task(self._fetch_tts(text))
        # Retrieve any failure so an unused prefetch doesn't warn; _speak re-raises
        # it when the task is actually awaited.
        task.add_done_callback(lambda t: t.cancelled() or t.exception())
        return task

    async def _fetch_tts(self, text):
        chunks = []
        async with self._rime_stream(text) as resp:
            resp.raise_for_status()
            async for chunk in resp.aiter_bytes():
                if chunk:
                    chunks.append(chunk)
        return chunks

    async def _speak(self, text, prefetched=None):
        key = _key('RIME_API_KEY')
        if not text.strip():
            self._ack.set()
            return
        if not key:
            await self.send_json({'type': 'speak', 'text': text})  # browser fallback
            return
        try:
            await self.send_json({'type': 'audioStart', 'mime': 'audio/mpeg'})
            if prefetched is not None:
                for chunk in await prefetched:
                    await self.send(bytes_data=chunk)
            else:
                async with self._rime_stream(text) as resp:
                    resp.raise_for_status()
                    async for chunk in resp.aiter_bytes():
                        if chunk:
                            await self.send(bytes_data=chunk)
            await self.send_json({'type': 'audioEnd'})
        except Exception as e:
            await self.send_json({'type': 'error', 'message': f'TTS failed: {e}'})
            await self.send_json({'type': 'speak', 'text': text})

    async def _cancel_lesson(self):
        if self._lesson_task and not self._lesson_task.done():
            self._lesson_task.cancel()
            try:
                await self._lesson_task
            except asyncio.CancelledError:
                pass
        self._lesson_task = None
        self._in_lesson = False

    # ── Deepgram STT (voice commands + barge-in) ─────────────────────────────────
    async def _ensure_dg(self):
        if self._dg is not None:
            return
        key = _key('DEEPGRAM_API_KEY')
        if not key:
            await self.send_json({'type': 'error', 'message': 'DEEPGRAM_API_KEY not configured'})
            return
        try:
            import websockets
            self._dg = await websockets.connect(DEEPGRAM_WS, additional_headers={'Authorization': f'Token {key}'})
            self._dg_task = asyncio.create_task(self._dg_reader())
        except Exception as e:
            self._dg = None
            await self.send_json({'type': 'error', 'message': f'STT connect failed: {e}'})

    async def _dg_reader(self):
        try:
            async for raw in self._dg:
                try:
                    data = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                alt = (data.get('channel', {}).get('alternatives') or [{}])[0]
                transcript = (alt.get('transcript') or '').strip()
                if not transcript:
                    continue
                is_final = bool(data.get('is_final'))
                await self.send_json({'type': 'transcript', 'text': transcript, 'final': is_final})
                await self._handle_speech(transcript, is_final)
        except Exception:
            pass

    async def _handle_speech(self, transcript, is_final):
        """Route speech (interim + final) — also used for typed 'utterance's.
        Interim results cut Jacob off the moment the learner starts talking;
        the final transcript then carries what they actually said."""
        words = len(transcript.split())
        if self._elaborating:
            # Sidebar: barge-in stops Jacob talking; finals feed the sidebar loop
            # (even one word — "yep" ends it).
            if words >= MIN_BARGE_WORDS:
                await self.send_json({'type': 'stopAudio'})
                self._ack.set()  # unblock the sidebar's _speak_and_wait
            if is_final:
                self._elab_queue.put_nowait(transcript)
        elif self._in_lesson:
            if words < MIN_BARGE_WORDS:
                return
            if not self._interrupt.is_set():
                self._interrupt.set()  # _conduct stops the audio immediately
                await self.send_json({'type': 'paused'})
            if is_final:
                self._questions.put_nowait(transcript)
        elif is_final and words >= MIN_BARGE_WORDS:
            # Idle: route like the orchestrator — look at the selection, then
            # teach / solve / animate / ask-to-clarify / chat.
            asyncio.create_task(self._route_utterance(transcript))

    async def _close_dg(self):
        if self._dg_task:
            self._dg_task.cancel()
        if self._dg is not None:
            try:
                await self._dg.close()
            except Exception:
                pass
        self._dg = None
        self._dg_task = None

    async def send_json(self, obj):
        await self.send(text_data=json.dumps(obj))
