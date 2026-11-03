import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from './format';

export type SplitMenuItem = {
  label: string;
  icon?: React.ReactNode;
  onSelect?: () => void;
  /** Opens this address in a new tab instead. */
  href?: string;
  disabled?: boolean;
  danger?: boolean;
};

/**
 * One main action with its lesser ones behind a chevron: "Download ▾"
 * (Remove, Visit Civitai). The menu opens under the button, closes on a
 * choice, a click elsewhere or Escape (without closing the window around it).
 */
export function SplitButton({ label, icon, onClick, disabled = false, busy = false, title, items, menuLabel = 'More actions' }: {
  label: React.ReactNode;
  icon?: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  /** Working on it: the main half shows that and can't be pressed. */
  busy?: boolean;
  title?: string;
  items: SplitMenuItem[];
  menuLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => { if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);
  return (
    <div
      className={cn('split-button', open && 'is-open', busy && 'is-busy')}
      ref={ref}
      onKeyDown={(event) => { if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); } }}
    >
      <button type="button" className="split-button-main" disabled={disabled || busy} title={title} onClick={onClick}>
        {icon}<span>{label}</span>
      </button>
      <span className="split-button-divider" aria-hidden="true" />
      <button type="button" className="split-button-more" aria-label={menuLabel} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <ChevronDown size={15} />
      </button>
      {open ? (
        <div className="split-button-menu" role="menu">
          {items.map((item) => item.href && !item.disabled ? (
            <a key={item.label} role="menuitem" className="split-button-item" href={item.href} target="_blank" rel="noreferrer noopener" onClick={() => setOpen(false)}>
              {item.icon}<span>{item.label}</span>
            </a>
          ) : (
            <button key={item.label} type="button" role="menuitem" className={cn('split-button-item', item.danger && 'is-danger')} disabled={item.disabled} onClick={() => { setOpen(false); item.onSelect?.(); }}>
              {item.icon}<span>{item.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
