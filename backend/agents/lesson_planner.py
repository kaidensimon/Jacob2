"""Voice-tutor lesson planner (per-section).

A LESSON is taught as a sequence of SECTIONS. Each section is planned by its OWN
LLM call — so a deep topic never has to fit in one response (dodging the 8192
completion-token cap) — and yields two things:

  - shapes: the finished, CLEAN diagram for that section, in the SAME shape format
            the Excalidraw agent already uses (so the existing client renderer,
            shapesToElements/convert.ts, draws them unchanged).
  - beats:  an ordered NARRATION SCRIPT that reveals those shapes in TEACHING
            order. Each beat ties one or two sentences of narration to the exact
            shapes it is about (reveal + emphasize), so speech and drawing line up.

Orchestration (client-driven, like the drawing agent):
    1. call `lesson_outline(topic)`        -> ["section 1", "section 2", ...]
    2. for each section, call `plan_section(topic, section, prior_sections)`
       -> {shapes, beats}; play it (narrate + reveal) while the NEXT is planned.

This module is pure planning: no TTS, no rendering. The client is the conductor.
"""

import json
import os

# ─── Persona: Jacob, a chill Aussie tutor ─────────────────────────────────────
# The SPOKEN narration is delivered in-character. The diagrams stay clean and the
# teaching stays correct — only the voice/tone is casual.
PERSONA = """

## Voice & persona (applies to every `say` line)
You are Jacob — a laid-back Aussie bloke tutoring like you're explaining it to a mate over a beer. Every spoken line MUST be in character:
- Talk in casual Australian slang: mate, reckon, heaps, bloody, arvo, keen as, no dramas, she'll be right, crack on, ripper, stoked, mad, dodgy, chuck, buggered, too easy, good on ya.
- Swear casually and good-naturedly like an Aussie — "bloody", "shit", "hell", "damn", "bugger", "crap", the odd "fuck" — for emphasis and vibe, NEVER aggressive or having a go at the learner.
- Keep it punchy, warm and spoken-word (it's read aloud) — no stiff textbook voice, contractions everywhere.
- BUT the actual teaching stays 100% correct and genuinely clear — you're a bloody good teacher who just talks chill. Don't let the vibe make you vague or wrong.
- No LaTeX or symbols in speech — say maths in words ("x squared", "w times x plus b")."""

from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from rest_framework_simplejwt.authentication import JWTAuthentication
from openai import OpenAI

from .agent_views import get_model_name

# ─── LLM plumbing ─────────────────────────────────────────────────────────────

def _complete_messages(messages: list, api_key: str, model: str, max_tokens: int) -> dict:
    """One non-streaming JSON-object completion from full chat messages (supports
    multimodal content for reading a selected image)."""
    client = OpenAI(api_key=api_key)
    kwargs = {'model': model, 'messages': messages, 'response_format': {'type': 'json_object'}}
    if model.startswith('gpt-5') or model.startswith('o'):
        kwargs['max_completion_tokens'] = max_tokens
        kwargs['reasoning_effort'] = 'none'
    else:
        kwargs['max_tokens'] = max_tokens
        kwargs['temperature'] = 0
    resp = client.chat.completions.create(**kwargs)
    return json.loads(resp.choices[0].message.content or '{}')


def _complete(system: str, user: str, api_key: str, model: str, max_tokens: int) -> dict:
    return _complete_messages(
        [{'role': 'system', 'content': system}, {'role': 'user', 'content': user}],
        api_key, model, max_tokens,
    )


# ─── 1. Outline pass ──────────────────────────────────────────────────────────

OUTLINE_SYSTEM = """You are planning a WHITEBOARD VIDEO LESSON — a tutor who draws on a board while talking, like 3Blue1Brown or a great professor.

Break the user's topic into an ordered list of SECTIONS. Each section is ONE board's worth of teaching — a single coherent idea that gets its own diagram and its own stretch of narration (roughly 20-60 seconds spoken). A good lesson builds: earlier sections set up what later ones use.

Aim for 3-6 sections for a normal topic (fewer for a simple one, more for a deep one). Do NOT cram everything into one section, and do NOT split one idea across sections.

Respond ONLY with JSON of this exact form:
{"title": "<short lesson title>", "sections": [{"id": "s1", "title": "<short board title>", "goal": "<one sentence: what the viewer should understand after this section, and what to draw>"}, ...]}"""


def lesson_outline(topic: str, api_key: str, model: str = None) -> dict:
    model = model or get_model_name({})
    user = f"Topic to teach: {topic}\n\nBreak it into teaching sections."
    return _complete(OUTLINE_SYSTEM, user, api_key, model, max_tokens=1500)


# ─── 2. Per-section planner ───────────────────────────────────────────────────

SECTION_SYSTEM = r"""You plan ONE SECTION of a whiteboard video lesson: the finished diagram for this section, plus the narration script that reveals it in teaching order. Speech and drawing must line up.

You respond ONLY with JSON of this exact form:
{"shapes": [ <shape>, ... ], "beats": [ <beat>, ... ]}

## Coordinate system
Lay this section's diagram out in a clean region roughly (0,0) to (960,640). x → right, y → down, pixels. (0,0) is the top-left of THIS board. Each shape's x,y is its top-left corner. A comfortable box is ~160-220 wide, 60-100 tall. Leave generous whitespace (~40-60px around things). The diagram must be FINAL and CLEAN — no overlaps — because it will be revealed as-is while you talk; there is no cleanup pass.

## shape  (same format the drawing engine renders)
- id (string, REQUIRED, unique within the section) — beats and arrows refer to shapes by id.
- type: "rectangle" | "ellipse" | "diamond" (containers, may hold a `text` label) | "text" (standalone label) | "arrow" (connector) | "line" | "math" (a LaTeX formula — put LaTeX in `latex`; THIS is how you write ANY equation/fraction/integral/symbol, never plain text).
- x, y, width, height (numbers). For "math" omit width/height (it auto-sizes).
- text (string, optional): a container's label, or the words of a "text" shape. Multi-line text uses REAL newlines in the JSON string — NEVER the two characters backslash-n.
- latex (string, optional): for "math", the LaTeX body (no $…$). JSON needs doubled backslashes ("\\frac").
- For arrows connect two shapes with fromId and toId (create both shapes first). A connector's label goes in the arrow's OWN `text` — never a floating text label. Don't repeat the same label on parallel arrows.
- strokeColor / backgroundColor (hex, optional): use color with restraint and meaning.
- fontSize (optional): 16 small, 20 medium, 28 large, 36 title.

## beat  (one step of the synchronized narration)
{"say": "<1-2 sentences of spoken narration, conversational, teaching the idea>", "reveal": ["id", ...], "emphasize": ["id", ...]}
- `say`: what the tutor SAYS at this moment. Teach the concept and tie it to what appears — e.g. "Each input feeds into every neuron in the hidden layer." NEVER narrate your drawing actions ("I'll draw a box"). No LaTeX in `say`; say math in words ("x squared").
- `reveal`: the shape ids that appear ON THE BOARD during this sentence (they fade in as you say it). Reveal shapes in the ORDER a teacher would introduce them.
- `emphasize` (optional): ids to highlight/point at while talking about them (already-revealed shapes are fine to re-emphasize).

## Hard rules
1. EVERY shape id must be revealed by exactly one beat (nothing left undrawn), and every id in a beat's reveal/emphasize MUST be a shape you defined in THIS section.
2. Order beats so the board builds up naturally as the narration proceeds.
3. Keep it to ONE board's worth — this section's single idea. Don't teach the whole topic.
4. Build on what was already taught (given as context) — don't redraw or re-explain it; you may refer back to it in words.
5. Standalone "text" shapes go in CLEAR whitespace — never on top of or crossing any other shape. To label a shape, use ITS `text` property instead of a separate text shape.
6. A large region/cluster container's label renders as a header at its TOP — keep the top band of a big container empty and place its contents in the middle/lower area, with the contents' own labels clear of each other.
7. Valid JSON only, no prose outside it.""" + PERSONA


def plan_section(topic: str, section: dict, prior_sections: list, api_key: str, model: str = None) -> dict:
    model = model or get_model_name({})
    prior = ''
    if prior_sections:
        lines = '\n'.join(f"- {s.get('title')}: {s.get('goal', '')}" for s in prior_sections)
        prior = f"\nAlready taught in earlier sections (build on these, don't repeat them):\n{lines}\n"
    user = (
        f"Overall lesson topic: {topic}\n{prior}\n"
        f"Plan THIS section now:\n"
        f"  title: {section.get('title')}\n"
        f"  goal:  {section.get('goal')}\n\n"
        f"Produce the clean diagram (shapes) and the synchronized narration (beats) for this section."
    )
    return _complete(SECTION_SYSTEM, user, api_key, model, max_tokens=6000)


# ─── Barge-in / conversation answers (spoken only) ───────────────────────────

ANSWER_SYSTEM = (
    "You are Jacob, a chill Aussie tutor, mid-lesson. The learner just interrupted "
    "to ask something or wants you to elaborate. Answer them directly and briefly "
    "(2-4 sentences), spoken aloud, then you'll get back to the lesson. Stay fully "
    "in character." + PERSONA +
    "\n\nRespond ONLY with JSON: {\"say\": \"<your spoken reply>\"}"
)


def answer_utterance(topic: str, question: str, prior_sections: list, api_key: str, model: str = None) -> dict:
    """Generate a short spoken reply to a mid-lesson interjection."""
    model = model or get_model_name({})
    covered = ', '.join(s.get('title', '') for s in (prior_sections or [])) or '(just getting started)'
    user = (
        f"Lesson topic: {topic}\nCovered so far: {covered}\n"
        f"The learner just said: \"{question}\"\n\nAnswer them, in character."
    )
    return _complete(ANSWER_SYSTEM, user, api_key, model, max_tokens=600)


# ─── Post-section visual cleanup (light correction pipeline) ─────────────────

FIX_SYSTEM = r"""You clean up ONE section of a whiteboard lesson diagram that has readability problems. You get the section's shapes (the same format they were planned in) and a list of DETECTED issues (overlaps, text overflowing its box, cramped spacing, things poking outside the region).

Return the FULL corrected shape list. You decide where things move — spread shapes out, widen boxes that clip their text, nudge labels clear of other shapes. Rules:
- Keep every shape's id, type and meaning. Don't delete or add shapes; don't rewrite teaching content (only reposition/resize; tweak fontSize only if that's what's broken).
- Keep the layout inside roughly (0,0) to (960,640) with generous whitespace (~40-60px between things). x right, y down, x/y is each shape's top-left.
- Arrows with fromId/toId route between their shapes automatically, and an arrow's `text` label renders at the arrow's MIDPOINT. If an arrow's label collides with something, you MAY: move the other element clear of the arrow's midpoint, move the shapes the arrow connects (which moves the midpoint), shorten the arrow's `text`, or delete the arrow's `text` entirely when the meaning is already conveyed elsewhere. Otherwise return arrows unchanged.
- Standalone text must sit in clear whitespace — never crossing a shape border or lying on an arrow's path.
- Multi-line text uses REAL newlines in the JSON string, never the two characters backslash-n.
Respond ONLY with JSON: {"shapes": [ <the full corrected list> ]}"""


def fix_section(shapes: list, issues: list, api_key: str, model: str = None) -> dict:
    """One-shot cleanup call: detected issues in, corrected shape list out."""
    model = model or get_model_name({})
    user = (
        "Section shapes:\n" + json.dumps(shapes) +
        "\n\nDetected issues:\n" + '\n'.join(f'- {i}' for i in issues) +
        "\n\nReturn the corrected full shape list."
    )
    return _complete(FIX_SYSTEM, user, api_key, model, max_tokens=6000)


# ─── Mid-lesson sidebar (fresh-context elaboration agent) ─────────────────────
# When the learner barges in confused, the consumer spawns a FRESH agent context
# — whiteboard snapshot + lesson summary + the confusion — instead of dragging
# the whole lesson history along. Verbal-first; drawing is opt-in only.

ELABORATE_SYSTEM = r"""You are Jacob, a chill Aussie whiteboard tutor, mid-lesson in a SIDEBAR: the learner interrupted because something didn't click. You get a snapshot of the whiteboard, a summary of the lesson so far, and the sidebar conversation. Respond ONLY with JSON:
{"say": "<spoken reply>", "satisfied": true|false, "offtopic": true|false, "shapes": [ <shape>, ... ]}

Rules:
- "offtopic" is true when the learner's LAST message is NOT actually about the lesson or a real confusion — banter, jokes, trash talk, random remarks. Then "say" is ONE short in-character quip firing back ("Ha, good one mate — righto, back to it.") and you do NOT explain anything; the lesson resumes straight away. Otherwise false.
- Explain VERBALLY: 2-4 spoken sentences, from a DIFFERENT angle than the board already shows (new analogy, concrete example, smaller steps). Do NOT draw by default — OMIT "shapes" entirely.
- Include "shapes" ONLY when the learner's LAST message EXPLICITLY asks you to visualize / draw / show it (e.g. "I still don't understand, could you visualize what you're trying to say?"). Never volunteer a drawing.
- "satisfied" is true ONLY when the learner's LAST message clearly says they get it now ("oh that makes sense", "got it", "yep I understand"). Then "say" is a short handover back to the lesson ("Sweet as — let's crack back on."). A follow-up question or lingering doubt is ALWAYS false.
- Stay on the confusion. Do NOT continue the lesson — the lesson resumes separately once they're sorted.

Shapes (only if explicitly asked): same engine as the lesson. Lay out in a clean region (0,0) to (960,640), x right / y down, each shape's x,y is its top-left. Each: {"id": "<unique string>", "type": "rectangle|ellipse|diamond|text|arrow|line|math", "x", "y", "width", "height", "text" (container label / text words), "latex" (for "math" only, no $, doubled backslashes), "fromId"/"toId" (arrows connect shapes; label in the arrow's own "text"), "strokeColor"/"backgroundColor" (hex, restrained), "fontSize" (16/20/28/36)}. Clean layout, no overlaps.""" + PERSONA


def elaborate_reply(lesson_summary: str, board_image, convo: list, api_key: str, model: str = None) -> dict:
    """One turn of the sidebar agent. The context is rebuilt FRESH every call:
    snapshot + summary + the short sidebar convo — never the lesson chat log."""
    model = model or get_model_name({})
    intro = f"{lesson_summary}\n\nRespond to the learner's LAST message in the sidebar conversation that follows."
    if board_image:
        intro = (f"{lesson_summary}\n\nA snapshot of the whiteboard as it stands is attached.\n"
                 f"Respond to the learner's LAST message in the sidebar conversation that follows.")
    content = [{'type': 'text', 'text': intro}]
    if board_image:
        content.append({'type': 'image_url', 'image_url': {'url': board_image}})
    messages = [{'role': 'system', 'content': ELABORATE_SYSTEM},
                {'role': 'user', 'content': content}]
    for h in convo:
        messages.append({'role': 'assistant' if h.get('role') == 'assistant' else 'user',
                         'content': h.get('text', '')})
    return _complete_messages(messages, api_key, model, max_tokens=4000)


SUMMARIZE_SYSTEM = (
    "A tutor paused a lesson for a sidebar with a confused learner. Compress the whole "
    "sidebar into ONE sentence for the tutor's memory: what the learner was confused about "
    "and how it got cleared up. Respond ONLY with JSON: {\"summary\": \"<one sentence>\"}"
)


def summarize_elaboration(convo: list, api_key: str, model: str = None) -> dict:
    """One-line summary of a sidebar, saved to history INSTEAD of the transcript."""
    model = model or get_model_name({})
    text = '\n'.join(f"{h.get('role')}: {h.get('text')}" for h in convo)
    return _complete(SUMMARIZE_SYSTEM, text, api_key, model, max_tokens=300)


# ─── Voice intent router (orchestrator-style, selection-aware) ────────────────

INTENT_SYSTEM = (
    "You are the router for Jacob, a chill Aussie voice whiteboard tutor. The user "
    "just SPOKE to you. Work out what they actually want and reply ONLY with JSON:\n"
    '{"action":"teach|solve|animate|ask|chat","topic":"<subject to teach/solve/animate>","say":"<spoken reply, for animate/ask/chat only>"}\n\n'
    "- teach: they want a concept/topic explained that you CAN identify — from their "
    "words, or from what they've SELECTED on the canvas. Put the subject in \"topic\".\n"
    "- solve: they want a specific problem worked through that is SELECTED on the canvas "
    "or clearly stated in their words. Read it (including from a selected image) and put "
    '"solve this problem: <the actual problem>" in "topic".\n'
    "- animate: they want a rendered VIDEO ANIMATION of something (\"show me this as a "
    "visual animation\", \"animate that for me\"). Put WHAT to animate in \"topic\" (read "
    "the selection/image if they said \"this\"), plus a short in-character heads-up in "
    '"say" ("Righto, cooking up an animation for ya — takes a few ticks, hang tight.").\n'
    "- ask: you genuinely CANNOT tell what they want taught or solved — nothing useful is "
    "selected AND their words don't name a subject (e.g. \"can you help me solve this "
    "problem\" with nothing selected). Put a short in-character spoken clarifying question "
    'in "say", e.g. "Yeah course mate — could you show us what you want solved? Chuck a '
    'selection round it, or just tell me what it is."\n'
    "- chat: a general question or comment you can just answer out loud → spoken reply in \"say\".\n\n"
    "If an image is selected, READ it to identify the problem/topic. Prefer teach/solve when "
    "you can genuinely tell the subject; only use ask when it's truly unclear what they mean "
    "by \"this\"/\"it\"." + PERSONA
)


def decide_voice_intent(utterance: str, selection: dict, history: list, api_key: str, model: str = None) -> dict:
    """Route a spoken request: teach / solve (using the canvas selection) / ask
    (clarify) / chat. `selection` = {text, image(dataURL), count}."""
    model = model or get_model_name({})
    selection = selection or {}
    sel_text = (selection.get('text') or '').strip()
    has_image = bool(selection.get('image'))
    where = sel_text or ('an image (read it)' if has_image else '(nothing selected)')
    content = [{'type': 'text', 'text': f'User said: "{utterance}"\nSelected on canvas: {where}'}]
    if has_image:
        content.append({'type': 'image_url', 'image_url': {'url': selection['image']}})
    messages = [{'role': 'system', 'content': INTENT_SYSTEM}]
    for h in (history or [])[-6:]:
        if h.get('text'):
            messages.append({'role': h.get('role', 'user'), 'content': h['text']})
    messages.append({'role': 'user', 'content': content})
    return _complete_messages(messages, api_key, model, max_tokens=900)


# ─── HTTP endpoints (client orchestrates the loop) ────────────────────────────

def _auth(request):
    auth = JWTAuthentication()
    try:
        return auth.authenticate(request) is not None
    except Exception:
        return False


def _cors(response):
    response['Access-Control-Allow-Origin'] = '*'
    response['Access-Control-Allow-Methods'] = 'POST, OPTIONS'
    response['Access-Control-Allow-Headers'] = 'Content-Type, Authorization'
    return response


@csrf_exempt
def lesson_outline_view(request):
    if request.method == 'OPTIONS':
        return _cors(JsonResponse({}))
    if request.method != 'POST':
        return _cors(JsonResponse({'error': 'Method not allowed'}, status=405))
    if not _auth(request):
        return _cors(JsonResponse({'error': 'Authentication required'}, status=401))
    api_key = os.environ.get('OPENAI_API_KEY', '')
    if not api_key:
        return _cors(JsonResponse({'error': 'OPENAI_API_KEY not configured'}, status=503))
    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return _cors(JsonResponse({'error': 'Invalid JSON body'}, status=400))
    topic = (data.get('topic') or '').strip()
    if not topic:
        return _cors(JsonResponse({'error': 'topic is required'}, status=400))
    try:
        return _cors(JsonResponse(lesson_outline(topic, api_key)))
    except Exception as e:
        return _cors(JsonResponse({'error': str(e)}, status=500))


@csrf_exempt
def lesson_section_view(request):
    if request.method == 'OPTIONS':
        return _cors(JsonResponse({}))
    if request.method != 'POST':
        return _cors(JsonResponse({'error': 'Method not allowed'}, status=405))
    if not _auth(request):
        return _cors(JsonResponse({'error': 'Authentication required'}, status=401))
    api_key = os.environ.get('OPENAI_API_KEY', '')
    if not api_key:
        return _cors(JsonResponse({'error': 'OPENAI_API_KEY not configured'}, status=503))
    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return _cors(JsonResponse({'error': 'Invalid JSON body'}, status=400))
    topic = (data.get('topic') or '').strip()
    section = data.get('section') or {}
    prior = data.get('priorSections') or []
    if not topic or not section:
        return _cors(JsonResponse({'error': 'topic and section are required'}, status=400))
    try:
        return _cors(JsonResponse(plan_section(topic, section, prior, api_key)))
    except Exception as e:
        return _cors(JsonResponse({'error': str(e)}, status=500))
