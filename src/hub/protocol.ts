/**
 * WebSocket protocol type definitions for CrossChat hub-and-spoke messaging.
 *
 * Defines all agent-to-server and server-to-agent message shapes as
 * discriminated unions keyed on the `type` field.
 */

// ─── Shared types ────────────────────────────────────────────────

export type AgentStatus = 'available' | 'busy';

export interface PeerInfo {
  peerId: string;
  name: string;
  cwd: string;
  pid: number;
  status: AgentStatus;
  statusDetail?: string;
  currentRoom: string;
  connectedAt: string;
}

export type HubTaskStatus = 'open' | 'claimed' | 'in_progress' | 'completed' | 'failed' | 'archived';

export interface TaskFilter {
  agentId?: string;
  workingDirReq?: string;
  gitProject?: string;
}

export interface TaskNote {
  noteId: string;
  authorId: string;
  authorName: string;
  content: string;    // markdown
  timestamp: string;
}

export interface TaskSummary {
  taskId: string;
  roomId: string;
  creatorId: string;
  creatorName: string;
  description: string;
  context?: string;
  filter?: TaskFilter;
  status: HubTaskStatus;
  claimantId?: string;
  claimantName?: string;
  createdAt: string;
  updatedAt: string;
}

// ─── Agent-to-server messages ────────────────────────────────────

export interface AgentRegisterMessage {
  type: 'agent.register';
  peerId: string;
  name: string;
  cwd: string;
  pid: number;
}

export interface AgentHeartbeatMessage {
  type: 'agent.heartbeat';
}

export interface AgentStatusMessage {
  type: 'agent.status';
  status: AgentStatus;
  detail?: string;
  taskId?: string;
}

export interface AgentDisconnectMessage {
  type: 'agent.disconnect';
}

export interface AgentJoinRoomMessage {
  type: 'agent.joinRoom';
  roomId: string;
}

export interface AgentCreateRoomMessage {
  type: 'agent.createRoom';
  roomId: string;
  name?: string;
}

export interface AgentSendMessageMessage {
  type: 'agent.sendMessage';
  content: string;
  metadata?: Record<string, unknown>;
}

export interface AgentListPeersMessage {
  type: 'agent.listPeers';
  requestId: string;
}

export interface TaskCreateMessage {
  type: 'task.create';
  description: string;
  context?: string;
  filter?: TaskFilter;
}

export interface TaskClaimMessage {
  type: 'task.claim';
  taskId: string;
}

export interface TaskAcceptMessage {
  type: 'task.accept';
  taskId: string;
  claimantId: string;
}

export interface TaskUpdateMessage {
  type: 'task.update';
  taskId: string;
  content: string;    // markdown
  status?: HubTaskStatus;
}

export interface TaskCompleteMessage {
  type: 'task.complete';
  taskId: string;
  result: string;     // markdown
  status: 'completed' | 'failed';
  error?: string;
}

export interface AgentListTasksMessage {
  type: 'agent.listTasks';
  requestId: string;
  status?: string;
  roomId?: string;
  assignedTo?: string;
}

export interface AgentClearSessionMessage {
  type: 'agent.clearSession';
  requestId: string;
  messages?: boolean;   // clear messages from current room (default true)
  tasks?: boolean;      // archive completed/failed tasks (default false)
}

export type AgentMessage =
  | AgentRegisterMessage
  | AgentHeartbeatMessage
  | AgentStatusMessage
  | AgentDisconnectMessage
  | AgentJoinRoomMessage
  | AgentCreateRoomMessage
  | AgentSendMessageMessage
  | AgentListPeersMessage
  | TaskCreateMessage
  | TaskClaimMessage
  | TaskAcceptMessage
  | TaskUpdateMessage
  | TaskCompleteMessage
  | AgentListTasksMessage
  | AgentClearSessionMessage;

// ─── Server-to-agent messages ────────────────────────────────────

export interface RegisteredMessage {
  type: 'registered';
  peerId: string;
  serverVersion: string;
}

export interface PeersMessage {
  type: 'peers';
  requestId: string;
  peers: PeerInfo[];
}

export interface RoomJoinedMessage {
  type: 'room.joined';
  roomId: string;
  name: string;
}

export interface RoomCreatedMessage {
  type: 'room.created';
  roomId: string;
  name: string;
}

export interface RoomMessageMessage {
  type: 'room.message';
  roomId: string;
  messageId: string;
  fromPeerId: string;
  fromName: string;
  content: string;
  metadata?: Record<string, unknown>;
  timestamp: string;
  source: 'agent' | 'user';
  mentions?: string[];       // mentioned agent names
  mentionType?: 'direct' | 'here' | 'broadcast';
}

export interface TaskCreatedMessage {
  type: 'task.created';
  task: TaskSummary;
}

export interface TaskClaimedMessage {
  type: 'task.claimed';
  taskId: string;
  claimantId: string;
  claimantName: string;
}

export interface TaskClaimAcceptedMessage {
  type: 'task.claimAccepted';
  taskId: string;
  assignedTo: string;
}

export interface TaskUpdatedMessage {
  type: 'task.updated';
  taskId: string;
  note: TaskNote;
}

export interface TaskCompletedMessage {
  type: 'task.completed';
  taskId: string;
  status: 'completed' | 'failed';
  result?: string;
}

export interface TasksMessage {
  type: 'tasks';
  requestId: string;
  tasks: TaskSummary[];
}

export interface SessionClearedMessage {
  type: 'session.cleared';
  requestId: string;
  messagesCleared: number;
  tasksArchived: number;
}

export interface ErrorMessage {
  type: 'error';
  message: string;
  requestId?: string;
}

export type ServerMessage =
  | RegisteredMessage
  | PeersMessage
  | RoomJoinedMessage
  | RoomCreatedMessage
  | RoomMessageMessage
  | TaskCreatedMessage
  | TaskClaimedMessage
  | TaskClaimAcceptedMessage
  | TaskUpdatedMessage
  | TaskCompletedMessage
  | TasksMessage
  | SessionClearedMessage
  | ErrorMessage;

// ─── Helpers ─────────────────────────────────────────────────────

/** Serialise a protocol message to a JSON string for sending over WebSocket. */
export function encodeMessage(msg: AgentMessage | ServerMessage): string {
  return JSON.stringify(msg);
}

/** Deserialise a raw WebSocket payload into a typed protocol message. */
export function decodeMessage(data: string): ServerMessage | AgentMessage {
  const parsed = JSON.parse(data);
  if (typeof parsed !== 'object' || parsed === null || typeof parsed.type !== 'string') {
    throw new Error('Invalid protocol message: missing or non-string "type" field');
  }
  return parsed as ServerMessage | AgentMessage;
}
