import json
from channels.generic.websocket import AsyncWebsocketConsumer
from channels.db import database_sync_to_async
from django.core.serializers.json import DjangoJSONEncoder
from .models import Whiteboard


class WhiteboardConsumer(AsyncWebsocketConsumer):
    async def connect(self):
        self.room_name = self.scope['url_route']['kwargs']['room_name']
        self.room_group_name = f'whiteboard_{self.room_name}'

        print(f"=== WebSocket connect: room={self.room_name} ===")

        try:
            # Присоединяемся к комнате
            await self.channel_layer.group_add(
                self.room_group_name,
                self.channel_name
            )
            print("Group added")

            await self.accept()
            print("Connection accepted")

            #Отправляем текущее состояние доски
            whiteboard_data = await self.get_whiteboard_data()
            print(f"Whiteboard data: {whiteboard_data}")

            await self.send(text_data=json.dumps({
                'type': 'init',
                'data': whiteboard_data
            }))
            print("Init message sent")

        except Exception as e:
            print(f"!!! ERROR in connect: {e}")
            import traceback
            traceback.print_exc()
            # Если произошла ошибка, закрываем соединение
            await self.close()

    async def disconnect(self, close_code):
        # Покидаем комнату
        await self.channel_layer.group_discard(
            self.room_group_name,
            self.channel_name
        )

    async def receive(self, text_data):
        data = json.loads(text_data)
        action_type = data.get('type')

        if action_type == 'draw':
            # Если пришёл один элемент
            if 'element' in data:
                element = data['element']
                await self.add_element(element)
                # Рассылаем всем этот элемент
                await self.channel_layer.group_send(
                    self.room_group_name,
                    {
                        'type': 'drawing_message',
                        'data': {'type': 'draw', 'element': element}
                    }
                )
            # Если пришёл полный массив (для обратной совместимости)
            elif 'elements' in data:
                await self.save_drawing(data['elements'])
                await self.channel_layer.group_send(
                    self.room_group_name,
                    {
                        'type': 'drawing_message',
                        'data': {'type': 'draw', 'elements': data['elements']}
                    }
                )

        elif action_type == 'clear':
            await self.clear_whiteboard()

            await self.channel_layer.group_send(
                self.room_group_name,
                {
                    'type': 'clear_message',
                }
            )
        elif action_type == 'delete':
            element_id = data.get('elementId')
            await self.delete_element(element_id)
            await self.channel_layer.group_send(
                self.room_group_name,
                {'type': 'delete_message', 'elementId': element_id}
            )
        elif action_type == 'update':
            element = data.get('element')
            await self.update_element(element)
            await self.channel_layer.group_send(
                self.room_group_name,
                {'type': 'update_message', 'element': element}
            )

    async def drawing_message(self, event):
        # Пересылаем данные клиенту
        await self.send(text_data=json.dumps(event['data']))

    async def clear_message(self, event):
        await self.send(text_data=json.dumps({
            'type': 'clear'
        }))

    @database_sync_to_async
    def update_element(self, element):
        try:
            whiteboard = Whiteboard.objects.get(id=self.room_name)
            data = whiteboard.get_board_data()
            new_data = [el if el.get('id') != element['id'] else element for el in data]
            whiteboard.set_board_data(new_data)
            whiteboard.save()
        except Whiteboard.DoesNotExist:
            pass

    async def update_message(self, event):
        await self.send(text_data=json.dumps({
            'type': 'update',
            'element': event['element']
        }))

    @database_sync_to_async
    def delete_element(self, element_id):
        try:
            whiteboard = Whiteboard.objects.get(id=self.room_name)
            data = whiteboard.get_board_data()
            new_data = [el for el in data if el.get('id') != element_id]
            whiteboard.set_board_data(new_data)
            whiteboard.save()
        except Whiteboard.DoesNotExist:
            pass

    async def delete_message(self, event):
        await self.send(text_data=json.dumps({
            'type': 'delete',
            'elementId': event['elementId']
        }))

    @database_sync_to_async
    def get_whiteboard_data(self):
        try:
            whiteboard = Whiteboard.objects.get(id=self.room_name)
            return whiteboard.get_board_data()
        except Whiteboard.DoesNotExist:
            return []

    @database_sync_to_async
    def save_drawing(self, elements):
        whiteboard, created = Whiteboard.objects.get_or_create(
            id=self.room_name,
            defaults={'name': f'Доска {self.room_name}'}
        )
        whiteboard.set_board_data(elements)
        whiteboard.save()

    @database_sync_to_async
    def add_element(self, element):
        """
        Добавляет один элемент в массив board_data существующей доски.
        Если доски нет, создаёт её с пустым массивом и добавляет элемент.
        """
        whiteboard, created = Whiteboard.objects.get_or_create(
            id=self.room_name,
            defaults={'name': f'Доска {self.room_name}'}
        )
        data = whiteboard.get_board_data()  # получаем текущий список
        data.append(element)  # добавляем элемент
        whiteboard.set_board_data(data)  # сохраняем обновлённый список
        whiteboard.save()

    @database_sync_to_async
    def clear_whiteboard(self):
        try:
            whiteboard = Whiteboard.objects.get(id=self.room_name)
            whiteboard.set_board_data([])
            whiteboard.save()
        except Whiteboard.DoesNotExist:
            pass
