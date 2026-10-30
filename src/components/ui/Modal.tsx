import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

interface ModalProps {
  open: boolean;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  /** Lucide icon or emoji rendered in the header badge. */
  icon?: React.ReactNode;
  /** When true, Escape / backdrop clicks / the X button are ignored. */
  busy?: boolean;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  testId?: string;
}

/**
 * Centered dialog in the TROPICFLOW look: jungle backdrop, mango/papaya
 * header stripe. Rendered in a portal so it floats above the canvas.
 */
export const Modal: React.FC<ModalProps> = ({ open, title, subtitle, icon, busy = false, onClose, children, footer, testId }) => {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    // Focus the first control so keyboard users land inside the dialog.
    const first = panelRef.current?.querySelector<HTMLElement>('input, select, button:not([data-modal-close])');
    first?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-jungle-950/80 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
      data-testid={testId}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        className="relative w-[520px] max-w-[94vw] rounded-2xl border border-jungle-700 bg-jungle-900 shadow-2xl shadow-black/60 overflow-hidden"
      >
        <div className="h-1 w-full bg-gradient-to-r from-mango-500 via-papaya-500 to-tomato-500" />
        <div className="flex items-start justify-between px-5 pt-4 pb-3 border-b border-jungle-800">
          <div className="flex items-center gap-3">
            {icon && (
              <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-mango-400 via-papaya-500 to-tomato-500 p-0.5 shadow-glow-mango">
                <div className="w-full h-full rounded-[10px] bg-jungle-950 flex items-center justify-center text-mango-400">{icon}</div>
              </div>
            )}
            <div>
              <h2 className="font-extrabold tracking-tight text-sm text-cream-100">{title}</h2>
              {subtitle && <p className="text-[10px] font-mono text-cream-200/50 mt-0.5">{subtitle}</p>}
            </div>
          </div>
          <button
            data-modal-close
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            className="p-1.5 rounded-lg text-cream-200/60 hover:text-cream-100 hover:bg-jungle-800 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <X size={14} />
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer && <div className="px-5 py-3 border-t border-jungle-800 bg-jungle-950/40 flex items-center justify-end gap-2">{footer}</div>}
      </div>
    </div>,
    document.body
  );
};
