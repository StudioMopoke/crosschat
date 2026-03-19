import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readRegistryEntry, removeRegistryEntry, removeSocketFile } from '../registry/registry.js';
import { sendPeerRequest } from '../transport/uds-client.js';
import type { TaskStore } from '../stores/task-store.js';
import type { PeerTaskUpdateParams } from '../types.js';

export function registerCompleteTask(server: McpServer, taskStore: TaskStore): void {
  server.tool(
    'complete_task',
    'Report the result of a delegated task back to the peer who assigned it. Use this instead of send_message when completing a task — it updates the task status on the delegator\'s side so they can track it via get_task_status, and the result appears in their inbox as a [TASK COMPLETED] or [TASK FAILED] message.',
    {
      taskId: z.string().describe('The task ID from the delegated task (from relatedTaskId in the inbox message)'),
      status: z.enum(['completed', 'failed']).describe('"completed" if the task was done successfully, "failed" if it could not be completed'),
      result: z.string().optional().describe('The result or output of the completed task. Include enough detail for the delegator to use.'),
      error: z.string().optional().describe('Error description if the task failed'),
    },
    async ({ taskId, status, result, error }) => {
      // Find the inbound task to get the delegator's peer ID
      const inboundTask = taskStore.getInbound(taskId);
      if (!inboundTask) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Task not found. Use the taskId from the relatedTaskId field of the delegated task message.' }) }],
          isError: true,
        };
      }

      const entry = await readRegistryEntry(inboundTask.fromPeerId);
      if (!entry) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Delegator ${inboundTask.fromName} (${inboundTask.fromPeerId}) is no longer available` }) }],
          isError: true,
        };
      }

      const params: PeerTaskUpdateParams = {
        taskId,
        status,
        result,
        error,
      };

      try {
        const response = await sendPeerRequest(
          entry.socketPath,
          'peer.task_update',
          params as unknown as Record<string, unknown>
        );

        if (response.error) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: response.error.message }) }],
            isError: true,
          };
        }

        // Update our own inbound task status
        taskStore.updateInboundStatus(taskId, status);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              reported: true,
              taskId,
              status,
              reportedTo: inboundTask.fromName,
            }),
          }],
        };
      } catch (err: unknown) {
        if (err instanceof Error && ('code' in err && ((err as NodeJS.ErrnoException).code === 'ECONNREFUSED' || (err as NodeJS.ErrnoException).code === 'ENOENT'))) {
          await removeRegistryEntry(inboundTask.fromPeerId);
          await removeSocketFile(inboundTask.fromPeerId);
        }
        const message = err instanceof Error ? err.message : 'Unknown error';
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Failed to reach delegator: ${message}` }) }],
          isError: true,
        };
      }
    }
  );
}
