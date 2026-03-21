import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { generateId } from '../util/id.js';
import { log, logError } from '../util/logger.js';

// ── Task types ──────────────────────────────────────────────────────

export type TaskStatus = 'open' | 'claimed' | 'in_progress' | 'completed' | 'failed' | 'archived';

export interface TaskFilter {
  agentId?: string;
  workingDirReq?: string;
  gitProject?: string;
}

export interface TaskNote {
  noteId: string;
  authorId: string;
  authorName: string;
  content: string;
  timestamp: string;
}

export interface Task {
  taskId: string;
  roomId: string;
  creatorId: string;
  creatorName: string;
  description: string;
  context?: string;
  filter?: TaskFilter;
  status: TaskStatus;
  claimantId?: string;
  claimantName?: string;
  createdAt: string;
  updatedAt: string;
  notes: TaskNote[];
  result?: string;
  error?: string;
}

// ── TaskManager ─────────────────────────────────────────────────────

export class TaskManager {
  private tasks: Map<string, Task> = new Map();
  private readonly tasksDir: string;

  constructor(tasksDir?: string) {
    this.tasksDir = tasksDir ?? path.join(os.homedir(), '.crosschat', 'tasks');
  }

  // ── Initialization ──────────────────────────────────────────────

  async init(): Promise<void> {
    await fs.mkdir(this.tasksDir, { recursive: true });
    await this.loadFromDisk();
    log(`TaskManager initialized with ${this.tasks.size} task(s) from ${this.tasksDir}`);
  }

  // ── CRUD operations ─────────────────────────────────────────────

  async create(params: {
    roomId: string;
    creatorId: string;
    creatorName: string;
    description: string;
    context?: string;
    filter?: TaskFilter;
  }): Promise<Task> {
    const now = new Date().toISOString();
    const task: Task = {
      taskId: generateId(),
      roomId: params.roomId,
      creatorId: params.creatorId,
      creatorName: params.creatorName,
      description: params.description,
      context: params.context,
      filter: params.filter,
      status: 'open',
      createdAt: now,
      updatedAt: now,
      notes: [],
    };

    this.tasks.set(task.taskId, task);
    await this.persist(task);
    log(`Task created: ${task.taskId} by ${task.creatorName}`);
    return task;
  }

  async claim(taskId: string, claimantId: string, claimantName: string): Promise<Task> {
    const task = this.requireTask(taskId);

    if (task.status !== 'open') {
      throw new Error(
        `Cannot claim task ${taskId}: task status is '${task.status}', must be 'open'`
      );
    }

    if (task.creatorId === claimantId) {
      throw new Error(`Cannot claim task ${taskId}: creator cannot claim their own task`);
    }

    task.claimantId = claimantId;
    task.claimantName = claimantName;
    task.status = 'claimed';
    task.updatedAt = new Date().toISOString();

    await this.persist(task);
    log(`Task ${taskId} claimed by ${claimantName} (${claimantId})`);
    return task;
  }

  async acceptClaim(taskId: string, creatorId: string): Promise<Task> {
    const task = this.requireTask(taskId);

    if (task.creatorId !== creatorId) {
      throw new Error(
        `Cannot accept claim on task ${taskId}: only the creator can accept claims`
      );
    }

    if (task.status !== 'claimed') {
      throw new Error(
        `Cannot accept claim on task ${taskId}: task status is '${task.status}', must be 'claimed'`
      );
    }

    task.status = 'in_progress';
    task.updatedAt = new Date().toISOString();

    await this.persist(task);
    log(`Task ${taskId} claim accepted, now in_progress`);
    return task;
  }

  async update(
    taskId: string,
    authorId: string,
    authorName: string,
    content: string,
    status?: TaskStatus
  ): Promise<Task> {
    const task = this.requireTask(taskId);

    this.validateParticipant(task, authorId);

    if (task.status === 'completed' || task.status === 'failed' || task.status === 'archived') {
      throw new Error(
        `Cannot update task ${taskId}: task status is '${task.status}' (terminal state)`
      );
    }

    const note: TaskNote = {
      noteId: generateId(),
      authorId,
      authorName,
      content,
      timestamp: new Date().toISOString(),
    };
    task.notes.push(note);

    if (status !== undefined) {
      this.validateStatusTransition(task.status, status, taskId);
      task.status = status;
    }

    task.updatedAt = new Date().toISOString();

    await this.persist(task);
    log(`Task ${taskId} updated by ${authorName}, note ${note.noteId} added`);
    return task;
  }

  async complete(
    taskId: string,
    authorId: string,
    authorName: string,
    result: string,
    status: 'completed' | 'failed',
    error?: string
  ): Promise<Task> {
    const task = this.requireTask(taskId);

    if (task.claimantId !== authorId) {
      throw new Error(
        `Cannot complete task ${taskId}: only the claimant can complete it`
      );
    }

    if (task.status !== 'in_progress' && task.status !== 'claimed') {
      throw new Error(
        `Cannot complete task ${taskId}: task status is '${task.status}', must be 'in_progress' or 'claimed'`
      );
    }

    const noteContent = status === 'completed'
      ? `Task completed: ${result}`
      : `Task failed: ${error ?? result}`;

    const note: TaskNote = {
      noteId: generateId(),
      authorId,
      authorName,
      content: noteContent,
      timestamp: new Date().toISOString(),
    };
    task.notes.push(note);

    task.status = status;
    task.result = result;
    if (error !== undefined) {
      task.error = error;
    }
    task.updatedAt = new Date().toISOString();

    await this.persist(task);
    log(`Task ${taskId} ${status} by ${authorName}`);
    return task;
  }

  async archive(taskId: string): Promise<Task> {
    const task = this.requireTask(taskId);

    if (task.status === 'archived') {
      throw new Error(`Task ${taskId} is already archived`);
    }

    task.status = 'archived';
    task.updatedAt = new Date().toISOString();

    await this.persist(task);
    log(`Task ${taskId} archived`);
    return task;
  }

  /** Archive all completed/failed tasks in a room. Returns count of tasks archived. */
  async archiveTerminal(roomId?: string): Promise<number> {
    let count = 0;
    for (const task of this.tasks.values()) {
      if (roomId && task.roomId !== roomId) continue;
      if (task.status === 'completed' || task.status === 'failed') {
        task.status = 'archived';
        task.updatedAt = new Date().toISOString();
        await this.persist(task);
        count++;
      }
    }
    if (count > 0) log(`Archived ${count} terminal task(s)${roomId ? ` in room ${roomId}` : ''}`);
    return count;
  }

  get(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }

  list(filter?: { status?: TaskStatus; roomId?: string; assignedTo?: string }): Task[] {
    let result = Array.from(this.tasks.values());

    if (filter?.status) {
      result = result.filter((t) => t.status === filter.status);
    }

    if (filter?.roomId) {
      result = result.filter((t) => t.roomId === filter.roomId);
    }

    if (filter?.assignedTo) {
      result = result.filter((t) => t.claimantId === filter.assignedTo);
    }

    return result;
  }

  // ── Filter matching ─────────────────────────────────────────────

  matchesFilter(
    task: Task,
    agent: { peerId: string; cwd?: string; gitProject?: string }
  ): boolean {
    const f = task.filter;
    if (!f) return true;

    if (f.agentId && f.agentId !== agent.peerId) return false;
    if (f.workingDirReq && f.workingDirReq !== agent.cwd) return false;
    if (f.gitProject && f.gitProject !== agent.gitProject) return false;

    return true;
  }

  // ── Persistence ─────────────────────────────────────────────────

  private async persist(task: Task): Promise<void> {
    const filePath = path.join(this.tasksDir, `${task.taskId}.json`);
    const tmpPath = `${filePath}.tmp`;
    try {
      await fs.writeFile(tmpPath, JSON.stringify(task, null, 2), 'utf-8');
      await fs.rename(tmpPath, filePath);
    } catch (err) {
      logError(`Failed to persist task ${task.taskId}`, err);
      // Clean up tmp file on failure
      try {
        await fs.unlink(tmpPath);
      } catch {
        // ignore cleanup errors
      }
      throw err;
    }
  }

  private async loadFromDisk(): Promise<void> {
    let entries: string[];
    try {
      const dirEntries = await fs.readdir(this.tasksDir);
      entries = dirEntries.filter((e) => e.endsWith('.json'));
    } catch (err) {
      logError('Failed to read tasks directory', err);
      return;
    }

    for (const entry of entries) {
      const filePath = path.join(this.tasksDir, entry);
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        const task = JSON.parse(content) as Task;
        if (task.taskId) {
          this.tasks.set(task.taskId, task);
        }
      } catch (err) {
        logError(`Failed to load task file ${entry}`, err);
      }
    }
  }

  // ── Validation helpers ──────────────────────────────────────────

  private requireTask(taskId: string): Task {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    return task;
  }

  private validateParticipant(task: Task, authorId: string): void {
    if (authorId !== task.creatorId && authorId !== task.claimantId) {
      throw new Error(
        `Agent ${authorId} is not a participant of task ${task.taskId} (neither creator nor claimant)`
      );
    }
  }

  private validateStatusTransition(current: TaskStatus, next: TaskStatus, taskId: string): void {
    const allowed: Record<TaskStatus, TaskStatus[]> = {
      open: ['claimed', 'archived'],
      claimed: ['in_progress', 'open', 'completed', 'failed', 'archived'],
      in_progress: ['completed', 'failed', 'archived'],
      completed: ['archived'],
      failed: ['archived'],
      archived: [],
    };

    if (!allowed[current].includes(next)) {
      throw new Error(
        `Invalid status transition for task ${taskId}: '${current}' -> '${next}'`
      );
    }
  }
}
