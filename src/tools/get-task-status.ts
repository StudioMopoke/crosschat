import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { TaskStore } from '../stores/task-store.js';

export function registerGetTaskStatus(server: McpServer, taskStore: TaskStore): void {
  server.tool(
    'get_task_status',
    'Poll the status of a task you previously delegated via delegate_task. Returns the current status (pending, in_progress, completed, failed, or timed_out), along with the task description, target peer info, timestamps, and any result or error message. Call this periodically after delegating to check if the peer has finished.',
    {
      taskId: z.string().describe('The task ID returned by delegate_task'),
    },
    async ({ taskId }) => {
      const task = taskStore.getDelegated(taskId);
      if (!task) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Task not found' }) }],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                taskId: task.taskId,
                targetPeerId: task.targetPeerId,
                targetName: task.targetName,
                description: task.description,
                status: task.status,
                createdAt: task.createdAt,
                updatedAt: task.updatedAt,
                result: task.result,
                error: task.error,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
