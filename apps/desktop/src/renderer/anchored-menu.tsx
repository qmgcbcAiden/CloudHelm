import { useLayoutEffect, useRef, type ReactNode } from 'react';
import styles from './ui.module.css';

/** The native popover top layer escapes sidebar scrolling and clipping. */
export function AnchoredMenu({ anchor, label, children, close }: {
  anchor: HTMLElement; label: string; children: ReactNode; close(): void;
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const menu = ref.current!;
    function position(): void {
      const bounds = anchor.getBoundingClientRect();
      const margin = 8;
      const left = Math.min(bounds.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - margin);
      const below = bounds.bottom + 5;
      const top = below + menu.offsetHeight <= window.innerHeight - margin ? below : bounds.top - menu.offsetHeight - 5;
      menu.style.left = `${Math.max(margin, left)}px`;
      menu.style.top = `${Math.max(margin, Math.min(top, window.innerHeight - menu.offsetHeight - margin))}px`;
    }
    function dismissOnScroll(event: Event): void {
      if (!menu.contains(event.target as Node)) menu.hidePopover();
    }
    menu.showPopover();
    position();
    menu.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true });
    const observer = new ResizeObserver(position);
    observer.observe(menu);
    window.addEventListener('resize', position);
    window.addEventListener('scroll', dismissOnScroll, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', dismissOnScroll, true);
      menu.hidePopover();
    };
  }, [anchor]);

  return <div ref={ref} popover="auto" role="menu" aria-label={label} className={styles.hostMenu}
    onClick={(event) => { if ((event.target as Element).closest('[role="menuitem"]')) close(); }}
    onToggle={(event) => { if ((event.nativeEvent as ToggleEvent).newState === 'closed') close(); }}
    onKeyDown={(event) => {
      if (event.key === 'Escape' || event.key === 'Tab') { anchor.focus({ preventScroll: true }); ref.current?.hidePopover(); return; }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]'));
      const current = items.indexOf(document.activeElement as HTMLElement);
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
        : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[index]?.focus();
    }}>{children}</div>;
}
