import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import WebSocket from 'ws';
import { generateId } from '../util/id.js';
import { log, logError } from '../util/logger.js';
import {
  encodeMessage,
  decodeMessage,
  type AgentMessage,
  type ServerMessage,
  type AgentStatus,
  type PeerInfo,
  type PeersMessage,
  type ChannelMessageMessage,
  type MessageBadgeAddedMessage,
  type TaskClaimedMessage,
  type TaskFlaggedMessage,
  type TaskResolvedMessage,
  type MessagesResponseMessage,
  type SessionClearedMessage,
  type BadgeAddedMessage,
  type MessageImportance,
} from './protocol.js';
import type { Badge, TaskFilter } from './message-manager.js';

const HEARTBEAT_INTERVAL_MS = 30_000;
const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

type MessageCallback = (msg: ChannelMessageMessage) => void;
type BadgeCallback = (msg: MessageBadgeAddedMessage) => void;
type VoidCallback = () => void;

interface PendingRequest<T> {
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Client-side WebSocket connection used by each agent to communicate
 * with the CrossChat hub server.
 *
 * Handles registration, heartbeats, reconnection with exponential
 * backoff, and provides typed methods for every protocol message.
 */
export class AgentConnection {
  private ws: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
  private stopped = false;
  private currentChannelId = 'general';

  private pendingRequests = new Map<string, PendingRequest<unknown>>();

  private messageCallbacks: MessageCallback[] = [];
  private badgeCallbacks: BadgeCallback[] = [];
  private connectedCallbacks: VoidCallback[] = [];
  private disconnectedCallbacks: VoidCallback[] = [];

  constructor(
    private port: number,
    private readonly peerId: string,
    private readonly name: string,
    private readonly cwd: string,
  ) {}

  // ─── Connection lifecycle ──────────────────────────────────────

  connect(): void {
    this.stopped = false;
    this.doConnect();
  }

  private doConnect(): void {
    if (this.stopped) return;

    const url = `ws://localhost:${this.port}/ws/agent`;

    try {
      this.ws = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      log(`Agent connection established on port ${this.port}`);
      this.reconnectDelay = INITIAL_RECONNECT_DELAY_MS;

      this.send({
        type: 'agent.register',
        peerId: this.peerId,
        name: this.name,
        cwd: this.cwd,
        pid: process.pid,
        parentPid: process.ppid,
      });

      this.startHeartbeat();

      for (const cb of this.connectedCallbacks) {
        try { cb(); } catch { /* swallow */ }
      }
    });

    this.ws.on('message', (raw: Buffer) => {
      try {
        const msg = decodeMessage(raw.toString()) as ServerMessage;
        this.handleServerMessage(msg);
      } catch (err) {
        logError('Failed to handle server message', err);
      }
    });

    this.ws.on('close', () => {
      this.ws = null;
      this.stopHeartbeat();

      for (const cb of this.disconnectedCallbacks) {
        try { cb(); } catch { /* swallow */ }
      }

      this.scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      logError('Agent connection WS error', err);
    });
  }

  disconnect(): void {
    this.stopped = true;
    this.stopHeartbeat();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Connection closed'));
      this.pendingRequests.delete(id);
    }

    if (this.ws) {
      try {
        this.send({ type: 'agent.disconnect' });
      } catch { /* best-effort */ }
      this.ws.close();
      this.ws = null;
    }
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  // ─── Outgoing message helpers ──────────────────────────────────

  sendMessage(content: string, opts?: {
    threadId?: string;
    metadata?: Record<string, unknown>;
    importance?: MessageImportance;
  }): void {
    this.send({
      type: 'agent.sendMessage',
      content,
      threadId: opts?.threadId,
      metadata: opts?.metadata,
      importance: opts?.importance,
    });
  }

  setStatus(status: AgentStatus, detail?: string, taskMessageId?: string): void {
    this.send({ type: 'agent.status', status, detail, taskMessageId });
  }

  getCurrentChannel(): string {
    return this.currentChannelId;
  }

  listPeers(): Promise<PeerInfo[]> {
    const requestId = generateId();
    this.send({ type: 'agent.listPeers', requestId });
    return this.createPendingRequest<PeerInfo[]>(requestId, 'listPeers');
  }

  getMessages(opts?: { threadId?: string; limit?: number; afterMessageId?: string }): Promise<ChannelMessageMessage[]> {
    const requestId = generateId();
    this.send({
      type: 'agent.getMessages',
      requestId,
      threadId: opts?.threadId,
      limit: opts?.limit,
      afterMessageId: opts?.afterMessageId,
    });
    return this.createPendingRequest<ChannelMessageMessage[]>(requestId, 'getMessages');
  }

  flagTask(messageId: string, filter?: TaskFilter): Promise<{ messageId: string; badges: Badge[] }> {
    const requestId = generateId();
    this.send({ type: 'agent.flagTask', requestId, messageId, filter });
    return this.createPendingRequest<{ messageId: string; badges: Badge[] }>(requestId, 'flagTask');
  }

  claimTask(messageId: string): Promise<{ messageId: string; claimantId: string }> {
    const requestId = generateId();
    this.send({ type: 'agent.claimTask', requestId, messageId });
    return this.createPendingRequest<{ messageId: string; claimantId: string }>(requestId, 'claimTask');
  }

  resolveTask(messageId: string, status: 'completed' | 'failed', result: string, error?: string): Promise<{ messageId: string; status: string }> {
    const requestId = generateId();
    this.send({ type: 'agent.resolveTask', requestId, messageId, status, result, error });
    return this.createPendingRequest<{ messageId: string; status: string }>(requestId, 'resolveTask');
  }

  addBadge(messageId: string, badgeType: string, badgeValue: string, label?: string): Promise<{ messageId: string; badge: Badge }> {
    const requestId = generateId();
    this.send({ type: 'agent.addBadge', requestId, messageId, badgeType, badgeValue, label });
    return this.createPendingRequest<{ messageId: string; badge: Badge }>(requestId, 'addBadge');
  }

  clearSession(opts?: { messages?: boolean }): Promise<{ messagesCleared: number }> {
    const requestId = generateId();
    this.send({ type: 'agent.clearSession', requestId, messages: opts?.messages });
    return this.createPendingRequest<{ messagesCleared: number }>(requestId, 'clearSession');
  }

  // ─── Event registration ────────────────────────────────────────

  onMessage(callback: MessageCallback): void {
    this.messageCallbacks.push(callback);
  }

  onBadge(callback: BadgeCallback): void {
    this.badgeCallbacks.push(callback);
  }

  onConnected(callback: VoidCallback): void {
    this.connectedCallbacks.push(callback);
  }

  onDisconnected(callback: VoidCallback): void {
    this.disconnectedCallbacks.push(callback);
  }

  // ─── Internal plumbing ─────────────────────────────────────────

  private send(msg: AgentMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected to hub — WebSocket not open');
    }
    this.ws.send(encodeMessage(msg));
  }

  private trySend(msg: AgentMessage): void {
    try { this.send(msg); } catch { /* connection down */ }
  }

  private createPendingRequest<T>(requestId: string, name: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`${name} request timed out`));
      }, 10_000);
      timer.unref();

      this.pendingRequests.set(requestId, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
    });
  }

  private resolvePending(requestId: string, value: unknown): boolean {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pendingRequests.delete(requestId);
    pending.resolve(value);
    return true;
  }

  private handleServerMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case 'registered':
        log(`Registered with hub (peerId=${msg.peerId}, server=${msg.serverVersion})`);
        break;

      case 'peers':
        this.resolvePending(msg.requestId, (msg as PeersMessage).peers);
        break;

      case 'channel.message':
        for (const cb of this.messageCallbacks) {
          try { cb(msg as ChannelMessageMessage); } catch { /* swallow */ }
        }
        break;

      case 'message.badgeAdded':
        for (const cb of this.badgeCallbacks) {
          try { cb(msg as MessageBadgeAddedMessage); } catch { /* swallow */ }
        }
        break;

      case 'message.updated':
        // Badge array updated — notify via badge callbacks with the first badge as representative
        break;

      case 'messages':
        this.resolvePending((msg as MessagesResponseMessage).requestId, (msg as MessagesResponseMessage).messages);
        break;

      case 'task.flagged':
        this.resolvePending((msg as TaskFlaggedMessage).requestId, {
          messageId: (msg as TaskFlaggedMessage).messageId,
          badges: (msg as TaskFlaggedMessage).badges,
        });
        break;

      case 'task.claimed': {
        const claimed = msg as TaskClaimedMessage;
        const resolvedClaim = claimed.requestId
          ? this.resolvePending(claimed.requestId, { messageId: claimed.messageId, claimantId: claimed.claimantId })
          : false;
        // If not a response to our request, this is a notification to the task author
        if (!resolvedClaim) {
          for (const cb of this.badgeCallbacks) {
            try { cb({ type: 'message.badgeAdded', messageId: claimed.messageId, badge: { type: 'task', value: 'claimed', addedBy: claimed.claimantId, addedAt: new Date().toISOString() } }); } catch { /* swallow */ }
          }
        }
        break;
      }

      case 'task.resolved': {
        const resolved = msg as TaskResolvedMessage;
        const resolvedTask = resolved.requestId
          ? this.resolvePending(resolved.requestId, { messageId: resolved.messageId, status: resolved.status })
          : false;
        // If not a response to our request, this is a notification to the task author
        if (!resolvedTask) {
          for (const cb of this.badgeCallbacks) {
            try { cb({ type: 'message.badgeAdded', messageId: resolved.messageId, badge: { type: 'task', value: resolved.status, addedBy: 'system', addedAt: new Date().toISOString() } }); } catch { /* swallow */ }
          }
        }
        break;
      }

      case 'badge.added':
        this.resolvePending((msg as BadgeAddedMessage).requestId, {
          messageId: (msg as BadgeAddedMessage).messageId,
          badge: (msg as BadgeAddedMessage).badge,
        });
        break;

      case 'session.cleared':
        this.resolvePending((msg as SessionClearedMessage).requestId, {
          messagesCleared: (msg as SessionClearedMessage).messagesCleared,
        });
        break;

      case 'error':
        logError(`Hub error: ${msg.message}${msg.requestId ? ` (requestId=${msg.requestId})` : ''}`);
        if (msg.requestId) {
          const pending = this.pendingRequests.get(msg.requestId);
          if (pending) {
            clearTimeout(pending.timer);
            this.pendingRequests.delete(msg.requestId);
            pending.reject(new Error(msg.message));
          }
        }
        break;
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.trySend({ type: 'agent.heartbeat' });
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /** Re-read the dashboard lock file to pick up a new hub port after restart. */
  private async refreshPort(): Promise<void> {
    try {
      const lockPath = path.join(os.homedir(), '.crosschat', 'dashboard.lock');
      const content = await fs.readFile(lockPath, 'utf-8');
      const lock = JSON.parse(content) as { port: number; pid: number };
      if (lock.port && lock.port !== this.port) {
        log(`Hub port changed: ${this.port} -> ${lock.port}`);
        this.port = lock.port;
      }
    } catch {
      // Lock file may not exist yet during hub restart
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;

    log(`Reconnecting in ${this.reconnectDelay}ms...`);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      await this.refreshPort();
      this.doConnect();
    }, this.reconnectDelay);
    this.reconnectTimer.unref();

    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
  }
}
