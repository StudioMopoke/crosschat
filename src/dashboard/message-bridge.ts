import type { MessageStore } from '../stores/message-store.js';
import type { DashboardServer } from './http-server.js';
import type { PeerMessage } from '../types.js';

const CROSSCHAT_ROOM = 'crosschat';

export class MessageBridge {
  private unsubscribe: (() => void) | null = null;

  constructor(
    private messageStore: MessageStore,
    private dashboard: DashboardServer,
    private ownName: string
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
