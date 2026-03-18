import fs from 'node:fs/promises';
import path from 'node:path';
import { isProcessAlive } from '../util/pid.js';
import { log, logError } from '../util/logger.js';
import { getPeersDir, getSocketPath } from './registry.js';
import type { PeerRegistryEntry } from '../types.js';

export async function pruneStaleEntries(ownPeerId?: string): Promise<void> {
  const peersDir = getPeersDir();
  let files: string[];
  try {
    files = await fs.readdir(peersDir);
  } catch {
    return;
  }

  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const filePath = path.join(peersDir, file);

    let entry: PeerRegistryEntry;
    try {
      const data = await fs.readFile(filePath, 'utf-8');
      entry = JSON.parse(data) as PeerRegistryEntry;
    } catch {
      // Malformed file — remove it
      log(`Removing malformed registry file: ${file}`);
      await safeUnlink(filePath);
      continue;
    }

    // Don't prune ourselves
    if (ownPeerId && entry.peerId === ownPeerId) continue;

    // Check if peer is still alive
    if (!isProcessAlive(entry.pid)) {
      log(`Pruning stale peer: ${entry.name} (${entry.peerId}, pid ${entry.pid})`);
      await safeUnlink(filePath);
      await safeUnlink(getSocketPath(entry.peerId));
      continue;
    }

    // Check if socket file exists
    try {
      await fs.access(entry.socketPath);
    } catch {
      log(`Pruning peer with missing socket: ${entry.name} (${entry.peerId})`);
      await safeUnlink(filePath);
    }
  }
}

async function safeUnlink(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logError(`Failed to unlink ${filePath}`, err);
    }
  }
}
