import type { TaskStatus } from '@cloudhelm/contracts';

export async function capture(action: () => Promise<unknown>, report: (error: string) => void): Promise<void> {
  try { await action(); report(''); } catch (error) { report(error instanceof Error ? error.message : String(error)); }
}
export const statusLabel: Record<TaskStatus, string> = {
  draft: '准备就绪', running: '正在处理', 'waiting-review': '等待确认', 'human-control': '你已接管', recovering: '核验远端状态',
  paused: '已暂停', answered: '已回答', 'ready-for-review': '待验收', accepted: '已验收', failed: '需要处理'
};
export const reviewLabel = { ask: '人工批准', 'ai-review': 'AI 审核', permissive: '自动执行' };
export type IconName = 'terminal' | 'server' | 'chat' | 'plus' | 'close' | 'more' | 'settings' | 'shield' | 'folder' | 'file' | 'arrow' | 'attach' | 'pause' | 'play' | 'stop' | 'expand' | 'disconnect' | 'check' | 'chevron';
const paths: Record<IconName, string> = {
  terminal: 'm4 6 5 6-5 6m8 0h8', server: 'M4 4h16v6H4zM4 14h16v6H4zM7 7h.01M7 17h.01',
  chat: 'M20 15a3 3 0 0 1-3 3H8l-5 3V6a3 3 0 0 1 3-3h11a3 3 0 0 1 3 3z',
  plus: 'M12 5v14M5 12h14', close: 'm6 6 12 12M6 18 18 6', more: 'M5 12h.01M12 12h.01M19 12h.01',
  settings: 'M9 3h6l1 4 4 2v6l-4 2-1 4H9l-1-4-4-2V9l4-2zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6',
  shield: 'm12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6zM8 12l3 3 5-6', folder: 'M3 6h7l2 3h9v11H3z',
  file: 'M5 3h9l5 5v13H5zM14 3v6h5M8 13h8M8 17h6', arrow: 'M12 19V5m-6 6 6-6 6 6',
  attach: 'm8 13 7-7a3 3 0 0 1 4 4L9 20a5 5 0 0 1-7-7L12 3m-7 13 9-9',
  pause: 'M8 5v14M16 5v14', play: 'm8 4 12 8-12 8z', stop: 'M5 5h14v14H5z',
  expand: 'M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5', disconnect: 'M9 7 6 4M17 15l3 3M6 10l4-4 8 8-4 4zM3 21l5-5M16 8l5-5',
  check: 'm5 12 4 4L19 6', chevron: 'm9 5 7 7-7 7'
};
export function Icon({ name, size = 16 }: { name: IconName; size?: number }): React.JSX.Element {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
