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
  {"type":"audioEnded"}                          # browser finished playing a clip
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
  {"type":"transcript","text":"...","final":bool}
  {"type":"paused"} {"type":"sectionDone"} {"type":"lessonDone"} {"type":"error",...}
"""

import asyncio
import json
import os
from urllib.parse import parse_qs

import httpx
from channels.generic.websocket import AsyncWebsocketConsumer

from .lesson_planner import lesson_outline, plan_section, answer_utterance, decide_voice_intent

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


def _key(name):
    return os.environ.get(name, '')


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
        elif say:
            self._history.append({'role': 'assistant', 'text': say})
            await self.send_json({'type': 'answer', 'text': say})
            await self._speak_and_wait(say)

    async def _speak_and_wait(self, text):
        self._ack.clear()
        await self._speak(text)
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
            outline = await asyncio.to_thread(lesson_outline, topic, key)
            sections = outline.get('sections', [])
            await self.send_json({'type': 'lessonStarted', 'title': outline.get('title', topic),
                                  'sections': [s.get('title') for s in sections]})
            for i, section in enumerate(sections):
                plan = await asyncio.to_thread(plan_section, topic, section, self._prior, key)
                if not plan.get('shapes'):
                    continue
                await self._conduct(plan, {'x': 0, 'y': i * 760})
                self._prior.append(section)
            await self.send_json({'type': 'lessonDone'})
        except asyncio.CancelledError:
            raise
        except Exception as e:
            await self.send_json({'type': 'error', 'message': str(e)})
        finally:
            self._in_lesson = False

    async def _conduct(self, section, origin):
        await self.send_json({'type': 'loadShapes', 'shapes': section.get('shapes', []), 'origin': origin})
        for i, beat in enumerate(section.get('beats', [])):
            await self._drain_questions()  # answer anything asked before this beat
            say = beat.get('say', '')
            await self.send_json({'type': 'beat', 'index': i, 'say': say})
            if beat.get('reveal'):
                await self.send_json({'type': 'reveal', 'ids': beat['reveal'], 'camera': True})
            if beat.get('emphasize'):
                await self.send_json({'type': 'emphasize', 'ids': beat['emphasize']})
            self._ack.clear()
            self._interrupt.clear()
            await self._speak(say)
            await self._wait_ack_or_interrupt()
            if self._interrupt.is_set():
                await self.send_json({'type': 'stopAudio'})
                await self._drain_questions()
                self._interrupt.clear()
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
            q = self._questions.get_nowait()
            await self.send_json({'type': 'thinking'})
            try:
                ans = await asyncio.to_thread(answer_utterance, self._topic, q, self._prior, _key('OPENAI_API_KEY'))
                say = ans.get('say', '')
            except Exception as e:
                say = f"Ah bugger, my brain glitched: {e}"
            await self.send_json({'type': 'answer', 'text': say})
            self._ack.clear()
            await self._speak(say)
            ack = asyncio.create_task(self._ack.wait())
            _, pending = await asyncio.wait({ack}, timeout=BEAT_TIMEOUT)
            for p in pending:
                p.cancel()

    # ── Rime TTS (marlu / arcana) ────────────────────────────────────────────────
    async def _speak(self, text):
        key = _key('RIME_API_KEY')
        if not text.strip():
            self._ack.set()
            return
        if not key:
            await self.send_json({'type': 'speak', 'text': text})  # browser fallback
            return
        try:
            await self.send_json({'type': 'audioStart', 'mime': 'audio/mpeg'})
            headers = {'Authorization': f'Bearer {key}', 'Accept': 'audio/mp3', 'Content-Type': 'application/json'}
            body = {'speaker': RIME_SPEAKER, 'text': text, 'modelId': RIME_MODEL, 'samplingRate': 24000}
            async with httpx.AsyncClient(timeout=60) as client:
                async with client.stream('POST', RIME_URL, headers=headers, json=body) as resp:
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
                if not is_final or len(transcript.split()) < MIN_BARGE_WORDS:
                    continue
                if self._in_lesson:
                    # Barge-in: queue the question and interrupt the current beat.
                    self._questions.put_nowait(transcript)
                    self._interrupt.set()
                    await self.send_json({'type': 'paused'})
                else:
                    # Idle: route like the orchestrator — look at the selection,
                    # then teach / solve / ask-to-clarify / chat.
                    asyncio.create_task(self._route_utterance(transcript))
        except Exception:
            pass

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
