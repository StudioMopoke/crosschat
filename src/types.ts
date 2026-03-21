// === Messages ===

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
  relatedTaskId?: string;
  replyToMessageId?: string;
  type?: 'message' | 'task_result' | 'task_delegated';
  mentions?: string[];       // mentioned agent names
  mentionType?: 'direct' | 'here' | 'broadcast';
  importance?: MessageImportance;
}
