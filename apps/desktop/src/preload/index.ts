import { contextBridge, ipcRenderer } from 'electron';
import type { AppEvent, DesktopAPI } from '@cloudhelm/contracts';

const invoke = <T>(method: string, ...args: unknown[]): Promise<T> => ipcRenderer.invoke(`cloudhelm:${method}`, ...args) as Promise<T>;

const api: DesktopAPI = {
  snapshot: () => invoke('snapshot'),
  addHost: (host) => invoke('add-host', host),
  editHost: (hostId, host, newSecret) => invoke('edit-host', hostId, host, newSecret),
  testHostConnection: (input) => invoke('test-host', input),
  setHostSecret: (hostId, secret) => invoke('set-host-secret', hostId, secret),
  updateHostSafety: (hostId, mode, protectedPaths) => invoke('update-host-safety', hostId, mode, protectedPaths),
  saveModelProfile: (profile) => invoke('save-profile', profile),
  testModelConnection: (profile) => invoke('test-model', profile),
  availableModels: () => invoke('available-models'),
  saveReviewSettings: (settings) => invoke('save-review-settings', settings),
  listModelProviders: () => invoke('list-model-providers'),
  modelProviderSettings: (providerId) => invoke('model-provider-settings', providerId),
  disconnectHost: (hostId) => invoke('disconnect-host', hostId),
  deleteHost: (hostId) => invoke('delete-host', hostId),
  connectHost: (hostId) => invoke('connect-host', hostId),
  trustHostKey: (hostId, fingerprint) => invoke('trust-host-key', hostId, fingerprint),
  openTerminal: (hostId) => invoke('open-terminal', hostId),
  closeTerminal: (terminalId) => invoke('close-terminal', terminalId),
  selectLocalPath: (kind) => invoke('select-local-path', kind),
  selectPrivateKey: () => invoke('select-private-key'),
  terminalInput: (terminalId, data) => invoke('terminal-input', terminalId, data),
  terminalProtocolResponse: (terminalId, data) => invoke('terminal-protocol', terminalId, data),
  takeOver: (terminalId) => invoke('take-over', terminalId),
  handBack: (terminalId) => invoke('hand-back', terminalId),
  resizeTerminal: (terminalId, cols, rows) => invoke('resize', terminalId, cols, rows),
  startConversation: (input) => invoke('start-conversation', input),
  sendMessage: (id, message, tokens) => invoke('send-message', id, message, tokens ?? []),
  setConversationModel: (id, model) => invoke('set-conversation-model', id, model),
  stopOperation: (id) => invoke('stop-operation', id),
  decideApproval: (approvalId, approved) => invoke('decide-approval', approvalId, approved),
  answerInput: (requestId, answer) => invoke('answer-input', requestId, answer),
  cancelInput: (requestId) => invoke('cancel-input', requestId),
  pauseConversation: (taskId) => invoke('pause-task', taskId),
  resumeConversation: (taskId) => invoke('resume-task', taskId),
  acceptConversation: (taskId) => invoke('accept-task', taskId),
  listRemote: (hostId, path) => invoke('list-remote', hostId, path),
  readTerminalLog: (terminalId) => invoke('read-terminal-log', terminalId),
  onEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: AppEvent) => listener(value);
    ipcRenderer.on('cloudhelm:event', handler);
    return () => ipcRenderer.off('cloudhelm:event', handler);
  }
};

contextBridge.exposeInMainWorld('cloudhelm', api);
