import React from 'react';

const ThicknessSlider = ({ thickness, onChange }) => {
  return (
    <div className="thickness-control">
      <label>Толщина:</label>
      <input
        type="range"
        min="1"
        max="20"
        value={thickness}
        onChange={(e) => onChange(parseInt(e.target.value))}
      />
      <span>{thickness}px</span>
    </div>
  );
};

export default ThicknessSlider;