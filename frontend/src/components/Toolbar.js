import React from 'react';
import ColorPicker from './ColorPicker';
import ThicknessSlider from './ThicknessSlider';

const Toolbar = ({
  tool,
  onToolChange,
  color,
  onColorChange,
  thickness,
  onThicknessChange,
  onClear,
  onSave,
  onExportPDF,
  onZoomIn,
  onZoomOut,
  onZoomReset,
  onLatex,
}) => {
  const tools = [
    { id: 'select', name: 'Курсор', icon: '🖱️' },
    { id: 'pencil', name: 'Карандаш', icon: '✏️' },
    { id: 'line', name: 'Линия', icon: '📏' },
    { id: 'arrow', name: 'Стрелка', icon: '➡️' },
    { id: 'rectangle', name: 'Прямоугольник', icon: '⬜' },
    { id: 'circle', name: 'Круг', icon: '⭕' },
    { id: 'triangle', name: 'Треугольник', icon: '🔺' },
    { id: 'text', name: 'Текст', icon: 'T' },
    { id: 'eraser', name: 'Ластик', icon: '🧽' },
    { id: 'fill', name: 'Заливка', icon: '🎨' },

  ];

  return (
    <div className="toolbar">
      <div className="tools">
        {tools.map(t => (
          <button
            key={t.id}
            className={`tool-btn ${tool === t.id ? 'active' : ''}`}
            onClick={() => onToolChange(t.id)}
            title={t.name}
          >
            {t.icon}
          </button>
        ))}
      </div>

      <ColorPicker color={color} onChange={onColorChange} />

      <ThicknessSlider thickness={thickness} onChange={onThicknessChange} />
      <div className="zoom-controls">
        <button onClick={onZoomIn} title="Приблизить">➕</button>
        <button onClick={onZoomOut} title="Отдалить">➖</button>
        <button onClick={onZoomReset} title="Сбросить масштаб">🔍</button>
      </div>
      <div className="actions">
        <button onClick={onClear} title="Очистить">🗑️ Очистить</button>
        <button onClick={onSave} title="Сохранить">💾 Сохранить</button>
        <button onClick={onExportPDF} title="Экспорт в PDF">📄 PDF</button>
        <button onClick={onLatex}>🧮 LaTeX</button>
      </div>
    </div>
  );
};

export default Toolbar;