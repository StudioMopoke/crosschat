// === Messages ===

import type { Badge } from './hub/message-manager.js';

export type MessageImportance = 'important' | 'comment' | 'chitchat';

export interface PeerMessage {
  messageId: string;
  fromPeerId: string;
  fromName: string;
  content: string;
  metadata?: Record<string, unknown>;
  sentAt: string;
  receivedAt: string;
  read: boolean;
  threadId?: string;
  type?: 'message' | 'badge_update';
  mentions?: string[];
  mentionType?: 'direct' | 'here' | 'broadcast';
  importance?: MessageImportance;
  badges?: Badge[];
}
