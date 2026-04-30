from rest_framework import serializers
from .models import Whiteboard, WhiteboardSession


class WhiteboardSerializer(serializers.ModelSerializer):
    class Meta:
        model = Whiteboard
        fields = ['id', 'name', 'created_at', 'updated_at', 'board_data', 'background_color']


class WhiteboardSessionSerializer(serializers.ModelSerializer):
    whiteboard_data = WhiteboardSerializer(source='whiteboard', read_only=True)

    class Meta:
        model = WhiteboardSession
        fields = ['id', 'whiteboard', 'session_id', 'created_at', 'is_active', 'whiteboard_data']