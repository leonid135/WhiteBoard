// frontend/src/App.js
import React, { useState, useEffect, useRef } from 'react';
import { BrowserRouter as Router, Routes, Route, useParams } from 'react-router-dom';
import Toolbar from './components/Toolbar';
import WhiteboardCanvas from './components/WhiteboardCanvas';
import WhiteboardWebSocket from './services/websocket';
import { createSession, exportPDF } from './services/api';
import { API_BASE } from './services/api';
import './App.css';

// ----------------------------------------------------------------------
// Home component
// ----------------------------------------------------------------------
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

// ----------------------------------------------------------------------
// Whiteboard component
// ----------------------------------------------------------------------
function Whiteboard() {
  const { roomId } = useParams();
  const [elements, setElements] = useState([]);
  const [previewElement, setPreviewElement] = useState(null);
  const [tool, setTool] = useState('pencil');
  const [color, setColor] = useState('#000000');
  const [thickness, setThickness] = useState(3);
  const [isErasing, setIsErasing] = useState(false);
  const wsRef = useRef(null);

  // Zoom and pan
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const lastMouseCoordsRef = useRef({ x: 400, y: 300 });

  // Text editing (inline)
  const [editingText, setEditingText] = useState(null);

  // LaTeX modal
  const [latexResult, setLatexResult] = useState(null);

  // Drag & drop for any element
  const [draggedElement, setDraggedElement] = useState(null);
  const [dragStartPos, setDragStartPos] = useState({ x: 0, y: 0 });
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });

  // Selection and resizing for images
  const [selectedElementId, setSelectedElementId] = useState(null);
  const [resizingElement, setResizingElement] = useState(null);

  // Colors and thickness refs (for real‑time use in event handlers)
  const colorRef = useRef(color);
  const thicknessRef = useRef(thickness);
  useEffect(() => { colorRef.current = color; }, [color]);
  useEffect(() => { thicknessRef.current = thickness; }, [thickness]);

  const [editingTextId, setEditingTextId] = useState(null);
  const [editingTextValue, setEditingTextValue] = useState('');
  // --------------------------------------------------------------------
  // Paste image from clipboard
  // --------------------------------------------------------------------
  const [lastMousePos, setLastMousePos] = useState({ x: 400, y: 300 });
  useEffect(() => {
    const handleMouseMoveGlobal = (e) => {
      const canvas = document.querySelector('canvas');
      if (canvas) {
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / 800;
        const scaleY = canvas.height / 600;
        const logicalX = (e.clientX - rect.left) / scaleX;
        const logicalY = (e.clientY - rect.top) / scaleY;
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
          const tempImg = new Image();
          tempImg.onload = () => {
            const aspect = tempImg.width / tempImg.height;
            const targetWidth = 200;
            const targetHeight = targetWidth / aspect;
            const newImage = {
              type: 'image',
              id: Date.now() + Math.random(),
              dataUrl,
              x: lastMousePos.x,
              y: lastMousePos.y,
              width: targetWidth,
              height: targetHeight,
            };
            setElements(prev => [...prev, newImage]);
            sendElement(newImage);
          };
          tempImg.src = dataUrl;
        };
        reader.readAsDataURL(file);
        break;
      }
    }
  };

  useEffect(() => {
    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [lastMousePos]);

  // --------------------------------------------------------------------
  // WebSocket connection and helpers
  // --------------------------------------------------------------------
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

  // --------------------------------------------------------------------
  // LaTeX generation via Groq API (using elements, not image)
  // --------------------------------------------------------------------
  const handleLatex = async () => {
    try {
      // Build description of all elements (same as before)
      const descriptionLines = [];
      for (let idx = 0; idx < elements.length; idx++) {
        const el = elements[idx];
        const typ = el.type;
        const color = el.color || 'black';
        const thick = el.thickness || 1;
        const fill = el.fillColor || null;
        if (typ === 'text') {
          descriptionLines.push(`Text ${idx}: "${el.text}" at (${el.x},${el.y}), color=${color}, font size=${el.fontSize || 16}`);
        } else if (typ === 'rectangle') {
          let line = `Rectangle ${idx}: top-left (${el.x},${el.y}), width=${el.width}, height=${el.height}, stroke=${color}, thickness=${thick}`;
          if (fill) line += `, fill=${fill}`;
          descriptionLines.push(line);
        } else if (typ === 'circle') {
          let line = `Ellipse ${idx}: center (${el.cx},${el.cy}), rx=${el.rx}, ry=${el.ry}, stroke=${color}, thickness=${thick}`;
          if (fill) line += `, fill=${fill}`;
          descriptionLines.push(line);
        } else if (typ === 'line') {
          descriptionLines.push(`Line ${idx}: (${el.x1},${el.y1}) to (${el.x2},${el.y2}), stroke=${color}, thickness=${thick}`);
        } else if (typ === 'arrow') {
          descriptionLines.push(`Arrow ${idx}: (${el.x1},${el.y1}) to (${el.x2},${el.y2}), stroke=${color}, thickness=${thick}`);
        } else if (typ === 'triangle') {
          let line = `Triangle ${idx}: vertices (${el.x1},${el.y1}), (${el.x2},${el.y1}), (${el.x1},${el.y2}), stroke=${color}, thickness=${thick}`;
          if (fill) line += `, fill=${fill}`;
          descriptionLines.push(line);
        } else if (typ === 'pencil') {
          const points = el.points || [];
          if (points.length) {
            const first = points[0];
            const last = points[points.length-1];
            descriptionLines.push(`Pencil drawing ${idx}: approx from (${first.x},${first.y}) to (${last.x},${last.y}), ${points.length} points, stroke=${color}, thickness=${thick}`);
          }
        } else if (typ === 'image') {
          descriptionLines.push(`Image ${idx}: at (${el.x},${el.y}), size ${el.width}x${el.height}`);
        }
      }
      const description = descriptionLines.length ? "The board contains:\n" + descriptionLines.join("\n") : "The board is empty.";
      const prompt = `You are an expert in LaTeX and TikZ. Generate a complete LaTeX document that accurately reproduces the whiteboard described below.

${description}

Requirements:
- Use \\documentclass{article} and include the tikz package.
- Place all drawings inside a single tikzpicture environment.
- Use absolute coordinates (x,y) in points (pt), with the canvas ranging from (0,0) to (800,600).
- For lines, use \\draw or \\draw[->] for arrows. For filled shapes, use \\filldraw.
- For pencil drawings, approximate the shape (e.g., a simple curve).
- Output ONLY the LaTeX code, starting with \\documentclass. Do not add any extra text.

Example format:
\\documentclass{article}
\\usepackage{tikz}
\\begin{document}
\\begin{tikzpicture}[x=1pt,y=1pt,yscale=-1]
  % commands
\\end{tikzpicture}
\\end{document}`;

      const response = await fetch(`${API_BASE}/whiteboards/${roomId}/convert_to_latex/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt })
      });
      const data = await response.json();
      if (data.latex) setLatexResult(data.latex);
      else alert('Ошибка: ' + (data.error || 'Неизвестная ошибка'));
    } catch (err) {
      console.error(err);
      alert('Ошибка при запросе к серверу');
    }
  };

  // --------------------------------------------------------------------
  // Geometry helpers (selection, eraser, fill)
  // --------------------------------------------------------------------
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
        case 'line': case 'arrow':
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
        case 'text': {
          const w = el.width || (el.text?.length * 12) || 80;
          const h = el.height || 24;
          if (x >= el.x && x <= el.x + w && y >= el.y - h && y <= el.y) return i;
          break;
        }
        case 'image':
          if (x >= el.x && x <= el.x + el.width && y >= el.y && y <= el.y + el.height) return i;
          break;
        default: break;
      }
    }
    return -1;
  };

  // --------------------------------------------------------------------
  // Element position update for drag
  // --------------------------------------------------------------------
  const updateElementPosition = (element, deltaX, deltaY) => {
    const updated = { ...element };
    switch (element.type) {
      case 'pencil':
        updated.points = element.points.map(p => ({ x: p.x + deltaX, y: p.y + deltaY }));
        break;
      case 'line': case 'arrow': case 'triangle':
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
      case 'image':
        updated.x = element.x + deltaX;
        updated.y = element.y + deltaY;
        break;
      default: return null;
    }
    return updated;
  };

  // --------------------------------------------------------------------
  // Mouse event handlers (drawing, selection, resize, etc.)
  // --------------------------------------------------------------------
  const handleMouseDown = (e) => {
    if (editingText) return;
    const { offsetX, offsetY } = e;

    // --- Select tool (cursor) ---
    if (tool === 'select') {
      // Check if we are over a resize handle of a selected image or text
      let resizing = false;
      if (selectedElementId) {
        const selectedEl = elements.find(el => el.id === selectedElementId);
        if (selectedEl && (selectedEl.type === 'image' || selectedEl.type === 'text')) {
          const isText = selectedEl.type === 'text';
          const w = isText ? (selectedEl.text?.length * 12) || 80 : selectedEl.width;
          const h = isText ? 24 : selectedEl.height;
          const x = selectedEl.x;
          const y = selectedEl.y;
          const markerSize = 10;
          const corners = [
            { x: x, y: y, corner: 'tl' },
            { x: x + w, y: y, corner: 'tr' },
            { x: x, y: y + h, corner: 'bl' },
            { x: x + w, y: y + h, corner: 'br' }
          ];
          for (const c of corners) {
            if (Math.hypot(offsetX - c.x, offsetY - c.y) < markerSize) {
              setResizingElement({
                element: selectedEl,
                startX: offsetX,
                startY: offsetY,
                originalWidth: w,
                originalHeight: h,
                originalFontSize: selectedEl.fontSize,
                corner: c.corner,
              });
              resizing = true;
              break;
            }
          }
        }
      }
      if (!resizing) {
        const index = findElementIndexAt(offsetX, offsetY);
        if (index !== -1) {
          const element = elements[index];
          setSelectedElementId(element.id);
          setDraggedElement(element);
          setDragStartPos({ x: offsetX, y: offsetY });
          setDragOffset({ x: 0, y: 0 });
          e.preventDefault();
        } else {
          setSelectedElementId(null);
          setDraggedElement(null);
        }
      }
      return;
    }

    // --- Fill tool ---
    if (tool === 'fill') {
      const index = findElementIndexAt(offsetX, offsetY);
      if (index !== -1) {
        const target = elements[index];
        const updated = { ...target, fillColor: colorRef.current };
        setElements(prev => prev.map((el, idx) => idx === index ? updated : el));
        sendUpdate(updated);
      }
      return;
    }

    // --- Text tool (modal) ---
    if (tool === 'text') {
      setTextPosition({ x: offsetX, y: offsetY });
      setTextToolVisible(true);
      return;
    }

    // --- Eraser tool ---
    if (tool === 'eraser') {
      setIsErasing(true);
      const index = findElementIndexAt(offsetX, offsetY);
      if (index !== -1) {
        const deleted = elements[index];
        setElements(prev => prev.filter((_, idx) => idx !== index));
        if (deleted) wsRef.current?.send({ type: 'delete', elementId: deleted.id });
      }
      return;
    }

    // --- Drawing tools (pencil, line, shapes) ---
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

    // Select tool: resize or drag
    if (tool === 'select') {
      if (resizingElement) {
        const deltaX = offsetX - resizingElement.startX;
        const deltaY = offsetY - resizingElement.startY;
        const el = resizingElement.element;
        if (el.type === 'image') {
          let newWidth = resizingElement.originalWidth;
          let newHeight = resizingElement.originalHeight;
          if (resizingElement.corner === 'br') {
            newWidth = resizingElement.originalWidth + deltaX;
            newHeight = resizingElement.originalHeight + deltaY;
          } else if (resizingElement.corner === 'tl') {
            newWidth = resizingElement.originalWidth - deltaX;
            newHeight = resizingElement.originalHeight - deltaY;
          }
          newWidth = Math.max(20, newWidth);
          newHeight = Math.max(20, newHeight);
          const updated = { ...el, width: newWidth, height: newHeight };
          setElements(prev => prev.map(e => e.id === updated.id ? updated : e));
          sendUpdate(updated);
          setResizingElement(prev => ({
            ...prev,
            startX: offsetX,
            startY: offsetY,
            originalWidth: newWidth,
            originalHeight: newHeight,
          }));
        } else if (el.type === 'text') {
          const delta = (resizingElement.corner === 'br') ? deltaX : -deltaX;
          const newFontSize = Math.max(8, resizingElement.originalFontSize + delta / 5);
          // Пересчёт ширины текста
          const tempCanvas = document.createElement('canvas');
          const tempCtx = tempCanvas.getContext('2d');
          tempCtx.font = `${newFontSize}px Arial`;
          const metrics = tempCtx.measureText(el.text);
          const newWidth = metrics.width;
          const newHeight = newFontSize * 1.2;
          const updated = { ...el, fontSize: newFontSize, width: newWidth, height: newHeight };
          setElements(prev => prev.map(e => e.id === updated.id ? updated : e));
          sendUpdate(updated);
          setResizingElement(prev => ({
            ...prev,
            startX: offsetX,
            startY: offsetY,
            originalFontSize: newFontSize,
          }));
        }
        return;
      } else if (draggedElement) {
        const deltaX = offsetX - dragStartPos.x;
        const deltaY = offsetY - dragStartPos.y;
        setDragOffset({ x: deltaX, y: deltaY });
        return;
      }
    }

    // Eraser while moving
    if (tool === 'eraser' && isErasing) {
      const index = findElementIndexAt(offsetX, offsetY);
      if (index !== -1) {
        const deleted = elements[index];
        setElements(prev => prev.filter((_, idx) => idx !== index));
        if (deleted) wsRef.current?.send({ type: 'delete', elementId: deleted.id });
      }
      return;
    }

    // Drawing preview
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
    if (tool === 'select') {
      if (resizingElement) {
        setResizingElement(null);
      } else if (draggedElement) {
        const moved = updateElementPosition(draggedElement, dragOffset.x, dragOffset.y);
        if (moved) {
          setElements(prev => prev.map(el => el.id === moved.id ? moved : el));
          sendUpdate(moved);
        }
        setDraggedElement(null);
        setDragOffset({ x: 0, y: 0 });
      }
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

  // --------------------------------------------------------------------
  // Text modal helpers
  // --------------------------------------------------------------------
  const [textToolVisible, setTextToolVisible] = useState(false);
  const [textPosition, setTextPosition] = useState({ x: 0, y: 0 });

  const handleTextConfirm = (text) => {
    if (text.trim()) {
      if (editingTextId) {
        // Редактирование существующего текста
        const existing = elements.find(el => el.id === editingTextId);
        if (existing) {
          const updatedText = { ...existing, text: text };
          // Пересчитываем ширину и высоту (шрифт остаётся прежним)
          const tempCanvas = document.createElement('canvas');
          const tempCtx = tempCanvas.getContext('2d');
          const fontSize = existing.fontSize || 16;
          tempCtx.font = `${fontSize}px Arial`;
          const metrics = tempCtx.measureText(text);
          updatedText.width = metrics.width;
          updatedText.height = fontSize * 1.2;
          setElements(prev => prev.map(el => el.id === editingTextId ? updatedText : el));
          sendUpdate(updatedText);
        }
      } else {
        // Создание нового текста
        const tempCanvas = document.createElement('canvas');
        const tempCtx = tempCanvas.getContext('2d');
        tempCtx.font = `16px Arial`;
        const metrics = tempCtx.measureText(text);
        const textWidth = metrics.width;
        const textHeight = 16 * 1.2;
        const newText = {
          type: 'text',
          x: textPosition.x,
          y: textPosition.y,
          text: text,
          color: colorRef.current,
          fontSize: 16,
          width: textWidth,
          height: textHeight,
          id: Date.now() + Math.random(),
        };
        setElements(prev => [...prev, newText]);
        sendElement(newText);
      }
    }
    setTextToolVisible(false);
    setEditingTextId(null);
    setEditingTextValue('');
  };

  const handleTextCancel = () => {
    setTextToolVisible(false);
    setEditingTextId(null);
    setEditingTextValue('')
  };

  // --------------------------------------------------------------------
  // Zoom & pan
  // --------------------------------------------------------------------
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

  // --------------------------------------------------------------------
  // Double click to edit text (optional, but we use modal anyway)
  // --------------------------------------------------------------------
  const handleDoubleClick = (e) => {
    const { offsetX, offsetY } = e;
    const index = findElementIndexAt(offsetX, offsetY);
    if (index !== -1 && elements[index].type === 'text') {
      const textElement = elements[index];
      setEditingTextId(textElement.id);
      setEditingTextValue(textElement.text);
      setTextPosition({ x: textElement.x, y: textElement.y });
      setTextToolVisible(true);
    }
  };

  // --------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------
  if (!roomId || roomId === 'undefined' || roomId.length !== 36) {
    return (
      <div>
        <h2>Неверный идентификатор доски</h2>
        <a href="/">Вернуться на главную</a>
      </div>
    );
  }

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
          selectedElementId={selectedElementId}
        />
        {textToolVisible && (
          <div className="modal-overlay">
            <div className="modal-content" onClick={e => e.stopPropagation()}>
              <h3>{editingTextId ? 'Редактировать текст' : 'Введите текст'}</h3>
              <input
                type="text"
                id="text-input-field"
                style={{ width: '100%', padding: '8px', marginBottom: '16px' }}
                defaultValue={editingTextValue}
                onKeyDown={(e) => { if (e.key === 'Enter') handleTextConfirm(e.target.value); }}
                autoFocus
              />
              <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
                <button onClick={() => {
                  const input = document.getElementById('text-input-field');
                  handleTextConfirm(input?.value || '');
                }}>OK</button>
                <button onClick={handleTextCancel}>Отмена</button>
              </div>
            </div>
          </div>
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

// ----------------------------------------------------------------------
// App component with routing
// ----------------------------------------------------------------------
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