import { useEffect, useState } from 'react';
import type { ApprovalView, InputRequestView } from '@cloudhelm/contracts';
import { capture, Icon } from './ui-helpers.js';
import styles from './ui.module.css';
import { FileOperationPreview } from './file-operation-preview.js';

function useExpired(expiresAt: number): boolean {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  return expiresAt <= now;
}

export function ApprovalCard({ approval, host, report }: { approval: ApprovalView; host: string; report(error: string): void }): React.JSX.Element {
  const expired = useExpired(approval.expiresAt);
  const [busy, setBusy] = useState(false);
  const [filePreviewAvailable, setFilePreviewAvailable] = useState(false);
  function decide(approved: boolean): void {
    setBusy(true);
    void capture(() => window.cloudhelm.decideApproval(approval.id, approved), report).finally(() => setBusy(false));
  }
  return <section className={styles.reviewCard} aria-label="命令审批">
    <div className={styles.cardTitle}><Icon name="shield" /><strong>{approval.title}</strong></div>
    <small>{host} · {expired ? '请求已过期' : '等待你的决定'}</small><p>{approval.explanation}</p>
    <small>执行账号：{approval.account ?? '未知'} · 工作目录：{approval.cwd ?? '未知'} · 影响：{approval.impact === 'high' ? '高' : approval.impact === 'unknown' ? '尚不明确' : '一般'}</small>
    <small>操作目标：{approval.targets?.length ? approval.targets.join('、') : '未识别到具体文件或资源路径'}</small>
    <div className={styles.reviewCommand}><small>待批准的完整操作</small><pre>{approval.preview}</pre></div>
    {approval.filePreviewOperationId && <FileOperationPreview key={approval.filePreviewOperationId} operationId={approval.filePreviewOperationId}
      report={report} autoLoad onAvailability={setFilePreviewAvailable} />}
    {approval.recovery && <p>{approval.recovery}</p>}
    <div className={styles.cardActions}><button disabled={expired || busy} onClick={() => decide(false)}>拒绝</button><button className={styles.primary}
      disabled={expired || busy || !!approval.filePreviewOperationId && !filePreviewAvailable} onClick={() => decide(true)}>批准这次操作</button></div>
  </section>;
}

export function InputCard({ input, host, report, later }: { input: InputRequestView; host: string; report(error: string): void; later?: () => void }): React.JSX.Element {
  const [answer, setAnswer] = useState('');
  const [cacheAsPassword, setCacheAsPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const expired = useExpired(input.expiresAt);
  const sensitive = input.kind === 'secret' || input.kind === 'otp';
  useEffect(() => { setAnswer(''); setCacheAsPassword(false); }, [input.id]);
  function submit(value: string): void {
    if (expired || busy) return;
    setBusy(true); setAnswer('');
    void capture(() => window.cloudhelm.answerInput(input.id, { action: 'submit', value,
      ...(input.kind === 'secret' && input.allowPasswordCache ? { cacheAsPassword } : {}) }), report).finally(() => setBusy(false));
  }
  return <form className={later ? styles.dialog : styles.reviewCard} role={later ? 'dialog' : undefined} aria-modal={later ? true : undefined}
    aria-label={input.title} onSubmit={(event) => { event.preventDefault(); submit(answer); }}>
    <div className={styles.cardTitle}><Icon name={sensitive ? 'shield' : 'chat'} /><strong>{input.title}</strong></div>
    <p>{input.explanation}</p><small>目标主机：{host} · {expired ? '请求已过期' : '仅用于当前操作'}</small>
    {sensitive && <p className={styles.notice}>密码或验证码直接提交给当前认证操作，AI 不会看到，也不会保存到对话或终端日志。</p>}
    {input.choices?.length ? <div className={styles.cardActions}>{input.choices.map((choice) => <button key={choice} type="button" disabled={expired || busy} onClick={() => submit(choice)}>{choice}</button>)}</div>
      : <label>{sensitive ? (input.kind === 'otp' ? '验证码' : '认证信息') : '你的回答'}<input autoFocus={sensitive} type={sensitive ? 'password' : 'text'}
        data-sensitive-input={sensitive ? 'true' : undefined}
        autoComplete="off" value={answer} disabled={expired || busy} onChange={(event) => setAnswer(event.target.value)} /></label>}
    {input.kind === 'secret' && input.allowPasswordCache && <label><input type="checkbox" checked={cacheAsPassword}
      disabled={expired || busy} onChange={(event) => setCacheAsPassword(event.target.checked)} />这是可复用密码，不是验证码；认证成功后允许在本任务内自动复用最多 5 分钟</label>}
    <div className={styles.cardActions}>
      <button type="button" disabled={busy} onClick={() => { setAnswer(''); void capture(() => window.cloudhelm.cancelInput(input.id), report); }}>取消输入</button>
      {later && <button type="button" onClick={() => { setAnswer(''); later(); }}>稍后填写</button>}
      {!input.choices?.length && <button className={styles.primary} disabled={!answer || expired || busy}>{busy ? '提交中…' : '安全提交'}</button>}
    </div>
    <small>取消输入或关闭窗口不会自动停止远端进程。需要时可单独选择“停止命令”。</small>
  </form>;
}
