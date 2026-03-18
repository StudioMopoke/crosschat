import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readRegistryEntry, removeRegistryEntry, removeSocketFile } from '../registry/registry.js';
import { sendPeerRequest } from '../transport/uds-client.js';
import { generateId } from '../util/id.js';
import type { TaskStore } from '../stores/task-store.js';
import type { DelegatedTask, PeerDelegateTaskParams } from '../types.js';

const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes

export function registerDelegateTask(
  server: McpServer,
  ownPeerId: string,
  ownName: string,
  taskStore: TaskStore
): void {
  server.tool(
    'delegate_task',
    'Ask another CrossChat peer to perform a task. The peer receives the task as a message in their inbox (prefixed with [TASK DELEGATED]) and can work on it independently. Returns a taskId that you can poll with get_task_status. Use this when you want to parallelize work across instances — e.g., "run the tests in project X" or "refactor the auth module". The peer must be running and reachable. Tasks time out after 5 minutes by default.',
    {
      targetPeerId: z.string().describe('The UUID of the peer to delegate to (from list_peers results)'),
      description: z.string().describe('Clear description of what the peer should do. Be specific — the peer will see this as their task instruction.'),
      context: z.string().optional().describe('Additional context to help the peer complete the task — e.g., relevant file paths, background info, constraints, or expected output format.'),
      timeoutMs: z.number().optional().describe('How long to wait before marking the task as timed_out, in milliseconds. Default: 300000 (5 minutes). Set higher for long-running tasks.'),
    },
    async ({ targetPeerId, description, context, timeoutMs }) => {
      const entry = await readRegistryEntry(targetPeerId);
      if (!entry) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Peer not found' }) }],
          isError: true,
        };
      }

      const taskId = generateId();
      const timeout = timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const now = new Date().toISOString();

      const params: PeerDelegateTaskParams = {
        taskId,
        fromPeerId: ownPeerId,
        fromName: ownName,
        description,
        context,
        timeoutMs: timeout,
      };

      try {
        const response = await sendPeerRequest(
          entry.socketPath,
          'peer.delegate_task',
          params as unknown as Record<string, unknown>,
          10_000 // 10s for delegation handshake
        );

        if (response.error) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: response.error.message }) }],
            isError: true,
          };
        }

        const task: DelegatedTask = {
          taskId,
          targetPeerId,
          targetName: entry.name,
          description,
          context,
          status: 'pending',
          createdAt: now,
          updatedAt: now,
          timeoutMs: timeout,
        };
        taskStore.addDelegated(task);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                delegated: true,
                taskId,
                targetPeerId,
                targetName: entry.name,
                timeoutMs: timeout,
              }),
            },
          ],
        };
      } catch (err: unknown) {
        if (err instanceof Error && ('code' in err && ((err as NodeJS.ErrnoException).code === 'ECONNREFUSED' || (err as NodeJS.ErrnoException).code === 'ENOENT'))) {
          await removeRegistryEntry(targetPeerId);
          await removeSocketFile(targetPeerId);
        }
        const message = err instanceof Error ? err.message : 'Unknown error';
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Failed to delegate: ${message}` }) }],
          isError: true,
        };
      }
    }
  );
}
