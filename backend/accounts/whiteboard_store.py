"""Save / list / load whiteboard sessions for the logged-in user."""

import base64
import json
from uuid import uuid4

from django.conf import settings
from django.core.files.base import ContentFile
from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from rest_framework_simplejwt.authentication import JWTAuthentication

from .models import WhiteboardSession


def _auth(request):
    """Return the user or None."""
    auth = JWTAuthentication()
    try:
        result = auth.authenticate(request)
        if result is None:
            return None
        return result[0]
    except Exception:
        return None


def _decode_thumbnail(data_url):
    """Turn a 'data:image/png;base64,...' string into a Django file, or None."""
    if not isinstance(data_url, str) or ',' not in data_url:
        return None
    try:
        header, b64 = data_url.split(',', 1)
        if 'image' not in header:
            return None
        # upload_to on the model already adds the 'whiteboards/' prefix.
        return ContentFile(base64.b64decode(b64), name=f'{uuid4().hex}.png')
    except Exception:
        return None


@csrf_exempt
def whiteboard_save(request):
    """Create or update a whiteboard session.

    Body: {id?, title, scene: {elements, appState, files}, thumbnail?: dataURL}
    """
    if request.method == 'OPTIONS':
        return _cors(JsonResponse({}))
    if request.method != 'POST':
        return _cors(JsonResponse({'error': 'Method not allowed'}, status=405))

    user = _auth(request)
    if user is None:
        return _cors(JsonResponse({'error': 'Authentication required'}, status=401))

    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return _cors(JsonResponse({'error': 'Invalid JSON body'}, status=400))

    title = (data.get('title') or 'Untitled whiteboard').strip()[:255]
    scene = data.get('scene')
    if scene is None:
        return _cors(JsonResponse({'error': 'No scene provided'}, status=400))
    scene_json = json.dumps(scene)

    session = None
    if data.get('id'):
        session = WhiteboardSession.objects.filter(user=user, id=data['id']).first()

    if session is None:
        session = WhiteboardSession(user=user)

    session.title = title
    session.scene = scene_json

    thumb = _decode_thumbnail(data.get('thumbnail'))
    if thumb is not None:
        # Replace any previous thumbnail file.
        if session.pk and session.thumbnail:
            session.thumbnail.delete(save=False)
        session.thumbnail.save(thumb.name, thumb, save=False)

    session.save()

    return _cors(JsonResponse({
        'id': session.id,
        'title': session.title,
        'updated_at': session.updated_at.isoformat(),
    }))


def whiteboard_list(request):
    """List the user's saved whiteboards (no full scene — just metadata)."""
    user = _auth(request)
    if user is None:
        return _cors(JsonResponse({'error': 'Authentication required'}, status=401))

    sessions = WhiteboardSession.objects.filter(user=user)
    return _cors(JsonResponse({
        'whiteboards': [
            {
                'id': s.id,
                'title': s.title,
                'thumbnailUrl': request.build_absolute_uri(s.thumbnail.url) if s.thumbnail else None,
                'updated_at': s.updated_at.isoformat(),
            }
            for s in sessions
        ]
    }))


def whiteboard_get(request, session_id):
    """Return one whiteboard's full scene so the client can load it."""
    user = _auth(request)
    if user is None:
        return _cors(JsonResponse({'error': 'Authentication required'}, status=401))

    session = WhiteboardSession.objects.filter(user=user, id=session_id).first()
    if session is None:
        return _cors(JsonResponse({'error': 'Whiteboard not found'}, status=404))

    try:
        scene = json.loads(session.scene)
    except json.JSONDecodeError:
        scene = {'elements': [], 'appState': {}}

    return _cors(JsonResponse({'id': session.id, 'title': session.title, 'scene': scene}))


@csrf_exempt
def whiteboard_delete(request, session_id):
    if request.method == 'OPTIONS':
        return _cors(JsonResponse({}))
    user = _auth(request)
    if user is None:
        return _cors(JsonResponse({'error': 'Authentication required'}, status=401))
    session = WhiteboardSession.objects.filter(user=user, id=session_id).first()
    if session is None:
        return _cors(JsonResponse({'error': 'Whiteboard not found'}, status=404))
    if session.thumbnail:
        session.thumbnail.delete(save=False)
    session.delete()
    return _cors(JsonResponse({'ok': True}))


def _cors(response):
    response['Access-Control-Allow-Origin'] = '*'
    response['Access-Control-Allow-Methods'] = 'POST, GET, DELETE, OPTIONS'
    response['Access-Control-Allow-Headers'] = 'Content-Type, Authorization'
    return response
