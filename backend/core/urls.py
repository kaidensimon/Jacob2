from django.conf import settings
from django.conf.urls.static import static
from django.contrib import admin
from django.urls import path, include
from rest_framework_simplejwt.views import TokenRefreshView
from accounts.agent_views import agent_stream, agent_stream_options
from accounts.excalidraw_agent import excalidraw_stream
from accounts.orchestrator import orchestrate
from accounts.manim_agent import manim_generate, manim_save, manim_list
from accounts.whiteboard_store import (
    whiteboard_save,
    whiteboard_list,
    whiteboard_get,
    whiteboard_delete,
)
from accounts.grapher_vision import grapher_read_image

urlpatterns = [
    path('admin/', admin.site.urls),
    path('api/auth/', include('accounts.urls')),
    path('api/auth/token/refresh/', TokenRefreshView.as_view(), name='token_refresh'),
    path('api/agent/stream/', agent_stream, name='agent_stream'),
    path('api/agent/stream', agent_stream_options, name='agent_stream_options'),
    path('api/excalidraw/stream/', excalidraw_stream, name='excalidraw_stream'),
    path('api/orchestrator/', orchestrate, name='orchestrate'),
    path('api/manim/generate/', manim_generate, name='manim_generate'),
    path('api/manim/save/', manim_save, name='manim_save'),
    path('api/manim/list/', manim_list, name='manim_list'),
    path('api/whiteboards/save/', whiteboard_save, name='whiteboard_save'),
    path('api/whiteboards/list/', whiteboard_list, name='whiteboard_list'),
    path('api/whiteboards/<int:session_id>/', whiteboard_get, name='whiteboard_get'),
    path('api/whiteboards/<int:session_id>/delete/', whiteboard_delete, name='whiteboard_delete'),
    path('api/grapher/read-image/', grapher_read_image, name='grapher_read_image'),
] + static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)
