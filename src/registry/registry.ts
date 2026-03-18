import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { PeerRegistryEntry } from '../types.js';
import { log, logError } from '../util/logger.js';

const CROSSCHAT_DIR = path.join(os.homedir(), '.crosschat');
const PEERS_DIR = path.join(CROSSCHAT_DIR, 'peers');
const SOCKETS_DIR = path.join(CROSSCHAT_DIR, 'sockets');

export function getPeersDir(): string {
  return PEERS_DIR;
}

export function getSocketsDir(): string {
  return SOCKETS_DIR;
}

export function getSocketPath(peerId: string): string {
  return path.join(SOCKETS_DIR, `${peerId}.sock`);
}

export async function ensureDirectories(): Promise<void> {
  await fs.mkdir(PEERS_DIR, { recursive: true });
  await fs.mkdir(SOCKETS_DIR, { recursive: true });
}

export async function writeRegistryEntry(entry: PeerRegistryEntry): Promise<void> {
  const filePath = path.join(PEERS_DIR, `${entry.peerId}.json`);
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(entry, null, 2), 'utf-8');
  await fs.rename(tmpPath, filePath);
  log(`Registered peer: ${entry.name} (${entry.peerId})`);
}

export async function removeRegistryEntry(peerId: string): Promise<void> {
  const filePath = path.join(PEERS_DIR, `${peerId}.json`);
  try {
    await fs.unlink(filePath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logError('Failed to remove registry entry', err);
    }
  }
}

export async function removeSocketFile(peerId: string): Promise<void> {
  const sockPath = getSocketPath(peerId);
  try {
    await fs.unlink(sockPath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logError('Failed to remove socket file', err);
    }
  }
}

export async function readRegistryEntry(peerId: string): Promise<PeerRegistryEntry | null> {
  const filePath = path.join(PEERS_DIR, `${peerId}.json`);
  try {
    const data = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(data) as PeerRegistryEntry;
  } catch {
    return null;
  }
}

export async function listRegistryEntries(): Promise<PeerRegistryEntry[]> {
  const entries: PeerRegistryEntry[] = [];
  let files: string[];
  try {
    files = await fs.readdir(PEERS_DIR);
  } catch {
    return entries;
  }

  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const data = await fs.readFile(path.join(PEERS_DIR, file), 'utf-8');
      entries.push(JSON.parse(data) as PeerRegistryEntry);
    } catch {
      // Skip malformed entries — cleanup will handle them
    }
  }
  return entries;
}
