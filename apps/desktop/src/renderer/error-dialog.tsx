import { useEffect, useRef, useState } from 'react';
import type { ErrorPresentation } from './error-presentation.js';
import { Icon } from './ui-helpers.js';
import styles from './error-dialog.module.css';

export function ErrorDialog({ notice, close, configureModel }: {
  notice: ErrorPresentation; close(): void; configureModel(): void;
}): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null);
  const [copyStatus, setCopyStatus] = useState('');
  useEffect(() => { dialog.current?.showModal(); }, []);
  async function copyDetails(): Promise<void> {
    try { await navigator.clipboard.writeText(notice.details); setCopyStatus('已复制脱敏详情'); }
    catch { setCopyStatus('暂时无法复制，请手动选择详情文本。'); }
  }
  return <dialog ref={dialog} className={styles.dialog} role="alertdialog" aria-labelledby="error-title" aria-describedby="error-description"
    onCancel={(event) => { event.preventDefault(); close(); }}>
    <div className={styles.heading}><span className={styles.symbol} aria-hidden="true">{notice.severity === 'warning' ? '!' : '×'}</span>
      <button type="button" aria-label="关闭错误提示" className={styles.close} onClick={close}><Icon name="close" /></button></div>
    <h2 id="error-title">{notice.title}</h2><p id="error-description">{notice.description}</p>
    <details className={styles.details}><summary>查看技术详情</summary><pre>{notice.details}</pre>
      <button type="button" onClick={() => void copyDetails()}>复制脱敏详情</button><span role="status">{copyStatus}</span></details>
    <div className={styles.actions}><button type="button" autoFocus={!notice.action} onClick={close}>{notice.action ? '稍后' : '知道了'}</button>
      {notice.action === 'model-settings' && <button type="button" className={styles.primary} autoFocus onClick={() => { close(); configureModel(); }}>去配置模型</button>}</div>
  </dialog>;
}
