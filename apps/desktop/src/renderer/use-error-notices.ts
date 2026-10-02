import { useCallback, useRef, useState } from 'react';
import { presentError, type ErrorPresentation } from './error-presentation.js';

export function useErrorNotices(): {
  current: ErrorPresentation | undefined;
  report(message: string): void;
  dismiss(): void;
} {
  const [notices, setNotices] = useState<ErrorPresentation[]>([]);
  const recent = useRef(new Map<string, number>());
  const report = useCallback((message: string) => {
    if (!message.trim()) return;
    const notice = presentError(message);
    const now = Date.now();
    for (const [code, shownAt] of recent.current) if (now - shownAt >= 8000) recent.current.delete(code);
    if (recent.current.has(notice.code)) return;
    recent.current.set(notice.code, now);
    setNotices((current) => current.some((item) => item.code === notice.code) ? current : [...current.slice(0, 4), notice]);
  }, []);
  const dismiss = useCallback(() => { setNotices((current) => current.slice(1)); }, []);
  return { current: notices[0], report, dismiss };
}
