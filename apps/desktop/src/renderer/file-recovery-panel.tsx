import { useState } from 'react';
import type { FileRecoveryView } from '@cloudhelm/contracts';

const explanations: Record<FileRecoveryView['evidence'], string> = {
  'receipt-confirmed': '已找到绑定本次操作的提交回执，当前文件状态也匹配。持久化恢复结果后可解除该项写入阻断。',
  'content-matches': '当前内容符合预期，但没有可证明原操作提交的回执。不能据此声称原操作成功，写入阻断仍保留。',
  'original-observed': '当前仍观察到原文件版本；暂存或备份可能存在。没有重放原操作，写入阻断仍保留。',
  conflict: '远端文件或父目录已变化，无法确认本次事务结果。没有覆盖文件，写入阻断仍保留。',
  unavailable: '无法取得可信恢复证据。没有重放原操作，写入阻断仍保留。'
};
export function FileRecoveryPanel({ transactionId, view, recover, report }: { transactionId: string; view?: FileRecoveryView;
  recover(id: string): Promise<FileRecoveryView>; report(error: string): void }): React.JSX.Element {
  const [busy, setBusy] = useState(false); const [observed, setObserved] = useState(view);
  async function inspect(): Promise<void> { setBusy(true); try { setObserved(await recover(transactionId)); } catch (error) { report(String(error)); } finally { setBusy(false); } }
  return <section aria-label="文件事务恢复核验">
    <p>读取事务回执与当前文件状态；此操作不会重新写入或自动清理备份。</p>
    <button disabled={busy} onClick={() => void inspect()}>{busy ? '正在核验文件事务…' : '核验文件事务结果'}</button>
    {observed && <><p role="status">{observed.lockState === 'pending' ? '原提交凭据已保存，但写锁同步未确认。再次核验仅重试本地写锁同步，不会重放远端操作。' : explanations[observed.evidence]}</p><small>目标：{observed.target}</small>
      {observed.backup && <p>恢复副本：<code>{observed.backup}</code></p>}{observed.directory && <small>事务目录：{observed.directory}</small>}</>}
  </section>;
}
