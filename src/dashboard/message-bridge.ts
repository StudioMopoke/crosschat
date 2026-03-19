import type { MessageStore } from '../stores/message-store.js';
import type { DashboardServer } from './http-server.js';
import type { PeerMessage, PeerMessageParams } from '../types.js';
import { listRegistryEntries } from '../registry/registry.js';
import { sendPeerRequest } from '../transport/uds-client.js';
import { generateId } from '../util/id.js';
import { log, logError } from '../util/logger.js';

const CROSSCHAT_ROOM = 'crosschat';

export class MessageBridge {
  private unsubscribePeerMessages: (() => void) | null = null;
  private unsubscribeDashboard: (() => void) | null = null;

  constructor(
    private messageStore: MessageStore,
    private dashboard: DashboardServer,
    private ownName: string,
    private ownPeerId: string
  ) {}

  start(): void {
    // Peer messages → Dashboard
    this.unsubscribePeerMessages = this.messageStore.onMessage((message) => {
      this.mirrorToDashboard(message);
    });

    // Dashboard user messages → All peers
    this.unsubscribeDashboard = this.dashboard.onUserMessage((username, text, _roomId) => {
      this.broadcastToPeers(username, text);
    });
  }

  stop(): void {
    if (this.unsubscribePeerMessages) {
      this.unsubscribePeerMessages();
      this.unsubscribePeerMessages = null;
    }
    if (this.unsubscribeDashboard) {
      this.unsubscribeDashboard();
      this.unsubscribeDashboard = null;
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

  private async broadcastToPeers(username: string, text: string): Promise<void> {
    // Parse @mentions from the message text
    const mentionPattern = /@([\w-]+)/g;
    const mentions: string[] = [];
    let match;
    while ((match = mentionPattern.exec(text)) !== null) {
      mentions.push(match[1]);
    }

    let entries;
    try {
      entries = await listRegistryEntries();
    } catch (err) {
      logError('Failed to list peers for dashboard broadcast', err);
      return;
    }

    const messageId = generateId();
    const sentAt = new Date().toISOString();

    for (const entry of entries) {
      // Skip self — add directly to local messageStore instead
      if (entry.peerId === this.ownPeerId) {
        const localMessage: PeerMessage = {
          messageId,
          fromPeerId: 'dashboard',
          fromName: `[dashboard] ${username}`,
          content: text,
          metadata: { source: 'dashboard', mentions },
          sentAt,
          receivedAt: sentAt,
          read: false,
          type: 'message',
        };
        this.messageStore.add(localMessage);
        continue;
      }

      const params: PeerMessageParams = {
        messageId: generateId(),
        fromPeerId: 'dashboard',
        fromName: `[dashboard] ${username}`,
        content: text,
        metadata: { source: 'dashboard', mentions },
        sentAt,
      };

      try {
        await sendPeerRequest(entry.socketPath, 'peer.message', params as unknown as Record<string, unknown>);
      } catch (err) {
        logError(`Failed to broadcast dashboard message to ${entry.name}`, err);
      }
    }

    log(`Dashboard message from ${username} broadcast to ${entries.length} peer(s)${mentions.length ? ` (mentions: ${mentions.join(', ')})` : ''}`);
  }
}
