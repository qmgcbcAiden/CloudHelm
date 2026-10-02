import { create } from 'zustand';
import type { AppEvent, AppSnapshot, ModelChoice, TaskView, TerminalViewState } from '@cloudhelm/contracts';

export interface TerminalTab extends TerminalViewState { buffer: string; offset: number }
export type WorkspaceTab = { id: string; kind: 'terminal'; terminalId: string; hostId: string }
  | { id: string; kind: 'files'; hostId: string }
  | { id: string; kind: 'report'; conversationId: string; hostId: string | null };

interface UiState {
  snapshot: AppSnapshot | null;
  terminals: Record<string, TerminalTab>;
  tabs: WorkspaceTab[];
  activeTabId: string | null;
  activeHostId: string | null;
  selectedConversationId: string | null;
  conversationSelection: Record<string, string | null>;
  currentRequests: Record<string, { model: ModelChoice; request: number }>;
  agentPanelOpen: boolean;
  agentPanelWidth: number;
  settingsOpen: boolean;
  setSnapshot(snapshot: AppSnapshot): void;
  applyEvent(event: AppEvent): void;
  openTerminal(id: string): void;
  openFiles(hostId: string): void;
  openReport(conversationId: string): void;
  selectTab(id: string): void;
  closeTab(id: string): void;
  selectConversation(id: string): void;
  newConversation(hostId: string | null): void;
  setSettingsOpen(open: boolean): void;
  toggleAgentPanel(): void;
  setAgentPanelWidth(width: number): void;
}

const hostKey = (hostId: string | null): string => hostId ?? 'local-chat';
function conversationFor(state: UiState, hostId: string | null): string | null {
  const remembered = state.conversationSelection[hostKey(hostId)];
  if (remembered === null) return null;
  const conversations = state.snapshot?.conversations ?? [];
  if (remembered && conversations.some((item) => item.id === remembered)) return remembered;
  return conversations.filter((item) => hostId ? item.hostIds.length === 1 && item.hostIds[0] === hostId : !item.hostIds.length)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0]?.id ?? null;
}

function tabSelection(state: UiState, tab: WorkspaceTab | undefined): Partial<UiState> {
  const hostId = tab?.hostId ?? null;
  const explicitConversation = tab?.kind === 'report' ? tab.conversationId
    : tab?.kind === 'terminal' ? state.terminals[tab.terminalId]?.taskId : undefined;
  return { activeTabId: tab?.id ?? null, activeHostId: hostId,
    selectedConversationId: explicitConversation ?? conversationFor(state, hostId), settingsOpen: false,
    ...(explicitConversation ? { conversationSelection: { ...state.conversationSelection, [hostKey(hostId)]: explicitConversation } } : {}) };
}

function closeTab(state: UiState, id: string): Partial<UiState> {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  const tabs = state.tabs.filter((tab) => tab.id !== id);
  return { tabs, ...(state.activeTabId === id ? tabSelection(state, tabs[Math.min(index, tabs.length - 1)]) : {}), settingsOpen: state.settingsOpen };
}

function projectSnapshot(state: UiState, snapshot: AppSnapshot): Partial<UiState> {
  const terminals: Record<string, TerminalTab> = {};
  for (const terminal of snapshot.terminals ?? Object.values(state.terminals)) {
    if (terminal.state !== 'closed') terminals[terminal.id] = { ...terminal, buffer: state.terminals[terminal.id]?.buffer ?? '', offset: state.terminals[terminal.id]?.offset ?? 0 };
  }
  const tabs = state.tabs.filter((tab) => tab.kind !== 'terminal' || terminals[tab.terminalId]);
  const next = { ...state, snapshot, terminals, tabs };
  const selection = state.activeTabId && !tabs.some((tab) => tab.id === state.activeTabId)
    ? tabSelection(next, tabs.at(-1)) : { selectedConversationId: conversationFor(next, state.activeHostId) };
  return { snapshot, terminals, tabs, ...selection, settingsOpen: state.settingsOpen };
}

function updateConversation(state: UiState, id: string, change: Partial<TaskView>): Partial<UiState> {
  if (!state.snapshot) return {};
  return { snapshot: { ...state.snapshot, conversations: state.snapshot.conversations.map((item) => item.id === id ? { ...item, ...change } : item) } };
}

export const useUi = create<UiState>((set) => ({
  snapshot: null, terminals: {}, tabs: [], activeTabId: null, activeHostId: null, selectedConversationId: null,
  conversationSelection: {}, currentRequests: {}, agentPanelOpen: true, agentPanelWidth: 400, settingsOpen: false,
  setSnapshot: (snapshot) => set((state) => projectSnapshot(state, snapshot)),
  applyEvent: (event) => set((state) => {
    if (event.type === 'snapshot') return projectSnapshot(state, event.value);
    if (event.type === 'terminal-data') {
      const tab = state.terminals[event.terminalId];
      if (!tab) return {};
      const joined = tab.buffer + event.data;
      const dropped = Math.max(0, joined.length - 100_000);
      return { terminals: { ...state.terminals, [tab.id]: { ...tab, buffer: joined.slice(dropped), offset: tab.offset + dropped } } };
    }
    if (event.type === 'terminal-state') {
      if (event.state === 'closed') {
        const terminals = { ...state.terminals };
        delete terminals[event.terminalId];
        return { ...closeTab(state, event.terminalId), terminals };
      }
      const previous = state.terminals[event.terminalId];
      const terminal: TerminalTab = { id: event.terminalId, hostId: event.hostId, taskId: event.taskId,
        state: event.state, buffer: previous?.buffer ?? '', offset: previous?.offset ?? 0 };
      return { terminals: { ...state.terminals, [terminal.id]: terminal } };
    }
    if (event.type === 'model-request') return { currentRequests: { ...state.currentRequests, [event.taskId]: { model: event.model, request: event.request } } };
    if (event.type === 'work-progress') return updateConversation(state, event.taskId, { plan: event.plan });
    if (event.type === 'work-report') return updateConversation(state, event.taskId, { report: event.report });
    if (event.type === 'task-message' && state.snapshot) {
      const duplicate = state.snapshot.messages.some((message) => message.taskId === event.taskId && message.createdAt === event.createdAt && message.role === event.role && message.text === event.text);
      return duplicate ? {} : { snapshot: { ...state.snapshot, messages: [...state.snapshot.messages, event] } };
    }
    return {};
  }),
  openTerminal: (id) => set((state) => {
    const terminal = state.terminals[id];
    if (!terminal) return {};
    const tab: WorkspaceTab = { id, kind: 'terminal', terminalId: id, hostId: terminal.hostId };
    return { tabs: state.tabs.some((item) => item.id === id) ? state.tabs : [...state.tabs, tab], ...tabSelection(state, tab) };
  }),
  openFiles: (hostId) => set((state) => {
    const tab: WorkspaceTab = { id: `files:${hostId}`, kind: 'files', hostId };
    return { tabs: state.tabs.some((item) => item.id === tab.id) ? state.tabs : [...state.tabs, tab], ...tabSelection(state, tab) };
  }),
  openReport: (conversationId) => set((state) => {
    const conversation = state.snapshot?.conversations.find((item) => item.id === conversationId);
    if (!conversation) return {};
    const tab: WorkspaceTab = { id: `report:${conversationId}`, kind: 'report', conversationId, hostId: conversation.hostIds[0] ?? null };
    return { tabs: state.tabs.some((item) => item.id === tab.id) ? state.tabs : [...state.tabs, tab], ...tabSelection(state, tab) };
  }),
  selectTab: (id) => set((state) => tabSelection(state, state.tabs.find((tab) => tab.id === id))),
  closeTab: (id) => set((state) => closeTab(state, id)),
  selectConversation: (id) => set((state) => {
    const conversation = state.snapshot?.conversations.find((item) => item.id === id);
    if (!conversation) return {};
    const hostId = conversation.hostIds[0] ?? null;
    const terminal = state.tabs.find((tab) => tab.kind === 'terminal' && tab.hostId === hostId && !state.terminals[tab.terminalId]?.taskId);
    return { selectedConversationId: id, activeHostId: hostId, activeTabId: terminal?.id ?? null,
      conversationSelection: { ...state.conversationSelection, [hostKey(hostId)]: id }, agentPanelOpen: true, settingsOpen: false };
  }),
  newConversation: (hostId) => set((state) => ({ selectedConversationId: null, activeHostId: hostId,
    activeTabId: hostId === state.activeHostId ? state.activeTabId : null,
    conversationSelection: { ...state.conversationSelection, [hostKey(hostId)]: null }, agentPanelOpen: true })),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  toggleAgentPanel: () => set((state) => ({ agentPanelOpen: !state.agentPanelOpen })),
  setAgentPanelWidth: (width) => set({ agentPanelWidth: Math.max(330, Math.min(620, width)) })
}));
