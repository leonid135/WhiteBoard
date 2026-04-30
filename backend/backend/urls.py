from django.contrib import admin
from django.urls import path, include
from rest_framework.routers import DefaultRouter

# Правильный импорт
from whiteboard import views  #

router = DefaultRouter()
router.register(r'whiteboards', views.WhiteboardViewSet)
router.register(r'sessions', views.WhiteboardSessionViewSet)

urlpatterns = [
    path('admin/', admin.site.urls),
    path('api/', include(router.urls)),
]
