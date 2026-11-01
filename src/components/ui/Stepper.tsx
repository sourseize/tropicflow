import React from 'react';

interface StepperProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  /** Decimal places shown. */
  digits?: number;
  testId?: string;
  onChange: (val: number) => void;
}

/** Compact numeric control for narrow cards: label, value, - / + (wheel over it steps too). */
export const Stepper: React.FC<StepperProps> = ({ label, value, min, max, step = 1, unit = '', digits = 0, testId, onChange }) => {
  const set = (v: number) => onChange(Math.max(min, Math.min(max, Number(v.toFixed(6)))));
  return (
    <div
      data-testid={testId}
      className="flex items-center justify-between gap-1 text-[9px] font-mono text-cream-200/60"
      onWheel={(e) => {
        e.preventDefault();
        set(value + (e.deltaY < 0 ? step : -step));
      }}
    >
      <span className="truncate">{label}</span>
      <span className="flex items-center gap-1">
        <button
          data-testid={testId ? `${testId}-down` : undefined}
          onClick={() => set(value - step)}
          className="px-1 rounded border border-jungle-700 hover:border-mango-500 text-cream-200"
        >
          -
        </button>
        <span data-testid={testId ? `${testId}-value` : undefined} className="text-cream-100 min-w-[2.6em] text-center">
          {value.toFixed(digits)}
          <span className="text-cream-200/50">{unit}</span>
        </span>
        <button
          data-testid={testId ? `${testId}-up` : undefined}
          onClick={() => set(value + step)}
          className="px-1 rounded border border-jungle-700 hover:border-mango-500 text-cream-200"
        >
          +
        </button>
      </span>
    </div>
  );
};
