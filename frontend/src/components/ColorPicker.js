import React from 'react';

const ColorPicker = ({ color, onChange }) => {
  const colors = ['#000000', '#FF0000', '#00FF00', '#0000FF', '#FFFF00', '#FF00FF', '#00FFFF', '#FFFFFF'];

  return (
    <div className="color-picker">
      <div className="color-presets">
        {colors.map(c => (
          <button
            key={c}
            className="color-btn"
            style={{ backgroundColor: c }}
            onClick={() => onChange(c)}
          />
        ))}
      </div>
      <input
        type="color"
        value={color}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
};

export default ColorPicker;