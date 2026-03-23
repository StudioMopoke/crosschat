/**
 * Unified messaging data model for CrossChat.
 *
 * Messages are the atomic unit. Threads are reply chains on any message.
 * Tasks are a workflow flag (badge) on a message. Badges provide extensible
 * metadata that is both machine-readable (agents parse like frontmatter)
 * and human-readable (rendered as visual badges in the dashboard).
 */

// ── Badge system ─────────────────────────────────────────────────

/** Well-known badge types. New types can be added without code changes. */
export const BADGE_TYPES = {
  TASK: 'task',
  IMPORTANCE: 'importance',
  QUESTION: 'question',
  GIT_COMMIT: 'git-commit',
  PROJECT: 'project',
  PERMISSION: 'permission',
  COMPLETION: 'completion',
} as const;

/** Task status values (used as Badge.value when type is 'task'). */
export type TaskStatus = 'open' | 'claimed' | 'in_progress' | 'completed' | 'failed';

/** Importance levels (used as Badge.value when type is 'importance'). */
export type ImportanceLevel = 'high' | 'normal' | 'low';

/**
 * A badge is a piece of extensible metadata on a message.
 * Rendered as small round badges in the dashboard UI.
 * Agents can read badges as structured data for quick context.
 */
export interface Badge {
  type: string;               // Badge type key (e.g., "task", "importance", "question")
  value: string;              // Badge value (e.g., "open", "high", "true", "abc1234")
  label?: string;             // Optional human-readable display text
  addedBy: string;            // peerId of who added this badge, or "system"
  addedAt: string;            // ISO 8601 timestamp
}

// ── Message ──────────────────────────────────────────────────────

/** Message source — who originated it. */
export type MessageSource = 'agent' | 'user' | 'system';

/** How @mentions target the message. */
export type MentionType = 'direct' | 'here' | 'broadcast';

/**
 * A message is the atomic unit of CrossChat.
 * All communication flows through messages. Tasks, threads, and badges
 * are layers on top of messages, not parallel systems.
 */
export interface Message {
  messageId: string;
  channelId: string;
  threadId?: string;          // If set, this is a reply in the thread rooted at this message ID
  fromPeerId: string;
  fromName: string;
  content: string;
  timestamp: string;
  source: MessageSource;
  mentions?: string[];        // Mentioned agent names (e.g., ["crosschat-20cd"])
  mentionType?: MentionType;
  badges: Badge[];            // Extensible metadata — rendered as visual badges in dashboard
  metadata?: Record<string, unknown>;  // Arbitrary structured data
}

// ── Task overlay ─────────────────────────────────────────────────

/**
 * Filter for task targeting — which agents qualify to claim a task.
 * Reuses the existing filter concept from the legacy task system.
 */
export interface TaskFilter {
  agentId?: string;           // Specific peer ID
  workingDirReq?: string;     // Required working directory
  gitProject?: string;        // Required git project name
}

/**
 * Task metadata stored as a sidecar to a flagged message.
 * The task status lives as a badge on the message itself;
 * TaskMeta holds the additional fields that don't fit in a badge.
 *
 * Storage: ~/.crosschat/messages/tasks/{messageId}.json
 */
export interface TaskMeta {
  messageId: string;          // The message this task is flagged on
  claimantId?: string;        // Who claimed it
  claimantName?: string;      // Display name of claimant
  filter?: TaskFilter;        // Who qualifies to claim
  result?: string;            // Completion result (markdown)
  error?: string;             // Error description if failed
  claimedAt?: string;         // ISO timestamp of claim
  resolvedAt?: string;        // ISO timestamp of resolution
}
