from django.contrib import admin
from django.urls import path, include
from rest_framework_simplejwt.views import TokenRefreshView
from accounts.agent_views import agent_stream, agent_stream_options

urlpatterns = [
    path('admin/', admin.site.urls),
    path('api/auth/', include('accounts.urls')),
    path('api/auth/token/refresh/', TokenRefreshView.as_view(), name='token_refresh'),
    path('api/agent/stream/', agent_stream, name='agent_stream'),
    path('api/agent/stream', agent_stream_options, name='agent_stream_options'),
]
