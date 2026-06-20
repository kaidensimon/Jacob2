"""Read a math equation/surface out of an image (e.g. a pasted screenshot) and
turn it into grapher expressions, using gpt-5.2 vision."""

import json
import os

from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from rest_framework_simplejwt.authentication import JWTAuthentication

GRAPHER_VISION_MODEL = 'gpt-5.2-2025-12-11'

GRAPHER_VISION_PROMPT = """You are reading mathematics from an image so it can be plotted in a graphing calculator. Look at the image and identify the equation, function, surface, or region to graph.

Reply with ONLY JSON: {"dimension": "2d" or "3d", "expressions": [ ... ], "message": "<short note>"}

Rules for expressions (plain math a JavaScript evaluator understands — use ^ for powers, * for multiply, and sin, cos, tan, sqrt, exp, abs, pi):
- 2D: "y = f(x)", a bare expression in x, or a point "(x, y)".
- 3D: "z = f(x,y)", a bare expression in x and y, or a point "(x, y, z)".
- For a region/solid implied by a multiple integral (e.g. a ball of radius 2 from bounds like z from -sqrt(4-x^2-y^2) to sqrt(4-x^2-y^2)), give the bounding surface(s) as z = f(x,y) — e.g. BOTH "sqrt(4 - x^2 - y^2)" and "-sqrt(4 - x^2 - y^2)".
- Do NOT output planes solved for x or y (no "x = 0", "y = 2"), and no interval bounds ("x = 0..2").
- If the image has no graphable equation/function/surface, return {"dimension": "2d", "expressions": [], "message": "I couldn't find an equation to graph in that image."}.
"""


@csrf_exempt
def grapher_read_image(request):
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

    image = data.get('image')
    if not isinstance(image, str) or not image.startswith('data:image/'):
        return _cors(JsonResponse({'error': 'No image provided'}, status=400))

    from openai import OpenAI
    client = OpenAI(api_key=api_key)

    messages = [
        {'role': 'system', 'content': GRAPHER_VISION_PROMPT},
        {'role': 'user', 'content': [
            {'type': 'text', 'text': 'Read the equation/surface to graph from this image and return the JSON.'},
            {'type': 'image_url', 'image_url': {'url': image}},
        ]},
    ]

    kwargs = {
        'model': GRAPHER_VISION_MODEL,
        'messages': messages,
        'response_format': {'type': 'json_object'},
        'max_completion_tokens': 4000,
        'reasoning_effort': 'none',
    }
    try:
        try:
            resp = client.chat.completions.create(**kwargs)
        except Exception as e:
            if 'reasoning' in str(e).lower():
                kwargs['reasoning_effort'] = 'minimal'
                resp = client.chat.completions.create(**kwargs)
            else:
                raise
        result = json.loads(resp.choices[0].message.content)
    except Exception as e:
        return _cors(JsonResponse({'error': str(e)}, status=502))

    return _cors(JsonResponse({
        'dimension': result.get('dimension') or '2d',
        'expressions': result.get('expressions') or [],
        'message': result.get('message') or '',
    }))


def _cors(response):
    response['Access-Control-Allow-Origin'] = '*'
    response['Access-Control-Allow-Methods'] = 'POST, OPTIONS'
    response['Access-Control-Allow-Headers'] = 'Content-Type, Authorization'
    return response
