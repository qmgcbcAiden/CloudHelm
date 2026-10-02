import { useEffect, useState } from 'react';
import type { ApprovalView, InputRequestView } from '@cloudhelm/contracts';
import { capture, Icon } from './ui-helpers.js';
import styles from './ui.module.css';

function useExpired(expiresAt: number): boolean {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  return expiresAt <= now;
}

export function ApprovalCard({ approval, host, report }: { approval: ApprovalView; host: string; report(error: string): void }): React.JSX.Element {
  const expired = useExpired(approval.expiresAt);
  const [busy, setBusy] = useState(false);
  function decide(approved: boolean): void {
    setBusy(true);
    void capture(() => window.cloudhelm.decideApproval(approval.id, approved), report).finally(() => setBusy(false));
  }
  return <section className={styles.reviewCard} aria-label="命令审批">
    <div className={styles.cardTitle}><Icon name="shield" /><strong>{approval.title}</strong></div>
    <small>{host} · {expired ? '请求已过期' : '等待你的决定'}</small><p>{approval.explanation}</p>
    <details><summary>查看完整命令与操作</summary><pre>{approval.preview}</pre></details>
    <div className={styles.cardActions}><button disabled={expired || busy} onClick={() => decide(false)}>拒绝</button><button className={styles.primary} disabled={expired || busy} onClick={() => decide(true)}>批准这次操作</button></div>
  </section>;
}

export function InputCard({ input, host, report, later }: { input: InputRequestView; host: string; report(error: string): void; later?: () => void }): React.JSX.Element {
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const expired = useExpired(input.expiresAt);
  const sensitive = input.kind === 'secret' || input.kind === 'otp';
  function submit(value: string): void {
    if (expired || busy) return;
    setBusy(true); setAnswer('');
    void capture(() => window.cloudhelm.answerInput(input.id, value), report).finally(() => setBusy(false));
  }
  return <form className={later ? styles.dialog : styles.reviewCard} role={later ? 'dialog' : undefined} aria-modal={later ? true : undefined}
    aria-label={input.title} onSubmit={(event) => { event.preventDefault(); submit(answer); }}>
    <div className={styles.cardTitle}><Icon name={sensitive ? 'shield' : 'chat'} /><strong>{input.title}</strong></div>
    <p>{input.explanation}</p><small>目标主机：{host} · {expired ? '请求已过期' : '仅用于当前操作'}</small>
    {sensitive && <p className={styles.notice}>密码或验证码直接提交给当前认证操作，AI 不会看到，也不会保存到对话或终端日志。</p>}
    {input.choices?.length ? <div className={styles.cardActions}>{input.choices.map((choice) => <button key={choice} type="button" disabled={expired || busy} onClick={() => submit(choice)}>{choice}</button>)}</div>
      : <label>{sensitive ? (input.kind === 'otp' ? '验证码' : '密码') : '你的回答'}<input autoFocus={sensitive} type={sensitive ? 'password' : 'text'}
        autoComplete="off" value={answer} disabled={expired || busy} onChange={(event) => setAnswer(event.target.value)} /></label>}
    <div className={styles.cardActions}>
      <button type="button" disabled={busy} onClick={() => { setAnswer(''); void capture(() => window.cloudhelm.cancelInput(input.id), report); }}>取消输入</button>
      {later && <button type="button" onClick={() => { setAnswer(''); later(); }}>稍后填写</button>}
      {!input.choices?.length && <button className={styles.primary} disabled={!answer || expired || busy}>{busy ? '提交中…' : '安全提交'}</button>}
    </div>
    <small>取消输入或关闭窗口不会自动停止远端进程。需要时可单独选择“停止命令”。</small>
  </form>;
}
