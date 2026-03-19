import type { MessageStore } from '../stores/message-store.js';
import type { DashboardServer } from './http-server.js';
import type { PeerMessage } from '../types.js';

const CROSSCHAT_ROOM = 'crosschat';

/**
 * One-way bridge: peer messages → dashboard.
 *
 * The reverse direction (dashboard → peers) is handled by DashboardListener
 * instances running on each peer, which connect to the dashboard WebSocket
 * and receive user messages directly.
 */
export class MessageBridge {
  private unsubscribe: (() => void) | null = null;

  constructor(
    private messageStore: MessageStore,
    private dashboard: DashboardServer,
  ) {}

  start(): void {
    this.unsubscribe = this.messageStore.onMessage((message) => {
      this.mirrorToDashboard(message);
    });
  }

  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  private mirrorToDashboard(message: PeerMessage): void {
    // Don't re-mirror messages that originated from the dashboard
    if (message.metadata?.source === 'dashboard') return;

    const type = message.type || 'message';
    let prefix = '';
    switch (type) {
      case 'task_delegated':
        prefix = '[TASK] ';
        break;
      case 'task_result':
        prefix = '[RESULT] ';
        break;
      default:
        prefix = '';
    }

    const text = `${prefix}${message.content}`;
    this.dashboard.postToRoom(CROSSCHAT_ROOM, message.fromName, text);
  }
}
