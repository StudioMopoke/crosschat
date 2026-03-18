import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PeerRegistryEntry, PeerStatus } from '../types.js';
import { writeRegistryEntry } from '../registry/registry.js';
import { sendPeerRequest } from '../transport/uds-client.js';
import { readRegistryEntry } from '../registry/registry.js';
import { log } from '../util/logger.js';

export function registerSetStatus(
  server: McpServer,
  entry: PeerRegistryEntry
): void {
  server.tool(
    'set_status',
    `Set your availability status so other peers and orchestrators can see whether you're free or busy. When you start working on a delegated task, set status to "busy" with a description of what you're doing and the orchestrator's peer ID. When you finish, set it back to "available" — this also notifies the orchestrator that you're done. Orchestrators check peer status via list_peers before delegating work and will skip busy peers.`,
    {
      status: z.enum(['available', 'busy']).describe('"available" = ready for work, "busy" = currently working on something'),
      detail: z.string().optional().describe('What you\'re doing (e.g., "Running tests for auth module"). Shown to other peers in list_peers.'),
      taskId: z.string().optional().describe('The task ID you\'re working on, if this is a delegated task.'),
      orchestratorPeerId: z.string().optional().describe('The peer ID of the orchestrator who assigned the work. When you set status back to "available", the orchestrator will be notified that you\'re done.'),
    },
    async ({ status, detail, taskId, orchestratorPeerId }) => {
      const prevStatus = entry.status;
      const prevOrchestrator = entry.orchestratorPeerId;

      entry.status = status;
      entry.statusDetail = detail;
      entry.busyWithTaskId = taskId;
      entry.orchestratorPeerId = status === 'busy' ? (orchestratorPeerId ?? entry.orchestratorPeerId) : undefined;

      await writeRegistryEntry(entry);
      log(`Status changed: ${prevStatus} → ${status}${detail ? ` (${detail})` : ''}`);

      // If transitioning from busy → available and we have an orchestrator, notify them
      if (prevStatus === 'busy' && status === 'available' && prevOrchestrator) {
        try {
          const orchestrator = await readRegistryEntry(prevOrchestrator);
          if (orchestrator) {
            const message = entry.busyWithTaskId
              ? `[PEER AVAILABLE] ${entry.name} has finished task ${entry.busyWithTaskId} and is now available for more work.`
              : `[PEER AVAILABLE] ${entry.name} is now available for work.`;

            await sendPeerRequest(orchestrator.socketPath, 'peer.message', {
              messageId: `status-${Date.now()}`,
              fromPeerId: entry.peerId,
              fromName: entry.name,
              content: message,
              sentAt: new Date().toISOString(),
              relatedTaskId: entry.busyWithTaskId,
            });

            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  status,
                  detail,
                  notifiedOrchestrator: orchestrator.name,
                }),
              }],
            };
          }
        } catch {
          // Orchestrator unreachable — still update our status
        }
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ status, detail }),
        }],
      };
    }
  );
}
