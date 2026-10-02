import { useEffect, useRef, useState } from 'react';
import type { HostConnectionTestResult, HostDraft, HostTestFailure } from '@cloudhelm/contracts';
import { errorMessage } from './error-presentation.js';
import styles from './ui.module.css';

const failures: Record<HostTestFailure, string> = {
  auth: '身份验证未通过。请核对账户、密码、私钥文件及私钥口令。',
  credentials: '请填写密码或私钥路径。更换地址、账户或私钥后，测试时需要重新填写对应凭据。',
  agent: '本机 SSH Agent 尚未就绪。请加载私钥，或改用私钥文件连接。',
  'key-file': '无法读取私钥文件。请重新选择文件，并确认本机有读取权限。',
  timeout: '服务器响应超时。请检查网络、端口和服务器上的 SSH 服务。',
  network: '无法建立 SSH 连接。请检查地址、端口、网络及跳板机的转发权限。',
  interactive: '服务器需要额外交互验证。请保存配置后正常连接，在登录弹窗中完成验证。',
  unknown: '连接测试未完成。请核对连接配置后重试。'
};

export function useHostConnectionTest(host: HostDraft, secret: string, editingHostId: string | undefined, report: (value: string) => void) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<HostConnectionTestResult | null>(null);
  const generation = useRef(0);
  const inFlight = useRef(false);
  useEffect(() => {
    generation.current += 1;
    setResult(null);
    return () => { generation.current += 1; };
  }, [host, secret, editingHostId]);
  async function test(trustRequestId?: string): Promise<void> {
    if (inFlight.current) return;
    const current = generation.current;
    inFlight.current = true;
    setTesting(true); setResult(null);
    try {
      const next = await window.cloudhelm.testHostConnection({ host, secret: secret || undefined, editingHostId, trustRequestId });
      if (generation.current === current) setResult(next);
    } catch (error) { if (generation.current === current) report(errorMessage(error)); }
    finally { inFlight.current = false; setTesting(false); }
  }
  return { testing, result, test, dismiss: () => setResult(null) };
}

export function HostConnectionTestStatus({ testing, result, confirm, dismiss }: {
  testing: boolean; result: HostConnectionTestResult | null; confirm(id: string): void; dismiss(): void;
}): React.JSX.Element | null {
  if (testing) return <p role="status" className={styles.notice}>正在检查网络和 SSH 身份验证，最长约 45 秒…</p>;
  if (!result) return null;
  if (result.status === 'success') return <p role="status" className={styles.notice}>
    连接成功 · 已通过 SSH 身份验证（{result.latencyMs} ms）。临时连接已关闭，配置尚未保存。
  </p>;
  if (result.status === 'failed') return <p role="alert" className={styles.notice}>
    {result.stage === 'jump' ? '跳板机测试失败：' : '连接测试失败：'}{failures[result.code]}
  </p>;
  return <div className={styles.notice} role="group" aria-label="核对测试连接的服务器身份">
    <strong>{result.expectedFingerprint ? '服务器指纹发生变化' : '首次连接，请核对服务器身份'}</strong>
    <p>{result.stage === 'jump' ? '跳板机' : '目标主机'}：{result.address}:{result.port}</p>
    {result.expectedFingerprint && <><p>原指纹</p><code className={styles.fingerprint}>{result.expectedFingerprint}</code></>}
    <p>本次指纹</p><code className={styles.fingerprint}>{result.fingerprint}</code>
    <p>请通过可信渠道核对。一致后仅允许本次测试继续，不会保存主机或永久信任记录。</p>
    <div className={styles.dialogActions}><button type="button" onClick={dismiss}>取消核对</button>
      <button type="button" onClick={() => confirm(result.requestId)}>已核对，继续测试</button></div>
  </div>;
}
