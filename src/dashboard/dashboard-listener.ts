import WebSocket from 'ws';
import type { MessageStore } from '../stores/message-store.js';
import type { PeerMessage } from '../types.js';
import { generateId } from '../util/id.js';
import { log, logError } from '../util/logger.js';

const RECONNECT_DELAY_MS = 3000;
const ROOMS_TO_JOIN = ['crosschat', 'general'];

/**
 * Connects to the dashboard WebSocket as a client and listens for
 * user-posted messages. Every CrossChat instance runs one of these
 * so that dashboard messages are delivered directly — no relay needed.
 */
export class DashboardListener {
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private port: number,
    private messageStore: MessageStore,
    private ownName: string,
    private ownPeerId: string
  ) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  private connect(): void {
    if (this.stopped) return;

    const url = `ws://localhost:${this.port}/ws`;

    try {
      this.ws = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      log(`Dashboard listener connected on port ${this.port}`);
      // Join all known rooms
      for (const roomId of ROOMS_TO_JOIN) {
        this.ws!.send(JSON.stringify({ type: 'join', roomId, username: this.ownName, silent: true }));
      }
    });

    this.ws.on('message', (raw: Buffer) => {
      try {
        const data = JSON.parse(raw.toString());

        // Only process user-posted messages (not agent-mirrored ones)
        if (data.type === 'message' && data.source === 'user') {
          this.handleUserMessage(data);
        }

        // Auto-join newly created rooms
        if (data.type === 'roomCreated' && this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'join', roomId: data.room.id, username: this.ownName, silent: true }));
        }
      } catch {
        // Ignore malformed messages
      }
    });

    this.ws.on('close', () => {
      this.ws = null;
      this.scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      logError('Dashboard listener WS error', err);
      // 'close' event fires after 'error', which triggers reconnect
    });
  }

  private handleUserMessage(data: Record<string, unknown>): void {
    const text = data.text as string;
    const username = data.username as string;
    const roomId = data.roomId as string;

    if (!text || !username) return;

    // Parse @mentions
    const mentionPattern = /@([\w-]+)/g;
    const mentions: string[] = [];
    let match;
    while ((match = mentionPattern.exec(text)) !== null) {
      mentions.push(match[1].toLowerCase());
    }

    const message: PeerMessage = {
      messageId: (data.messageId as string) || generateId(),
      fromPeerId: 'dashboard',
      fromName: `[dashboard] ${username}`,
      content: text,
      metadata: {
        source: 'dashboard',
        mentions,
        roomId,
      },
      sentAt: (data.timestamp as string) || new Date().toISOString(),
      receivedAt: new Date().toISOString(),
      read: false,
      type: 'message',
    };

    this.messageStore.add(message);
    log(`Dashboard message from ${username} in ${roomId}: ${text.slice(0, 80)}`);
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, RECONNECT_DELAY_MS);
    this.reconnectTimer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
