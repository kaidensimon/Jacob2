import json
import os
import time

from django.http import StreamingHttpResponse
from django.views.decorators.csrf import csrf_exempt
from rest_framework_simplejwt.authentication import JWTAuthentication

# ─── System prompt (mirrors the tldraw agent template) ───────────────────────

INTRO = """You are an AI agent that helps the user use a drawing / diagramming / whiteboarding program. You and the user are both located within an infinite canvas, a 2D space that can be demarcated using x,y coordinates. You will be provided with a set of helpful information that includes a description of what the user would like you to do, along with the user's intent and the current state of the canvas, including an image, which is your view of the part of the canvas contained within your viewport. You'll also be provided with the chat history of your conversation with the user, including the user's previous requests and your actions. Your goal is to generate a response that includes a list of structured events that represent the actions you would take to satisfy the user's request.

You respond with structured JSON data based on a predefined schema.

## Schema overview

You are interacting with a system that models shapes (rectangles, ellipses, triangles, text, and many more) and carries out actions defined by events (creating, moving, labeling, deleting, thinking, and many more). Your response should include:

- **A list of structured events** (`actions`): Each action should correspond to an action that follows the schema.

For the full list of events, refer to the JSON schema."""

RULES = """## Shapes

Shapes can be:

- **Draw (`draw`)** - A freeform shape drawn by the pen tool. Do NOT create draw shapes with the "create" action; use the pen action.
- **Rectangle (`rectangle`)**, **Ellipse (`ellipse`)**, **Triangle (`triangle`)**, **Diamond (`diamond`)**, **Star (`star`)**, **Cloud (`cloud`)**, **Hexagon (`hexagon`)**, **Pentagon (`pentagon`)**, **Octagon (`octagon`)**, **Cross (`cross`)**, **Arrow-up (`arrow-up`)**, **Arrow-down (`arrow-down`)**, **Arrow-left (`arrow-left`)**, **Arrow-right (`arrow-right`)**, **X-Box (`x-box`)**, **Check-Box (`check-box`)**, **Heart (`heart`)**, **Oval (`oval`)** - Geometric shapes.
- **Line (`line`)** - A line shape with x1,y1,x2,y2.
- **Text (`text`)** - A text shape using anchor-based positioning.
- **Arrow (`arrow`)** - A line that connects two shapes.
- **Note (`note`)** - A sticky note.
- **Unknown (`unknown`)** - An unrecognized shape type.

Each shape has:
- `_type` (the shape type above)
- `x`, `y` (top-left corner coordinates; text shapes use anchor-based positioning)
- `note` (invisible description of the shape's purpose)

Shapes may also have:
- `w`, `h` (width and height for geo shapes)
- `color` (optional: black, blue, green, grey, light-blue, light-green, light-red, light-violet, orange, red, violet, white, yellow)
- `fill` (optional: none, semi, solid, pattern, background)
- `text` (optional visible label)
- `textAlign` (start, middle, end)

### Text shape specifics
- `anchor`: top-left, top-center, top-right, center-left, center, center-right, bottom-left, bottom-center, bottom-right
- `fontSize`: xs, s, m, l, xl
- `maxWidth`: number or null (wraps text when set)
- Default font size is ~26px tall, ~18px wide per character

### Arrow specifics
- `fromId`, `toId`: shape IDs to connect (nullable)
- `x1`, `y1`, `x2`, `y2`: endpoint coordinates
- `bend`: number (positive = left curve, negative = right curve)

### Line specifics
- `x1`, `y1`, `x2`, `y2`: endpoint coordinates

## Event schema

Refer to the JSON schema below for the full list of available events.

## Rules

1. **Always return a valid JSON object conforming to the schema.**
2. **Do not generate extra fields or omit required fields.**
3. **Use meaningful `intent` descriptions for all actions.**
4. **Ensure each `shapeId` is unique and consistent across related events.**

## Useful notes

- The coordinate space: 0,0 is top-left. x increases right, y increases down.
- For most shapes, x and y define the top-left corner. Text shapes use anchor-based positioning.
- When creating shapes, use the `note` field to describe purpose (invisible to user).
- Never create "unknown" type shapes.
- Note shapes are 200×200 — sticky notes only. Use geo shapes or text for more content.
- When labeling geo shapes, they must be at least 200px on any side.
- Use `background` fill (not `white`) for shapes that should match the canvas background.

## Communicating with the user
- Use the `message` action to communicate with the user.
- `think` events are not visible to the user — always include a `message` if you want to say something.

## Starting your work
- Use `think` events to work through your strategy.
- Use `update-todo-list` events to plan multi-step tasks.

## Finishing your work
- Use a `message` action to tell the user what you did.
- Review your work for overlaps, misaligned labels, and disconnected arrows."""

SCHEMA = None  # loaded lazily from file


def get_schema() -> str:
    global SCHEMA
    if SCHEMA is None:
        schema_path = os.path.join(os.path.dirname(__file__), '..', 'agent_schema.json')
        try:
            with open(schema_path) as f:
                SCHEMA = f.read()
        except FileNotFoundError:
            SCHEMA = '{}'
    return SCHEMA


def build_system_prompt() -> str:
    return f"{INTRO}\n\n{RULES}\n\n## JSON schema\n\nThis is the JSON schema for the events you can return. You must conform to this schema.\n\n{get_schema()}"


# ─── Partial JSON parser ──────────────────────────────────────────────────────

def close_partial_json(text: str) -> str | None:
    """Close unclosed brackets/braces in streaming JSON."""
    stack = []
    in_string = False
    escape_next = False

    for ch in text:
        if escape_next:
            escape_next = False
            continue
        if ch == '\\' and in_string:
            escape_next = True
            continue
        if ch == '"':
            in_string = not in_string
            continue
        if not in_string:
            if ch in '{[':
                stack.append('}' if ch == '{' else ']')
            elif ch in '}]':
                if stack and stack[-1] == ch:
                    stack.pop()

    if in_string:
        return None

    closed = text.rstrip(',').rstrip()
    for closer in reversed(stack):
        closed += closer
    return closed


def extract_actions(buffer: str) -> list:
    closed = close_partial_json(buffer)
    if not closed:
        return []
    try:
        obj = json.loads(closed)
        return obj.get('actions', []) if isinstance(obj, dict) else []
    except json.JSONDecodeError:
        return []


# ─── SSE streaming view ───────────────────────────────────────────────────────

def _stream_events(prompt_data: dict, api_key: str):
    """Generator that streams SSE events from OpenAI."""
    from openai import OpenAI

    client = OpenAI(api_key=api_key)

    # Extract parts from AgentPrompt
    messages_part = prompt_data.get('messages', {})
    screenshot_part = prompt_data.get('screenshot', {})
    blurry_shapes_part = prompt_data.get('blurryShapes', {})
    selected_shapes_part = prompt_data.get('selectedShapes', {})
    chat_history_part = prompt_data.get('chatHistory', {})
    peripheral_shapes_part = prompt_data.get('peripheralShapes', {})

    user_messages = messages_part.get('agentMessages', [])
    screenshot = screenshot_part.get('screenshot')
    blurry_shapes = blurry_shapes_part.get('shapes', [])
    selected_shape_ids = selected_shapes_part.get('shapeIds', [])
    chat_history = chat_history_part.get('history', [])
    peripheral_clusters = peripheral_shapes_part.get('clusters', [])

    # Build context string
    context_parts = []
    if blurry_shapes:
        context_parts.append(f"Shapes in viewport: {json.dumps(blurry_shapes)}")
    if peripheral_clusters:
        context_parts.append(f"Shapes outside viewport: {json.dumps(peripheral_clusters)}")
    if selected_shape_ids:
        context_parts.append(f"Selected shape IDs: {json.dumps(selected_shape_ids)}")

    context_str = '\n'.join(context_parts) if context_parts else 'Canvas is empty.'

    # Build OpenAI messages
    openai_messages = [{'role': 'system', 'content': build_system_prompt()}]

    # Add chat history
    for item in chat_history:
        if item.get('type') == 'prompt':
            for msg in item.get('agentMessages', []):
                openai_messages.append({'role': 'user', 'content': msg})
        elif item.get('type') == 'group':
            for action in item.get('actions', []):
                if action.get('_type') == 'message':
                    openai_messages.append({'role': 'assistant', 'content': action.get('text', '')})

    # Build current user message content
    user_text = '\n'.join(user_messages) if user_messages else 'Hello'
    user_content: list = [{'type': 'text', 'text': f"Canvas state:\n{context_str}\n\nUser request: {user_text}"}]

    if screenshot:
        user_content.append({
            'type': 'image_url',
            'image_url': {'url': screenshot, 'detail': 'low'},
        })

    openai_messages.append({'role': 'user', 'content': user_content})

    # Prime the assistant to output the expected JSON structure
    try:
        stream = client.chat.completions.create(
            model='gpt-4o',
            messages=openai_messages,
            max_tokens=4096,
            temperature=0,
            stream=True,
            response_format={'type': 'json_object'},
        )

        buffer = ''
        cursor = 0
        last_actions: list = []
        start_time = time.time()

        for chunk in stream:
            delta = chunk.choices[0].delta.content if chunk.choices else None
            if delta is None:
                continue

            buffer += delta
            actions = extract_actions(buffer)

            if not actions:
                continue

            # Yield any newly completed actions
            while len(actions) > cursor + 1:
                action = actions[cursor]
                elapsed = int((time.time() - start_time) * 1000)
                event = json.dumps({**action, 'complete': True, 'time': elapsed})
                yield f'data: {event}\n\n'
                cursor += 1
                start_time = time.time()

            # Yield the current (possibly incomplete) action
            current_action = actions[cursor] if cursor < len(actions) else None
            if current_action and current_action != (last_actions[cursor] if cursor < len(last_actions) else None):
                elapsed = int((time.time() - start_time) * 1000)
                event = json.dumps({**current_action, 'complete': False, 'time': elapsed})
                yield f'data: {event}\n\n'

            last_actions = list(actions)

        # Yield the final action as complete
        final_actions = extract_actions(buffer)
        if final_actions and cursor < len(final_actions):
            action = final_actions[cursor]
            elapsed = int((time.time() - start_time) * 1000)
            event = json.dumps({**action, 'complete': True, 'time': elapsed})
            yield f'data: {event}\n\n'

    except Exception as e:
        yield f'data: {json.dumps({"error": str(e)})}\n\n'


@csrf_exempt
def agent_stream(request):
    """SSE streaming endpoint for the tldraw AI agent."""
    if request.method == 'OPTIONS':
        return agent_stream_options(request)
    if request.method != 'POST':
        from django.http import JsonResponse
        return JsonResponse({'error': 'Method not allowed'}, status=405)

    # Manual JWT auth (can't use DRF decorator with StreamingHttpResponse)
    auth = JWTAuthentication()
    try:
        result = auth.authenticate(request)
        if result is None:
            from django.http import JsonResponse
            return JsonResponse({'error': 'Authentication required'}, status=401)
    except Exception:
        from django.http import JsonResponse
        return JsonResponse({'error': 'Invalid token'}, status=401)

    api_key = os.environ.get('OPENAI_API_KEY', '')
    if not api_key:
        from django.http import JsonResponse
        return JsonResponse({'error': 'OPENAI_API_KEY not configured'}, status=503)

    try:
        prompt_data = json.loads(request.body)
    except json.JSONDecodeError:
        from django.http import JsonResponse
        return JsonResponse({'error': 'Invalid JSON body'}, status=400)

    response = StreamingHttpResponse(
        _stream_events(prompt_data, api_key),
        content_type='text/event-stream',
    )
    response['Cache-Control'] = 'no-cache, no-transform'
    response['X-Accel-Buffering'] = 'no'
    response['Access-Control-Allow-Origin'] = 'http://localhost:5173'
    response['Access-Control-Allow-Headers'] = 'Content-Type, Authorization'
    return response


@csrf_exempt
def agent_stream_options(request):
    """Handle CORS preflight for the stream endpoint."""
    from django.http import HttpResponse
    response = HttpResponse()
    response['Access-Control-Allow-Origin'] = 'http://localhost:5173'
    response['Access-Control-Allow-Methods'] = 'POST, OPTIONS'
    response['Access-Control-Allow-Headers'] = 'Content-Type, Authorization'
    return response
