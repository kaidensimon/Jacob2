"""Manim animation agent.

Given a topic, gpt-5.2 reasons about the clearest way to teach it, writes Manim
(Community v0.20) code, and we render it to an mp4. LLM-written Manim code often
has small bugs, so we retry with the render error fed back for self-correction.
Videos are stored so the user can choose to keep them.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from uuid import uuid4

from django.conf import settings
from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from rest_framework_simplejwt.authentication import JWTAuthentication

from .models import Animation

MANIM_MODEL = 'gpt-5.2-2025-12-11'
RENDER_QUALITY = '-ql'  # 480p15 — fast & reliable; fine for a chat-embedded video
TOTAL_BUDGET = 300        # ~5 minutes total
RENDER_CAP = 160          # max seconds for any single render
MAX_ATTEMPTS = 3          # initial code-error retries
MAX_REVIEWS = 2           # visual review/fix passes (the agent looks at frames)
MIN_TIME_FOR_REVIEW = 110 # need this much budget left to do another review + render

MANIM_SYSTEM_PROMPT = """You are an expert Manim (Community Edition v0.20) animator and educator. Given a topic, FIRST reason about the clearest, most engaging way to teach it as a short animation, then write the Manim code to do it.

Reply with ONLY a JSON object:
{"title": "<short title of the topic being explained>", "code": "<complete manim python code>"}

Hard requirements for the code (it MUST render without errors):
- Begin with `from manim import *`.
- Define EXACTLY ONE Scene subclass named EXACTLY `GeneratedScene` (class GeneratedScene(Scene): ...).
- NO LaTeX. Do NOT use Tex, MathTex, or Title. No LaTeX is installed and it WILL crash. For any math or symbols, use `Text` or `MarkupText` with unicode characters (e.g. ∮, ∇, ×, ·, ², √, subscripts/superscripts via unicode like ₁ ²).
- Use only Manim's built-in mobjects/animations (Text, MarkupText, Circle, Square, Rectangle, Line, Arrow, Dot, Axes, NumberPlane, VGroup, SurroundingRectangle, etc.). NO external images, SVG files, fonts, assets, or network access.
- Be visually clean and educational: introduce elements step by step, label them, use color and motion to convey the idea. Avoid overlaps and clutter — position things with .shift, .next_to, .to_edge, .arrange, and VGroup, and fade/move things out when no longer needed so the frame doesn't get crowded.
- The code must be COMPLETE and RUNNABLE on Manim Community v0.20 with Python 3.12. Use correct, current method and argument names.

LENGTH & PACING:
- Keep it SHORT: about 10-15 seconds — a handful of clear steps, brief run_times (≈1s), and at most a couple of short self.wait()s. Short animations render fast and read cleanly.
- Prefer cheap, reliable constructs (Text, shapes, Arrow, simple Axes, Transform, Write/Create/FadeIn, .animate). Use heavier things (updaters, 3D, dense plots) only if truly necessary, kept light.
- KEEP EVERYTHING INSIDE THE FRAME. The visible area is roughly x ∈ [-7, 7] and y ∈ [-4, 4] manim units — leave margin. Nothing should run off the edges. Scale groups down (.scale) or use .arrange/.to_edge with buffers so it all fits.
- Lay out with generous spacing and NO OVERLAPS: introduce elements step by step, and fade/move out anything no longer needed so the frame never gets crowded.
- READABILITY: never slide moving copies of numbers/text on top of existing labels or shapes — overlapping moving text looks broken. Show calculations in a SEPARATE clear area (a panel below, or beside the figure), not on top of the matrix/diagram. Highlight source elements in place (e.g. a colored box around a row/column) instead of duplicating and moving them.

Think carefully about correctness, clarity, pacing, and readability, then output the JSON."""


def _generate_code(client, task, prev_code=None, prev_error=None):
    user = f'Create a Manim animation that clearly teaches/visualizes: {task}'
    if prev_error:
        if 'timed out' in prev_error.lower():
            user += (
                '\n\nYour previous animation was TOO LONG / TOO HEAVY and TIMED OUT while rendering. '
                'Make a MUCH SHORTER and SIMPLER animation this time: fewer objects, fewer steps, '
                'short run_times, at most one or two brief self.wait() calls, and ONLY cheap '
                'animations (Write/Create/FadeIn/Transform/.animate). Strictly NO 3D, NO long-running '
                'updaters/always_redraw, NO high-sample plots. Aim for about 8 seconds total. '
                'Here is the code that was too heavy — cut it down drastically:\n' + (prev_code or '')
            )
        else:
            user += (
                '\n\nYour previous attempt FAILED to render with this error:\n'
                f'{prev_error}\n\nHere is the code that failed:\n{prev_code}\n\n'
                'Fix the problem and return corrected JSON (same format). Keep what worked.'
            )
    resp = client.chat.completions.create(
        model=MANIM_MODEL,
        messages=[
            {'role': 'system', 'content': MANIM_SYSTEM_PROMPT},
            {'role': 'user', 'content': user},
        ],
        response_format={'type': 'json_object'},
        max_completion_tokens=16000,
    )
    data = json.loads(resp.choices[0].message.content)
    return data.get('title') or 'Animation', data.get('code') or ''


def _render(code, timeout):
    """Render code's GeneratedScene to an mp4. Returns (mp4_path|None, error|None, tmpdir)."""
    tmpdir = tempfile.mkdtemp(prefix='manim_')
    script = os.path.join(tmpdir, 'scene.py')
    with open(script, 'w', encoding='utf-8') as f:
        f.write(code)
    media = os.path.join(tmpdir, 'out')

    try:
        proc = subprocess.run(
            [
                sys.executable, '-m', 'manim', 'render', RENDER_QUALITY,
                '--format', 'mp4', '--media_dir', media, script, 'GeneratedScene',
            ],
            capture_output=True, text=True, timeout=timeout, cwd=tmpdir,
        )
    except subprocess.TimeoutExpired:
        return None, 'Render timed out (the animation was too complex/long).', tmpdir
    except Exception as e:
        return None, str(e), tmpdir

    # Find the rendered file (skip partial_movie_files).
    for root, _dirs, files in os.walk(media):
        if 'partial_movie_files' in root:
            continue
        for fn in files:
            if fn == 'GeneratedScene.mp4':
                return os.path.join(root, fn), None, tmpdir

    err = (proc.stderr or proc.stdout or 'Unknown render error').strip()
    # Keep the most relevant tail of the traceback.
    return None, err[-3500:], tmpdir


def _frame_to_dataurl(frame):
    import io
    import base64
    img = frame.to_image()
    buf = io.BytesIO()
    img.save(buf, format='PNG')
    return 'data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode()


def _extract_frames(video_path, n=5):
    """Return up to n evenly-spaced key frames as base64 PNG data URLs (for the
    agent to visually review). Uses PyAV (a manim dependency)."""
    try:
        import av
        container = av.open(video_path)
        stream = container.streams.video[0]
        fps = float(stream.average_rate) if stream.average_rate else 15.0
        dur = None
        if stream.duration and stream.time_base:
            dur = float(stream.duration * stream.time_base)
        elif container.duration:
            dur = container.duration / 1_000_000.0
        total = int(dur * fps) if dur else 0
        targets = None
        if total > 1:
            targets = sorted(set(max(0, int(total * i / (n + 1))) for i in range(1, n + 1)))

        out = []
        idx = 0
        ti = 0
        for frame in container.decode(stream):
            if targets is None:
                if idx % 30 == 0:
                    out.append(_frame_to_dataurl(frame))
                    if len(out) >= n:
                        break
            elif ti < len(targets) and idx >= targets[ti]:
                out.append(_frame_to_dataurl(frame))
                ti += 1
                if ti >= len(targets):
                    break
            idx += 1
        container.close()
        return out
    except Exception:
        return []


MANIM_REVIEW_PROMPT = """You are reviewing your OWN Manim animation for VISUAL QUALITY. You are shown several KEY FRAMES captured from the rendered video, plus the code that produced them.

Look hard at the frames for LAYOUT PROBLEMS:
- text or shapes OVERLAPPING / sitting on top of each other
- elements CUT OFF or running past the edges of the frame (visible area is about x ∈ [-7, 7], y ∈ [-4, 4] manim units — content must stay inside with margin)
- moving or duplicated text colliding with existing labels
- clutter, cramped spacing, labels that are hard to read, or anything that just looks broken

If there are problems, REWRITE the code to fix them: reposition and space things out (next_to/shift/to_edge/arrange with buffers), scale groups down so everything fits inside the frame, put calculations in their own clear area, and fade/remove anything that overlaps. Preserve the teaching content and keep it cheap to render. Same rules as before: `class GeneratedScene(Scene)`, NO LaTeX (unicode only).

Reply with ONLY JSON:
- If the frames are clean and readable: {"clean": true}
- If they need fixing: {"clean": false, "title": "<title>", "code": "<full corrected manim code>"}"""


def _critique_and_fix(client, task, code, frames):
    content = [{
        'type': 'text',
        'text': (
            f'Topic: {task}\n\nBelow are key frames from the rendered video, then the code. '
            'Find and fix any overlapping, cut-off, or cluttered layout problems.\n\nCODE:\n' + code
        ),
    }]
    for f in frames:
        content.append({'type': 'image_url', 'image_url': {'url': f}})
    resp = client.chat.completions.create(
        model=MANIM_MODEL,
        messages=[
            {'role': 'system', 'content': MANIM_REVIEW_PROMPT},
            {'role': 'user', 'content': content},
        ],
        response_format={'type': 'json_object'},
        max_completion_tokens=16000,
    )
    return json.loads(resp.choices[0].message.content)


@csrf_exempt
def manim_generate(request):
    if request.method == 'OPTIONS':
        return _cors(JsonResponse({}))
    if request.method != 'POST':
        return _cors(JsonResponse({'error': 'Method not allowed'}, status=405))

    auth = JWTAuthentication()
    try:
        result = auth.authenticate(request)
        if result is None:
            return _cors(JsonResponse({'error': 'Authentication required'}, status=401))
    except Exception:
        return _cors(JsonResponse({'error': 'Invalid token'}, status=401))
    user = result[0]

    api_key = os.environ.get('OPENAI_API_KEY', '')
    if not api_key:
        return _cors(JsonResponse({'error': 'OPENAI_API_KEY not configured'}, status=503))

    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return _cors(JsonResponse({'error': 'Invalid JSON body'}, status=400))

    task = (data.get('task') or data.get('message') or '').strip()
    if not task:
        return _cors(JsonResponse({'error': 'No task provided'}, status=400))

    from openai import OpenAI
    client = OpenAI(api_key=api_key)

    title = 'Animation'
    code = None
    error = None
    mp4_path = None
    tmpdir = None

    deadline = time.monotonic() + TOTAL_BUDGET
    try:
        for attempt in range(MAX_ATTEMPTS):
            remaining = int(deadline - time.monotonic())
            if remaining < 25:
                break  # out of the 5-minute budget
            # Cap each render and leave room in the budget for visual review passes.
            render_timeout = min(RENDER_CAP, remaining)

            try:
                title, code = _generate_code(client, task, code, error)
            except Exception as e:
                error = f'Code generation failed: {e}'
                break
            mp4_path, error, tmpdir = _render(code, render_timeout)
            if mp4_path:
                break
            # On a timeout, the retry prompt (see _generate_code) asks for a much
            # simpler animation that can finish in the remaining budget.
            if tmpdir:
                shutil.rmtree(tmpdir, ignore_errors=True)
                tmpdir = None

        if not mp4_path:
            if error and 'timed out' in error.lower():
                msg = ("I couldn't render this one in time — it kept coming out too complex. "
                       "Try a simpler or more focused request (one concept, fewer moving parts).")
            else:
                msg = f'I couldn\'t render this animation. {(error or "")[:400]}'
            return _cors(JsonResponse({'error': msg}, status=500))

        # ── Visual review loop ──────────────────────────────────────────────
        # The agent looks at key frames of the rendered video and fixes layout
        # problems (overlaps, off-screen, clutter), then re-renders. Bounded by
        # the time budget so the whole request stays within ~5 minutes.
        for _review in range(MAX_REVIEWS):
            remaining = int(deadline - time.monotonic())
            if remaining < MIN_TIME_FOR_REVIEW:
                break
            frames = _extract_frames(mp4_path, n=5)
            if not frames:
                break
            try:
                verdict = _critique_and_fix(client, task, code, frames)
            except Exception:
                break
            if verdict.get('clean'):
                break
            new_code = verdict.get('code')
            if not new_code or new_code.strip() == (code or '').strip():
                break

            remaining = int(deadline - time.monotonic())
            new_mp4, _rerr, new_tmp = _render(new_code, min(RENDER_CAP, remaining))
            if new_mp4:
                # Adopt the improved version; drop the previous render. Keep the
                # original topic title (the review's title describes the fix).
                if tmpdir:
                    shutil.rmtree(tmpdir, ignore_errors=True)
                tmpdir, mp4_path, code = new_tmp, new_mp4, new_code
            else:
                # The fix didn't render — keep the last good version and stop.
                if new_tmp:
                    shutil.rmtree(new_tmp, ignore_errors=True)
                break

        # Store the video and create the (unsaved) Animation record.
        dest_dir = os.path.join(settings.MEDIA_ROOT, 'animations')
        os.makedirs(dest_dir, exist_ok=True)
        rel_name = f'animations/{uuid4().hex}.mp4'
        shutil.move(mp4_path, os.path.join(settings.MEDIA_ROOT, rel_name))

        anim = Animation.objects.create(
            user=user, title=title, prompt=task, code=code, video=rel_name, saved=False
        )
        return _cors(JsonResponse({
            'id': anim.id,
            'title': title,
            'videoUrl': request.build_absolute_uri(anim.video.url),
        }))
    finally:
        if tmpdir:
            shutil.rmtree(tmpdir, ignore_errors=True)


@csrf_exempt
def manim_save(request):
    """Mark a generated animation as saved (kept in the user's library)."""
    if request.method == 'OPTIONS':
        return _cors(JsonResponse({}))
    if request.method != 'POST':
        return _cors(JsonResponse({'error': 'Method not allowed'}, status=405))

    auth = JWTAuthentication()
    try:
        result = auth.authenticate(request)
        if result is None:
            return _cors(JsonResponse({'error': 'Authentication required'}, status=401))
    except Exception:
        return _cors(JsonResponse({'error': 'Invalid token'}, status=401))
    user = result[0]

    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return _cors(JsonResponse({'error': 'Invalid JSON body'}, status=400))

    anim = Animation.objects.filter(user=user, id=data.get('id')).first()
    if not anim:
        return _cors(JsonResponse({'error': 'Animation not found'}, status=404))

    anim.saved = True
    if data.get('title'):
        anim.title = data['title']
    anim.save(update_fields=['saved', 'title'])
    return _cors(JsonResponse({'ok': True, 'title': anim.title}))


def manim_list(request):
    """List the user's saved animations (their library)."""
    auth = JWTAuthentication()
    try:
        result = auth.authenticate(request)
        if result is None:
            return _cors(JsonResponse({'error': 'Authentication required'}, status=401))
    except Exception:
        return _cors(JsonResponse({'error': 'Invalid token'}, status=401))
    user = result[0]

    anims = Animation.objects.filter(user=user, saved=True)
    return _cors(JsonResponse({
        'animations': [
            {
                'id': a.id,
                'title': a.title,
                'videoUrl': request.build_absolute_uri(a.video.url),
                'created_at': a.created_at.isoformat(),
            }
            for a in anims
        ]
    }))


def _cors(response):
    response['Access-Control-Allow-Origin'] = '*'
    response['Access-Control-Allow-Methods'] = 'POST, GET, OPTIONS'
    response['Access-Control-Allow-Headers'] = 'Content-Type, Authorization'
    return response
