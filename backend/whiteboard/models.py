from django.db import models
import uuid
import json


class Whiteboard(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=200, default="Новая доска")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    board_data = models.TextField(default='[]')  # JSON данные доски
    background_color = models.CharField(max_length=7, default='#FFFFFF')

    def get_board_data(self):
        try:
            return json.loads(self.board_data)
        except:
            return []

    def set_board_data(self, data):
        self.board_data = json.dumps(data)

    def __str__(self):
        return f"{self.name} ({self.id})"


class WhiteboardSession(models.Model):
    whiteboard = models.ForeignKey(Whiteboard, on_delete=models.CASCADE, related_name='sessions')
    session_id = models.CharField(max_length=100, unique=True)
    created_at = models.DateTimeField(auto_now_add=True)
    is_active = models.BooleanField(default=True)

    class Meta:
        unique_together = ['whiteboard', 'session_id']