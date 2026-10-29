import React, { useState, useRef, useCallback } from 'react';

interface KnobProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  accentColor?: string;
  onChange: (val: number) => void;
}

export const Knob: React.FC<KnobProps> = ({
  label,
  value,
  min,
  max,
  step = 1,
  unit = '',
  accentColor = '#FF9E00',
  onChange,
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const startYRef = useRef<number>(0);
  const startValRef = useRef<number>(0);

  const normalized = Math.max(0, Math.min(1, (value - min) / (max - min)));
  const angle = -135 + normalized * 270;

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    setIsDragging(true);
    startYRef.current = e.clientY;
    startValRef.current = value;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaY = startYRef.current - moveEvent.clientY;
      const sensitivity = 0.005;
      const range = max - min;
      let nextVal = startValRef.current + deltaY * range * sensitivity;
      nextVal = Math.max(min, Math.min(max, nextVal));

      if (step >= 1) {
        nextVal = Math.round(nextVal / step) * step;
      } else {
        const decimals = step.toString().split('.')[1]?.length || 2;
        nextVal = Number(nextVal.toFixed(decimals));
      }
      onChange(nextVal);
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  }, [min, max, step, value, onChange]);

  return (
    <div className="flex flex-col items-center select-none text-xs">
      <span className="text-[10px] tracking-wider uppercase font-semibold text-cream-200/70 mb-1">
        {label}
      </span>

      <div
        onMouseDown={handleMouseDown}
        className={`relative w-11 h-11 rounded-full bg-jungle-900 border border-jungle-600 cursor-ns-resize shadow-md flex items-center justify-center transition-all ${
          isDragging ? 'scale-105 ring-2' : 'hover:border-jungle-500'
        }`}
        style={{
          boxShadow: isDragging ? `0 0 12px ${accentColor}66` : undefined,
        }}
      >
        <svg className="absolute inset-0 w-full h-full -rotate-90 pointer-events-none" viewBox="0 0 44 44">
          <circle
            cx="22"
            cy="22"
            r="18"
            stroke="rgba(43, 83, 61, 0.4)"
            strokeWidth="3"
            fill="none"
            strokeDasharray="85 100"
            strokeLinecap="round"
          />
          <circle
            cx="22"
            cy="22"
            r="18"
            stroke={accentColor}
            strokeWidth="3.5"
            fill="none"
            strokeDasharray={`${normalized * 85} 100`}
            strokeLinecap="round"
          />
        </svg>

        <div
          className="w-7 h-7 rounded-full bg-jungle-800 border border-jungle-700 flex items-center justify-center shadow-inner relative"
          style={{ transform: `rotate(${angle}deg)` }}
        >
          <div
            className="w-1.5 h-1.5 rounded-full absolute top-1"
            style={{ backgroundColor: accentColor, boxShadow: `0 0 6px ${accentColor}` }}
          />
        </div>
      </div>

      <span className="mt-1 font-mono text-[10px] text-cream-100 font-medium">
        {value}
        <span className="text-[9px] text-cream-200/50 ml-0.5">{unit}</span>
      </span>
    </div>
  );
};
