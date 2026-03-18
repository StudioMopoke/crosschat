import type { DelegatedTask, InboundTask, TaskStatus } from '../types.js';

export class TaskStore {
  private delegated: Map<string, DelegatedTask> = new Map();
  private inbound: Map<string, InboundTask> = new Map();

  // === Delegated (outbound) tasks ===

  addDelegated(task: DelegatedTask): void {
    this.delegated.set(task.taskId, task);
  }

  getDelegated(taskId: string): DelegatedTask | undefined {
    return this.delegated.get(taskId);
  }

  updateDelegatedStatus(taskId: string, status: TaskStatus, result?: string, error?: string): boolean {
    const task = this.delegated.get(taskId);
    if (!task) return false;
    task.status = status;
    task.updatedAt = new Date().toISOString();
    if (result !== undefined) task.result = result;
    if (error !== undefined) task.error = error;
    return true;
  }

  listDelegated(): DelegatedTask[] {
    return Array.from(this.delegated.values());
  }

  // === Inbound tasks ===

  addInbound(task: InboundTask): void {
    this.inbound.set(task.taskId, task);
  }

  getInbound(taskId: string): InboundTask | undefined {
    return this.inbound.get(taskId);
  }

  updateInboundStatus(taskId: string, status: TaskStatus): boolean {
    const task = this.inbound.get(taskId);
    if (!task) return false;
    task.status = status;
    return true;
  }

  listInbound(): InboundTask[] {
    return Array.from(this.inbound.values());
  }

  // === Timeout sweep ===

  sweepTimedOutTasks(): void {
    const now = Date.now();
    for (const task of this.delegated.values()) {
      if (task.status === 'pending' || task.status === 'in_progress') {
        const createdAt = new Date(task.createdAt).getTime();
        if (now - createdAt > task.timeoutMs) {
          task.status = 'timed_out';
          task.updatedAt = new Date().toISOString();
        }
      }
    }
  }
}
