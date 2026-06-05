import uuid
import os
import base64
import math
import zipfile
from io import BytesIO

from django.shortcuts import get_object_or_404
from django.http import HttpResponse
from django.conf import settings
from rest_framework import viewsets, status
from rest_framework.decorators import action
from rest_framework.response import Response
from PIL import Image, ImageDraw, ImageFont
from reportlab.pdfgen import canvas
from reportlab.lib.colors import Color, black
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

from .models import Whiteboard, WhiteboardSession
from .serializers import WhiteboardSerializer, WhiteboardSessionSerializer
from groq import Groq


# ----------------------------------------------------------------------
# Вспомогательные функции
# ----------------------------------------------------------------------
def hex_to_reportlab_color(hex_color):
    hex_color = hex_color.lstrip('#')
    if len(hex_color) == 6:
        r, g, b = int(hex_color[0:2], 16), int(hex_color[2:4], 16), int(hex_color[4:6], 16)
        return Color(r / 255.0, g / 255.0, b / 255.0)
    return black


# ----------------------------------------------------------------------
# ViewSet
# ----------------------------------------------------------------------
class WhiteboardViewSet(viewsets.ModelViewSet):
    queryset = Whiteboard.objects.all()
    serializer_class = WhiteboardSerializer

    @action(detail=True, methods=['post'])
    def convert_to_latex(self, request, pk=None):
        """
        Генерирует LaTeX-код на основе элементов доски (без изображений).
        """
        whiteboard = self.get_object()
        elements = whiteboard.get_board_data()

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
                description_lines.append(f"Line {idx}: ({x1},{y1}) to ({x2},{y2}), stroke={color}, thickness={thickness}")
            elif typ == 'arrow':
                x1, y1 = el.get('x1', 0), el.get('y1', 0)
                x2, y2 = el.get('x2', 0), el.get('y2', 0)
                description_lines.append(f"Arrow {idx}: ({x1},{y1}) to ({x2},{y2}), stroke={color}, thickness={thickness}")
            elif typ == 'triangle':
                x1, y1 = el.get('x1', 0), el.get('y1', 0)
                x2, y2 = el.get('x2', 0), el.get('y2', 0)
                line = f"Triangle {idx}: vertices ({x1},{y1}), ({x2},{y1}), ({x1},{y2}), stroke={color}, thickness={thickness}"
                if fill:
                    line += f", fill={fill}"
                description_lines.append(line)
            elif typ == 'pencil':
                points = el.get('points', [])
                if points:
                    sampled = sample_points(points, max_points=200)
                    coords = ','.join(f"{int(p['x'])} {int(p['y'])}" for p in sampled)
                    description_lines.append(
                        f"Pencil drawing {idx}: path of {len(points)} points (sampled to {len(sampled)}): {coords}, "
                        f"stroke={color}, thickness={thickness}"
                    )
            # Изображения в convert_to_latex игнорируем
        description = "The board contains:\n" + "\n".join(description_lines) if description_lines else "The board is empty."

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
                max_tokens=4096
            )
            latex_code = response.choices[0].message.content
            return Response({'latex': latex_code})
        except Exception as e:
            return Response({'error': f'Groq API error: {e}'}, status=500)

    @action(detail=True, methods=['get'])
    def export_latex_with_images(self, request, pk=None):
        """
        Возвращает ZIP-архив, содержащий:
        - whiteboard.tex – LaTeX‑код (со ссылками на изображения)
        - папку images/ со всеми вставленными изображениями.
        """
        whiteboard = self.get_object()
        elements = whiteboard.get_board_data()

        # Подготовка описания для Groq
        description_lines = []
        images = []  # (img_bytes, filename)

        for idx, el in enumerate(elements):
            typ = el.get('type')
            if typ == 'image':
                data_url = el.get('dataUrl')
                if data_url and data_url.startswith('data:image'):
                    # Извлекаем base64-данные
                    img_data = data_url.split(',')[1]
                    img_bytes = base64.b64decode(img_data)
                    ext = 'png'  # формат может быть png / jpeg – упростим
                    filename = f"image_{el['id']}.{ext}"
                    images.append((img_bytes, filename))
                    description_lines.append(
                        f"Image {idx}: file {filename}, at ({el.get('x',0)},{el.get('y',0)}), size {el.get('width',0)}x{el.get('height',0)}"
                    )
                else:
                    description_lines.append(f"Image {idx}: invalid data")
            else:
                # Текст, фигуры – формируем описание как в convert_to_latex
                # (скопируем логику, опустим для краткости, но можно вынести в функцию)
                # Для полноты добавим основные типы
                color = el.get('color', 'black')
                thickness = el.get('thickness', 1)
                fill = el.get('fillColor', None)
                if typ == 'text':
                    description_lines.append(f"Text {idx}: \"{el.get('text','')}\" at ({el.get('x',0)},{el.get('y',0)}), color={color}, font size={el.get('fontSize',16)}")
                elif typ == 'rectangle':
                    desc = f"Rectangle {idx}: top-left ({el.get('x',0)},{el.get('y',0)}), width={el.get('width',0)}, height={el.get('height',0)}, stroke={color}, thickness={thickness}"
                    if fill:
                        desc += f", fill={fill}"
                    description_lines.append(desc)
                elif typ == 'circle':
                    desc = f"Ellipse {idx}: center ({el.get('cx',0)},{el.get('cy',0)}), rx={el.get('rx',0)}, ry={el.get('ry',0)}, stroke={color}, thickness={thickness}"
                    if fill:
                        desc += f", fill={fill}"
                    description_lines.append(desc)
                elif typ in ('line', 'arrow', 'triangle'):
                    if typ == 'line':
                        desc = f"Line {idx}: ({el.get('x1',0)},{el.get('y1',0)}) to ({el.get('x2',0)},{el.get('y2',0)}), stroke={color}, thickness={thickness}"
                    elif typ == 'arrow':
                        desc = f"Arrow {idx}: ({el.get('x1',0)},{el.get('y1',0)}) to ({el.get('x2',0)},{el.get('y2',0)}), stroke={color}, thickness={thickness}"
                    else:
                        desc = f"Triangle {idx}: vertices ({el.get('x1',0)},{el.get('y1',0)}), ({el.get('x2',0)},{el.get('y1',0)}), ({el.get('x1',0)},{el.get('y2',0)}), stroke={color}, thickness={thickness}"
                        if fill:
                            desc += f", fill={fill}"
                    description_lines.append(desc)
                elif typ == 'pencil':
                    points = el.get('points', [])
                    if points:
                        first = points[0]
                        last = points[-1]
                        description_lines.append(f"Pencil drawing {idx}: approx from ({first['x']},{first['y']}) to ({last['x']},{last['y']}), {len(points)} points, stroke={color}, thickness={thickness}")
                # остальные типы (если есть) можно добавить аналогично

        description = "The board contains:\n" + "\n".join(description_lines) if description_lines else "The board is empty."

        prompt = f"""You are an expert in LaTeX and TikZ. Generate a complete LaTeX document that accurately reproduces the whiteboard described below.

{description}

Requirements:
- Use \\documentclass{{article}} and include the packages tikz and graphicx.
- Place all drawings inside a single tikzpicture environment.
- Use absolute coordinates (x,y) in points (pt), with the canvas ranging from (0,0) to (800,600).
- For images, use \\includegraphics{{images/{filename}}} (replace filename with the actual file name).
- For lines, use \\draw or \\draw[->] for arrows. For filled shapes, use \\filldraw.
- For pencil drawings, approximate the shape.
- Output ONLY the LaTeX code, starting with \\documentclass. Do not add any extra text.

Example format:
\\documentclass{{article}}
\\usepackage{{tikz,graphicx}}
\\begin{{document}}
\\begin{{tikzpicture}}[x=1pt,y=1pt,yscale=-1]
  % commands
\\end{{tikzpicture}}
\\end{{document}}"""

        # Получаем LaTeX-код от Groq
        try:
            client = Groq(api_key=settings.GROQ_API_KEY)
            response = client.chat.completions.create(
                model="llama-3.3-70b-versatile",
                messages=[{"role": "user", "content": prompt}],
                temperature=0.2,
                max_tokens=4096
            )
            latex_code = response.choices[0].message.content
        except Exception as e:
            return Response({'error': f'Groq API error: {e}'}, status=500)

        # Создаём ZIP-архив
        zip_buffer = BytesIO()
        with zipfile.ZipFile(zip_buffer, 'w', zipfile.ZIP_DEFLATED) as zip_file:
            # Добавляем LaTeX-файл
            zip_file.writestr('whiteboard.tex', latex_code)
            # Добавляем изображения в папку images/
            for img_bytes, filename in images:
                zip_file.writestr(f'images/{filename}', img_bytes)

        zip_buffer.seek(0)
        response = HttpResponse(zip_buffer.getvalue(), content_type='application/zip')
        response['Content-Disposition'] = f'attachment; filename="{whiteboard.name}_latex_images.zip"'
        return response

    @action(detail=True, methods=['get'])
    def export_pdf(self, request, pk=None):
        """
        Экспорт содержимого доски в PDF с поддержкой кириллицы и изображений.
        """
        whiteboard = self.get_object()
        board_data = whiteboard.get_board_data()

        # Функция для поиска шрифта с кириллицей
        def find_cyrillic_font():
            possible_paths = [
                os.path.join(settings.BASE_DIR, "whiteboard", "font", "arial.ttf"),
                "C:/Windows/Fonts/arial.ttf",
                "C:/Windows/Fonts/arialbd.ttf",
                "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
                "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
                "/System/Library/Fonts/Helvetica.ttc",
            ]
            for path in possible_paths:
                if os.path.exists(path):
                    return path
            return None

        font_path = find_cyrillic_font()
        if font_path:
            try:
                pdfmetrics.registerFont(TTFont("CyrillicFont", font_path))
                has_font = True
            except:
                has_font = False
        else:
            has_font = False

        # Если нет подходящего шрифта, используем стандартный (латиница)
        if not has_font:
            print("Warning: No Cyrillic font found, text may not display correctly")

        if not board_data:
            buffer = BytesIO()
            pdf = canvas.Canvas(buffer, pagesize=(800, 600))
            pdf.setTitle(f"Whiteboard {whiteboard.name}")
            pdf.drawString(100, 300, "Пустая доска")
            pdf.save()
            buffer.seek(0)
            response = HttpResponse(buffer.getvalue(), content_type='application/pdf')
            response['Content-Disposition'] = f'attachment; filename="{whiteboard.name}.pdf"'
            return response

        # Вычисляем bounding box (как в предыдущей версии)
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
                font_size = el.get('fontSize', 16)
                text = el.get('text', '')
                approx_width = len(text) * font_size * 0.6
                approx_height = font_size * 1.2
                min_x = min(min_x, x)
                min_y = min(min_y, y - approx_height)
                max_x = max(max_x, x + approx_width)
                max_y = max(max_y, y)
            elif typ == 'image':
                x, y = el.get('x', 0), el.get('y', 0)
                w, h = el.get('width', 100), el.get('height', 100)
                min_x = min(min_x, x, x + w)
                min_y = min(min_y, y, y + h)
                max_x = max(max_x, x, x + w)
                max_y = max(max_y, y, y + h)

        padding = 50
        width = max(max_x - min_x + 2 * padding, 200)
        height = max(max_y - min_y + 2 * padding, 200)

        buffer = BytesIO()
        pdf = canvas.Canvas(buffer, pagesize=(width, height))
        pdf.setTitle(f"Whiteboard {whiteboard.name}")

        def transform(x, y):
            new_x = x - min_x + padding
            new_y = height - (y - min_y + padding)
            return new_x, new_y

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
                if has_font:
                    pdf.setFont("CyrillicFont", font_size)
                else:
                    pdf.setFont("Helvetica", font_size)
                # Корректируем позицию: в ReportLab y - это baseline
                pdf.drawString(x, y - font_size / 2, text)

            elif typ == 'image':
                data_url = el.get('dataUrl')
                if data_url and data_url.startswith('data:image'):
                    img_data = base64.b64decode(data_url.split(',')[1])
                    img_byte_arr = BytesIO(img_data)
                    img_reader = ImageReader(img_byte_arr)
                    x, y = transform(el['x'], el['y'])
                    x2, y2 = transform(el['x'] + el['width'], el['y'] + el['height'])
                    w = x2 - x
                    h = y2 - y
                    if h < 0:
                        y = y2
                        h = -h
                    pdf.drawImage(img_reader, x, y - h, width=w, height=h, preserveAspectRatio=True)

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
        whiteboard_id = request.data.get('whiteboard_id')
        if not whiteboard_id:
            whiteboard = Whiteboard.objects.create(
                name=request.data.get('name', 'Новая доска')
            )
        else:
            whiteboard = get_object_or_404(Whiteboard, id=whiteboard_id)

        session = WhiteboardSession.objects.create(
            whiteboard=whiteboard,
            session_id=str(uuid.uuid4())
        )
        serializer = self.get_serializer(session)
        return Response(serializer.data, status=status.HTTP_201_CREATED)