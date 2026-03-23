/**
 * WebSocket protocol type definitions for CrossChat hub-and-spoke messaging.
 *
 * Defines all agent-to-server and server-to-agent message shapes as
 * discriminated unions keyed on the `type` field.
 *
 * v2: Unified messaging — rooms renamed to channels, tasks replaced by
 * message badges, threads via threadId on messages.
 */

import type { Badge, TaskFilter } from './message-manager.js';

// ─── Shared types ────────────────────────────────────────────────

export type AgentStatus = 'available' | 'busy';

export interface PeerInfo {
  peerId: string;
  name: string;
  cwd: string;
  pid: number;
  status: AgentStatus;
  statusDetail?: string;
  currentChannel: string;
  connectedAt: string;
}

export type MessageImportance = 'important' | 'comment' | 'chitchat';

// ─── Agent-to-server messages ────────────────────────────────────

export interface AgentRegisterMessage {
  type: 'agent.register';
  peerId: string;
  name: string;
  cwd: string;
  pid: number;
  parentPid?: number;
}

export interface AgentHeartbeatMessage {
  type: 'agent.heartbeat';
}

export interface AgentStatusMessage {
  type: 'agent.status';
  status: AgentStatus;
  detail?: string;
  taskMessageId?: string;
}

export interface AgentDisconnectMessage {
  type: 'agent.disconnect';
}

export interface AgentSendMessageMessage {
  type: 'agent.sendMessage';
  content: string;
  threadId?: string;
  metadata?: Record<string, unknown>;
  importance?: MessageImportance;
}

export interface AgentListPeersMessage {
  type: 'agent.listPeers';
  requestId: string;
}

export interface AgentGetMessagesMessage {
  type: 'agent.getMessages';
  requestId: string;
  threadId?: string;
  limit?: number;
  afterMessageId?: string;
}

export interface AgentFlagTaskMessage {
  type: 'agent.flagTask';
  requestId: string;
  messageId: string;
  filter?: TaskFilter;
}

export interface AgentClaimTaskMessage {
  type: 'agent.claimTask';
  requestId: string;
  messageId: string;
}

export interface AgentResolveTaskMessage {
  type: 'agent.resolveTask';
  requestId: string;
  messageId: string;
  status: 'completed' | 'failed';
  result: string;
  error?: string;
}

export interface AgentAddBadgeMessage {
  type: 'agent.addBadge';
  requestId: string;
  messageId: string;
  badgeType: string;
  badgeValue: string;
  label?: string;
}

export interface AgentClearSessionMessage {
  type: 'agent.clearSession';
  requestId: string;
  messages?: boolean;
}

export type AgentMessage =
  | AgentRegisterMessage
  | AgentHeartbeatMessage
  | AgentStatusMessage
  | AgentDisconnectMessage
  | AgentSendMessageMessage
  | AgentListPeersMessage
  | AgentGetMessagesMessage
  | AgentFlagTaskMessage
  | AgentClaimTaskMessage
  | AgentResolveTaskMessage
  | AgentAddBadgeMessage
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

export interface ChannelMessageMessage {
  type: 'channel.message';
  channelId: string;
  messageId: string;
  threadId?: string;
  fromPeerId: string;
  fromName: string;
  content: string;
  metadata?: Record<string, unknown>;
  timestamp: string;
  source: 'agent' | 'user' | 'system';
  mentions?: string[];
  mentionType?: 'direct' | 'here' | 'broadcast';
  importance?: MessageImportance;
  badges: Badge[];
}

export interface MessageBadgeAddedMessage {
  type: 'message.badgeAdded';
  messageId: string;
  badge: Badge;
}

export interface MessageUpdatedMessage {
  type: 'message.updated';
  messageId: string;
  badges: Badge[];
}

export interface TaskFlaggedMessage {
  type: 'task.flagged';
  requestId: string;
  messageId: string;
  badges: Badge[];
}

export interface TaskClaimedMessage {
  type: 'task.claimed';
  requestId: string;
  messageId: string;
  claimantId: string;
  claimantName: string;
}

export interface TaskResolvedMessage {
  type: 'task.resolved';
  requestId: string;
  messageId: string;
  status: 'completed' | 'failed';
  result: string;
}

export interface BadgeAddedMessage {
  type: 'badge.added';
  requestId: string;
  messageId: string;
  badge: Badge;
}

export interface MessagesResponseMessage {
  type: 'messages';
  requestId: string;
  messages: ChannelMessageMessage[];
  threadId?: string;
}

export interface SessionClearedMessage {
  type: 'session.cleared';
  requestId: string;
  messagesCleared: number;
}

export interface ErrorMessage {
  type: 'error';
  message: string;
  requestId?: string;
}

export type ServerMessage =
  | RegisteredMessage
  | PeersMessage
  | ChannelMessageMessage
  | MessageBadgeAddedMessage
  | MessageUpdatedMessage
  | TaskFlaggedMessage
  | TaskClaimedMessage
  | TaskResolvedMessage
  | BadgeAddedMessage
  | MessagesResponseMessage
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
