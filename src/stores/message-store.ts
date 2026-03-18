import type { PeerMessage } from '../types.js';

type MessageWaiter = (message: PeerMessage) => void;

export class MessageStore {
  private messages: PeerMessage[] = [];
  private waiters: MessageWaiter[] = [];

  add(message: PeerMessage): void {
    this.messages.push(message);
    // Wake up anyone waiting
    const toNotify = this.waiters.splice(0);
    for (const resolve of toNotify) {
      resolve(message);
    }
  }

  waitForNext(timeoutMs: number): Promise<PeerMessage | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(onMessage);
        if (idx !== -1) this.waiters.splice(idx, 1);
        resolve(null);
      }, timeoutMs);

      const onMessage = (msg: PeerMessage) => {
        clearTimeout(timer);
        resolve(msg);
      };

      this.waiters.push(onMessage);
    });
  }

  getAll(opts?: {
    fromPeerId?: string;
    afterMessageId?: string;
    limit?: number;
    unreadOnly?: boolean;
  }): PeerMessage[] {
    let result = [...this.messages];

    if (opts?.fromPeerId) {
      result = result.filter((m) => m.fromPeerId === opts.fromPeerId);
    }

    if (opts?.afterMessageId) {
      const idx = result.findIndex((m) => m.messageId === opts.afterMessageId);
      if (idx !== -1) {
        result = result.slice(idx + 1);
      }
    }

    if (opts?.unreadOnly) {
      result = result.filter((m) => !m.read);
    }

    if (opts?.limit && opts.limit > 0) {
      result = result.slice(0, opts.limit);
    }

    return result;
  }

  markAsRead(messageIds: string[]): void {
    const idSet = new Set(messageIds);
    for (const msg of this.messages) {
      if (idSet.has(msg.messageId)) {
        msg.read = true;
      }
    }
  }

  markAllAsRead(): void {
    for (const msg of this.messages) {
      msg.read = true;
    }
  }
}
