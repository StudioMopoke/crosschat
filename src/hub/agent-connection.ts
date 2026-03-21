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
  type RoomMessageMessage,
  type SessionClearedMessage,
  type TaskCreatedMessage,
  type TaskClaimedMessage,
  type TaskClaimAcceptedMessage,
  type TaskUpdatedMessage,
  type TaskCompletedMessage,
  type TaskFilter,
  type HubTaskStatus,
  type TaskDetailMessage,
  type TasksMessage,
  type TaskSummary,
  type TaskNote,
  type MessageImportance,
} from './protocol.js';

const HEARTBEAT_INTERVAL_MS = 30_000;
const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

type TaskEvent =
  | TaskCreatedMessage
  | TaskClaimedMessage
  | TaskClaimAcceptedMessage
  | TaskUpdatedMessage
  | TaskCompletedMessage;

type MessageCallback = (msg: RoomMessageMessage) => void;
type TaskEventCallback = (evt: TaskEvent) => void;
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
  private currentRoomId = 'general';

  private pendingRequests = new Map<string, PendingRequest<unknown>>();

  private messageCallbacks: MessageCallback[] = [];
  private taskEventCallbacks: TaskEventCallback[] = [];
  private connectedCallbacks: VoidCallback[] = [];
  private disconnectedCallbacks: VoidCallback[] = [];

  constructor(
    private readonly port: number,
    private readonly peerId: string,
    private readonly name: string,
    private readonly cwd: string,
  ) {}

  // ─── Connection lifecycle ──────────────────────────────────────

  /** Open the WebSocket connection to the hub and send registration. */
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

      // Register with the hub
      this.send({
        type: 'agent.register',
        peerId: this.peerId,
        name: this.name,
        cwd: this.cwd,
        pid: process.pid,
      });

      this.startHeartbeat();

      for (const cb of this.connectedCallbacks) {
        try { cb(); } catch { /* swallow callback errors */ }
      }
    });

    this.ws.on('message', (raw: Buffer) => {
      try {
        const msg = decodeMessage(raw.toString()) as ServerMessage;
        this.handleServerMessage(msg);
      } catch {
        // Ignore malformed messages
      }
    });

    this.ws.on('close', () => {
      this.ws = null;
      this.stopHeartbeat();

      for (const cb of this.disconnectedCallbacks) {
        try { cb(); } catch { /* swallow callback errors */ }
      }

      this.scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      logError('Agent connection WS error', err);
      // 'close' fires after 'error', which triggers reconnect
    });
  }

  /** Gracefully close the connection without reconnecting. */
  disconnect(): void {
    this.stopped = true;

    this.stopHeartbeat();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Connection closed'));
      this.pendingRequests.delete(id);
    }

    if (this.ws) {
      // Send disconnect notice before closing
      try {
        this.send({ type: 'agent.disconnect' });
      } catch { /* best-effort */ }
      this.ws.close();
      this.ws = null;
    }
  }

  /** Whether the underlying WebSocket is currently open. */
  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  // ─── Outgoing message helpers ──────────────────────────────────

  /** Send a message to the agent's current room. */
  sendMessage(content: string, metadata?: Record<string, unknown>, importance?: MessageImportance): void {
    this.send({ type: 'agent.sendMessage', content, metadata, importance });
  }

  /** Update this agent's availability status. */
  setStatus(status: AgentStatus, detail?: string, taskId?: string): void {
    this.send({ type: 'agent.status', status, detail, taskId });
  }

  /** Get the current room ID. */
  getCurrentRoom(): string {
    return this.currentRoomId;
  }

  /** Join a room (implicitly leaves the current room). */
  joinRoom(roomId: string): void {
    this.send({ type: 'agent.joinRoom', roomId });
  }

  /** Create a new room on the server. */
  createRoom(roomId: string, name?: string): void {
    this.send({ type: 'agent.createRoom', roomId, name });
  }

  /**
   * Request the list of connected peers from the hub.
   * Returns a Promise that resolves when the server responds.
   */
  listPeers(): Promise<PeerInfo[]> {
    const requestId = generateId();
    this.send({ type: 'agent.listPeers', requestId });

    return new Promise<PeerInfo[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error('listPeers request timed out'));
      }, 10_000);
      timer.unref();

      this.pendingRequests.set(requestId, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
    });
  }

  /** Create a task in the current room. */
  createTask(description: string, context?: string, filter?: TaskFilter): void {
    this.send({ type: 'task.create', description, context, filter });
  }

  /** Bid on an open task. */
  claimTask(taskId: string): void {
    this.send({ type: 'task.claim', taskId });
  }

  /** List tasks with optional filters. Returns a Promise. */
  listTasks(filter?: { status?: string; roomId?: string; assignedTo?: string }): Promise<{ tasks: TaskSummary[] }> {
    const requestId = generateId();
    this.send({ type: 'agent.listTasks', requestId, ...filter });

    return new Promise<{ tasks: TaskSummary[] }>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error('listTasks request timed out'));
      }, 10_000);
      timer.unref();

      this.pendingRequests.set(requestId, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
    });
  }

  /** Get full task details including notes. Returns a Promise. */
  getTask(taskId: string): Promise<TaskSummary & { notes: TaskNote[]; result?: string; error?: string }> {
    type TaskDetail = TaskSummary & { notes: TaskNote[]; result?: string; error?: string };
    const requestId = generateId();
    this.send({ type: 'agent.getTask', requestId, taskId });

    return new Promise<TaskDetail>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error('getTask request timed out'));
      }, 10_000);
      timer.unref();

      this.pendingRequests.set(requestId, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
    });
  }

  /** Accept a claim on a task you created. */
  acceptClaim(taskId: string, claimantId: string): void {
    this.send({ type: 'task.accept', taskId, claimantId });
  }

  /** Append a progress note to a task (supports markdown). */
  updateTask(taskId: string, content: string, status?: HubTaskStatus): void {
    this.send({ type: 'task.update', taskId, content, status });
  }

  /** Mark a task as completed or failed with a result blob. */
  completeTask(taskId: string, result: string, status: 'completed' | 'failed', error?: string): void {
    this.send({ type: 'task.complete', taskId, result, status, error });
  }

  /** Clear session state: messages from current room and optionally archive completed tasks. */
  clearSession(opts?: { messages?: boolean; tasks?: boolean }): Promise<{ messagesCleared: number; tasksArchived: number }> {
    const requestId = generateId();
    this.send({
      type: 'agent.clearSession',
      requestId,
      messages: opts?.messages,
      tasks: opts?.tasks,
    });

    return new Promise<{ messagesCleared: number; tasksArchived: number }>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error('clearSession request timed out'));
      }, 10_000);
      timer.unref();

      this.pendingRequests.set(requestId, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
    });
  }

  // ─── Event registration ────────────────────────────────────────

  /** Register a callback invoked for every incoming room message. */
  onMessage(callback: MessageCallback): void {
    this.messageCallbacks.push(callback);
  }

  /** Register a callback invoked for task lifecycle events. */
  onTaskEvent(callback: TaskEventCallback): void {
    this.taskEventCallbacks.push(callback);
  }

  /** Register a callback invoked on (re)connection. */
  onConnected(callback: VoidCallback): void {
    this.connectedCallbacks.push(callback);
  }

  /** Register a callback invoked when the connection drops. */
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

  /** Send without throwing — used for internal/lifecycle messages where failure is expected. */
  private trySend(msg: AgentMessage): void {
    try { this.send(msg); } catch { /* connection down — expected during reconnect */ }
  }

  private handleServerMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case 'registered':
        log(`Registered with hub (peerId=${msg.peerId}, server=${msg.serverVersion})`);
        break;

      case 'peers': {
        const pending = this.pendingRequests.get(msg.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingRequests.delete(msg.requestId);
          pending.resolve((msg as PeersMessage).peers);
        }
        break;
      }

      case 'task.detail': {
        const pending = this.pendingRequests.get(msg.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingRequests.delete(msg.requestId);
          pending.resolve((msg as TaskDetailMessage).task);
        }
        break;
      }

      case 'tasks': {
        const pending = this.pendingRequests.get(msg.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingRequests.delete(msg.requestId);
          pending.resolve({ tasks: (msg as TasksMessage).tasks });
        }
        break;
      }

      case 'session.cleared': {
        const pending = this.pendingRequests.get(msg.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingRequests.delete(msg.requestId);
          const cleared = msg as SessionClearedMessage;
          pending.resolve({ messagesCleared: cleared.messagesCleared, tasksArchived: cleared.tasksArchived });
        }
        break;
      }

      case 'room.joined':
        this.currentRoomId = msg.roomId;
        log(`Joined room "${msg.name}" (${msg.roomId})`);
        break;

      case 'room.created':
        log(`Room created: "${msg.name}" (${msg.roomId})`);
        break;

      case 'room.message':
        for (const cb of this.messageCallbacks) {
          try { cb(msg as RoomMessageMessage); } catch { /* swallow */ }
        }
        break;

      case 'task.created':
      case 'task.claimed':
      case 'task.claimAccepted':
      case 'task.updated':
      case 'task.completed':
        for (const cb of this.taskEventCallbacks) {
          try { cb(msg as TaskEvent); } catch { /* swallow */ }
        }
        break;

      case 'error':
        logError(`Hub error: ${msg.message}${msg.requestId ? ` (requestId=${msg.requestId})` : ''}`);
        // If the error is tied to a pending request, reject it
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

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;

    log(`Reconnecting in ${this.reconnectDelay}ms...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.doConnect();
    }, this.reconnectDelay);
    this.reconnectTimer.unref();

    // Exponential backoff: 1s -> 2s -> 4s -> 8s -> ... -> 30s max
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
  }
}
