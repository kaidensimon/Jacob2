from django.urls import re_path

from .consumers import LessonConsumer

websocket_urlpatterns = [
    re_path(r'^ws/lesson/$', LessonConsumer.as_asgi()),
]
