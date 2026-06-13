import json
import os
import time
import uuid

from django.http import StreamingHttpResponse
from django.views.decorators.csrf import csrf_exempt
from rest_framework_simplejwt.authentication import JWTAuthentication

# ─── System prompt ────────────────────────────────────────────────────────────
# Generated from the tldraw agent template's own buildSystemPrompt() for the
# 'working' mode (see tldraw-agent/generate-system-prompt.ts). Do not hand-edit;
# regenerate with: cd tldraw-agent && npx tsx generate-system-prompt.ts

_SYSTEM_PROMPT = None


def get_system_prompt() -> str:
    global _SYSTEM_PROMPT
    if _SYSTEM_PROMPT is None:
        path = os.path.join(os.path.dirname(__file__), '..', 'system_prompt.txt')
        with open(path, encoding='utf-8') as f:
            _SYSTEM_PROMPT = f.read()
    return _SYSTEM_PROMPT


# ─── Prompt parts → model messages ───────────────────────────────────────────
# Mirrors shared/schema/PromptPartDefinitions.ts and worker/prompt/buildMessages.ts

PART_PRIORITIES = {
    'chatHistory': float('-inf'),
    'time': -100,
    'userViewportBounds': -80,
    'agentViewportBounds': -80,
    'blurryShapes': -70,
    'peripheralShapes': -65,
    'contextItems': -55,
    'selectedShapes': -55,
    'canvasLints': -50,
    'screenshot': -40,
    'userActionHistory': -40,
    'todoList': 10,
    'data': 200,
    'messages': float('inf'),
}


def build_part_content(ptype: str, part: dict) -> list:
    """Returns a list of content strings for a prompt part."""
    if ptype == 'blurryShapes':
        shapes = part.get('shapes', [])
        if not shapes:
            return ['There are no shapes in your view at the moment.']
        return ['These are the shapes you can currently see:', json.dumps(shapes)]

    if ptype == 'peripheralShapes':
        clusters = part.get('clusters', [])
        if not clusters:
            return []
        return [
            "There are some groups of shapes in your peripheral vision, outside the your main view. "
            "You can't make out their details or content. If you want to see their content, you need "
            "to get closer. The groups are as follows",
            json.dumps(clusters),
        ]

    if ptype == 'selectedShapes':
        shape_ids = part.get('shapeIds', [])
        if not shape_ids:
            return []
        if len(shape_ids) == 1:
            return [f'The user has this shape selected: {shape_ids[0]}']
        return [f"The user has these shapes selected: {', '.join(shape_ids)}"]

    if ptype == 'screenshot':
        screenshot = part.get('screenshot', '')
        if not screenshot:
            return []
        return [
            'Here is the part of the canvas that you can currently see at this moment. It is not a reference image.',
            screenshot,
        ]

    if ptype == 'userViewportBounds':
        bounds = part.get('userBounds')
        if not bounds:
            return []
        cx = bounds.get('x', 0) + bounds.get('w', 0) / 2
        cy = bounds.get('y', 0) + bounds.get('h', 0) / 2
        return [f"The user's view is centered at ({cx}, {cy})."]

    if ptype == 'agentViewportBounds':
        bounds = part.get('agentBounds')
        if not bounds:
            return []
        return [f'The bounds of the part of the canvas that you can currently see are: {json.dumps(bounds)}']

    if ptype == 'time':
        return [f"The user's current time is: {part.get('time', '')}"]

    if ptype == 'todoList':
        items = part.get('items', [])
        if not items:
            return ['You have no todos yet.']
        return ['Here is your current todo list:', json.dumps(items)]

    if ptype == 'data':
        data = part.get('data', [])
        if not data:
            return []
        return ["Here's the data you requested:"] + [json.dumps(item) for item in data]

    if ptype == 'messages':
        return part.get('agentMessages', [])

    if ptype == 'userActionHistory':
        if not (part.get('added') or part.get('removed') or part.get('updated')):
            return []
        return [
            'Since the previous request, the user has made the following changes to the canvas:',
            json.dumps(part),
        ]

    if ptype == 'canvasLints':
        lints = part.get('lints', [])
        if not lints:
            return []
        messages = [
            "[LINTER]: The following potential visual problems have been detected in the canvas. "
            "You should decide if you want to address them. Defer to your view of the canvas to decide "
            "if you need to make changes; it's very possible that you don't need to make any changes."
        ]
        grow_y = [l for l in lints if l.get('type') == 'growY-on-shape']
        overlapping = [l for l in lints if l.get('type') == 'overlapping-text']
        friendless = [l for l in lints if l.get('type') == 'friendless-arrow']
        if grow_y:
            ids = [i for l in grow_y for i in l.get('shapeIds', [])]
            messages.append('\n'.join(
                ['Text overflow: These shapes have text that caused their containers to grow past the '
                 'size that they were intended to be, potentially breaking out of their container. If you '
                 'decide to fix: you need to set the height back to what you originally intended after '
                 'increasing the width.'] + [f'  - {i}' for i in ids]))
        if overlapping:
            messages.append('\n'.join(
                ['Overlapping text: The shapes in each group have text and overlap each other, which may '
                 'make text hard to read. If you decide to fix this, you may need to increase the size of '
                 'any shapes containing the text.'] + [f"  - {', '.join(l.get('shapeIds', []))}" for l in overlapping]))
        if friendless:
            ids = [i for l in friendless for i in l.get('shapeIds', [])]
            messages.append('\n'.join(
                ["Unconnected arrows: These arrows aren't fully connected to other shapes."]
                + [f'  - {i}' for i in ids]))
        return messages

    if ptype == 'contextItems':
        items = part.get('items', [])
        request_source = part.get('requestSource', 'user')
        messages = []
        shape_items = [i for i in items if i.get('type') == 'shape']
        shapes_items = [i for i in items if i.get('type') == 'shapes']
        area_items = [i for i in items if i.get('type') == 'area']
        point_items = [i for i in items if i.get('type') == 'point']
        if area_items:
            messages.append(
                'You have decided to focus your view on the following area. Make sure to focus your task here.'
                if request_source == 'self' else
                'The user has specifically brought your attention to the following areas in this request. '
                'The user might refer to them as the "area(s)" or perhaps "here" or "there", but either way, '
                "it's implied that you should focus on these areas in both your reasoning and actions. "
                'Make sure to focus your task on these areas:')
            messages.extend(json.dumps(i.get('bounds')) for i in area_items)
        if point_items:
            messages.append(
                'The user has specifically brought your attention to the following points in this request. '
                'The user might refer to them as the "point(s)" or perhaps "here" or "there", but either way, '
                "it's implied that you should focus on these points in both your reasoning and actions. "
                'Make sure to focus your task on these points:')
            messages.extend(json.dumps(i.get('point')) for i in point_items)
        if shape_items:
            messages.append(
                f'The user has specifically brought your attention to these {len(shape_items)} shapes '
                'individually in this request. Make sure to focus your task on these shapes where applicable:')
            messages.extend(json.dumps(i.get('shape')) for i in shape_items)
        for item in shapes_items:
            shapes = item.get('shapes', [])
            if shapes:
                messages.append(
                    f'The user has specifically brought your attention to the following group of {len(shapes)} '
                    'shapes in this request. Make sure to focus your task on these shapes where applicable:')
                messages.append('\n'.join(json.dumps(s) for s in shapes))
        return messages

    # mode, debug, modelName: metadata only, no content
    return []


def build_history_messages(part: dict) -> list:
    """Returns a list of (role, [text, ...]) for chat history items.
    Mirrors ChatHistoryPartDefinition.buildMessages."""
    history = part.get('history', [])
    if not history:
        return []

    # If the last item is a prompt (the current request), skip it
    end = len(history)
    if end > 0 and history[-1].get('type') == 'prompt':
        end -= 1

    messages = []
    for item in history[:end]:
        itype = item.get('type')
        if itype == 'prompt':
            texts = []
            agent_facing = (item.get('agentFacingMessage') or '').strip()
            if agent_facing:
                texts.append(item.get('agentFacingMessage'))
            for ctx in item.get('contextItems', []):
                ctype = ctx.get('type')
                if ctype == 'shape':
                    texts.append(f"[CONTEXT]: {json.dumps(ctx.get('shape'))}")
                elif ctype == 'shapes':
                    texts.append(f"[CONTEXT]: {json.dumps(ctx.get('shapes'))}")
                else:
                    texts.append(f'[CONTEXT]: {json.dumps(ctx)}')
            if not texts:
                continue
            role = 'user' if item.get('promptSource') in ('user', 'other-agent') else 'assistant'
            messages.append((role, texts))
        elif itype == 'continuation':
            data = item.get('data', [])
            if not data:
                continue
            messages.append(('assistant', [f'[DATA RETRIEVED]: {json.dumps(data)}']))
        elif itype == 'action':
            action = item.get('action') or {}
            atype = action.get('_type')
            if atype == 'message':
                text = action.get('text') or '<message data lost>'
            elif atype == 'think':
                text = '[THOUGHT]: ' + (action.get('text') or '<thought data lost>')
            else:
                raw = {k: v for k, v in action.items() if k not in ('complete', 'time')}
                text = '[ACTION]: ' + json.dumps(raw)
            messages.append(('assistant', [text]))
    return messages


def build_model_messages(prompt_data: dict) -> list:
    """Convert an AgentPrompt into OpenAI chat messages, ordered by part priority."""
    entries = []  # (priority, seq, role, content_items)
    seq = 0

    for key, part in prompt_data.items():
        if not isinstance(part, dict):
            continue
        ptype = part.get('type', key)

        if ptype == 'chatHistory':
            for role, texts in build_history_messages(part):
                content = [{'type': 'text', 'text': t} for t in texts]
                entries.append((PART_PRIORITIES['chatHistory'], seq, role, content))
                seq += 1
            continue

        texts = build_part_content(ptype, part)
        if not texts:
            continue
        content = []
        for t in texts:
            if isinstance(t, str) and t.startswith('data:image/'):
                content.append({'type': 'image_url', 'image_url': {'url': t}})
            else:
                content.append({'type': 'text', 'text': t})
        entries.append((PART_PRIORITIES.get(ptype, 0), seq, 'user', content))
        seq += 1

    entries.sort(key=lambda e: (e[0], e[1]))

    messages = []
    for _, _, role, content in entries:
        if role == 'assistant':
            text = '\n'.join(c['text'] for c in content if c['type'] == 'text')
            messages.append({'role': 'assistant', 'content': text})
        else:
            messages.append({'role': 'user', 'content': content})

    if not any(m['role'] == 'user' for m in messages):
        messages.append({'role': 'user', 'content': [{'type': 'text', 'text': 'Hello'}]})

    return messages


# ─── Action validation ────────────────────────────────────────────────────────

# Shape types the client's converter supports (convertFocusedShapeToTldrawShape).
# An unsupported type crashes the client renderer, so drop those actions here.
VALID_SHAPE_TYPES = {
    'rectangle', 'ellipse', 'triangle', 'diamond', 'hexagon', 'pill', 'cloud',
    'x-box', 'check-box', 'heart', 'pentagon', 'octagon', 'star',
    'parallelogram-right', 'parallelogram-left', 'trapezoid',
    'fat-arrow-right', 'fat-arrow-left', 'fat-arrow-up', 'fat-arrow-down',
    'text', 'line', 'arrow', 'note', 'draw', 'unknown',
}


def is_action_safe(action: dict) -> bool:
    if action.get('_type') in ('create', 'update'):
        shape = action.get('shape')
        if isinstance(shape, dict) and '_type' in shape:
            return shape['_type'] in VALID_SHAPE_TYPES
    return True


def ensure_shape_ids(actions: list, request_id: str) -> None:
    """The model sometimes omits shapeId on created shapes; without one, every
    shape collides on the same fallback id client-side. Inject a deterministic
    id per action index so re-parses of the stream stay stable."""
    for i, action in enumerate(actions):
        if action.get('_type') == 'create':
            shape = action.get('shape')
            if isinstance(shape, dict) and not shape.get('shapeId'):
                shape['shapeId'] = f'gen-{request_id}-{i}'


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

# Models the client's dropdown can request (shared/models.ts). Anything else
# falls back to the default.
SUPPORTED_MODELS = {'gpt-5.2-2025-12-11', 'gpt-5-mini', 'gpt-4o'}
DEFAULT_MODEL = 'gpt-5.2-2025-12-11'


def get_model_name(prompt_data: dict) -> str:
    part = prompt_data.get('modelName')
    if isinstance(part, dict):
        name = part.get('modelName')
        if name in SUPPORTED_MODELS:
            return name
    return DEFAULT_MODEL


def build_completion_kwargs(model: str, messages: list) -> dict:
    kwargs = {
        'model': model,
        'messages': messages,
        'stream': True,
        'response_format': {'type': 'json_object'},
    }
    if model.startswith('gpt-5') or model.startswith('o'):
        # Reasoning models: no temperature control, and we keep built-in
        # reasoning minimal — the agent thinks out loud via 'think' actions
        # instead (same choice as the template's worker).
        kwargs['max_completion_tokens'] = 8192
        kwargs['reasoning_effort'] = 'none'
    else:
        kwargs['max_tokens'] = 8192
        kwargs['temperature'] = 0
    return kwargs


def _stream_events(prompt_data: dict, api_key: str):
    """Generator that streams SSE events from OpenAI."""
    from openai import OpenAI

    client = OpenAI(api_key=api_key)

    openai_messages = [{'role': 'system', 'content': get_system_prompt()}]
    openai_messages.extend(build_model_messages(prompt_data))

    try:
        kwargs = build_completion_kwargs(get_model_name(prompt_data), openai_messages)
        try:
            stream = client.chat.completions.create(**kwargs)
        except Exception as e:
            # Some models reject 'none' reasoning effort; retry with 'minimal'
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

            # Yield any newly completed actions
            while len(actions) > cursor + 1:
                action = actions[cursor]
                if is_action_safe(action):
                    elapsed = int((time.time() - start_time) * 1000)
                    event = json.dumps({**action, 'complete': True, 'time': elapsed})
                    yield f'data: {event}\n\n'
                cursor += 1
                start_time = time.time()

            # Yield the current (possibly incomplete) action
            current_action = actions[cursor] if cursor < len(actions) else None
            if current_action and is_action_safe(current_action) and current_action != (last_actions[cursor] if cursor < len(last_actions) else None):
                elapsed = int((time.time() - start_time) * 1000)
                event = json.dumps({**current_action, 'complete': False, 'time': elapsed})
                yield f'data: {event}\n\n'

            last_actions = list(actions)

        # Yield the final action as complete
        final_actions = extract_actions(buffer)
        ensure_shape_ids(final_actions, request_id)
        if final_actions and cursor < len(final_actions):
            action = final_actions[cursor]
            if is_action_safe(action):
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
