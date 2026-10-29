import { createRoot } from 'react-dom/client';
import type { AppEvent, AppSnapshot, DesktopAPI, TerminalViewState, ReferenceBody } from '@cloudhelm/contracts';
import { App } from '../../../apps/desktop/src/renderer/app.js';
import '../../../apps/desktop/src/renderer/global.css';

// This fixture deliberately uses fake hosts, credentials, model responses, and SSH output.
// It validates renderer behavior only; it never opens a network connection.
let listeners: Array<(event: AppEvent) => void> = [];
let sequence = 0;
const calls: Array<Record<string, unknown>> = [];
const view: AppSnapshot = {
  hosts: [
    { id: 'prod', label: '生产服务器', address: '192.0.2.10', port: 22, username: 'ubuntu', auth: 'agent', status: 'disconnected', defaultMode: 'ai-review', policyRevision: 1, protectedPaths: [] },
    { id: 'dev', label: '开发服务器', address: '192.0.2.20', port: 22, username: 'deployer', auth: 'agent', status: 'disconnected', defaultMode: 'ask', policyRevision: 1, protectedPaths: [] }
  ],
  conversations: [], terminals: [], operations: [], approvals: [], inputs: [], messages: [],
  profile: { provider: 'openai', modelId: 'gpt-5.4', hasKey: true, hasJevKey: false }
};
const emit = (event: AppEvent): void => listeners.forEach((listener) => listener(event));
const sync = (): void => emit({ type: 'snapshot', value: structuredClone(view) });
const terminalEvent = (terminal: TerminalViewState): void => emit({ type: 'terminal-state', terminalId: terminal.id, ...terminal });
const unsupported = async (): Promise<never> => { throw new Error('UI smoke reached an unimplemented fixture method'); };
const shortcutSettings = { bindings: {} as Record<string, string>, enabled: true };

const referenceBodies = new Map<string, ReferenceBody>();
const api: DesktopAPI = {
  recoverFileTransaction: unsupported,
  readFilePreview: async (operationId) => ({ status: 'unavailable', operationId, reason: 'expired-or-unavailable' }),
  quoteTerminal: async (input) => {
    const reference = { id: crypto.randomUUID(), kind: 'terminal' as const, terminalId: input.terminalId, hostId: input.hostId, hostLabel: '生产服务器', command: input.selection ? undefined : 'docker ps', capturedAt: Date.now() };
    referenceBodies.set(reference.id, { reference, original: input.selection ?? '$ docker ps\nCONTAINER ID   IMAGE\nabc123        service:latest' });
    calls.push({ kind: 'quote', input }); return reference;
  },
  readReference: async (id) => { const body = referenceBodies.get(id); if (!body) throw new Error('引用不存在'); return body; },
  cancelMessage: async (id) => { calls.push({ kind: 'cancel-message', id }); },
  sendStructured: async (input) => {
    calls.push({ kind: 'structured', input });
    const text = input.document.parts.map((part) => part.type === 'text' ? part.text : part.content ?? referenceBodies.get(part.reference.id)?.original ?? '').join('');
    let id = input.conversationId;
    if (id) await api.sendMessage(id, text, input.localSelectionTokens);
    else id = (await api.startConversation({ ...input, message: text || '请分析这段终端输出' })).id;
    if (input.document.parts.some((part) => part.type === 'reference')) {
      const parts = input.document.parts.map((part) => {
        if (part.type === 'text') return part;
        if (part.content !== undefined) referenceBodies.set(part.reference.id, { reference: part.reference, original: part.content });
        return { type: 'reference' as const, reference: part.reference };
      });
      const message = view.messages.filter((m) => m.taskId === id && m.role === 'user').at(-1)!;
      message.document = { requestId: input.document.requestId, parts }; sync();
    }
    return { conversationId: id };
  },
  snapshot: async () => structuredClone(view),
  onEvent: (listener) => { listeners.push(listener); return () => { listeners = listeners.filter((item) => item !== listener); }; },
  availableModels: async () => [
    { provider: 'openai', modelId: 'gpt-5.4', name: 'GPT-5.4', thinkingLevels: ['off', 'low', 'medium', 'high', 'xhigh'] },
    { provider: 'anthropic', modelId: 'claude-sonnet', name: 'Claude Sonnet' },
    { provider: 'cloudhelm-custom', modelId: 'long-model', name: 'Custom reasoning model with an exceptionally long display name' }
  ],
  updateHostReviewMode: async (id, mode) => {
    calls.push({ kind: 'review-mode', id, mode });
    const host = view.hosts.find((item) => item.id === id)!;
    host.defaultMode = mode; host.policyRevision++; sync();
  },
  updateConversationReviewMode: async (taskId, hostId, mode) => {
    calls.push({ kind: 'review-mode', taskId, hostId, mode });
    const task = view.conversations.find((item) => item.id === taskId)!;
    task.reviewModesByHost = { ...task.reviewModesByHost, [hostId]: mode };
    task.reviewRevision = (task.reviewRevision ?? 1) + 1;
    sync();
  },
  requestAiDenialReview: unsupported,
  connectHost: async (id) => { calls.push({ kind: 'connect', id }); view.hosts.find((host) => host.id === id)!.status = 'connected'; sync(); },
  openTerminal: async (hostId) => {
    const terminal: TerminalViewState = { id: `term${++sequence}`, hostId, state: 'human' };
    view.terminals.push(terminal); terminalEvent(terminal);
    setTimeout(() => emit({ type: 'terminal-data', terminalId: terminal.id, data:
      'Welcome to Ubuntu 24.04.2 LTS (GNU/Linux 6.8.0-52-generic x86_64)\r\n\r\n System load:  0.12             Processes:             126\r\n Usage of /:   24.8% of 48.0GB   Memory usage:          18%\r\n\r\nubuntu@production:~$ ' }), 50);
    return terminal.id;
  },
  closeTerminal: async (id) => {
    calls.push({ kind: 'close', id });
    const terminal = view.terminals.find((item) => item.id === id)!;
    view.terminals = view.terminals.filter((item) => item.id !== id);
    terminalEvent({ ...terminal, state: 'closed' });
  },
  terminalInput: async (id, data) => {
    const terminal = view.terminals.find((item) => item.id === id);
    const task = view.conversations.find((item) => item.id === terminal?.taskId);
    if (task && ['running', 'waiting-review', 'waiting-user'].includes(task.status)) {
      calls.push({ kind: 'blocked-input', id }); throw new Error('AI 正在运行，请先停止再输入');
    }
    calls.push({ kind: 'input', id, data });
  },
  terminalProtocolResponse: async (id, data) => { calls.push({ kind: 'protocol', id, data }); },
  resizeTerminal: async (id, cols, rows) => { calls.push({ kind: 'resize', id, cols, rows }); },
  startConversation: async (input) => {
    calls.push({ kind: 'start', input });
    const conversation = { id: `chat${++sequence}`, goal: input.message, hostIds: input.hostId ? [input.hostId] : [], localScopes: [],
      status: 'running' as const, provider: input.model!.provider, modelId: input.model!.modelId,
      reviewModesByHost: input.hostId ? { [input.hostId]: view.hosts.find((host) => host.id === input.hostId)!.defaultMode } : {},
      reviewRevision: 1, requestCount: 1, requestLimit: 100, createdAt: Date.now(), updatedAt: Date.now() };
    Object.assign(conversation, { thinking: { levels: ['off', 'low', 'medium', 'high', 'xhigh'], selected: input.thinkingLevel ?? 'off', effective: input.thinkingLevel ?? 'off', pending: false }, session: { version: 1, id: conversation.id } });
    view.conversations.push(conversation);
    view.messages.push({ taskId: conversation.id, role: 'user', text: input.message, createdAt: Date.now() });
    sync(); return conversation;
  },
  sendMessage: async (id, message, tokens) => {
    calls.push({ kind: 'send', id, message, tokens }); view.messages.push({ taskId: id, role: 'user', text: message, createdAt: Date.now() }); sync();
  },
  setConversationThinking: async (id, level) => {
    const task = view.conversations.find((item) => item.id === id)!;
    task.thinking = { levels: task.thinking!.levels, selected: level, effective: task.thinking!.effective, pending: true };
    calls.push({ kind: 'thinking', id, level }); sync();
  },
  setConversationModel: async (id, model) => { calls.push({ kind: 'model', id, model }); Object.assign(view.conversations.find((item) => item.id === id)!, model, { thinking: { levels: model.provider === 'cloudhelm-custom' ? [] : ['off', 'low', 'medium', 'high'], selected: 'off', effective: 'off', pending: false } }); if (view.contextUsage) delete view.contextUsage[id]; sync(); },
  readTerminalLog: async () => 'ubuntu@prod:~$ docker ps\nCONTAINER ID   IMAGE\nabc123        service:latest',
  selectLocalPath: async (kind) => ({ token: `local-${kind}`, scope: { path: '/Users/demo/service', kind } }),
  selectPrivateKey: async () => { calls.push({ kind: 'select-private-key' }); return '/Users/demo/.ssh/server key'; },
  pauseConversation: async (id) => { calls.push({ kind: 'pause', id }); view.conversations.find((item) => item.id === id)!.status = 'paused'; sync(); },
  stopTerminal: async (id) => {
    calls.push({ kind: 'stop-terminal', id });
    const terminal = view.terminals.find((item) => item.id === id);
    if (terminal?.taskId) await api.stopOperation(terminal.taskId);
  },
  stopOperation: async (id) => {
    calls.push({ kind: 'stop', id });
    const task = view.conversations.find((item) => item.id === id);
    if (task) task.status = 'paused';
    for (const terminal of view.terminals) if (terminal.taskId === id) { terminal.state = 'human'; terminalEvent(terminal); }
    sync();
  },
  listRemote: async () => [{ name: 'service', isDirectory: true, size: 0 }, { name: 'README.md', isDirectory: false, size: 512 }],
  decideApproval: async (id, approved) => { calls.push({ kind: 'approval', id, approved }); view.approvals = view.approvals.filter((item) => item.id !== id); sync(); },
  answerInput: async (id, answer) => { calls.push({ kind: 'answer', id, answer }); view.inputs = view.inputs.filter((item) => item.id !== id); sync(); },
  listModelProviders: async () => [{ id: 'openai', name: 'OpenAI', defaultBaseUrl: 'https://api.openai.com/v1', models: [{ id: 'gpt-5.4', name: 'GPT-5.4' }] }],
  modelProviderSettings: async () => ({ hasKey: true }),
  testModelConnection: async () => ({ latencyMs: 12 }),
  testHostConnection: async (input) => { calls.push({ kind: 'test-host', input }); return { status: 'success', latencyMs: 42 }; },
  saveModelProfile: async (profile) => { calls.push({ kind: 'profile', profile }); },
  saveReviewSettings: async (settings) => { calls.push({ kind: 'review-settings', settings }); },
  appVersion: async () => '0.1.0-smoke',
  shortcuts: async () => structuredClone(shortcutSettings),
  saveShortcuts: async (settings) => { calls.push({ kind: 'shortcuts', settings }); shortcutSettings.bindings = structuredClone(settings.bindings); shortcutSettings.enabled = settings.enabled; },
  readClipboard: async () => 'pasted from clipboard',
  writeClipboard: async (text) => { calls.push({ kind: 'clipboard-write', text }); },
  deleteConversation: async (id) => {
    calls.push({ kind: 'delete-conversation', id });
    view.conversations = view.conversations.filter((item) => item.id !== id);
    view.messages = view.messages.filter((item) => item.taskId !== id);
    view.operations = view.operations.filter((item) => item.taskId !== id);
    sync();
  },
  resumeConversation: unsupported, extendRequestBudget: unsupported,
  rebuildVerificationReport: unsupported, readRecoveryOperationLog: unsupported, acceptOperationRisk: unsupported,
  answerClarification: unsupported, cancelClarification: unsupported,
  cancelInput: unsupported, addHost: unsupported, editHost: unsupported, updateHostSafety: unsupported,
  disconnectHost: unsupported, deleteHost: unsupported, trustHostKey: unsupported, setHostSecret: unsupported
};
window.cloudhelm = api;

const fixture = {
  calls,
  inject(event: AppEvent): void {
    if (event.type === 'execution') {
      if (event.value.model === 'idle') view.conversations.find((task) => task.id === event.taskId)!.status = 'paused';
      view.execution = { ...view.execution, [event.taskId]: event.value }; sync(); return; }
    if (event.type === 'thinking') { view.conversations.find((task) => task.id === event.taskId)!.thinking = event.value; sync(); return; }
    if (event.type === 'terminal-state') view.terminals.push({ id: event.terminalId, hostId: event.hostId, taskId: event.taskId, state: event.state });
    if (event.type === 'context-compaction') { view.contextCompaction = { ...view.contextCompaction, [event.taskId]: event.status }; sync(); return; }
    if (event.type === 'context-usage') { view.contextUsage = { ...view.contextUsage, [event.taskId]: event.value }; sync(); return; }
    emit(event);
  },
  addInput(options: { cache?: boolean; otp?: boolean } = {}): void {
    view.inputs.push({ id: `secret${++sequence}`, taskId: view.conversations[0]!.id, operationId: 'op1', hostId: 'prod', title: '安装 Docker 需要管理员权限',
      explanation: '服务器请求 sudo 认证信息；再次请求可能是多因素认证，不自动等于密码错误。接收方：当前 sudo 进程。',
      kind: options.otp ? 'otp' : 'secret', allowPasswordCache: options.cache ?? false, expiresAt: Date.now() + 60_000 }); sync();
  },
  running(): void { view.operations[0]!.status = 'running'; view.operations[0]!.logRef = 'agent1'; sync(); },
  decorate(): void {
    const conversation = view.conversations[0]!;
    conversation.plan = [{ id: 'p1', title: '检查服务结构和服务器环境', status: 'done' }, { id: 'p2', title: '生成 Docker 配置并启动容器', status: 'running' }, { id: 'p3', title: '验证服务并提供访问方式', status: 'pending' }];
    view.messages.push({ taskId: conversation.id, role: 'agent', text: '已经确认这台服务器可以运行 Docker。我会先检查现有服务和端口占用，再为你的服务添加容器配置。', createdAt: Date.now() });
    view.operations.push({ id: 'op1', taskId: conversation.id, hostId: 'prod', kind: 'command', preview: 'docker version && ss -tlnp', status: 'succeeded', exitCode: 0, outputTail: 'Docker version 28.0.4\nLISTEN 0 4096 0.0.0.0:22', createdAt: Date.now() });
    view.approvals.push({ id: 'ap1', taskId: conversation.id, operationId: 'op2', hostId: 'prod', fingerprint: 'fixture', title: '需要你确认安装系统依赖', explanation: '这一步会安装 Docker 所需的软件包并修改系统服务配置。完成后会检查服务状态。', preview: 'sudo apt-get install -y docker.io', expiresAt: Date.now() + 60_000 }); sync();
  }
};
Object.assign(window, { fixture });
createRoot(document.getElementById('root')!).render(<App />);
