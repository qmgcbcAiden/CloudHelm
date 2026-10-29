import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { FileApprovalPreview } from '../../../apps/desktop/src/renderer/file-approval-preview.js';
import { FileRecoveryPanel } from '../../../apps/desktop/src/renderer/file-recovery-panel.js';
import { FileOperationPreview, FilePreviewResult } from '../../../apps/desktop/src/renderer/file-operation-preview.js';

it('renders old/new file contents as escaped text with hashes and explicit expansion', () => {
  const html = renderToStaticMarkup(createElement(FileApprovalPreview, { preview: { path: '/srv/file', beforeSha256: 'old-hash', afterSha256: 'new-hash',
    before: '<script>private old</script>', after: 'line\n'.repeat(4000), encoding: 'utf8', metadata: 'preserve owner' } }));
  expect(html).toContain('&lt;script&gt;private old&lt;/script&gt;'); expect(html).not.toContain('<script>');
  expect(html).toContain('old-hash'); expect(html).toContain('new-hash'); expect(html).toContain('展开完整内容以便审核');
});
it('offers full preview for automatically executed operations and describes expired content honestly', () => {
  const entry = renderToStaticMarkup(createElement(FileOperationPreview, { operationId: 'operation', report() {} }));
  expect(entry).toContain('查看完整文件变更'); expect(entry).toContain('自动执行的操作也可查看');
  const expired = renderToStaticMarkup(createElement(FilePreviewResult, { value: { status: 'unavailable', operationId: 'operation', reason: 'expired-or-unavailable' } }));
  expect(expired).toContain('不能用摘要代替'); expect(expired).toContain('不要重放原写入'); expect(expired).not.toContain('修改前');
});
it('renders bounded plus/minus differences as escaped text', () => {
  const html = renderToStaticMarkup(createElement(FileApprovalPreview, { preview: { path: '/srv/file', before: 'same\n<script>old</script>',
    after: 'same\n<img>new</img>', encoding: 'utf8', metadata: 'preserve' } }));
  expect(html).toContain('文件行差异'); expect(html).toContain('− &lt;script&gt;old'); expect(html).toContain('+ &lt;img&gt;new');
  expect(html).not.toContain('<script>');
});
it('distinguishes state matches from historical execution proof in recovery', () => {
  const html = renderToStaticMarkup(createElement(FileRecoveryPanel, { transactionId: 'txn', view: { transactionId: 'txn', operationId: 'operation',
    taskId: 'task', hostId: 'host', target: '/srv/file', evidence: 'content-matches', observedAt: 1 }, recover: async () => { throw new Error('not invoked'); }, report() {} }));
  expect(html).toContain('没有可证明原操作提交的回执'); expect(html).toContain('写入阻断仍保留'); expect(html).toContain('不会重新写入');
});
