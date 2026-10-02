import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useUi } from './store.js';
import styles from './ui.module.css';

export function TerminalView({ terminalId, report }: { terminalId: string; report(error: string): void }): React.JSX.Element {
  const holder = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const shown = useRef(0);
  const humanIntent = useRef(false);
  const takeover = useRef<Promise<boolean> | null>(null);
  const tab = useUi((state) => state.terminals[terminalId]);

  useEffect(() => {
    if (tab?.state === 'agent' || tab?.state === 'suspended') { humanIntent.current = false; takeover.current = null; }
  }, [tab?.state]);

  useEffect(() => {
    const element = holder.current;
    if (!element) return;
    const media = window.matchMedia('(prefers-color-scheme: light)');
    const theme = () => media.matches
      ? { background: '#f7f9f8', foreground: '#262d2a', cursor: '#397d6b', selectionBackground: '#b8d6ca' }
      : { background: '#202324', foreground: '#e0e4e2', cursor: '#83b7aa', selectionBackground: '#44665b' };
    const xterm = new Terminal({ cursorBlink: true, fontFamily: 'SFMono-Regular, Consolas, monospace', fontSize: 13,
      lineHeight: 1.2, theme: theme(), scrollback: 5000 });
    const updateTheme = () => { xterm.options.theme = theme(); };
    media.addEventListener('change', updateTheme);
    terminal.current = xterm;
    humanIntent.current = false;
    takeover.current = null;
    xterm.open(element);
    const showError = (error: unknown): void => report(error instanceof Error ? error.message : String(error));
    const markHuman = (): void => {
      const current = useUi.getState().terminals[terminalId];
      if (!current?.taskId || current.state === 'human' || humanIntent.current) return;
      humanIntent.current = true;
      takeover.current = window.cloudhelm.takeOver(terminalId).then(() => true, (error: unknown) => {
        humanIntent.current = false; showError(error); return false;
      });
    };
    const onKey = (event: KeyboardEvent): void => { if (!['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) markHuman(); };
    element.addEventListener('keydown', onKey, true);
    element.addEventListener('paste', markHuman, true);
    element.addEventListener('compositionstart', markHuman, true);
    element.addEventListener('beforeinput', markHuman, true);
    const dispose = xterm.onData((data) => {
      const current = useUi.getState().terminals[terminalId];
      if (!current || current.state === 'closed') return;
      if (current.taskId && current.state !== 'human' && !humanIntent.current) {
        void window.cloudhelm.terminalProtocolResponse(terminalId, data).catch(showError);
        return;
      }
      void (takeover.current ?? Promise.resolve(true)).then((granted) => {
        if (granted) return window.cloudhelm.terminalInput(terminalId, data);
        return undefined;
      }).catch(showError);
    });
    const observer = new ResizeObserver(() => {
      const cols = Math.max(20, Math.floor((element.clientWidth - 24) / 7.83));
      const rows = Math.max(4, Math.floor((element.clientHeight - 24) / 15.6));
      if (xterm.cols === cols && xterm.rows === rows) return;
      xterm.resize(cols, rows);
      void window.cloudhelm.resizeTerminal(terminalId, cols, rows).catch(showError);
    });
    observer.observe(element);
    return () => {
      observer.disconnect(); dispose.dispose(); media.removeEventListener('change', updateTheme); xterm.dispose(); terminal.current = null; shown.current = 0;
      element.removeEventListener('keydown', onKey, true); element.removeEventListener('paste', markHuman, true);
      element.removeEventListener('compositionstart', markHuman, true); element.removeEventListener('beforeinput', markHuman, true);
    };
  }, [terminalId, report]);

  useEffect(() => {
    if (!tab || !terminal.current) return;
    if (shown.current < tab.offset || shown.current > tab.offset + tab.buffer.length) {
      terminal.current.reset(); shown.current = tab.offset;
    }
    terminal.current.write(tab.buffer.slice(shown.current - tab.offset));
    shown.current = tab.offset + tab.buffer.length;
  }, [terminalId, tab?.buffer, tab?.offset]);

  return <div className={styles.terminal} ref={holder} aria-label="SSH terminal" />;
}
