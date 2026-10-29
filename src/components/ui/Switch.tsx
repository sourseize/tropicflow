import React from 'react';

interface SwitchProps {
  label: string;
  checked: boolean;
  accentColor?: string;
  onChange: (checked: boolean) => void;
}

export const Switch: React.FC<SwitchProps> = ({
  label,
  checked,
  accentColor = '#70E000',
  onChange,
}) => {
  return (
    <label className="inline-flex items-center gap-2 cursor-pointer select-none text-xs">
      <div
        onClick={() => onChange(!checked)}
        className={`w-9 h-5 flex items-center rounded-full p-0.5 transition-colors duration-200 ease-in-out ${
          checked ? 'bg-jungle-700' : 'bg-jungle-900 border border-jungle-700'
        }`}
        style={{
          backgroundColor: checked ? `${accentColor}33` : undefined,
          borderColor: checked ? accentColor : undefined,
        }}
      >
        <div
          className={`w-4 h-4 rounded-full transition-transform duration-200 transform shadow-sm ${
            checked ? 'translate-x-4' : 'translate-x-0'
          }`}
          style={{
            backgroundColor: checked ? accentColor : '#3c7255',
            boxShadow: checked ? `0 0 8px ${accentColor}` : undefined,
          }}
        />
      </div>
      <span className="text-[11px] font-medium text-cream-200/80">{label}</span>
    </label>
  );
};
