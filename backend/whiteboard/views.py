import uuid

from rest_framework import viewsets, status

from django.shortcuts import get_object_or_404

from PIL import Image

from django.http import HttpResponse
from .models import Whiteboard, WhiteboardSession
from .serializers import WhiteboardSerializer, WhiteboardSessionSerializer
from reportlab.pdfgen import canvas

from reportlab.lib.colors import Color, black, red, green, blue, yellow, magenta, cyan, white
import math

import base64
import pytesseract
import requests


# Инициализируем reader один раз вне метода (глобально в файле)

from io import BytesIO
from rest_framework.decorators import action
from rest_framework.response import Response

import google.generativeai as genai
from django.conf import settings
from groq import Groq

# Вспомогательная функция для преобразования hex цвета в reportlab Color
def hex_to_reportlab_color(hex_color):
    hex_color = hex_color.lstrip('#')
    if len(hex_color) == 6:
        r, g, b = int(hex_color[0:2], 16), int(hex_color[2:4], 16), int(hex_color[4:6], 16)
        return Color(r / 255.0, g / 255.0, b / 255.0)
    return black


class WhiteboardViewSet(viewsets.ModelViewSet):
    queryset = Whiteboard.objects.all()
    serializer_class = WhiteboardSerializer

    @action(detail=True, methods=['post'])
    def convert_to_latex(self, request, pk=None):
        whiteboard = self.get_object()
        elements = whiteboard.get_board_data()

        # Функция для семплирования точек (оставляем каждую n-ю)
        def sample_points(points, max_points=150):
            if len(points) <= max_points:
                return points
            step = len(points) // max_points
            return [points[i] for i in range(0, len(points), step)]

        description_lines = []
        for idx, el in enumerate(elements):
            typ = el.get('type')
            color = el.get('color', 'black')
            thickness = el.get('thickness', 1)
            fill = el.get('fillColor', None)

            if typ == 'text':
                x, y = el.get('x', 0), el.get('y', 0)
                text = el.get('text', '')
                description_lines.append(
                    f"Text {idx}: '{text}' at ({x},{y}), color={color}, font size={el.get('fontSize', 16)}"
                )
            elif typ == 'rectangle':
                x, y = el.get('x', 0), el.get('y', 0)
                w, h = el.get('width', 0), el.get('height', 0)
                line = f"Rectangle {idx}: top-left ({x},{y}), width={w}, height={h}, stroke={color}, thickness={thickness}"
                if fill:
                    line += f", fill={fill}"
                description_lines.append(line)
            elif typ == 'circle':
                cx, cy = el.get('cx', 0), el.get('cy', 0)
                rx, ry = el.get('rx', 0), el.get('ry', 0)
                line = f"Ellipse {idx}: center ({cx},{cy}), rx={rx}, ry={ry}, stroke={color}, thickness={thickness}"
                if fill:
                    line += f", fill={fill}"
                description_lines.append(line)
            elif typ == 'line':
                x1, y1 = el.get('x1', 0), el.get('y1', 0)
                x2, y2 = el.get('x2', 0), el.get('y2', 0)
                description_lines.append(
                    f"Line {idx}: ({x1},{y1}) to ({x2},{y2}), stroke={color}, thickness={thickness}")
            elif typ == 'arrow':
                x1, y1 = el.get('x1', 0), el.get('y1', 0)
                x2, y2 = el.get('x2', 0), el.get('y2', 0)
                description_lines.append(
                    f"Arrow {idx}: ({x1},{y1}) to ({x2},{y2}), stroke={color}, thickness={thickness}")
            elif typ == 'triangle':
                x1, y1 = el.get('x1', 0), el.get('y1', 0)
                x2, y2 = el.get('x2', 0), el.get('y2', 0)
                # треугольник: (x1,y1), (x2,y1), (x1,y2)
                line = f"Triangle {idx}: vertices ({x1},{y1}), ({x2},{y1}), ({x1},{y2}), stroke={color}, thickness={thickness}"
                if fill:
                    line += f", fill={fill}"
                description_lines.append(line)
            elif typ == 'pencil':
                points = el.get('points', [])
                if points:
                    # Семплируем точки, чтобы не перегружать LLM
                    sampled = sample_points(points, max_points=200)
                    # Превращаем в строку: "x1 y1, x2 y2, ..."
                    coords = ','.join(f"{int(p['x'])} {int(p['y'])}" for p in sampled)
                    description_lines.append(
                        f"Pencil drawing {idx}: path of {len(points)} points (sampled to {len(sampled)}): {coords}, "
                        f"stroke={color}, thickness={thickness}"
                    )

        if not description_lines:
            description = "The board is empty."
        else:
            description = "The board contains the following objects:\n" + "\n".join(description_lines)

        prompt = f"""You are an expert in LaTeX and TikZ. Generate a complete LaTeX document that accurately reproduces the whiteboard described below.

    {description}

    Requirements:
    - Use \\documentclass{{article}} and include the tikz package.
    - Place all drawings inside a single tikzpicture environment.
    - Use absolute coordinates (x,y) in points (pt), with the canvas ranging from (0,0) to (800,600).
    - For lines, use \\draw or \\draw[->] for arrows. For filled shapes, use \\filldraw.
    - For the pencil drawings, connect the given points in order using a \\draw command with line join=round.
    - Preserve colors and line thicknesses.
    - Output ONLY the LaTeX code, starting with \\documentclass. Do not add any extra text.

    Example format:
    \\documentclass{{article}}
    \\usepackage{{tikz}}
    \\begin{{document}}
    \\begin{{tikzpicture}}[x=1pt,y=1pt,yscale=-1]
      % your commands here
    \\end{{tikzpicture}}
    \\end{{document}}"""

        try:
            client = Groq(api_key=settings.GROQ_API_KEY)
            response = client.chat.completions.create(
                model="llama-3.3-70b-versatile",
                messages=[{"role": "user", "content": prompt}],
                temperature=0.2,
                max_tokens=4096  # чтобы поместился длинный путь
            )
            latex_code = response.choices[0].message.content
            return Response({'latex': latex_code})
        except Exception as e:
            return Response({'error': f'Groq API error: {e}'}, status=500)

    @action(detail=True, methods=['get'])
    def export_pdf(self, request, pk=None):
        whiteboard = self.get_object()
        board_data = whiteboard.get_board_data()

        if not board_data:
            # Пустая доска
            buffer = BytesIO()
            pdf = canvas.Canvas(buffer, pagesize=(800, 600))
            pdf.setTitle(f"Whiteboard {whiteboard.name}")
            pdf.drawString(100, 300, "Пустая доска")
            pdf.save()
            buffer.seek(0)
            response = HttpResponse(buffer.getvalue(), content_type='application/pdf')
            response['Content-Disposition'] = f'attachment; filename="{whiteboard.name}.pdf"'
            return response

        # 1. Находим bounding box всех элементов
        min_x = float('inf')
        min_y = float('inf')
        max_x = float('-inf')
        max_y = float('-inf')

        for el in board_data:
            typ = el['type']
            if typ == 'pencil':
                for point in el.get('points', []):
                    x, y = point['x'], point['y']
                    min_x = min(min_x, x)
                    min_y = min(min_y, y)
                    max_x = max(max_x, x)
                    max_y = max(max_y, y)
            elif typ in ('line', 'arrow', 'triangle'):
                x1, y1 = el.get('x1', 0), el.get('y1', 0)
                x2, y2 = el.get('x2', 0), el.get('y2', 0)
                min_x = min(min_x, x1, x2)
                min_y = min(min_y, y1, y2)
                max_x = max(max_x, x1, x2)
                max_y = max(max_y, y1, y2)
            elif typ == 'rectangle':
                x, y = el.get('x', 0), el.get('y', 0)
                w, h = el.get('width', 0), el.get('height', 0)
                min_x = min(min_x, x, x + w)
                min_y = min(min_y, y, y + h)
                max_x = max(max_x, x, x + w)
                max_y = max(max_y, y, y + h)
            elif typ == 'circle':
                cx, cy = el.get('cx', 0), el.get('cy', 0)
                rx, ry = el.get('rx', 0), el.get('ry', 0)
                min_x = min(min_x, cx - rx, cx + rx)
                min_y = min(min_y, cy - ry, cy + ry)
                max_x = max(max_x, cx - rx, cx + rx)
                max_y = max(max_y, cy - ry, cy + ry)
            elif typ == 'text':
                x, y = el.get('x', 0), el.get('y', 0)
                min_x = min(min_x, x)
                min_y = min(min_y, y - 20)  # примерный учёт высоты текста
                max_x = max(max_x, x + len(el.get('text', '')) * 8)
                max_y = max(max_y, y)

        # Добавляем отступы
        padding = 50
        width = max_x - min_x + 2 * padding
        height = max_y - min_y + 2 * padding
        width = max(width, 200)  # минимальная ширина
        height = max(height, 200)  # минимальная высота

        buffer = BytesIO()
        pdf = canvas.Canvas(buffer, pagesize=(width, height))
        pdf.setTitle(f"Whiteboard {whiteboard.name}")

        # Функция преобразования координат (перенос и масштабирование)
        def transform(x, y):
            # Сдвиг: теперь (min_x, min_y) станет (padding, height - padding)
            new_x = x - min_x + padding
            new_y = height - (y - min_y + padding)  # инвертируем Y
            return new_x, new_y

        # Вспомогательная функция цвета (оставляем как есть)
        def hex_to_reportlab_color(hex_color):
            hex_color = hex_color.lstrip('#')
            if len(hex_color) == 6:
                r = int(hex_color[0:2], 16)
                g = int(hex_color[2:4], 16)
                b = int(hex_color[4:6], 16)
                return Color(r / 255.0, g / 255.0, b / 255.0)
            return black

        # Функция отрисовки одного элемента
        def draw_element(el):
            color = hex_to_reportlab_color(el.get('color', '#000000'))
            pdf.setStrokeColor(color)
            pdf.setFillColor(color)
            thickness = el.get('thickness', 3)
            pdf.setLineWidth(thickness)

            fill_color = None
            if 'fillColor' in el and el['fillColor']:
                fill_color = hex_to_reportlab_color(el['fillColor'])

            typ = el['type']

            if typ == 'pencil':
                points = el.get('points', [])
                if len(points) > 1:
                    for i in range(1, len(points)):
                        x1, y1 = transform(points[i - 1]['x'], points[i - 1]['y'])
                        x2, y2 = transform(points[i]['x'], points[i]['y'])
                        pdf.line(x1, y1, x2, y2)

            elif typ == 'line':
                x1, y1 = transform(el['x1'], el['y1'])
                x2, y2 = transform(el['x2'], el['y2'])
                pdf.line(x1, y1, x2, y2)

            elif typ == 'arrow':
                x1, y1 = transform(el['x1'], el['y1'])
                x2, y2 = transform(el['x2'], el['y2'])
                pdf.line(x1, y1, x2, y2)
                angle = math.atan2(y2 - y1, x2 - x1)
                arrow_size = 10 + thickness
                x3 = x2 - arrow_size * math.cos(angle - math.pi / 6)
                y3 = y2 - arrow_size * math.sin(angle - math.pi / 6)
                x4 = x2 - arrow_size * math.cos(angle + math.pi / 6)
                y4 = y2 - arrow_size * math.sin(angle + math.pi / 6)
                path = pdf.beginPath()
                path.moveTo(x2, y2)
                path.lineTo(x3, y3)
                path.lineTo(x4, y4)
                path.close()
                pdf.setFillColor(color)
                pdf.drawPath(path, fill=1, stroke=1)

            elif typ == 'rectangle':
                x, y = transform(el['x'], el['y'])
                x2, y2 = transform(el['x'] + el['width'], el['y'] + el['height'])
                w = x2 - x
                h = y2 - y
                if h < 0:
                    y = y2
                    h = -h
                pdf.rect(x, y - h, w, h, fill=fill_color is not None, stroke=1)
                if fill_color:
                    pdf.setFillColor(fill_color)
                    pdf.rect(x, y - h, w, h, fill=1, stroke=0)
                    pdf.setFillColor(color)

            elif typ == 'circle':
                cx, cy = transform(el['cx'], el['cy'])
                rx, ry = el.get('rx', 0), el.get('ry', 0)
                left = cx - rx
                bottom = cy - ry
                right = cx + rx
                top = cy + ry
                pdf.ellipse(left, bottom, right, top, fill=fill_color is not None, stroke=1)
                if fill_color:
                    pdf.setFillColor(fill_color)
                    pdf.ellipse(left, bottom, right, top, fill=1, stroke=0)
                    pdf.setFillColor(color)

            elif typ == 'triangle':
                x1, y1 = transform(el['x1'], el['y1'])
                x2, y2 = transform(el['x2'], el['y1'])
                x3, y3 = transform(el['x1'], el['y2'])
                path = pdf.beginPath()
                path.moveTo(x1, y1)
                path.lineTo(x2, y2)
                path.lineTo(x3, y3)
                path.close()
                pdf.setStrokeColor(color)
                pdf.setFillColor(fill_color if fill_color else color)
                pdf.drawPath(path, fill=fill_color is not None, stroke=1)

            elif typ == 'text':
                x, y = transform(el['x'], el['y'])
                text = el.get('text', '')
                font_size = el.get('fontSize', 16)
                pdf.setFont("Helvetica", font_size)
                pdf.setFillColor(color)
                pdf.drawString(x, y - 5, text)

        # Отрисовываем все элементы
        for el in board_data:
            try:
                draw_element(el)
            except Exception as e:
                print(f"Error drawing element {el}: {e}")

        pdf.save()
        buffer.seek(0)
        response = HttpResponse(buffer.getvalue(), content_type='application/pdf')
        response['Content-Disposition'] = f'attachment; filename="{whiteboard.name}.pdf"'
        return response


class WhiteboardSessionViewSet(viewsets.ModelViewSet):
    queryset = WhiteboardSession.objects.all()
    serializer_class = WhiteboardSessionSerializer

    def create(self, request):
        """Создание новой сессии для доски"""
        whiteboard_id = request.data.get('whiteboard_id')

        if not whiteboard_id:
            # Создаем новую доску
            whiteboard = Whiteboard.objects.create(
                name=request.data.get('name', 'Новая доска')
            )
        else:
            whiteboard = get_object_or_404(Whiteboard, id=whiteboard_id)

        # Создаем сессию
        session = WhiteboardSession.objects.create(
            whiteboard=whiteboard,
            session_id=str(uuid.uuid4())
        )

        serializer = self.get_serializer(session)
        return Response(serializer.data, status=status.HTTP_201_CREATED)
