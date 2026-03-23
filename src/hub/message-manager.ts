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

// ── MessageManager ───────────────────────────────────────────────

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { generateId } from '../util/id.js';
import { log, logError } from '../util/logger.js';

const MESSAGES_DIR = path.join(os.homedir(), '.crosschat', 'messages');
const THREADS_DIR = path.join(MESSAGES_DIR, 'threads');
const TASKS_DIR = path.join(MESSAGES_DIR, 'tasks');
const CHANNEL_MESSAGE_CAP = 200;
const THREAD_MESSAGE_CAP = 500;

type MessageCallback = (message: Message) => void;
type BadgeCallback = (messageId: string, badge: Badge) => void;

/**
 * Persistent message storage with thread isolation and badge support.
 *
 * Channel messages stored in: ~/.crosschat/messages/{channelId}.jsonl
 * Thread messages stored in:  ~/.crosschat/messages/threads/{threadId}.jsonl
 * Task metadata stored in:    ~/.crosschat/messages/tasks/{messageId}.json
 */
export class MessageManager {
  /** In-memory cache of channel messages (capped at CHANNEL_MESSAGE_CAP). */
  private channelMessages = new Map<string, Message[]>();

  /** In-memory cache of thread messages (keyed by root messageId). */
  private threadMessages = new Map<string, Message[]>();

  /** In-memory index of all messages by ID (for badge operations). */
  private messageIndex = new Map<string, Message>();

  /** Task metadata for flagged messages. */
  private taskMetas = new Map<string, TaskMeta>();

  /** Listeners notified on new messages. */
  private messageListeners: MessageCallback[] = [];

  /** Listeners notified on badge changes. */
  private badgeListeners: BadgeCallback[] = [];

  // ── Initialization ──────────────────────────────────────────────

  async init(): Promise<void> {
    await fs.mkdir(MESSAGES_DIR, { recursive: true });
    await fs.mkdir(THREADS_DIR, { recursive: true });
    await fs.mkdir(TASKS_DIR, { recursive: true });
    await this.loadFromDisk();
    const msgCount = this.messageIndex.size;
    const threadCount = this.threadMessages.size;
    const taskCount = this.taskMetas.size;
    log(`MessageManager initialized: ${msgCount} messages, ${threadCount} threads, ${taskCount} tasks`);
  }

  // ── Message operations ──────────────────────────────────────────

  /** Add a message to the channel or a thread. Persists to disk. */
  async addMessage(message: Message): Promise<void> {
    this.messageIndex.set(message.messageId, message);

    if (message.threadId) {
      // Thread reply
      const thread = this.threadMessages.get(message.threadId) ?? [];
      thread.push(message);
      this.threadMessages.set(message.threadId, thread);
      await this.appendToFile(
        path.join(THREADS_DIR, `${message.threadId}.jsonl`),
        message,
      );

      // Enforce thread cap — evict oldest from memory (disk retains full history)
      if (thread.length > THREAD_MESSAGE_CAP) {
        const overflow = thread.length - THREAD_MESSAGE_CAP;
        const evicted = thread.splice(0, overflow);
        for (const msg of evicted) {
          this.messageIndex.delete(msg.messageId);
        }
      }
    } else {
      // Channel message
      const channel = this.channelMessages.get(message.channelId) ?? [];
      channel.push(message);
      this.channelMessages.set(message.channelId, channel);
      await this.appendToFile(
        path.join(MESSAGES_DIR, `${message.channelId}.jsonl`),
        message,
      );

      // Enforce cap — keep only the most recent messages in memory
      if (channel.length > CHANNEL_MESSAGE_CAP) {
        const overflow = channel.length - CHANNEL_MESSAGE_CAP;
        const evicted = channel.splice(0, overflow);
        for (const msg of evicted) {
          this.messageIndex.delete(msg.messageId);
        }
      }
    }

    // Notify listeners
    for (const cb of this.messageListeners) {
      try { cb(message); } catch { /* swallow */ }
    }
  }

  /** Get a message by ID. */
  getMessage(messageId: string): Message | undefined {
    return this.messageIndex.get(messageId);
  }

  /** Get channel messages (from in-memory cache). */
  getChannelMessages(channelId: string, opts?: {
    limit?: number;
    afterMessageId?: string;
  }): Message[] {
    let messages = this.channelMessages.get(channelId) ?? [];

    if (opts?.afterMessageId) {
      const idx = messages.findIndex((m) => m.messageId === opts.afterMessageId);
      if (idx !== -1) {
        messages = messages.slice(idx + 1);
      }
    }

    if (opts?.limit && opts.limit > 0) {
      messages = messages.slice(-opts.limit);
    }

    return [...messages];
  }

  /** Get thread messages for a given root message. */
  getThreadMessages(threadId: string): Message[] {
    return [...(this.threadMessages.get(threadId) ?? [])];
  }

  /** Get the number of replies in a thread. */
  getThreadReplyCount(threadId: string): number {
    return this.threadMessages.get(threadId)?.length ?? 0;
  }

  /** Clear channel messages (in-memory only — disk retains history). */
  clearChannel(channelId: string): number {
    const messages = this.channelMessages.get(channelId);
    if (!messages) return 0;
    const count = messages.length;
    for (const msg of messages) {
      this.messageIndex.delete(msg.messageId);
    }
    this.channelMessages.set(channelId, []);
    return count;
  }

  // ── Badge operations ────────────────────────────────────────────

  /** Add a badge to a message. Updates in-memory and persists badge state. */
  async addBadge(messageId: string, badge: Badge): Promise<Message | null> {
    const message = this.messageIndex.get(messageId);
    if (!message) return null;

    // Replace existing badge of same type, or append
    const existingIdx = message.badges.findIndex((b) => b.type === badge.type);
    if (existingIdx >= 0) {
      message.badges[existingIdx] = badge;
    } else {
      message.badges.push(badge);
    }

    // Persist the badge change by rewriting the message's badges to a sidecar
    await this.persistBadges(messageId, message.badges);

    // Notify listeners
    for (const cb of this.badgeListeners) {
      try { cb(messageId, badge); } catch { /* swallow */ }
    }

    return message;
  }

  /** Remove a badge by type from a message. */
  async removeBadge(messageId: string, badgeType: string): Promise<Message | null> {
    const message = this.messageIndex.get(messageId);
    if (!message) return null;

    message.badges = message.badges.filter((b) => b.type !== badgeType);
    await this.persistBadges(messageId, message.badges);
    return message;
  }

  /** Get all badges on a message. */
  getBadges(messageId: string): Badge[] {
    return this.messageIndex.get(messageId)?.badges ?? [];
  }

  // ── Task operations ─────────────────────────────────────────────

  /** Flag a message as a task. Adds a task badge and creates TaskMeta. */
  async flagAsTask(messageId: string, addedBy: string, filter?: TaskFilter): Promise<TaskMeta | null> {
    const message = this.messageIndex.get(messageId);
    if (!message) return null;

    // Check if already flagged
    if (message.badges.some((b) => b.type === BADGE_TYPES.TASK)) {
      return this.taskMetas.get(messageId) ?? null;
    }

    const badge: Badge = {
      type: BADGE_TYPES.TASK,
      value: 'open',
      label: 'Task',
      addedBy,
      addedAt: new Date().toISOString(),
    };
    await this.addBadge(messageId, badge);

    const meta: TaskMeta = {
      messageId,
      filter,
    };
    this.taskMetas.set(messageId, meta);
    await this.persistTaskMeta(meta);

    log(`Message ${messageId} flagged as task by ${addedBy}`);
    return meta;
  }

  /** Claim a task. First-come-first-served. */
  async claimTask(messageId: string, claimantId: string, claimantName: string): Promise<TaskMeta> {
    const meta = this.taskMetas.get(messageId);
    if (!meta) throw new Error(`No task on message ${messageId}`);

    const message = this.messageIndex.get(messageId);
    const taskBadge = message?.badges.find((b) => b.type === BADGE_TYPES.TASK);
    if (!taskBadge || taskBadge.value !== 'open') {
      throw new Error(`Task on message ${messageId} is not open (status: ${taskBadge?.value ?? 'none'})`);
    }

    if (message?.fromPeerId === claimantId) {
      throw new Error('Cannot claim your own task');
    }

    // Update badge
    taskBadge.value = 'claimed';
    await this.persistBadges(messageId, message!.badges);

    // Update meta
    meta.claimantId = claimantId;
    meta.claimantName = claimantName;
    meta.claimedAt = new Date().toISOString();
    await this.persistTaskMeta(meta);

    log(`Task ${messageId} claimed by ${claimantName}`);
    return meta;
  }

  /** Resolve (complete or fail) a task. */
  async resolveTask(
    messageId: string,
    resolverId: string,
    status: 'completed' | 'failed',
    result: string,
    error?: string,
  ): Promise<TaskMeta> {
    const meta = this.taskMetas.get(messageId);
    if (!meta) throw new Error(`No task on message ${messageId}`);

    const message = this.messageIndex.get(messageId);
    const taskBadge = message?.badges.find((b) => b.type === BADGE_TYPES.TASK);
    if (!taskBadge) throw new Error(`No task badge on message ${messageId}`);

    if (taskBadge.value !== 'claimed' && taskBadge.value !== 'in_progress') {
      throw new Error(`Task ${messageId} cannot be resolved (status: ${taskBadge.value})`);
    }

    if (meta.claimantId !== resolverId) {
      throw new Error('Only the claimant can resolve a task');
    }

    // Update badge
    taskBadge.value = status;
    await this.persistBadges(messageId, message!.badges);

    // Update meta
    meta.result = result;
    if (error) meta.error = error;
    meta.resolvedAt = new Date().toISOString();
    await this.persistTaskMeta(meta);

    log(`Task ${messageId} resolved as ${status} by ${resolverId}`);
    return meta;
  }

  /** Get task metadata for a flagged message. */
  getTaskMeta(messageId: string): TaskMeta | undefined {
    return this.taskMetas.get(messageId);
  }

  /** List all tasks, optionally filtered. */
  listTasks(filter?: { status?: string; channelId?: string; claimantId?: string }): Array<{ message: Message; task: TaskMeta }> {
    const results: Array<{ message: Message; task: TaskMeta }> = [];

    for (const [messageId, meta] of this.taskMetas) {
      const message = this.messageIndex.get(messageId);
      if (!message) continue;

      const taskBadge = message.badges.find((b) => b.type === BADGE_TYPES.TASK);
      if (!taskBadge) continue;

      if (filter?.status && taskBadge.value !== filter.status) continue;
      if (filter?.channelId && message.channelId !== filter.channelId) continue;
      if (filter?.claimantId && meta.claimantId !== filter.claimantId) continue;

      results.push({ message, task: meta });
    }

    return results;
  }

  // ── Event registration ──────────────────────────────────────────

  onMessage(callback: MessageCallback): () => void {
    this.messageListeners.push(callback);
    return () => {
      const idx = this.messageListeners.indexOf(callback);
      if (idx !== -1) this.messageListeners.splice(idx, 1);
    };
  }

  onBadge(callback: BadgeCallback): () => void {
    this.badgeListeners.push(callback);
    return () => {
      const idx = this.badgeListeners.indexOf(callback);
      if (idx !== -1) this.badgeListeners.splice(idx, 1);
    };
  }

  // ── Persistence ─────────────────────────────────────────────────

  private async appendToFile(filePath: string, message: Message): Promise<void> {
    try {
      await fs.appendFile(filePath, JSON.stringify(message) + '\n', 'utf-8');
    } catch (err) {
      logError(`Failed to append message to ${filePath}`, err);
    }
  }

  private async persistBadges(messageId: string, badges: Badge[]): Promise<void> {
    const filePath = path.join(MESSAGES_DIR, 'badges', `${messageId}.json`);
    try {
      await fs.mkdir(path.join(MESSAGES_DIR, 'badges'), { recursive: true });
      const tmpPath = `${filePath}.tmp`;
      await fs.writeFile(tmpPath, JSON.stringify(badges, null, 2), 'utf-8');
      await fs.rename(tmpPath, filePath);
    } catch (err) {
      logError(`Failed to persist badges for ${messageId}`, err);
    }
  }

  private async persistTaskMeta(meta: TaskMeta): Promise<void> {
    const filePath = path.join(TASKS_DIR, `${meta.messageId}.json`);
    try {
      const tmpPath = `${filePath}.tmp`;
      await fs.writeFile(tmpPath, JSON.stringify(meta, null, 2), 'utf-8');
      await fs.rename(tmpPath, filePath);
    } catch (err) {
      logError(`Failed to persist task meta for ${meta.messageId}`, err);
    }
  }

  private async loadFromDisk(): Promise<void> {
    // Load channel messages
    await this.loadChannelMessages();
    // Load thread messages
    await this.loadThreadMessages();
    // Load badge overrides
    await this.loadBadges();
    // Load task metadata
    await this.loadTaskMetas();
  }

  private async loadChannelMessages(): Promise<void> {
    let entries: string[];
    try {
      entries = (await fs.readdir(MESSAGES_DIR)).filter((e) => e.endsWith('.jsonl'));
    } catch {
      return;
    }

    for (const entry of entries) {
      const channelId = entry.replace('.jsonl', '');
      const filePath = path.join(MESSAGES_DIR, entry);
      const messages = await this.readJsonlFile(filePath);
      // Keep only the last CHANNEL_MESSAGE_CAP in memory
      const recent = messages.slice(-CHANNEL_MESSAGE_CAP);
      this.channelMessages.set(channelId, recent);
      for (const msg of recent) {
        this.messageIndex.set(msg.messageId, msg);
      }
    }
  }

  private async loadThreadMessages(): Promise<void> {
    let entries: string[];
    try {
      entries = (await fs.readdir(THREADS_DIR)).filter((e) => e.endsWith('.jsonl'));
    } catch {
      return;
    }

    for (const entry of entries) {
      const threadId = entry.replace('.jsonl', '');
      const filePath = path.join(THREADS_DIR, entry);
      const messages = await this.readJsonlFile(filePath);
      this.threadMessages.set(threadId, messages);
      for (const msg of messages) {
        this.messageIndex.set(msg.messageId, msg);
      }
    }
  }

  private async loadBadges(): Promise<void> {
    const badgesDir = path.join(MESSAGES_DIR, 'badges');
    let entries: string[];
    try {
      entries = (await fs.readdir(badgesDir)).filter((e) => e.endsWith('.json'));
    } catch {
      return;
    }

    for (const entry of entries) {
      const messageId = entry.replace('.json', '');
      const message = this.messageIndex.get(messageId);
      if (!message) continue;

      try {
        const content = await fs.readFile(path.join(badgesDir, entry), 'utf-8');
        message.badges = JSON.parse(content) as Badge[];
      } catch {
        // Ignore corrupt badge files
      }
    }
  }

  private async loadTaskMetas(): Promise<void> {
    let entries: string[];
    try {
      entries = (await fs.readdir(TASKS_DIR)).filter((e) => e.endsWith('.json'));
    } catch {
      return;
    }

    for (const entry of entries) {
      try {
        const content = await fs.readFile(path.join(TASKS_DIR, entry), 'utf-8');
        const meta = JSON.parse(content) as TaskMeta;
        if (meta.messageId) {
          this.taskMetas.set(meta.messageId, meta);
        }
      } catch {
        // Ignore corrupt task files
      }
    }
  }

  private async readJsonlFile(filePath: string): Promise<Message[]> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const messages: Message[] = [];
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
          messages.push(JSON.parse(line) as Message);
        } catch {
          // Skip malformed lines
        }
      }
      return messages;
    } catch {
      return [];
    }
  }
}
