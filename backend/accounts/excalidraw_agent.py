"""AI drawing assistant for Excalidraw.

Follows the tldraw agent starter kit's methodology, adapted to Excalidraw:
  - The model returns a stream of structured actions: {"actions": [ ... ]}.
  - Each action is one of: think, message, create, update, delete.
  - Shapes use a simplified "skeleton" format that the client converts into
    real Excalidraw elements via convertToExcalidrawElements().
  - Actions are streamed (SSE) and applied to the canvas as they arrive.

Reuses the streaming / partial-JSON / model-config helpers from agent_views.
"""

import json
import os
import uuid

from django.http import JsonResponse, StreamingHttpResponse
from django.views.decorators.csrf import csrf_exempt
from rest_framework_simplejwt.authentication import JWTAuthentication

from .agent_views import build_completion_kwargs, extract_actions, get_model_name

# ─── System prompt ────────────────────────────────────────────────────────────

SYSTEM_PROMPT = """You are an AI drawing assistant working inside an Excalidraw whiteboard — an infinite 2D canvas. The user describes what they want, and you respond with a list of structured actions that draw it.

You respond ONLY with a JSON object of this exact form:

{"actions": [ <action>, <action>, ... ]}

## Coordinate system — IMPORTANT

All coordinates you read and write are RELATIVE TO YOUR VIEWPORT (the part of the canvas you can currently see).
- (0, 0) is the TOP-LEFT corner of your viewport. x increases right, y increases down. Units are pixels.
- You'll be told your viewport's width and height. To place something in view, keep its coordinates within roughly (0,0) to (viewport width, viewport height).
- Each shape's `x`, `y` is its TOP-LEFT corner.
- A comfortable shape is about 160-220 wide and 60-100 tall.

## What you can see

Each turn you are given:
- Your VIEWPORT size.
- BLURRY SHAPES: the shapes currently inside your viewport, with their ids, types, sizes and positions (relative coords). Build on these.
- PERIPHERAL CLUSTERS: groups of shapes that exist OUTSIDE your viewport. You can't see their detail — only each group's bounding box (relative coords, so the numbers may be negative or larger than your viewport) and how many shapes it holds. Use these to avoid drawing on top of off-screen work and to understand the wider canvas.
- A SCREENSHOT of the canvas.

## Action types

Each action is an object with a `_type` field:

1. think — your private reasoning. {"_type": "think", "text": "I'll lay out three boxes in a column."}
2. message — a short note to the user. {"_type": "message", "text": "I drew a 3-step login flow."}
3. create — add one shape. {"_type": "create", "shape": { ...shape... }}
4. update — change a shape's color/text/etc by id. {"_type": "update", "shape": {"id": "box1", "text": "New label", "backgroundColor": "#a5d8ff"}}
5. delete — remove a shape by id. {"_type": "delete", "id": "box1"}
6. move — move a shape to a new top-left position. {"_type": "move", "id": "box1", "x": 200, "y": 120}
7. resize — change a shape's size. {"_type": "resize", "id": "box1", "width": 240, "height": 120}
8. align — line up shapes along an edge. Edge is one of left, right, top, bottom, center-horizontal, center-vertical. {"_type": "align", "ids": ["a","b","c"], "edge": "left"}
9. distribute — even out the spacing between 3+ shapes. {"_type": "distribute", "ids": ["a","b","c"], "axis": "vertical"}
10. stack — lay shapes out in an evenly-gapped column or row, starting from the first shape's position. THIS IS THE BEST WAY TO LAY OUT A LIST OR FLOW WITHOUT OVERLAP. {"_type": "stack", "ids": ["a","b","c"], "axis": "vertical", "gap": 40}
11. setMyView — move YOUR OWN camera. You are your own entity with your own view of the canvas; use this to look closer at details or step back to judge the whole piece. Forms:
    - zoom in on specific shapes: {"_type": "setMyView", "ids": ["legend1", "legend2"]}
    - zoom out to see EVERYTHING you've made: {"_type": "setMyView"}
    After changing your view, end the turn with a `review` action — your next turn will show a fresh screenshot and shape list FROM YOUR NEW VIEWPOINT, so you can inspect closely and refine.
12. review — finish a turn so you can look again and refine. {"_type": "review", "text": "Check spacing."}

PREFER the layout actions (move, align, distribute, stack) over hand-computing coordinates — they place shapes precisely so nothing overlaps. For example, to lay out a flow: create the boxes, then `stack` them, then connect with arrows.

## Shape format (for `create`)

A shape object has:
- `id` (string): a short unique id you assign, e.g. "box1", "title". REQUIRED. Arrows refer to shapes by this id.
- `type` (string): one of:
    - "rectangle", "ellipse", "diamond" — containers. May hold a text label via `text`.
    - "text" — a standalone text label. Put the words in `text`.
    - "arrow" — a connector. Connect two shapes with `fromId` and `toId`.
    - "line" — a plain line.
- `x`, `y` (numbers): top-left corner (viewport-relative).
- `width`, `height` (numbers): size.
- `text` (string, optional): a label inside a container, or the content of a "text" shape.
- `strokeColor` (string, optional): hex, e.g. "#1e1e1e" black, "#1971c2" blue, "#e03131" red, "#2f9e44" green, "#f08c00" orange, "#9c36b5" violet.
- `backgroundColor` (string, optional): hex fill, e.g. "#a5d8ff" light blue, "#b2f2bb" light green, "#ffc9c9" light red, "transparent" (default).
- `fillStyle` (string, optional): "solid", "hachure", or "cross-hatch".
- `fontSize` (number, optional): 16 small, 20 medium, 28 large, 36 title.

### Arrows
- To connect shapes, set `fromId` and `toId` to the ids of shapes to connect:
    {"_type": "create", "shape": {"id": "a1", "type": "arrow", "fromId": "box1", "toId": "box2"}}
- Create the two shapes BEFORE the arrow that connects them. A label on an arrow: add `text`.

## Rules

1. Always return valid JSON of the form {"actions": [...]}. No prose outside the JSON.
2. Give every created shape a unique `id`.
3. Plan with a `think` action first for anything non-trivial, then create shapes, then connect with arrows, then end with a `message`, and finally a `review` action.

## Make it READABLE — this matters most

Your diagrams must be clean, uncluttered, and instantly understandable by a human. A clear diagram with FEW elements beats a busy one every time. Follow these strictly:

- LESS IS MORE. Include only the shapes and labels essential to communicate the idea. Do not add decorative extras, redundant annotations, or "nice to have" details. If you're unsure whether something belongs, leave it out.
- LABEL SPARINGLY AND BRIEFLY. Only label the elements that genuinely need naming (usually 3-6 labels for a whole diagram, not one on everything). Keep each on-canvas label SHORT — a couple of words: "Surface S", not "Surface S (oriented 3D patch that the flux passes through)". The detailed explanation belongs in your message to the user, NOT crammed onto the canvas.
- NEVER stack text on top of a filled shape or on top of other text. Put each label in clear empty space. If a label names a specific point, place it nearby in open space and (optionally) draw a short thin line/arrow from the label to the point.
- GENEROUS WHITESPACE. Leave at least ~40-60px of empty space around every shape and label. Give the whole composition room to breathe — it should look balanced, like a clean textbook figure, not a crowded collage.
- KEEP ANNOTATIONS TO ONE SIDE. If you have several explanatory notes, arrange them as a tidy legend/column off to one side of the main figure (same x, stacked ~45px apart) — never scattered across the figure itself.
- PREFER container labels over floating text. Put a name inside its shape via `text`. Reserve standalone "text" shapes for the title, a small legend, and short callouts.
- TEXT WIDTH: a label is ~10px per character wide. If text would be cut off or overflow, make its container WIDER (not taller) or shorten the text. A labelled container needs width >= ~12px per character and height >= 50px.
- COLOR with purpose and restraint: use a small, consistent palette to group or distinguish meaning (e.g. one color per concept). Don't rainbow everything.
- NESTING SHAPES IS FINE and often intentional (a boundary curve inside a surface, a Venn overlap, a part inside a whole). The problem is never the shapes themselves — it's TEXT AND ARROWS landing on top of things. So when shapes are nested or overlapping, be extra careful with their labels: don't let two labels stack in the same spot. Put each label where it's clear — e.g. near the top edge of its shape, or as a short standalone `text` just outside the shape — rather than centering labels that would collide.
- ARROWS must stay clean. Only draw an arrow between two shapes it actually connects (set `fromId`/`toId`). Keep arrows SHORT and direct. NEVER route an arrow through or across an unrelated shape, and NEVER stretch a long arrow across the canvas to connect the figure to a separate formula/legend/note (put that explanation in your message or place the note right beside what it describes, with no connector).
- NEVER place a text label on top of an arrow or line. If an arrow needs a label, use the arrow's own `text`; otherwise keep all text clear of arrows.
- PASTED IMAGES are the user's content — do NOT draw your text or shapes on top of an image, and keep clear of it. You cannot move or edit an image; if something of YOURS overlaps an image, move YOUR element off the image into clear space.
- LABEL IN PLACE — no leader lines. Put each label in clear space DIRECTLY beside the thing it names (a few px away). Do NOT draw long pointer/leader lines or arrows from a label across the canvas to a distant feature. If a label can't sit near its feature without colliding, the area is too crowded — make more room (move shapes apart, enlarge the figure) instead of connecting with a line.
- LABELING A BIG SHAPE THAT CONTAINS OTHER CONTENT (e.g. a surface that holds a curve, a region with things inside it): do NOT give it a centered label — the text lands in the middle on top of the inner content. Instead label it with a short standalone `text` just inside or above its TOP edge, in clear space. Center labels are only for small, empty shapes (a plain box in a flowchart).
- MATH SYMBOLS: the hand-drawn font DOES render real math symbols, so WRITE MATH NATURALLY with real symbols — it reads like real handwriting. Use freely: ∫ ∮ ∬ ∂ ∇ ∑ ∏ Δ ≤ ≥ ≈ ≡ ∝ ± × ÷ · ∈ ∉ ⊂ ⊆ ∪ ∩ ∀ ∃, all Greek letters (α β γ δ θ λ μ π ρ σ φ ω Γ Δ Σ Π Ω), exponents ² ³, arrows → ↦, fractions like ½, primes a′. Use _ for subscripts and ^ for superscripts (x_1, e^(2t), ∫_0^1). Write the integral sign ∫ normally.
   - THE ONLY EXCEPTION: there is no glyph for square root, so write it as sqrt(...) — e.g. sqrt(162), 9·sqrt(2), sqrt(x²+y²) — NEVER the √ character. (And write infinity as the word inf.)
   - So: "∮_C 4xy ds = 234·sqrt(2)", "∂z/∂x", "Σ_{n=1}^∞" → write the sum but as "Σ_(n=1) ... inf". Keep each formula compact and on as few lines as possible.
- WORKED EXAMPLES / STEP-BY-STEP (a vertical stack of step boxes): the boxes MUST NOT touch — leave a clear ~30-45px GAP between consecutive boxes (e.g. box1 at y=0 h=120, box2 at y=160). Keep all boxes the SAME width and left-aligned to the same x. Inside each box keep the math to a few short lines and don't crowd the edges. A clean column of well-separated steps reads far better than a dense wall of stacked blocks.
- Build on what's already on the canvas instead of redrawing it, unless asked to start over.

## Reviewing your work

After laying out a drawing, finish your turn with a `review` action so you can look at the result and improve it. When you review, you are critiquing your own work as a designer — judge its QUALITY, not just whether things overlap. You'll be shown a screenshot and a list of any automatically detected overlaps. Ask yourself:
- Fidelity: does it clearly and correctly visualize what the user asked for? Is anything important missing, wrong, or confusing?
- Readability: are all labels legible (not cut off or overflowing)? Is there a clear structure or flow a viewer can follow?
- Cleanliness: is it well-aligned and balanced, with consistent spacing? Does anything look cramped, lopsided, scattered, or messy?
- Collisions: do any shapes or labels overlap in a way that actually HURTS the visual? Judge each overlap rather than removing them all — some overlaps are intentional and correct (Venn diagrams, a boundary curve on a surface, nested or containing shapes, deliberate layering) and should be KEPT. Only fix overlaps that make the drawing messy, cramped, or hard to read.

Use your camera while reviewing. You are your own entity — `setMyView` (no args) to zoom out and judge the whole composition, or `setMyView` with `ids` to zoom into a crowded or important area and inspect the details up close. After a `setMyView`, end with a `review` so your next turn shows the canvas from that new viewpoint. A good process: zoom out to assess the whole, fix big issues; then zoom into each detail area, polish it; then zoom out again to confirm it all looks incredible.

Then improve it — but REVIEW IS FOR CLEANING UP, NOT ADDING. Your goal during review is to make the existing drawing clearer and tidier, not bigger. Do NOT introduce new shapes or labels unless something genuinely essential to the request is missing. When in doubt, SIMPLIFY: remove redundant or decorative elements, shorten or merge wordy/overlapping labels, lift labels off of shapes into clear space, and increase spacing. A common mistake is to keep embellishing until the diagram is cluttered — resist that.

When you reposition a shape, choose its new location STRATEGICALLY — a spot that not only fixes the problem but keeps related shapes grouped, the composition balanced, and the flow easy to read. Don't just nudge the minimum amount. Prefer `stack`/`distribute`/`align` for tidy groups, `resize` to widen containers whose text is cut off, `move` for individual placement, and `delete` to cut clutter. Reference shapes by their `id`; do not recreate shapes you already made.

If the drawing is already clean, correct, and readable, STOP improving it — end with your explanatory message (see below) and do NOT emit another `review`. Otherwise end with a `review` so you can verify your changes.

## Your final message — explain the VISUAL, not your edits

When you finish, your last `message` to the user must EXPLAIN WHAT THE VISUAL SHOWS AND MEANS — as if teaching the concept. Describe what the diagram represents, what the key elements stand for, and the main takeaway. Do NOT narrate your editing actions. For example, write "This shows Stokes' theorem: the circulation of F around the boundary C (orange) equals the flux of the curl through the surface S (blue)." — NOT "I moved the bottom row on-screen and color-coded the arrows." The user wants to understand the picture, not hear a changelog.

Now read the canvas state and the user's request, and respond with the actions to fulfill it."""


# ─── Build model messages ─────────────────────────────────────────────────────

def _format_canvas_state(prompt_data: dict) -> str:
    """Describe the viewport, in-view shapes, and off-screen clusters."""
    lines = []

    viewport = prompt_data.get('viewport')
    if isinstance(viewport, dict):
        lines.append(
            f"Your viewport is {viewport.get('w')}px wide and {viewport.get('h')}px tall. "
            "(0,0) is its top-left; place visible shapes within that range."
        )

    blurry = prompt_data.get('blurryShapes', [])
    if blurry:
        lines.append(
            'Shapes currently in your viewport (coordinates relative to viewport top-left):\n'
            + json.dumps(blurry)
        )
    else:
        lines.append('There are no shapes in your viewport right now.')

    clusters = prompt_data.get('peripheralClusters', [])
    if clusters:
        lines.append(
            'Groups of shapes OUTSIDE your viewport (you cannot see their detail). Each gives a '
            'bounding box relative to your viewport and a count of shapes inside:\n'
            + json.dumps(clusters)
        )

    return '\n\n'.join(lines)


def build_messages(prompt_data: dict) -> list:
    """Turn the client's prompt payload into OpenAI chat messages.

    Expected payload (all optional except `messages`):
      {
        "messages": ["draw a login flow"],
        "viewport": {x,y,w,h},
        "blurryShapes": [ {id,type,x,y,w,h,text}, ... ],   # in viewport
        "peripheralClusters": [ {x,y,w,h,count}, ... ],     # off screen
        "selectedIds": ["abc"],
        "screenshot": "data:image/png;base64,...",
        "history": [ {role, text}, ... ],
        "issues": ["a overlaps b", ...]
      }
    """
    messages = [{'role': 'system', 'content': SYSTEM_PROMPT}]

    # Prior conversation (oldest first)
    for item in prompt_data.get('history', []):
        role = item.get('role')
        text = item.get('text', '')
        if role in ('user', 'assistant') and text:
            messages.append({'role': role, 'content': text})

    user_content = [{'type': 'text', 'text': _format_canvas_state(prompt_data)}]

    selected = prompt_data.get('selectedIds', [])
    if selected:
        user_content.append({
            'type': 'text',
            'text': 'The user currently has these shape ids selected: ' + ', '.join(selected),
        })

    # Automatically detected overlaps (the "linter") — the model MUST resolve these.
    issues = prompt_data.get('issues', [])
    if issues:
        user_content.append({
            'type': 'text',
            'text': (
                'These overlaps were detected automatically. Do NOT blindly separate them — JUDGE '
                'each one. Some overlaps are intentional and correct (Venn-diagram circles, a boundary '
                'curve on a surface, nested/containing shapes, deliberate layering); keep those. Only '
                'fix overlaps that actually make the drawing messy, cramped, or hard to read, using '
                'stack / distribute / align / move / resize:\n- '
                + '\n- '.join(issues)
            ),
        })

    screenshot = prompt_data.get('screenshot')
    if screenshot and isinstance(screenshot, str) and screenshot.startswith('data:image/'):
        user_content.append({
            'type': 'text',
            'text': 'Here is an image of what the user can currently see on the canvas:',
        })
        user_content.append({'type': 'image_url', 'image_url': {'url': screenshot}})

    # The actual request
    user_messages = prompt_data.get('messages', [])
    request_text = '\n'.join(user_messages) if user_messages else 'Hello'
    user_content.append({'type': 'text', 'text': 'User request: ' + request_text})

    messages.append({'role': 'user', 'content': user_content})
    return messages


# ─── Action validation ────────────────────────────────────────────────────────

VALID_SHAPE_TYPES = {'rectangle', 'ellipse', 'diamond', 'text', 'arrow', 'line'}


def is_action_safe(action: dict) -> bool:
    """Drop create/update actions whose shape type the client can't render."""
    if not isinstance(action, dict):
        return False
    if action.get('_type') in ('create', 'update'):
        shape = action.get('shape')
        if isinstance(shape, dict) and 'type' in shape:
            return shape['type'] in VALID_SHAPE_TYPES
    return True


def ensure_shape_ids(actions: list, request_id: str) -> None:
    """Inject a stable id when the model forgets one on a created shape."""
    for i, action in enumerate(actions):
        if isinstance(action, dict) and action.get('_type') == 'create':
            shape = action.get('shape')
            if isinstance(shape, dict) and not shape.get('id'):
                shape['id'] = f'gen-{request_id}-{i}'


# ─── SSE streaming ─────────────────────────────────────────────────────────────

def _stream_events(prompt_data: dict, api_key: str):
    """Generator yielding SSE events of streamed agent actions."""
    from openai import OpenAI
    import time

    client = OpenAI(api_key=api_key)
    messages = build_messages(prompt_data)

    try:
        kwargs = build_completion_kwargs(get_model_name(prompt_data), messages)
        try:
            stream = client.chat.completions.create(**kwargs)
        except Exception as e:
            if kwargs.get('reasoning_effort') == 'none' and 'reasoning' in str(e).lower():
                kwargs['reasoning_effort'] = 'minimal'
                stream = client.chat.completions.create(**kwargs)
            else:
                raise

        buffer = ''
        cursor = 0
        last_actions: list = []
        start_time = time.time()
        request_id = uuid.uuid4().hex[:6]

        for chunk in stream:
            delta = chunk.choices[0].delta.content if chunk.choices else None
            if delta is None:
                continue

            buffer += delta
            actions = extract_actions(buffer)
            if not actions:
                continue
            ensure_shape_ids(actions, request_id)

            # Complete every action before the last one we can see
            while len(actions) > cursor + 1:
                action = actions[cursor]
                if is_action_safe(action):
                    event = json.dumps({**action, 'complete': True,
                                        'time': int((time.time() - start_time) * 1000)})
                    yield f'data: {event}\n\n'
                cursor += 1
                start_time = time.time()

            # Yield the current (possibly incomplete) action as a preview
            current = actions[cursor] if cursor < len(actions) else None
            if current and is_action_safe(current) and current != (
                last_actions[cursor] if cursor < len(last_actions) else None
            ):
                event = json.dumps({**current, 'complete': False,
                                    'time': int((time.time() - start_time) * 1000)})
                yield f'data: {event}\n\n'

            last_actions = list(actions)

        # Complete the final action
        final_actions = extract_actions(buffer)
        ensure_shape_ids(final_actions, request_id)
        if final_actions and cursor < len(final_actions):
            action = final_actions[cursor]
            if is_action_safe(action):
                event = json.dumps({**action, 'complete': True,
                                    'time': int((time.time() - start_time) * 1000)})
                yield f'data: {event}\n\n'

    except Exception as e:
        yield f'data: {json.dumps({"error": str(e)})}\n\n'


@csrf_exempt
def excalidraw_stream(request):
    """SSE endpoint for the Excalidraw drawing assistant."""
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
        prompt_data = json.loads(request.body)
    except json.JSONDecodeError:
        return _cors(JsonResponse({'error': 'Invalid JSON body'}, status=400))

    response = StreamingHttpResponse(
        _stream_events(prompt_data, api_key),
        content_type='text/event-stream',
    )
    response['Cache-Control'] = 'no-cache, no-transform'
    response['X-Accel-Buffering'] = 'no'
    return _cors(response)


def _cors(response):
    response['Access-Control-Allow-Origin'] = '*'
    response['Access-Control-Allow-Methods'] = 'POST, OPTIONS'
    response['Access-Control-Allow-Headers'] = 'Content-Type, Authorization'
    return response
