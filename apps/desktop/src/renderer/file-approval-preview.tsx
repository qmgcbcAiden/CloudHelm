import { useMemo, useState } from 'react';
import type { FileApprovalPreviewView } from '@cloudhelm/contracts';
import { fileLineDiff } from './file-line-diff.js';
import styles from './file-diff.module.css';

/** Private approval data is rendered as text, never Markdown/HTML or model context. */
export function FileApprovalPreview({ preview }: { preview: FileApprovalPreviewView }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const limit = expanded ? Number.POSITIVE_INFINITY : 12_000;
  const shortened = preview.before.length > limit || preview.after.length > limit;
  const diff = useMemo(() => preview.encoding === 'utf8' ? fileLineDiff(preview.before, preview.after) : undefined, [preview]);
  return <section aria-label="文件内容审核">
    <p>{preview.path}</p><p>{preview.metadata}</p>
    <small style={{ overflowWrap: 'anywhere' }}>旧版本 SHA-256：{preview.beforeSha256 ?? '不存在'}<br />新版本 SHA-256：{preview.afterSha256 ?? '删除文件'}</small>
    <p>{preview.encoding === 'utf8' ? '对照检查完整的新旧内容。此预览仅供你查看，不发送给模型或写入普通日志。' : '二进制内容以下列 Base64 展示。此预览仅供你查看。'}</p>
    {diff && <section aria-label="文件行差异"><strong>内容差异（− 删除，+ 新增）</strong>
      {diff.message && <p>{diff.message}</p>}<pre style={{ maxHeight: '24rem', overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
        {diff.rows.map((row, index) => <span key={index} className={row.kind === 'add' ? styles.added : row.kind === 'remove' ? styles.removed : undefined}>{row.kind === 'add' ? '+' : row.kind === 'remove' ? '−' : ' '} {row.text}{'\n'}</span>)}
      </pre></section>}
    <details open><summary>修改前</summary><pre style={{ maxHeight: '24rem', overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{preview.before.slice(0, limit) || '（空）'}</pre></details>
    <details open><summary>修改后</summary><pre style={{ maxHeight: '24rem', overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{preview.after.slice(0, limit) || '（空）'}</pre></details>
    {shortened && <button type="button" onClick={() => setExpanded(true)}>展开完整内容以便审核</button>}
  </section>;
}
