import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { X } from 'lucide-preact';

export function IconButton({ label, children, onClick, active = false, disabled = false, className = '' }: {
  label: string; children: ComponentChildren; onClick: () => void; active?: boolean; disabled?: boolean; className?: string;
}) {
  return <button type="button" className={`icon-button ${active ? 'selected' : ''} ${className}`} aria-label={label}
    title={label} onClick={onClick} disabled={disabled}>{children}</button>;
}

export function Modal({ title, children, onClose }: { title: string; children: ComponentChildren; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const element = dialog.current!;
    element.showModal();
    return () => { element.close(); previous?.focus(); };
  }, []);
  return <dialog ref={dialog} className="modal" aria-label={title} onCancel={(event) => { event.preventDefault(); onClose(); }}
    onClick={(event) => { if (event.target === dialog.current) {
      const bounds = dialog.current!.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
    } }}>
    <div className="modal-heading"><h2>{title}</h2><IconButton label="Close dialog" onClick={onClose}><X size={20} /></IconButton></div>
    {children}
  </dialog>;
}