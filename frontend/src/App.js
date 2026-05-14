// frontend/src/App.js
import React, { useState, useEffect, useRef } from 'react';
import { BrowserRouter as Router, Routes, Route, useParams } from 'react-router-dom';
import Toolbar from './components/Toolbar';
import WhiteboardCanvas from './components/WhiteboardCanvas';
import WhiteboardWebSocket from './services/websocket';
import { createSession, exportPDF } from './services/api';
import './App.css';
import { API_BASE } from './services/api';

function Home() {
  const [error, setError] = useState(null);
  const createNewBoard = async () => {
    try {
      const session = await createSession();
      window.location.href = `/whiteboard/${session.whiteboard}`;
    } catch (err) {
      console.error('Failed to create board', err);
      setError('Не удалось создать доску. Проверьте, запущен ли сервер.');
    }
  };
  return (
    <div className="home">
      <h1>Онлайн доска для занятий</h1>
      <div className="board-creation">
        <button onClick={createNewBoard}>Создать новую доску</button>
        {error && <p style={{ color: 'red' }}>{error}</p>}
      </div>
    </div>
  );
}

function Whiteboard() {
  const { roomId } = useParams();
  const [elements, setElements] = useState([]);
  const [previewElement, setPreviewElement] = useState(null);
  const [tool, setTool] = useState('pencil');
  const [color, setColor] = useState('#000000');
  const [thickness, setThickness] = useState(3);
  const [isErasing, setIsErasing] = useState(false);
  const wsRef = useRef(null);

  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const lastMouseCoordsRef = useRef({ x: 400, y: 300 });

  const [editingText, setEditingText] = useState(null);

  const [latexResult, setLatexResult] = useState(null);

  // --- Состояния для плавного перетаскивания ---
  const [draggedElement, setDraggedElement] = useState(null);   // перетаскиваемый элемент
  const [dragStartPos, setDragStartPos] = useState({ x: 0, y: 0 });
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });

  const colorRef = useRef(color);
  const thicknessRef = useRef(thickness);
  useEffect(() => { colorRef.current = color; }, [color]);
  useEffect(() => { thicknessRef.current = thickness; }, [thickness]);


  // --- Обработка вставки изображений из буфера обмена ---
  const [lastMousePos, setLastMousePos] = useState({ x: 400, y: 300 });

  // Сохраняем последнюю позицию мыши (для размещения вставленного изображения)
  useEffect(() => {
    const handleMouseMoveGlobal = (e) => {
      // Получаем позицию относительно canvas (преобразуем логические координаты)
      const canvas = document.querySelector('canvas');
      if (canvas) {
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / 800;
        const scaleY = canvas.height / 600;
        const physicalX = e.clientX - rect.left;
        const physicalY = e.clientY - rect.top;
        const logicalX = physicalX / scaleX;
        const logicalY = physicalY / scaleY;
        setLastMousePos({ x: logicalX, y: logicalY });
      }
    };
    window.addEventListener('mousemove', handleMouseMoveGlobal);
    return () => window.removeEventListener('mousemove', handleMouseMoveGlobal);
  }, []);

  const handlePaste = async (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (const item of items) {
      if (item.type.indexOf('image') !== -1) {
        const file = item.getAsFile();
        if (!file) continue;

        const reader = new FileReader();
        reader.onload = (event) => {
          const dataUrl = event.target.result;
          // Создаём элемент изображения на доске
          const imgElement = {
            type: 'image',
            id: Date.now() + Math.random(),
            dataUrl: dataUrl,          // base64
            x: lastMousePos.x,
            y: lastMousePos.y,
            width: 200,                // начальная ширина (можно задать любую)
            height: 200,               // будет скорректировано при отрисовке с сохранением пропорций
          };
          // Для сохранения пропорций при вставке можно загрузить изображение и вычислить реальные размеры
          const tempImg = new Image();
          tempImg.onload = () => {
            const aspect = tempImg.width / tempImg.height;
            const targetWidth = 200;
            const targetHeight = targetWidth / aspect;
            imgElement.width = targetWidth;
            imgElement.height = targetHeight;
            setElements(prev => [...prev, imgElement]);
            sendElement(imgElement);
          };
          tempImg.src = dataUrl;
        };
        reader.readAsDataURL(file);
        break; // берём только первое изображение
      }
    }
  };

  useEffect(() => {
    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [lastMousePos]);



  if (!roomId || roomId === 'undefined' || roomId.length !== 36) {
    return (
      <div>
        <h2>Неверный идентификатор доски</h2>
        <a href="/">Вернуться на главную</a>
      </div>
    );
  }

  useEffect(() => {
    const ws = new WhiteboardWebSocket(roomId, (data) => {
      if (data.type === 'init') setElements(data.data || []);
      else if (data.type === 'draw') {
        if (data.element) setElements(prev => [...prev, data.element]);
        if (data.elements) setElements(data.elements);
      } else if (data.type === 'clear') setElements([]);
      else if (data.type === 'delete') setElements(prev => prev.filter(el => el.id !== data.elementId));
      else if (data.type === 'update') setElements(prev => prev.map(el => el.id === data.element.id ? data.element : el));
    });
    wsRef.current = ws;
    createSession(roomId).then(sessionData => console.log('Session created', sessionData));
    return () => ws.close();
  }, [roomId]);

  const sendElement = (element) => wsRef.current?.send({ type: 'draw', element });
  const sendUpdate = (element) => wsRef.current?.send({ type: 'update', element });

  const handleClear = () => {
    setElements([]);
    wsRef.current?.send({ type: 'clear' });
  };
  const handleSave = () => {
    const canvas = document.querySelector('canvas');
    const link = document.createElement('a');
    link.download = 'whiteboard.png';
    link.href = canvas.toDataURL();
    link.click();
  };
  const handleExportPDF = () => exportPDF(roomId);

  const handleLatex = async () => {
  try {
    const canvas = document.querySelector('canvas');
        if (!canvas) {
          alert('Холст не найден');
          return;
        }
        const imageData = canvas.toDataURL('image/png');

        const response = await fetch(`${API_BASE}/whiteboards/${roomId}/convert_to_latex/`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image: imageData })
        });
        const data = await response.json();
        if (data.latex && data.latex.trim()) {
          setLatexResult(data.latex);
        } else if (data.error) {
          alert('Ошибка: ' + data.error);
        } else {
          alert('Текст не распознан. Нарисуйте более крупные и чёткие буквы.');
        }
      } catch (err) {
        console.error(err);
        alert('Ошибка при запросе к серверу');
      }
    };
  // Геометрические функции
  const distanceToSegment = (x, y, x1, y1, x2, y2) => {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(x - x1, y - y1);
    let t = ((x - x1) * dx + (y - y1) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const projX = x1 + t * dx;
    const projY = y1 + t * dy;
    return Math.hypot(x - projX, y - projY);
  };

  const isPointInTriangle = (px, py, ax, ay, bx, by, cx, cy) => {
    const v0x = cx - ax;
    const v0y = cy - ay;
    const v1x = bx - ax;
    const v1y = by - ay;
    const v2x = px - ax;
    const v2y = py - ay;
    const dot00 = v0x * v0x + v0y * v0y;
    const dot01 = v0x * v1x + v0y * v1y;
    const dot02 = v0x * v2x + v0y * v2y;
    const dot11 = v1x * v1x + v1y * v1y;
    const dot12 = v1x * v2x + v1y * v2y;
    const invDenom = 1 / (dot00 * dot11 - dot01 * dot01);
    const u = (dot11 * dot02 - dot01 * dot12) * invDenom;
    const v = (dot00 * dot12 - dot01 * dot02) * invDenom;
    return (u >= 0) && (v >= 0) && (u + v <= 1);
  };

  const findElementIndexAt = (x, y) => {
    for (let i = elements.length - 1; i >= 0; i--) {
      const el = elements[i];
      if (!el || !el.type) continue;
      switch (el.type) {
        case 'pencil':
          for (const point of el.points) {
            if (Math.hypot(point.x - x, point.y - y) < 10) return i;
          }
          break;
        case 'line':
        case 'arrow':
          if (distanceToSegment(x, y, el.x1, el.y1, el.x2, el.y2) < 10) return i;
          break;
        case 'triangle':
          if (isPointInTriangle(x, y, el.x1, el.y1, el.x2, el.y1, el.x1, el.y2)) return i;
          break;
        case 'rectangle':
          if (x >= el.x && x <= el.x + el.width && y >= el.y && y <= el.y + el.height) return i;
          break;
        case 'circle':
          const dx = x - el.cx, dy = y - el.cy;
          const rx = el.rx || 0, ry = el.ry || 0;
          if (Math.abs(dx) <= rx && Math.abs(dy) <= ry) return i;
          break;
        case 'text':
          const textWidth = (el.text?.length * 12) || 80;
          const textHeight = 24;
          if (x >= el.x - 10 && x <= el.x + textWidth + 10 &&
              y >= el.y - textHeight && y <= el.y + 10) {
            return i;
          }
          break;
        default: break;
      }
    }
    return -1;
  };

  // Вспомогательная функция для обновления координат фигуры
  const updateElementPosition = (element, deltaX, deltaY) => {
    const updated = { ...element };
    switch (element.type) {
      case 'pencil':
        updated.points = element.points.map(p => ({ x: p.x + deltaX, y: p.y + deltaY }));
        break;
      case 'line':
      case 'arrow':
      case 'triangle':
        updated.x1 = element.x1 + deltaX;
        updated.y1 = element.y1 + deltaY;
        updated.x2 = element.x2 + deltaX;
        updated.y2 = element.y2 + deltaY;
        break;
      case 'rectangle':
        updated.x = element.x + deltaX;
        updated.y = element.y + deltaY;
        break;
      case 'circle':
        updated.cx = element.cx + deltaX;
        updated.cy = element.cy + deltaY;
        break;
      case 'text':
        updated.x = element.x + deltaX;
        updated.y = element.y + deltaY;
        break;
      default:
        return null;
    }
    return updated;
  };

  // Обработчики мыши
  const handleMouseDown = (e) => {
    if (editingText) return;
    const { offsetX, offsetY } = e;

    // Инструмент "Курсор" (выделение и перетаскивание)
    if (tool === 'select') {
      const index = findElementIndexAt(offsetX, offsetY);
      if (index !== -1) {
        const element = elements[index];
        setDraggedElement(element);
        setDragStartPos({ x: offsetX, y: offsetY });
        setDragOffset({ x: 0, y: 0 });
        e.preventDefault();
      } else {
        setDraggedElement(null);
      }
      return;
    }

    if (tool === 'fill') {
      const index = findElementIndexAt(offsetX, offsetY);
      if (index !== -1) {
        const target = elements[index];
        if (target) {
          const updated = { ...target, fillColor: colorRef.current };
          setElements(prev => prev.map((el, idx) => idx === index ? updated : el));
          sendUpdate(updated);
        }
      }
      return;
    }
    console.log('handleMouseDown, tool:', tool, 'editingText:', editingText);
    if (tool === 'text') {
      console.log('Text tool triggered, offsetX:', offsetX, 'offsetY:', offsetY, 'clientX:', e.clientX, 'clientY:', e.clientY);
      setEditingText({
        x: offsetX,          // логические координаты для сохранения в элементе
        y: offsetY,
        value: '',
        existingId: null,
        clientX: e.clientX,  // экранные координаты для позиционирования input
        clientY: e.clientY - 16,  // немного выше курсора
      });
      return;
    }
    console.log(editingText)
    if (tool === 'eraser') {
      setIsErasing(true);
      const index = findElementIndexAt(offsetX, offsetY);
      if (index !== -1) {
        const deleted = elements[index];
        if (deleted) {
          setElements(prev => prev.filter((_, idx) => idx !== index));
          if (wsRef.current) wsRef.current.send({ type: 'delete', elementId: deleted.id });
        }
      }
      return;
    }

    const baseElement = {
      type: tool,
      color: colorRef.current,
      thickness: thicknessRef.current,
      id: Date.now() + Math.random(),
    };
    if (tool === 'pencil') {
      setPreviewElement({ ...baseElement, points: [{ x: offsetX, y: offsetY }] });
    } else if (tool === 'line' || tool === 'arrow' || tool === 'triangle') {
      setPreviewElement({ ...baseElement, x1: offsetX, y1: offsetY, x2: offsetX, y2: offsetY });
    } else if (tool === 'rectangle') {
      setPreviewElement({ ...baseElement, x: offsetX, y: offsetY, width: 0, height: 0 });
    } else if (tool === 'circle') {
      setPreviewElement({ ...baseElement, cx: offsetX, cy: offsetY, rx: 0, ry: 0 });
    }
  };

  const handleMouseMove = (e) => {
    if (editingText) return;
    const { offsetX, offsetY } = e;
    lastMouseCoordsRef.current = { x: offsetX, y: offsetY };

    // Плавное перетаскивание выбранного элемента
    if (tool === 'select' && draggedElement) {
      const deltaX = offsetX - dragStartPos.x;
      const deltaY = offsetY - dragStartPos.y;
      setDragOffset({ x: deltaX, y: deltaY });
      // НЕ обновляем elements и НЕ отправляем на сервер
      return;
    }

    if (tool === 'eraser' && isErasing) {
      const index = findElementIndexAt(offsetX, offsetY);
      if (index !== -1) {
        const deleted = elements[index];
        if (deleted) {
          setElements(prev => prev.filter((_, idx) => idx !== index));
          if (wsRef.current) wsRef.current.send({ type: 'delete', elementId: deleted.id });
        }
      }
      return;
    }

    if (!previewElement) return;
    if (tool === 'pencil') {
      setPreviewElement(prev => ({ ...prev, points: [...prev.points, { x: offsetX, y: offsetY }] }));
    } else if (tool === 'line' || tool === 'arrow' || tool === 'triangle') {
      setPreviewElement(prev => ({ ...prev, x2: offsetX, y2: offsetY }));
    } else if (tool === 'rectangle') {
      setPreviewElement(prev => ({ ...prev, width: offsetX - prev.x, height: offsetY - prev.y }));
    } else if (tool === 'circle') {
      setPreviewElement(prev => ({ ...prev, rx: Math.abs(offsetX - prev.cx), ry: Math.abs(offsetY - prev.cy) }));
    }
  };

  const handleMouseUp = () => {
    if (editingText) return;
    if (tool === 'select' && draggedElement) {
      // Применяем окончательное смещение и отправляем на сервер
      const moved = updateElementPosition(draggedElement, dragOffset.x, dragOffset.y);
      if (moved) {
        setElements(prev => prev.map(el => el.id === moved.id ? moved : el));
        sendUpdate(moved);
      }
      setDraggedElement(null);
      setDragOffset({ x: 0, y: 0 });
      return;
    }
    if (tool === 'eraser') {
      setIsErasing(false);
      return;
    }
    if (previewElement) {
      setElements(prev => [...prev, previewElement]);
      sendElement(previewElement);
      setPreviewElement(null);
    }
  };

  const handleDoubleClick = (e) => {
    const { offsetX, offsetY } = e;
    const index = findElementIndexAt(offsetX, offsetY);
    if (index !== -1) {
      const textElement = elements[index];
      if (textElement && textElement.type === 'text') {
        const canvas = e.target;
        const rect = canvas.getBoundingClientRect();
        setEditingText({
          x: textElement.x,
          y: textElement.y,
          value: textElement.text,
          existingId: textElement.id,
          clientX: rect.left + textElement.x * (rect.width / 800),
          clientY: rect.top + textElement.y * (rect.height / 600) - 16,
        });
      }
    }
  };

  const finishTextEditing = () => {
    if (!editingText) return;
    const { x, y, value, existingId } = editingText;
    if (value.trim()) {
      if (existingId === null) {
        const newText = { type: 'text', x, y, text: value, color: colorRef.current, fontSize: 16, id: Date.now() + Math.random() };
        setElements(prev => [...prev, newText]);
        sendElement(newText);
      } else {
        const updatedText = { ...elements.find(el => el.id === existingId), text: value, color: colorRef.current };
        setElements(prev => prev.map(el => el.id === existingId ? updatedText : el));
        sendUpdate(updatedText);
      }
    }
    setEditingText(null);
  };

  const handleTextKeyDown = (e) => {
    if (e.key === 'Enter') finishTextEditing();
    else if (e.key === 'Escape') setEditingText(null);
  };

  const zoomRelativeToPoint = (deltaScale, pointX, pointY) => {
    let newScale = scale + deltaScale;
    newScale = Math.min(3, Math.max(0.3, newScale));
    if (newScale === scale) return;
    const physX = pointX * scale + pan.x;
    const physY = pointY * scale + pan.y;
    setPan({ x: physX - pointX * newScale, y: physY - pointY * newScale });
    setScale(newScale);
  };

  const handleZoomIn = () => zoomRelativeToPoint(0.1, lastMouseCoordsRef.current.x, lastMouseCoordsRef.current.y);
  const handleZoomOut = () => zoomRelativeToPoint(-0.1, lastMouseCoordsRef.current.x, lastMouseCoordsRef.current.y);
  const handleZoomReset = () => { setScale(1); setPan({ x: 0, y: 0 }); };
  const handleWheel = (e, logicalX, logicalY) => zoomRelativeToPoint(e.deltaY > 0 ? -0.1 : 0.1, logicalX, logicalY);

  return (
    <div className="App">
      <Toolbar
        tool={tool}
        onToolChange={setTool}
        color={color}
        onColorChange={setColor}
        thickness={thickness}
        onThicknessChange={setThickness}
        onClear={handleClear}
        onSave={handleSave}
        onExportPDF={handleExportPDF}
        onZoomIn={handleZoomIn}
        onZoomOut={handleZoomOut}
        onZoomReset={handleZoomReset}
        onLatex={handleLatex}
      />
      <div className="canvas-container" style={{ position: 'relative' }}>
        <WhiteboardCanvas
          elements={elements}
          previewElement={previewElement}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onDoubleClick={handleDoubleClick}
          scale={scale}
          pan={pan}
          onWheel={handleWheel}
          draggedElement={draggedElement}
          dragOffset={dragOffset}
        />
        {editingText && (
          <input
            type="text"
            className="inline-text-input"
            style={{
              position: 'fixed',
              left: editingText.clientX,
              top: editingText.clientY,
              fontFamily: 'Arial',
              fontSize: '16px',
              border: '1px solid #ccc',
              background: 'white',
              zIndex: 1000,
            }}
            value={editingText.value}
            onChange={(e) => setEditingText({ ...editingText, value: e.target.value })}
            onBlur={finishTextEditing}
            onKeyDown={handleTextKeyDown}
            autoFocus
          />
        )}
      </div>
      <div className="room-info">
        <p>Комната: {roomId}</p>
      </div>
      {latexResult && (
        <div className="modal-overlay">
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <h3>LaTeX-код доски</h3>
            <pre style={{ whiteSpace: 'pre-wrap', maxHeight: '400px', overflow: 'auto' }}>
              {latexResult}
            </pre>
            <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '16px' }}>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(latexResult);
                  alert('Код скопирован в буфер обмена');
                }}
                className="copy-button"
              >
                📋 Копировать
              </button>
              <button onClick={() => setLatexResult(null)} className="close-button">
                Закрыть
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/whiteboard/:roomId" element={<Whiteboard />} />
      </Routes>
    </Router>
  );
}

export default App;