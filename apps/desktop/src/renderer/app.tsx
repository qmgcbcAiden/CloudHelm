import { useCallback, useEffect, useRef, useState } from 'react';
import type { HostView } from '@cloudhelm/contracts';
import { useUi, type WorkspaceTab } from './store.js';
import { TerminalView } from './terminal-view.js';
import { ModelSettingsDialog } from './model-settings.js';
import { AgentPanel, type QuotedOutput } from './agent-panel.js';
import { HostDialog, SafetyDialog, ConfirmDialog } from './host-dialogs.js';
import { InputCard } from './interaction-cards.js';
import { FilesPage, ReportPage } from './workspace-pages.js';
import { capture, Icon, statusLabel } from './ui-helpers.js';
import { ErrorDialog } from './error-dialog.js';
import { useErrorNotices } from './use-error-notices.js';
import { AnchoredMenu } from './anchored-menu.js';
import styles from './ui.module.css';

type Confirmation = { title: string; message: string; label: string; action(): Promise<void> };
type Dialog = { kind: 'host'; hostId?: string } | { kind: 'safety'; hostId: string } | null;

function hostLineage(host: HostView, hosts: HostView[]): string[] {
  const ids = [host.id];
  let previousId = host.previousHostId;
  while (previousId && !ids.includes(previousId)) { ids.push(previousId); previousId = hosts.find((item) => item.id === previousId)?.previousHostId; }
  return ids;
}

export function App(): React.JSX.Element {
  const ui = useUi();
  const { snapshot, terminals, tabs, activeTabId, activeHostId, selectedConversationId, settingsOpen, agentPanelOpen } = ui;
  const [dialog, setDialog] = useState<Dialog>(null);
  const [hostMenu, setHostMenu] = useState<{ hostId: string; anchor: HTMLButtonElement } | null>(null);
  const { current: error, report: setError, dismiss: dismissError } = useErrorNotices();
  const [fingerprint, setFingerprint] = useState<{ hostId: string; value: string } | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [hiddenInputs, setHiddenInputs] = useState<string[]>([]);
  const [connecting, setConnecting] = useState<string[]>([]);
  const [quote, setQuote] = useState<QuotedOutput | null>(null);
  const navigationGuard = useRef<((next: () => void) => void) | null>(null);
  const registerNavigationGuard = useCallback((guard: ((next: () => void) => void) | null) => { navigationGuard.current = guard; }, []);
  function navigate(action: () => void): void {
    if (settingsOpen && navigationGuard.current) navigationGuard.current(() => { useUi.getState().setSettingsOpen(false); action(); });
    else action();
  }
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  const activeTerminal = activeTab?.kind === 'terminal' ? terminals[activeTab.terminalId] : undefined;
  const conversation = snapshot?.conversations.find((item) => item.id === selectedConversationId);
  const activeHost = snapshot?.hosts.find((host) => host.id === activeHostId);
  const hostName = (hostId: string): string => snapshot?.hosts.find((host) => host.id === hostId)?.label ?? hostId;
  const pendingCount = (snapshot?.approvals.length ?? 0) + (snapshot?.inputs.length ?? 0);

  useEffect(() => {
    const unsubscribe = window.cloudhelm.onEvent((event) => {
      const previous = useUi.getState().snapshot;
      useUi.getState().applyEvent(event);
      // Main projects worker task-status events into snapshots. Only a new
      // failure of an already known conversation should interrupt the user;
      // restoring historical failed conversations must stay quiet.
      if (event.type !== 'snapshot' || !previous) return;
      const previousStatuses = new Map(previous.conversations.map((item) => [item.id, item.status]));
      for (const conversation of event.value.conversations) {
        const before = previousStatuses.get(conversation.id);
        if (before && before !== 'failed' && conversation.status === 'failed') {
          setError(conversation.summary || 'Unknown conversation failure');
        }
      }
    });
    void window.cloudhelm.snapshot().then(useUi.getState().setSnapshot).catch((cause: unknown) => setError(String(cause)));
    return unsubscribe;
  }, [setError]);
  useEffect(() => { setQuote(null); }, [activeHostId]);

  async function connectHost(hostId: string, alwaysNew = false): Promise<void> {
    if (connecting.includes(hostId)) return;
    setConnecting((ids) => [...ids, hostId]);
    try {
      const existing = Object.values(useUi.getState().terminals).find((terminal) => terminal.hostId === hostId && !terminal.taskId && terminal.state !== 'closed');
      if (existing && !alwaysNew) { useUi.getState().openTerminal(existing.id); return; }
      const host = useUi.getState().snapshot?.hosts.find((item) => item.id === hostId);
      if (host?.status !== 'connected') await window.cloudhelm.connectHost(hostId);
      const id = await window.cloudhelm.openTerminal(hostId);
      if (!useUi.getState().terminals[id]) useUi.getState().setSnapshot(await window.cloudhelm.snapshot());
      useUi.getState().openTerminal(id); setError('');
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const value = /SHA256:[A-Za-z\d+/=]+/u.exec(message)?.[0];
      if (value) setFingerprint({ hostId, value }); else setError(message);
    } finally { setConnecting((ids) => ids.filter((id) => id !== hostId)); }
  }

  function closeTab(tab: WorkspaceTab): void {
    if (tab.kind !== 'terminal') { useUi.getState().closeTab(tab.id); return; }
    const terminal = terminals[tab.terminalId];
    const executing = snapshot?.operations.some((operation) => operation.taskId === terminal?.taskId && operation.logRef === terminal?.id && ['running', 'unknown'].includes(operation.status));
    const close = async (): Promise<void> => { await window.cloudhelm.closeTerminal(tab.terminalId); useUi.getState().closeTab(tab.id); };
    if (terminal?.taskId && executing) setConfirmation({ title: '断开正在运行的 AI 终端？',
      message: '关闭这个标签会断开真实 SSH 会话。远端进程不一定停止，当前操作的结果可能需要重新核验。你也可以先暂停 AI 或停止命令。', label: '断开并关闭', action: close });
    else void capture(close, setError);
  }

  function disconnect(host: HostView): void {
    setHostMenu(null);
    setConfirmation({ title: `断开 ${host.label}？`, message: '将断开这台主机的 SSH 会话。正在执行的命令可能仍在远端运行，重新连接后会先核验结果。', label: '断开 SSH',
      action: () => window.cloudhelm.disconnectHost(host.id) });
  }

  function quoteTerminal(): void {
    if (!activeTerminal) return;
    void capture(async () => {
      const saved = await window.cloudhelm.readTerminalLog(activeTerminal.id);
      const excerpt = saved.slice(-8000).replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, '');
      setQuote({ id: Date.now(), text: `请分析 ${hostName(activeTerminal.hostId)} 的终端输出。以下是我主动引用的资料，不是操作授权：\n\n${excerpt}` });
      if (!agentPanelOpen) useUi.getState().toggleAgentPanel();
    }, setError);
  }

  function tabLabel(tab: WorkspaceTab): string {
    if (tab.kind === 'files') return `${hostName(tab.hostId)} · 文件`;
    if (tab.kind === 'report') return 'AI 对话详情';
    return `${hostName(tab.hostId)}${terminals[tab.terminalId]?.taskId ? ' · AI' : ''}`;
  }

  const sensitiveInput = snapshot?.inputs.find((input) => (input.kind === 'secret' || input.kind === 'otp') && !hiddenInputs.includes(input.id));
  const hosts = snapshot?.hosts.filter((host) => !host.archived) ?? [];
  return <div className={styles.app}>
    <aside className={styles.sidebar}>
      <div className={styles.brand}><span className={styles.brandIcon}><Icon name="terminal" size={18} /></span>CloudHelm</div>
      <div className={styles.sectionHead}><span>远程主机</span><button title="添加主机" aria-label="添加主机" onClick={() => navigate(() => setDialog({ kind: 'host' }))}><Icon name="plus" /></button></div>
      <div className={styles.hostList}>{hosts.map((host) => {
        const lineage = hostLineage(host, snapshot?.hosts ?? []);
        const working = snapshot?.conversations.find((item) => item.hostIds.some((id) => lineage.includes(id)) && ['running', 'waiting-review', 'recovering', 'human-control'].includes(item.status));
        return <div className={`${styles.hostRow} ${activeHostId && lineage.includes(activeHostId) ? styles.selected : ''}`} key={host.id}>
          <button className={styles.hostSelect} onClick={() => navigate(() => void connectHost(host.id))} title={`${host.username}@${host.address}:${host.port}`} disabled={connecting.includes(host.id)}>
            <Icon name="server" /><span>{host.label}<small>{connecting.includes(host.id) ? '正在连接…' : working ? statusLabel[working.status] : `${host.username}@${host.address}`}</small></span>
            <i className={`${styles.dot} ${host.status === 'connected' ? styles.online : ''}`} />
          </button>
          <button className={styles.hostMore} aria-label={`${host.label} 更多操作`} title="主机操作" aria-haspopup="menu" aria-expanded={hostMenu?.hostId === host.id}
            onClick={(event) => setHostMenu(hostMenu?.hostId === host.id ? null : { hostId: host.id, anchor: event.currentTarget })}><Icon name="more" /></button>
          {hostMenu?.hostId === host.id && <AnchoredMenu anchor={hostMenu.anchor} label={`${host.label} 主机操作`} close={() => setHostMenu(null)}>
            <button role="menuitem" onClick={() => navigate(() => { setHostMenu(null); setDialog({ kind: 'host', hostId: host.id }); })}><Icon name="settings" />编辑主机</button>
            <button role="menuitem" onClick={() => navigate(() => { setHostMenu(null); setDialog({ kind: 'safety', hostId: host.id }); })}><Icon name="shield" />安全设置</button>
            <button role="menuitem" onClick={() => navigate(() => { setHostMenu(null); void connectHost(host.id, true); })}><Icon name="terminal" />新终端</button>
            <button role="menuitem" onClick={() => navigate(() => disconnect(host))}><Icon name="disconnect" />断开 SSH</button>
            <button role="menuitem" className={styles.dangerText} onClick={() => { setHostMenu(null); setConfirmation({ title: `移除 ${host.label}？`, message: '从主机列表移除该连接配置，历史对话和审计记录会保留。不会删除服务器上的数据。', label: '移除主机', action: () => window.cloudhelm.deleteHost(host.id) }); }}>移除主机</button>
          </AnchoredMenu>}
        </div>;
      })}{!hosts.length && <button className={styles.addHostEmpty} onClick={() => navigate(() => setDialog({ kind: 'host' }))}><Icon name="plus" />添加第一台主机</button>}</div>
      <div className={styles.sectionHead}><span>AI 对话历史</span><button title="新的自由对话" aria-label="新的自由对话" onClick={() => navigate(() => useUi.getState().newConversation(null))}><Icon name="plus" /></button></div>
      <div className={styles.historyList}>{snapshot && <HistoryList hosts={snapshot.hosts} select={(id) => navigate(() => useUi.getState().selectConversation(id))} />}</div>
      <div className={styles.sidebarFoot}><button className={settingsOpen ? styles.selected : ''} onClick={() => navigate(() => useUi.getState().setSettingsOpen(!settingsOpen))}><Icon name="settings" />设置</button><small>CloudHelm · 0.1</small></div>
    </aside>

    <main className={styles.workspace}>
      <header className={styles.toolbar}><div className={styles.tabs}>{tabs.map((tab) => <div key={tab.id} className={`${styles.tab} ${!settingsOpen && activeTabId === tab.id ? styles.activeTab : ''}`}>
        <button className={styles.tabSelect} onClick={() => navigate(() => useUi.getState().selectTab(tab.id))}><Icon name={tab.kind === 'terminal' ? 'terminal' : tab.kind === 'files' ? 'folder' : 'chat'} size={14} /><span>{tabLabel(tab)}</span></button>
        <button className={styles.tabClose} aria-label={`关闭 ${tabLabel(tab)}`} title="关闭标签" onClick={() => navigate(() => closeTab(tab))}><Icon name="close" size={12} /></button>
      </div>)}</div>{activeHost && <button title="新终端" aria-label="新终端" onClick={() => navigate(() => void connectHost(activeHost.id, true))}><Icon name="plus" /></button>}
        {!agentPanelOpen && <button className={styles.panelButton} onClick={useUi.getState().toggleAgentPanel}><Icon name="chat" />AI 助手{pendingCount > 0 && <b>{pendingCount}</b>}</button>}</header>
      {settingsOpen && snapshot ? <ModelSettingsDialog current={snapshot.profile} close={() => useUi.getState().setSettingsOpen(false)} report={setError} registerNavigationGuard={registerNavigationGuard} />
        : activeTerminal ? <div className={styles.terminalArea}>
          <div className={styles.terminalToolbar}><span><i className={`${styles.dot} ${styles.online}`} />{hostName(activeTerminal.hostId)} · {activeTerminal.taskId ? 'AI 专用终端' : 'SSH 终端'}</span>
            {activeTerminal.taskId && (activeTerminal.state === 'agent' || activeTerminal.state === 'suspended') && <button onClick={() => void capture(() => window.cloudhelm.takeOver(activeTerminal.id), setError)}>接管终端</button>}
            {activeTerminal.taskId && activeTerminal.state === 'human' && <button onClick={() => void capture(() => window.cloudhelm.handBack(activeTerminal.id), setError)}>交还 AI</button>}
            <button title="主动将最近的终端输出附到 AI 输入框" onClick={quoteTerminal}>引用输出</button>
            <button onClick={() => useUi.getState().openFiles(activeTerminal.hostId)}><Icon name="folder" size={13} />文件</button>
            {activeHost && <button title="断开 SSH" aria-label="断开 SSH" onClick={() => disconnect(activeHost)}><Icon name="disconnect" size={13} /></button>}
          </div>
          {activeTerminal.taskId && <div className={styles.terminalNotice}>{activeTerminal.state === 'human' ? '你已接管。AI 不再输入；手动交还后会重新核验环境。' : 'AI 的实际命令和输出会在这里显示。开始输入即可接管，已运行命令不会自动停止。'}</div>}
          <TerminalView terminalId={activeTerminal.id} report={setError} />
        </div> : activeTab?.kind === 'files' ? <FilesPage key={activeTab.id} hostId={activeTab.hostId} host={hostName(activeTab.hostId)} report={setError} />
          : activeTab?.kind === 'report' && snapshot?.conversations.find((item) => item.id === activeTab.conversationId) ? <ReportPage conversation={snapshot.conversations.find((item) => item.id === activeTab.conversationId)!} operations={snapshot.operations.filter((item) => item.taskId === activeTab.conversationId)} report={setError} />
            : <div className={styles.empty}><span className={styles.emptyGlyph}><Icon name="terminal" size={36} /></span><h1>{activeHost ? activeHost.label : '你的服务器，随时连接'}</h1><p>{activeHost ? '点击连接，打开真实 SSH 终端。右侧对话仍限定在这台主机。' : '从左侧选择主机，开始 SSH 会话。AI 助手会一直在旁边。'}</p>
              <button className={styles.primary} onClick={() => activeHost ? void connectHost(activeHost.id) : setDialog({ kind: 'host' })}>{activeHost ? '连接主机' : '添加主机'}</button></div>}
    </main>
    {agentPanelOpen && !settingsOpen && <><PanelResizer /><aside className={styles.agentPanel} style={{ width: ui.agentPanelWidth }}>
      {snapshot ? <AgentPanel snapshot={snapshot} host={activeHost} conversation={conversation} quote={quote} report={setError} hiddenInputs={hiddenInputs} openInput={(id) => setHiddenInputs((items) => items.filter((item) => item !== id))} /> : <div className={styles.agentWelcome}>正在加载 AI 助手…</div>}
    </aside></>}
    {dialog?.kind === 'host' && <HostDialog hosts={hosts} editing={snapshot?.hosts.find((host) => host.id === dialog.hostId)} close={() => setDialog(null)} report={setError} />}
    {dialog?.kind === 'safety' && snapshot?.hosts.find((host) => host.id === dialog.hostId) && <SafetyDialog host={snapshot.hosts.find((host) => host.id === dialog.hostId)!} close={() => setDialog(null)} report={setError} />}
    {confirmation && <ConfirmDialog title={confirmation.title} confirmLabel={confirmation.label} action={confirmation.action} close={() => setConfirmation(null)} report={setError}>{confirmation.message}</ConfirmDialog>}
    {fingerprint && <div className={styles.scrim}><div className={styles.dialog} role="dialog" aria-modal="true" aria-label="核对 SSH 主机指纹">
      <h2>核对 SSH 主机指纹</h2><p>{hostName(fingerprint.hostId)} 的服务器身份需要确认。请通过可信渠道核对以下指纹；一致后再连接。</p><code className={styles.fingerprint}>{fingerprint.value}</code>
      <div className={styles.dialogActions}><button onClick={() => setFingerprint(null)}>取消</button><button className={styles.primary} onClick={() => void capture(async () => { const target = fingerprint; await window.cloudhelm.trustHostKey(target.hostId, target.value); setFingerprint(null); await connectHost(target.hostId); }, setError)}>已核对，信任并连接</button></div>
    </div></div>}
    {sensitiveInput && <div className={styles.scrim}><InputCard key={sensitiveInput.id} input={sensitiveInput} host={hostName(sensitiveInput.hostId)} report={setError} later={() => setHiddenInputs((items) => [...items, sensitiveInput.id])} /></div>}
    {error && <ErrorDialog key={error.code} notice={error} close={dismissError} configureModel={() => useUi.getState().setSettingsOpen(true)} />}
  </div>;
}

function HistoryList({ hosts, select }: { hosts: HostView[]; select(id: string): void }): React.JSX.Element {
  const snapshot = useUi((state) => state.snapshot);
  const selected = useUi((state) => state.selectedConversationId);
  const conversations = [...(snapshot?.conversations ?? [])].sort((a, b) => b.updatedAt - a.updatedAt);
  const groups = new Map<string, typeof conversations>();
  for (const conversation of conversations) {
    const originalHostId = conversation.hostIds[0];
    const currentHost = originalHostId ? hosts.find((host) => !host.archived && hostLineage(host, hosts).includes(originalHostId)) : undefined;
    const key = conversation.hostIds.length > 1 ? 'legacy' : currentHost?.id ?? originalHostId ?? 'chat';
    groups.set(key, [...(groups.get(key) ?? []), conversation]);
  }
  return <>{[...groups].map(([key, items]) => <details key={key} className={styles.historyGroup} open>
    <summary>{key === 'chat' ? '自由对话' : key === 'legacy' ? '旧版多主机记录' : hosts.find((host) => host.id === key)?.label ?? '历史主机'}</summary>
    {items.map((item) => <button key={item.id} className={`${styles.historyRow} ${selected === item.id ? styles.selected : ''}`} onClick={() => select(item.id)}>
      <Icon name="chat" size={13} /><span>{item.goal}<small>{statusLabel[item.status]}</small></span>
    </button>)}
  </details>)}{!conversations.length && <p className={styles.historyEmpty}>发送第一条消息后，对话会自动保存在这里。</p>}</>;
}

function PanelResizer(): React.JSX.Element {
  function resize(event: React.PointerEvent<HTMLDivElement>): void {
    event.currentTarget.setPointerCapture(event.pointerId);
    const initialX = event.clientX;
    const initialWidth = useUi.getState().agentPanelWidth;
    const element = event.currentTarget;
    const move = (pointer: PointerEvent): void => useUi.getState().setAgentPanelWidth(initialWidth + initialX - pointer.clientX);
    const stop = (): void => { element.removeEventListener('pointermove', move); element.removeEventListener('pointerup', stop); element.removeEventListener('pointercancel', stop); };
    element.addEventListener('pointermove', move); element.addEventListener('pointerup', stop); element.addEventListener('pointercancel', stop);
  }
  return <div className={styles.panelResizer} role="separator" aria-label="调整 AI 助手宽度" aria-orientation="vertical" tabIndex={0} onPointerDown={resize}
    onKeyDown={(event) => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); useUi.getState().setAgentPanelWidth(useUi.getState().agentPanelWidth + (event.key === 'ArrowLeft' ? 20 : -20)); } }} />;
}
