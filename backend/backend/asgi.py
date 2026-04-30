import os
from django.core.asgi import get_asgi_application

# Устанавливаем настройки ДО вызова get_asgi_application
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'backend.settings')

# Инициализируем Django ASGI приложение (это загружает приложения)
django_asgi_app = get_asgi_application()

# Теперь можно безопасно импортировать модули, использующие модели Django
from channels.routing import ProtocolTypeRouter, URLRouter
from channels.auth import AuthMiddlewareStack
import whiteboard.routing

application = ProtocolTypeRouter({
    "http": django_asgi_app,
    "websocket": AuthMiddlewareStack(
        URLRouter(
            whiteboard.routing.websocket_urlpatterns
        )
    ),
})