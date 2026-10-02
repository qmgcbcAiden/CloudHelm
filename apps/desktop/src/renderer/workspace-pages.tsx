import { useEffect, useState } from 'react';
import type { OperationView, TaskView } from '@cloudhelm/contracts';
import { capture, Icon, statusLabel } from './ui-helpers.js';
import { useUi } from './store.js';
import { MarkdownMessage } from './markdown-message.js';
import { presentError } from './error-presentation.js';
import styles from './ui.module.css';

export function FilesPage({ hostId, host, report }: { hostId: string; host: string; report(error: string): void }): React.JSX.Element {
  const [path, setPath] = useState('.');
  const [draft, setDraft] = useState('.');
  const [files, setFiles] = useState<Array<{ name: string; isDirectory: boolean; size: number }>>([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let active = true;
    setLoading(true);
    void window.cloudhelm.listRemote(hostId, path).then((items) => { if (active) setFiles(items); })
      .catch((error: unknown) => { if (active) report(String(error)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [hostId, path, report]);
  function navigate(next: string): void { setPath(next); setDraft(next); }
  return <section className={styles.filesPage}>
    <div className={styles.pageHead}><div><small>{host}</small><h2>远程文件</h2></div><span className={styles.pill}>只读 SFTP</span></div>
    <form className={styles.pathRow} onSubmit={(event) => { event.preventDefault(); navigate(draft); }}>
      <button type="button" title="上一级" onClick={() => navigate(path === '/' ? '/' : `${path.replace(/\/$/u, '')}/..`)}><Icon name="arrow" /></button>
      <input aria-label="远程目录" value={draft} onChange={(event) => setDraft(event.target.value)} /><button>前往</button>
    </form>
    <p className={styles.note}>在这里查看目录。需要修改文件时，可在 AI 助手中说明，变更将经过审核。</p>
    <div className={styles.fileTable}><div className={styles.fileHeader}><span>名称</span><span>大小</span></div>
      {loading ? <p>正在读取目录…</p> : files.length ? [...files].sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name)).map((file) =>
        <button className={styles.fileRow} key={file.name} disabled={!file.isDirectory} onClick={() => navigate(`${path.replace(/\/$/u, '')}/${file.name}`)}>
          <span><Icon name={file.isDirectory ? 'folder' : 'file'} />{file.name}</span><small>{file.isDirectory ? '文件夹' : new Intl.NumberFormat('zh-CN').format(file.size) + ' B'}</small>
        </button>) : <p>这个目录是空的。</p>}
    </div>
  </section>;
}

export function OperationCard({ operation, report }: { operation: OperationView; report(error: string): void }): React.JSX.Element {
  const terminal = useUi((state) => operation.logRef ? state.terminals[operation.logRef] : undefined);
  const [fullLog, setFullLog] = useState<string | null>(null);
  const live = terminal?.buffer.slice(-3000).replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, '');
  const output = operation.status === 'running' ? live : operation.outputTail;
  const statuses = { proposed: '审核中', approved: '已批准', running: '执行中', succeeded: '已完成', failed: '执行失败', denied: '已拦截', unknown: '结果待核验' };
  return <section className={styles.operationCard}>
    <div className={styles.cardTitle}><Icon name="terminal" /><strong>{operation.kind === 'command' ? '远程命令' : '文件操作'}</strong><small>{statuses[operation.status]}</small></div>
    <pre className={styles.command}>{operation.preview}</pre>
    {output && <pre className={styles.outputTail}>{output.slice(-1600)}</pre>}
    <details><summary>操作详情{operation.exitCode !== undefined ? ` · 退出码 ${operation.exitCode}` : ''}</summary>
      {operation.reason && <p>{operation.reason}</p>}{operation.model && <small>{operation.model.provider} · {operation.model.modelId}</small>}
      <div className={styles.cardActions}>{terminal && <button onClick={() => useUi.getState().openTerminal(terminal.id)}><Icon name="terminal" />打开 AI 终端</button>}
        {operation.logRef && <button onClick={() => void capture(async () => setFullLog(await window.cloudhelm.readTerminalLog(operation.logRef!)), report)}>查看日志</button>}</div>
      {fullLog && <pre>{fullLog}</pre>}
    </details>
  </section>;
}

export function VerificationCard({ conversation, report }: { conversation: TaskView; report(error: string): void }): React.JSX.Element {
  const verified = conversation.status === 'ready-for-review' && !!conversation.report?.evidenceOperationIds.length;
  const failure = conversation.status === 'failed' ? presentError(conversation.summary) : null;
  return <section className={`${styles.reviewCard} ${styles.verificationCard}`}>
    <div className={styles.cardTitle}><Icon name={verified || conversation.status === 'accepted' ? 'check' : 'shield'} /><strong>{failure?.title ?? statusLabel[conversation.status]}</strong></div>
    <p>{failure?.description ?? conversation.report?.summary ?? conversation.summary ?? '还需要补充验证证据，请查看对话中的说明。'}</p>
    {failure ? <details><summary>查看错误详情</summary><pre className={styles.outputTail}>{failure.details}</pre></details>
      : conversation.report?.access.map((address) => <code className={styles.access} key={address}>{address}</code>)}
    <div className={styles.cardActions}><button onClick={() => useUi.getState().openReport(conversation.id)}>{failure ? '查看对话记录' : '查看完整报告'}</button>
      {verified && <button className={styles.primary} onClick={() => void capture(() => window.cloudhelm.acceptConversation(conversation.id), report)}>验收完成</button>}
    </div>
  </section>;
}

export function ReportPage({ conversation, operations, report }: { conversation: TaskView; operations: OperationView[]; report(error: string): void }): React.JSX.Element {
  const snapshot = useUi((state) => state.snapshot);
  const messages = snapshot?.messages.filter((message) => message.taskId === conversation.id) ?? [];
  return <section className={styles.reportPage}>
    <div className={styles.pageHead}><div><small>AI 对话详情</small><h2>{conversation.goal}</h2></div><span className={styles.pill}>{statusLabel[conversation.status]}</span></div>
    {!conversation.report && conversation.status === 'failed' && <VerificationCard conversation={conversation} report={report} />}
    {conversation.report && <>
      <VerificationCard conversation={conversation} report={report} />
      <h3>变更</h3><ul>{conversation.report.changes.map((item) => <li key={item}>{item}</li>)}</ul>
      <h3>恢复说明</h3><ul>{conversation.report.recovery.map((item) => <li key={item}>{item}</li>)}</ul>
      <h3>验证证据</h3>{operations.filter((operation) => conversation.report?.evidenceOperationIds.includes(operation.id)).map((operation) => <OperationCard key={operation.id} operation={operation} report={report} />)}
    </>}
    <h3>对话记录</h3>{messages.map((message, index) => <article className={styles.message} key={`${message.createdAt}:${index}`}><strong>{message.role === 'user' ? '你' : message.role === 'agent' ? 'CloudHelm' : '系统'}</strong>{message.role === 'agent' ? <MarkdownMessage text={message.text} /> : <p>{message.text}</p>}</article>)}
    {!!operations.length && <details><summary>全部操作（{operations.length}）</summary>{operations.map((operation) => <OperationCard key={operation.id} operation={operation} report={report} />)}</details>}
  </section>;
}
