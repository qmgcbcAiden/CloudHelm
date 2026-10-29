import { contextBridge, ipcRenderer } from 'electron';
import type { AppEvent, DesktopAPI } from '@cloudhelm/contracts';

const invoke = <T>(method: string, ...args: unknown[]): Promise<T> => ipcRenderer.invoke(`cloudhelm:${method}`, ...args) as Promise<T>;

const api: DesktopAPI = {
  quoteTerminal: (input) => invoke('quote-terminal', input),
  readReference: (id) => invoke('read-reference', id),
  sendStructured: (input) => invoke('send-structured', input),
  cancelMessage: (id) => invoke('cancel-message', id),
  snapshot: () => invoke('snapshot'),
  appVersion: () => invoke('app-version'),
  addHost: (host) => invoke('add-host', host),
  editHost: (hostId, host, newSecret) => invoke('edit-host', hostId, host, newSecret),
  testHostConnection: (input) => invoke('test-host', input),
  setHostSecret: (hostId, secret) => invoke('set-host-secret', hostId, secret),
  updateHostReviewMode: (hostId, mode) => invoke('update-host-review-mode', hostId, mode),
  updateHostSafety: (hostId, mode, protectedReadPaths, protectedWritePaths, sudoCacheMode) => invoke('update-host-safety', hostId, mode, protectedReadPaths, protectedWritePaths, sudoCacheMode),
  updateConversationReviewMode: (taskId, hostId, mode) => invoke('update-conversation-review-mode', taskId, hostId, mode),
  requestAiDenialReview: (taskId, operationId) => invoke('request-ai-denial-review', taskId, operationId),
  recoverFileTransaction: (transactionId) => invoke('recover-file-transaction', transactionId),
  readFilePreview: (operationId) => invoke('read-file-preview', operationId),
  readRecoveryOperationLog: (operationId, cursor) => invoke('read-recovery-operation-log', operationId, cursor),
  acceptOperationRisk: (operationId, explanation, sourceTaskId, evidenceOperationIds) => invoke('accept-operation-risk', operationId, explanation, sourceTaskId, evidenceOperationIds),
  saveModelProfile: (profile) => invoke('save-profile', profile),
  testModelConnection: (profile) => invoke('test-model', profile),
  availableModels: () => invoke('available-models'),
  saveReviewSettings: (settings) => invoke('save-review-settings', settings),
  shortcuts: () => invoke('shortcuts'),
  saveShortcuts: (settings) => invoke('save-shortcuts', settings),
  readClipboard: () => invoke('read-clipboard'),
  writeClipboard: (text) => invoke('write-clipboard', text),
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
  stopTerminal: (terminalId) => invoke('stop-terminal', terminalId),
  resizeTerminal: (terminalId, cols, rows) => invoke('resize', terminalId, cols, rows),
  startConversation: (input) => invoke('start-conversation', input),
  sendMessage: (id, message, tokens) => invoke('send-message', id, message, tokens ?? []),
  setConversationThinking: (id, level) => invoke('set-conversation-thinking', id, level),
  setConversationModel: (id, model) => invoke('set-conversation-model', id, model),
  answerClarification: (taskId, requestId, answers) => invoke('answer-clarification', taskId, requestId, answers),
  cancelClarification: (taskId, requestId) => invoke('cancel-clarification', taskId, requestId),
  stopOperation: (id) => invoke('stop-operation', id),
  decideApproval: (approvalId, approved) => invoke('decide-approval', approvalId, approved),
  answerInput: (requestId, answer) => invoke('answer-input', requestId, answer),
  cancelInput: (requestId) => invoke('cancel-input', requestId),
  pauseConversation: (taskId) => invoke('pause-task', taskId),
  resumeConversation: (taskId) => invoke('resume-task', taskId),
  rebuildVerificationReport: (taskId) => invoke('rebuild-verification-report', taskId),
  extendRequestBudget: (input) => invoke('extend-request-budget', input),
  listRemote: (hostId, path) => invoke('list-remote', hostId, path),
  readTerminalLog: (terminalId) => invoke('read-terminal-log', terminalId),
  deleteConversation: (id) => invoke('delete-conversation', id),
  onEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: AppEvent) => listener(value);
    ipcRenderer.on('cloudhelm:event', handler);
    return () => ipcRenderer.off('cloudhelm:event', handler);
  }
};

contextBridge.exposeInMainWorld('cloudhelm', api);
