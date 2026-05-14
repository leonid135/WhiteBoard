// frontend/src/components/WhiteboardCanvas.js
import React, { useRef, useEffect, useCallback, useState } from 'react';

const WhiteboardCanvas = ({
  elements,
  previewElement,
  onMouseDown,
  onMouseMove,
  onMouseUp,
  onDoubleClick,
  scale,
  pan,
  onWheel,
  draggedElement,
  dragOffset,
}) => {
  const canvasRef = useRef(null);
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });
  // Кеш для загруженных изображений (чтобы не создавать каждый раз)
  const imageCache = useRef({});

  const updateCanvasSize = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const container = canvas.parentElement;
    if (!container) return;
    const width = container.clientWidth;
    const height = container.clientHeight;
    canvas.width = width;
    canvas.height = height;
    setDimensions({ width, height });
  }, []);

  useEffect(() => {
    updateCanvasSize();
    window.addEventListener('resize', updateCanvasSize);
    return () => window.removeEventListener('resize', updateCanvasSize);
  }, [updateCanvasSize]);

  const drawCanvas = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.save();

    const scaleX = canvas.width / 800;
    const scaleY = canvas.height / 600;
    ctx.scale(scaleX, scaleY);
    ctx.translate(pan.x, pan.y);
    ctx.scale(scale, scale);

    if (Array.isArray(elements)) elements.forEach(el => drawElement(ctx, el));
    if (previewElement) drawElement(ctx, previewElement);
    if (draggedElement) {
      ctx.save();
      ctx.translate(dragOffset.x, dragOffset.y);
      drawElement(ctx, draggedElement);
      ctx.restore();
    }
    ctx.restore();
  };

  const drawElement = (ctx, el) => {
    if (!el || !el.type) return;
    ctx.strokeStyle = el.color || '#000000';
    ctx.lineWidth = el.thickness || 3;
    ctx.fillStyle = el.fillColor || 'transparent';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    switch (el.type) {
      case 'pencil':
        if (el.points?.length > 1) {
          ctx.beginPath();
          ctx.moveTo(el.points[0].x, el.points[0].y);
          for (let i = 1; i < el.points.length; i++) ctx.lineTo(el.points[i].x, el.points[i].y);
          ctx.stroke();
        }
        break;
      case 'line':
        ctx.beginPath();
        ctx.moveTo(el.x1, el.y1);
        ctx.lineTo(el.x2, el.y2);
        ctx.stroke();
        break;
      case 'rectangle':
        ctx.strokeRect(el.x, el.y, el.width, el.height);
        if (el.fillColor) ctx.fillRect(el.x, el.y, el.width, el.height);
        break;
      case 'circle':
        ctx.beginPath();
        ctx.ellipse(el.cx, el.cy, el.rx, el.ry || el.rx, 0, 0, 2 * Math.PI);
        ctx.stroke();
        if (el.fillColor) ctx.fill();
        break;
      case 'arrow':
        ctx.beginPath();
        ctx.moveTo(el.x1, el.y1);
        ctx.lineTo(el.x2, el.y2);
        ctx.stroke();
        const angle = Math.atan2(el.y2 - el.y1, el.x2 - el.x1);
        const arrowSize = 10 + (el.thickness || 3);
        const x3 = el.x2 - arrowSize * Math.cos(angle - Math.PI/6);
        const y3 = el.y2 - arrowSize * Math.sin(angle - Math.PI/6);
        const x4 = el.x2 - arrowSize * Math.cos(angle + Math.PI/6);
        const y4 = el.y2 - arrowSize * Math.sin(angle + Math.PI/6);
        ctx.beginPath();
        ctx.moveTo(el.x2, el.y2);
        ctx.lineTo(x3, y3);
        ctx.lineTo(x4, y4);
        ctx.closePath();
        ctx.fillStyle = el.color;
        ctx.fill();
        break;
      case 'triangle':
        ctx.beginPath();
        ctx.moveTo(el.x1, el.y1);
        ctx.lineTo(el.x2, el.y1);
        ctx.lineTo(el.x1, el.y2);
        ctx.closePath();
        ctx.stroke();
        if (el.fillColor) { ctx.fillStyle = el.fillColor; ctx.fill(); }
        break;
      case 'text':
        ctx.font = `${el.fontSize || 16}px ${el.fontFamily || 'Arial'}`;
        ctx.fillStyle = el.color;
        ctx.fillText(el.text, el.x, el.y);
        break;
      case 'image':
        let img = imageCache.current[el.id];
        if (!img) {
          img = new Image();
          img.src = el.dataUrl;
          imageCache.current[el.id] = img;
        }
        // Рисуем, если изображение загружено, иначе ожидаем загрузки
        if (img.complete && img.naturalWidth > 0) {
          ctx.drawImage(img, el.x, el.y, el.width, el.height);
        } else {
          img.onload = () => drawCanvas();
        }
        break;
      default:
        break;
    }
  };

  const getLogicalCoords = (e) => {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const physicalX = e.clientX - rect.left;
    const physicalY = e.clientY - rect.top;
    const scaleX = canvas.width / 800;
    const scaleY = canvas.height / 600;
    const canvasX = (physicalX / scaleX - pan.x) / scale;
    const canvasY = (physicalY / scaleY - pan.y) / scale;
    return { offsetX: canvasX, offsetY: canvasY };
  };

  const adaptEvent = (e, handler) => {
    if (!handler) return;
    const coords = getLogicalCoords(e);
    const syntheticEvent = {
      ...e,
      nativeEvent: e,
      offsetX: coords.offsetX,
      offsetY: coords.offsetY,
      clientX: e.clientX,
      clientY: e.clientY,
      target: e.target,
      currentTarget: e.currentTarget,
      preventDefault: () => e.preventDefault(),
      stopPropagation: () => e.stopPropagation(),
    };
    handler(syntheticEvent);
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const wheelHandler = (e) => {
      if (onWheel) {
        e.preventDefault();
        const coords = getLogicalCoords(e);
        onWheel(e, coords.offsetX, coords.offsetY);
      }
    };
    canvas.addEventListener('wheel', wheelHandler, { passive: false });
    return () => canvas.removeEventListener('wheel', wheelHandler);
  }, [onWheel]);

  useEffect(() => { drawCanvas(); }, [elements, previewElement, scale, pan, dimensions, draggedElement, dragOffset]);

  return (
    <canvas
      ref={canvasRef}
      onMouseDown={(e) => adaptEvent(e, onMouseDown)}
      onMouseMove={(e) => adaptEvent(e, onMouseMove)}
      onMouseUp={(e) => adaptEvent(e, onMouseUp)}
      onDoubleClick={(e) => adaptEvent(e, onDoubleClick)}
    />
  );
};

export default WhiteboardCanvas;