"""Reasoning orchestrator that sits in front of the whiteboard agent.

It decides, from ONLY the user's message + conversation history (no canvas
context — that would waste tokens), one of four actions:
  - chat:       just reply conversationally (e.g. the user said "hi")
  - ask:        the user wants a visualization but hasn't said whiteboard vs video
  - whiteboard: forward the task to the whiteboard agent
  - manim:      forward the task to the (placeholder) animation agent
"""

import json
import os

from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from rest_framework_simplejwt.authentication import JWTAuthentication

# A small, fast model is plenty for routing.
ORCHESTRATOR_MODEL = 'gpt-5-mini'

ORCHESTRATOR_PROMPT = """You are the orchestrator for an AI assistant. Read the user's latest message together with the conversation history and decide what should happen next. Reply with ONLY a JSON object — no other text.

You must choose exactly ONE action:

1. "chat" — The user is just talking conversationally and is NOT asking you to create, draw, visualize, or animate anything (e.g. greetings like "hi", small talk, "how are you?", thanks, or a general question you can answer in words). Reply:
   {"action": "chat", "message": "<your friendly, helpful reply>"}

2. "ask" — The user wants something VISUALIZED (draw / diagram / illustrate / show / visualize / animate / graph something), but the conversation has NOT yet made clear whether they want it as a STATIC drawing on a whiteboard or as an ANIMATED VIDEO. Before doing anything, ask them which they want:
   {"action": "ask", "message": "Would you like this drawn on the whiteboard, or made into an animated video?"}

3. "whiteboard" — It is clear they want a STATIC drawing/diagram on the whiteboard. This is the case when the user explicitly says whiteboard / draw / diagram / sketch (a static medium), OR when, earlier in the conversation, you asked which they wanted and they have now chosen the whiteboard. Reply:
   {"action": "whiteboard", "task": "<the thing to visualize, in a clear imperative, distilled from the whole conversation>"}

4. "manim" — It is clear they want an ANIMATED VIDEO. This is the case when the user explicitly says animation / animate / video / manim, OR they chose the video option after you asked. Reply:
   {"action": "manim", "task": "<the thing to animate, distilled from the whole conversation>"}

5. "grapher" — The user wants to GRAPH or PLOT an equation/function, or to VISUALIZE a mathematical surface, curve, or region they could explore interactively (an interactive graphing calculator). Examples: "graph y = sin(x)", "plot z = x^2 - y^2", "show the surface x^2+y^2+z^2 = 4", "visualize the region of this triple integral", or a pasted integral over a 3D region. This is PREFERRED over whiteboard/video whenever the thing to show is a plottable equation/function/surface — and you do NOT need to ask whiteboard-vs-video for these. Reply:
   {"action": "grapher", "dimension": "2d" or "3d", "expressions": ["<expr>", ...], "message": "<short note>"}
   - Use "3d" if it involves z, a surface, a solid/region, or a multiple integral over a 3D region; otherwise "2d".
   - "expressions": the equation(s) to pre-load, in PLAIN math syntax a JavaScript math evaluator understands — use ^ for powers, * for multiplication, and functions like sin, cos, sqrt, exp, abs, pi. Examples: "z = x^2 - y^2", "y = sin(x)", "sqrt(4 - x^2 - y^2)". For a region bounded by a surface (e.g. a sphere of radius 2 implied by a triple integral), give the surface as z = f(x,y) — e.g. BOTH "sqrt(4 - x^2 - y^2)" and "-sqrt(4 - x^2 - y^2)" for a full sphere. A point is "(x, y)" or "(x, y, z)".
   - Every expression must be PLOTTABLE. In 2D: "y = f(x)", a bare expression, or a point "(x, y)". In 3D: ONLY a surface "z = f(x,y)", a bare expression in x and y, or a point "(x, y, z)". Do NOT output interval/range bounds ("x = 0..2"), and in 3D do NOT output equations solved for x or y or planes (NOT "x = 0", "y = 2", "x = sqrt(4 - y^2)") — the grapher plots z as a function of x and y only. For a region, just give the main bounding surface(s) as z = f(x,y). Keep it to a few key expressions.
   - IMPORTANT — equation FROM THE WHITEBOARD: if the user wants to graph/plot something but did NOT actually provide an equation in the conversation (e.g. "graph this equation", "plot the equation on the whiteboard", "graph this", "plot what I drew"), they are referring to something already on the whiteboard. Do NOT invent an equation. Instead reply with: {"action": "grapher", "source": "whiteboard"} (you may add "dimension" only if it's truly clear, otherwise omit it). The app will figure out which whiteboard item they mean.

Rules:
- Output ONLY the JSON object.
- For "whiteboard" and "manim", the "task" is the actual subject to visualize, taken from the WHOLE conversation. Example: if earlier the user said "visualize Stokes' theorem" and now says "whiteboard", the task is "Visualize Stokes' theorem".
- Keep the "task" CONCISE — just say WHAT to visualize (the subject), not a detailed shot-list of every shape, arrow, label, and annotation to include. The downstream agent decides the visual details. Roughly one sentence. Good: "Visualize Stokes' theorem in 3D." Bad: a paragraph enumerating tangent arrows, curl fields, every label, and the equation.
- Choose "grapher" for anything that is essentially plotting an equation/function/surface/region. Choose "ask" (whiteboard vs video) only for conceptual illustrations/diagrams that are NOT a plottable equation and whose medium is ambiguous.
"""

VALID_ACTIONS = {'chat', 'ask', 'whiteboard', 'manim', 'grapher'}


def _decide(messages, api_key):
    from openai import OpenAI

    client = OpenAI(api_key=api_key)
    kwargs = {
        'model': ORCHESTRATOR_MODEL,
        'messages': messages,
        'response_format': {'type': 'json_object'},
    }
    if ORCHESTRATOR_MODEL.startswith('gpt-5') or ORCHESTRATOR_MODEL.startswith('o'):
        kwargs['max_completion_tokens'] = 2000
        kwargs['reasoning_effort'] = 'none'
    else:
        kwargs['max_tokens'] = 500
        kwargs['temperature'] = 0

    try:
        resp = client.chat.completions.create(**kwargs)
    except Exception as e:
        if kwargs.get('reasoning_effort') == 'none' and 'reasoning' in str(e).lower():
            kwargs['reasoning_effort'] = 'minimal'
            resp = client.chat.completions.create(**kwargs)
        else:
            raise
    return resp.choices[0].message.content


@csrf_exempt
def orchestrate(request):
    if request.method == 'OPTIONS':
        return _cors(JsonResponse({}))
    if request.method != 'POST':
        return _cors(JsonResponse({'error': 'Method not allowed'}, status=405))

    auth = JWTAuthentication()
    try:
        if auth.authenticate(request) is None:
            return _cors(JsonResponse({'error': 'Authentication required'}, status=401))
    except Exception:
        return _cors(JsonResponse({'error': 'Invalid token'}, status=401))

    api_key = os.environ.get('OPENAI_API_KEY', '')
    if not api_key:
        return _cors(JsonResponse({'error': 'OPENAI_API_KEY not configured'}, status=503))

    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return _cors(JsonResponse({'error': 'Invalid JSON body'}, status=400))

    raw_message = data.get('message', '')
    user_message = '\n'.join(raw_message) if isinstance(raw_message, list) else str(raw_message)

    # Build the orchestrator's messages: system + history + current message ONLY.
    # Deliberately NO canvas context here.
    messages = [{'role': 'system', 'content': ORCHESTRATOR_PROMPT}]
    for item in data.get('history', []):
        role = item.get('role')
        text = item.get('text', '')
        if role in ('user', 'assistant') and text:
            messages.append({'role': role, 'content': text})
    messages.append({'role': 'user', 'content': user_message or 'Hello'})

    try:
        decision = json.loads(_decide(messages, api_key))
    except Exception as e:
        return _cors(JsonResponse({'error': str(e)}, status=502))

    action = decision.get('action')
    if action not in VALID_ACTIONS:
        decision = {'action': 'chat', 'message': decision.get('message') or "I'm not sure how to help with that — could you rephrase?"}
        action = 'chat'

    if action == 'manim':
        print('forwarded to manim agent')

    return _cors(JsonResponse(decision))


def _cors(response):
    response['Access-Control-Allow-Origin'] = '*'
    response['Access-Control-Allow-Methods'] = 'POST, OPTIONS'
    response['Access-Control-Allow-Headers'] = 'Content-Type, Authorization'
    return response
