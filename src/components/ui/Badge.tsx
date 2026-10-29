import React from 'react';

interface BadgeProps {
  children: React.ReactNode;
  variant?: 'mango' | 'tomato' | 'lime' | 'papaya' | 'jungle';
  className?: string;
}

export const Badge: React.FC<BadgeProps> = ({
  children,
  variant = 'mango',
  className = '',
}) => {
  const variantStyles = {
    mango: 'bg-mango-500/15 text-mango-400 border-mango-500/40',
    tomato: 'bg-tomato-500/15 text-tomato-400 border-tomato-500/40',
    lime: 'bg-lime-500/15 text-lime-400 border-lime-500/40',
    papaya: 'bg-papaya-500/15 text-papaya-400 border-papaya-500/40',
    jungle: 'bg-jungle-800 text-cream-200 border-jungle-600',
  };

  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-mono font-semibold tracking-wide border uppercase ${variantStyles[variant]} ${className}`}
    >
      {children}
    </span>
  );
};
