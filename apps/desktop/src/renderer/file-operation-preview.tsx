import { useCallback, useEffect, useRef, useState } from 'react';
import type { FilePreviewResponse } from '@cloudhelm/contracts';
import { FileApprovalPreview } from './file-approval-preview.js';

export function FilePreviewResult({ value }: { value: FilePreviewResponse }): React.JSX.Element {
  return value.status === 'available' ? <><p>这是操作准备时的新旧内容快照，不代表远端当前内容。预览保留至 {new Date(value.expiresAt).toLocaleTimeString()}。</p>
    <FileApprovalPreview preview={value.preview} /></>
    : <p role="status">完整预览已过期或不可用，不能用摘要代替。可重新进行只读核验以了解当前文件；不要重放原写入。原操作的新旧完整快照不会从日志恢复。</p>;
}

/** Loads private bodies only on human request and drops them at their original expiry. */
export function FileOperationPreview({ operationId, report, autoLoad = false, onAvailability }: {
  operationId: string; report(error: string): void; autoLoad?: boolean; onAvailability?(available: boolean): void;
}): React.JSX.Element {
  const [value, setValue] = useState<FilePreviewResponse>(); const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const autoRead = useRef<string | undefined>(undefined);
  useEffect(() => () => { generation.current++; }, [operationId]);
  useEffect(() => { onAvailability?.(value?.status === 'available' && value.expiresAt > Date.now()); }, [value, onAvailability]);
  useEffect(() => {
    if (value?.status !== 'available') return;
    const timer = setTimeout(() => setValue({ status: 'unavailable', operationId, reason: 'expired-or-unavailable' }), Math.max(0, value.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [operationId, value]);
  const read = useCallback(async (): Promise<void> => {
    const request = ++generation.current; setBusy(true);
    try {
      const result = await window.cloudhelm.readFilePreview(operationId);
      if (request !== generation.current) return;
      if (result.operationId !== operationId) throw new Error('文件预览绑定无效');
      setValue(result.status === 'available' && result.expiresAt <= Date.now()
        ? { status: 'unavailable', operationId, reason: 'expired-or-unavailable' } : result);
    } catch (error) { if (request === generation.current) report(String(error)); }
    finally { if (request === generation.current) setBusy(false); }
  }, [operationId, report]);
  useEffect(() => {
    if (autoLoad && autoRead.current !== operationId) { autoRead.current = operationId; void read(); }
  }, [autoLoad, operationId, read]);
  return <section aria-label="完整文件变更预览">
    <button disabled={busy} onClick={() => void read()}>{busy ? '正在读取文件预览…' : '查看完整文件变更'}</button>
    <small>包含修改前后内容，自动执行的操作也可查看。仅临时保留 15 分钟；重启或容量回收后不可用。</small>
    {value && <FilePreviewResult value={value} />}
  </section>;
}
