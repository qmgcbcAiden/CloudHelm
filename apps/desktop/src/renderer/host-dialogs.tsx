import { useState } from 'react';
import type { HostDraft, HostView, ReviewMode, SudoCachePolicy } from '@cloudhelm/contracts';
import { capture, Icon } from './ui-helpers.js';
import { HostConnectionTestStatus, useHostConnectionTest } from './host-connection-test.js';
import styles from './ui.module.css';

type DialogProps = { close(): void; report(value: string): void };
export function HostDialog({ hosts, editing, close, report }: DialogProps & { hosts: HostView[]; editing?: HostView }): React.JSX.Element {
  const [draft, setDraft] = useState<HostDraft>(editing
    ? { label: editing.label, address: editing.address, port: editing.port, username: editing.username,
      auth: editing.auth, privateKeyPath: editing.privateKeyPath, jumpHostId: editing.jumpHostId, runtimeDirectory: editing.runtimeDirectory }
    : { label: '', address: '', port: 22, username: '', auth: 'agent' });
  const [secret, setSecret] = useState('');
  const [saving, setSaving] = useState(false);
  const [selectingKey, setSelectingKey] = useState(false);
  const connectionTest = useHostConnectionTest(draft, secret, editing?.id, report);
  const update = (change: Partial<HostDraft>) => setDraft((current) => ({ ...current, ...change }));
  async function selectPrivateKey(): Promise<void> {
    setSelectingKey(true);
    try {
      await capture(async () => {
        const path = await window.cloudhelm.selectPrivateKey();
        if (path !== null) update({ privateKeyPath: path });
      }, report);
    } finally { setSelectingKey(false); }
  }
  async function save(): Promise<void> {
    if (connectionTest.testing || selectingKey || saving) return;
    setSaving(true);
    await capture(async () => {
      if (editing) await window.cloudhelm.editHost(editing.id, draft, secret || undefined);
      else {
        const host = await window.cloudhelm.addHost(draft);
        if (secret) await window.cloudhelm.setHostSecret(host.id, secret);
      }
      setSecret(''); close();
    }, report);
    setSaving(false);
  }
  return <div className={styles.scrim}><form className={`${styles.dialog} ${styles.hostDialog}`} role="dialog" aria-modal="true" aria-labelledby="host-title"
    onSubmit={(event) => { event.preventDefault(); void save(); }}>
    <div className={styles.dialogHead}><h2 id="host-title">{editing ? '编辑 SSH 主机' : '添加 SSH 主机'}</h2><button type="button" aria-label="关闭" onClick={close}><Icon name="close" /></button></div>
    <div className={styles.hostBody}>
    {editing && <p className={styles.notice}>连接配置只对新连接生效。保存后，请关闭原终端并重新连接；正在运行的对话仍使用原连接。</p>}
    <fieldset className={styles.hostFields} disabled={connectionTest.testing || saving}>
    <label>名称<input required autoFocus maxLength={80} value={draft.label} onChange={(event) => update({ label: event.target.value })} placeholder="例如：生产服务器" /></label>
    <label>服务器地址<input required value={draft.address} onChange={(event) => update({ address: event.target.value })} placeholder="192.0.2.10 或 example.com" /></label>
    <div className={styles.formRow}><label>端口<input type="number" required min="1" max="65535" value={draft.port} onChange={(event) => update({ port: Number(event.target.value) })} /></label>
      <label>账户<input required value={draft.username} onChange={(event) => update({ username: event.target.value })} placeholder="ubuntu" /></label></div>
    <small>建议使用普通 SSH 用户；需要管理员权限时提交具体的 sudo 命令。也可按需使用 root 登录。</small>
    <label>认证方式<select value={draft.auth} onChange={(event) => update({ auth: event.target.value as HostDraft['auth'], privateKeyPath: undefined })}>
      <option value="agent">SSH Agent</option><option value="private-key">私钥</option><option value="password">密码</option>
    </select></label>
    {draft.auth === 'private-key' && <div><label htmlFor="private-key-path">私钥路径</label><div className={styles.privateKeyField}>
      <input id="private-key-path" required value={draft.privateKeyPath ?? ''} onChange={(event) => update({ privateKeyPath: event.target.value })} placeholder="选择私钥文件，或输入完整路径" />
      <button type="button" disabled={selectingKey || saving} onClick={() => void selectPrivateKey()}><Icon name="folder" size={14} />{selectingKey ? '选择中…' : '选择文件'}</button>
    </div></div>}
    <label>跳板机<select value={draft.jumpHostId ?? ''} onChange={(event) => update({ jumpHostId: event.target.value || undefined })}>
      <option value="">直连（不使用跳板机）</option>{hosts.filter((host) => !host.jumpHostId && host.id !== editing?.id).map((host) => <option key={host.id} value={host.id}>{host.label}</option>)}
    </select></label>
    <label>AI 临时执行目录（可选）<input value={draft.runtimeDirectory ?? ''}
      onChange={(event) => update({ runtimeDirectory: event.target.value || undefined })} placeholder="默认 /tmp；填写远端绝对路径" /></label>
    <small>此目录需允许当前账户创建并执行临时组件。若 /tmp 禁止执行，可指定其他目录；使用 su 时，目录及其上级还需由 root 拥有（如 /var/tmp）。没有可用目录时 AI 会停止，仍可使用人工 SSH。</small>
    {draft.auth !== 'agent' && <label>{draft.auth === 'password' ? 'SSH 密码' : '私钥口令（如有）'}
      <input type="password" autoComplete="new-password" data-sensitive-input="true" required={draft.auth === 'password' && (!editing || editing.auth !== 'password')}
        value={secret} onChange={(event) => setSecret(event.target.value)} placeholder={editing && editing.auth === draft.auth ? '留空保留现有凭据' : ''} /></label>}
    </fieldset>
    <HostConnectionTestStatus testing={connectionTest.testing} result={connectionTest.result}
      confirm={(id) => void connectionTest.test(id)} dismiss={connectionTest.dismiss} />
    </div>
    <div className={styles.dialogActions}><button type="button" className={styles.testHostButton}
      disabled={saving || selectingKey || connectionTest.testing} onClick={(event) => {
        if (event.currentTarget.form?.reportValidity()) void connectionTest.test();
      }}>{connectionTest.testing ? '正在测试…' : '测试连接'}</button>
      <button type="button" onClick={close}>取消</button><button className={styles.primary} disabled={saving || selectingKey || connectionTest.testing}>{saving ? '保存中…' : '保存'}</button></div>
  </form></div>;
}

export function SafetyDialog({ host, close, report }: DialogProps & { host: HostView }): React.JSX.Element {
  const [mode, setMode] = useState<ReviewMode>(host.defaultMode);
  const [readPaths, setReadPaths] = useState((host.protectedReadPaths ?? host.protectedPaths).join('\n'));
  const [writePaths, setWritePaths] = useState((host.protectedWritePaths ?? host.protectedPaths).join('\n'));
  const [sudoCacheMode, setSudoCacheMode] = useState<SudoCachePolicy['mode']>(host.sudoCachePolicy?.mode ?? 'disabled');
  return <div className={styles.scrim}><form className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="safety-title"
    onSubmit={(event) => { event.preventDefault(); void capture(async () => {
      await window.cloudhelm.updateHostSafety(host.id, mode,
        readPaths.split('\n').map((value) => value.trim()).filter(Boolean),
        writePaths.split('\n').map((value) => value.trim()).filter(Boolean), sudoCacheMode); close();
    }, report); }}>
    <div className={styles.dialogHead}><h2 id="safety-title">{host.label} · 安全设置</h2><button type="button" aria-label="关闭" onClick={close}><Icon name="close" /></button></div>
    <p>这里设置新对话的默认档位；当前对话可在输入框旁单独切换。</p>
    <label>新对话默认档位<select value={mode} onChange={(event) => setMode(event.target.value as ReviewMode)}>
      <option value="ask">第一档 · 重要操作询问</option><option value="ai-review">第二档 · AI 审核不确定操作</option><option value="permissive">第三档 · 默认自动执行</option>
    </select></label>
    <p className={styles.notice}>{mode === 'ai-review' ? '不确定操作由设置中显式选择的模型独立审核；高影响操作仍需你确认。' : mode === 'permissive' ? 'SSH 黑名单和路径扫描只能尽力识别，无法保证拦截脚本内部的危险操作。' : '普通写入自动执行，只询问高影响或无法确认影响的操作。'}</p>
    <label>禁止 AI 读取的路径（每行一个绝对路径）<textarea rows={4} value={readPaths} onChange={(event) => setReadPaths(event.target.value)} placeholder={'/srv/private\n/home/user/.ssh'} /></label>
    <label>禁止 AI 写入的路径（每行一个绝对路径）<textarea rows={4} value={writePaths} onChange={(event) => setWritePaths(event.target.value)} placeholder={'/srv/backup\n/etc/ssh'} /></label>
    <label><input type="checkbox" checked={sudoCacheMode === 'single-password-auto'} onChange={(event) => setSudoCacheMode(event.target.checked ? 'single-password-auto' : 'disabled')} />
      我确认此主机的 sudo 使用单密码认证，允许任务内自动复用已确认的密码</label>
    <p>默认关闭。每次首次输入仍需明确勾选“这是可复用密码”；单次认证成功后仅在内存保留最多 5 分钟，绑定主机、身份和当前任务。验证码不应勾选；多次认证请求、提示变化、暂停或失败会清除。服务器认证策略改变时请关闭此选项。</p>
    <p>修改安全设置后，尚未执行的批准将失效。你手动输入的命令不受 AI 命令审核约束。</p>
    <div className={styles.dialogActions}><button type="button" onClick={close}>取消</button><button className={styles.primary}>保存</button></div>
  </form></div>;
}

export function ConfirmDialog({ title, children, confirmLabel, close, action, report }: DialogProps & {
  title: string; children: React.ReactNode; confirmLabel: string; action(): Promise<void>;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  return <div className={styles.scrim}><div className={styles.dialog} role="alertdialog" aria-modal="true" aria-labelledby="confirm-title">
    <h2 id="confirm-title">{title}</h2><p>{children}</p>
    <div className={styles.dialogActions}><button onClick={close} disabled={busy}>取消</button><button className={styles.primary} disabled={busy} onClick={() => {
      setBusy(true); void capture(async () => { await action(); close(); }, report).finally(() => setBusy(false));
    }}>{confirmLabel}</button></div>
  </div></div>;
}
