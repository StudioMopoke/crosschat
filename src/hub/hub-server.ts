import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { generateId } from '../util/id.js';
import { isProcessAlive } from '../util/pid.js';
import { log, logError } from '../util/logger.js';
import { TaskManager, type Task } from './task-manager.js';
import {
  type AgentMessage,
  type ServerMessage,
  type PeerInfo,
  type AgentStatus,
  type TaskNote,
  encodeMessage,
  decodeMessage,
} from './protocol.js';
import { createRequire } from 'node:module';

// ── Constants ────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pkg = require('../../package.json') as { version: string };

const CROSSCHAT_DIR = path.join(os.homedir(), '.crosschat');
const DIGESTS_DIR = path.join(CROSSCHAT_DIR, 'digests');
const DASHBOARD_LOCK_FILE = path.join(CROSSCHAT_DIR, 'dashboard.lock');
const INSTANCES_FILE = path.join(CROSSCHAT_DIR, 'instances.json');
const REGISTER_TIMEOUT_MS = 5_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 10_000;
const ROOM_MESSAGE_CAP = 200;
const IDLE_SHUTDOWN_MS = 5 * 60 * 1000; // 5 minutes with no agents → auto-shutdown
const PERMISSION_TTL_MS = 10 * 60 * 1000;  // 10 minutes for pending permissions
const PERMISSION_SWEEP_INTERVAL_MS = 60_000;
const WS_MAX_PAYLOAD = 1 * 1024 * 1024;  // 1MB

// ── Types ────────────────────────────────────────────────────────────

interface DashboardLock {
  pid: number;
  port: number;
  version: string;
  startedAt: string;
}

interface Instance {
  id: string;
  name: string;
  path: string;
  description?: string;
  createdAt: string;
}

interface PendingPermission {
  id: string;
  agentName: string;
  agentPeerId?: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  description?: string;
  status: 'pending' | 'approved' | 'denied';
  reason?: string;
  createdAt: string;
  decidedAt?: string;
}

interface ConnectedAgent {
  peerId: string;
  name: string;
  cwd: string;
  pid: number;
  ws: WebSocket;
  status: AgentStatus;
  statusDetail?: string;
  currentRoom: string;
  connectedAt: string;
}

type MessageImportance = 'important' | 'comment' | 'chitchat';

interface ChatMessage {
  messageId: string;
  roomId: string;
  fromPeerId: string;
  fromName: string;
  content: string;
  metadata?: Record<string, unknown>;
  timestamp: string;
  source: 'agent' | 'user' | 'system';
  mentions?: string[];       // mentioned agent names (e.g., ["crosschat-20cd"])
  mentionType?: 'direct' | 'here' | 'broadcast';  // how the message is targeted
  importance?: MessageImportance;
}

interface Room {
  id: string;
  name: string;
  messages: ChatMessage[];
  createdAt: string;
}

// ── Lock file helpers ────────────────────────────────────────────────

async function ensureCrosschatDir(): Promise<void> {
  await fs.mkdir(CROSSCHAT_DIR, { recursive: true });
}

async function readDashboardLock(): Promise<DashboardLock | null> {
  try {
    const data = await fs.readFile(DASHBOARD_LOCK_FILE, 'utf-8');
    const lock = JSON.parse(data) as DashboardLock;
    if (isProcessAlive(lock.pid)) {
      return lock;
    }
    await fs.unlink(DASHBOARD_LOCK_FILE).catch(() => {});
    return null;
  } catch {
    return null;
  }
}

async function writeDashboardLock(port: number): Promise<void> {
  const lock: DashboardLock = {
    pid: process.pid,
    port,
    version: pkg.version,
    startedAt: new Date().toISOString(),
  };
  const tmpPath = `${DASHBOARD_LOCK_FILE}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(lock, null, 2), 'utf-8');
  await fs.rename(tmpPath, DASHBOARD_LOCK_FILE);
}

async function removeDashboardLock(): Promise<void> {
  try {
    const data = await fs.readFile(DASHBOARD_LOCK_FILE, 'utf-8');
    const lock = JSON.parse(data) as DashboardLock;
    if (lock.pid === process.pid) {
      await fs.unlink(DASHBOARD_LOCK_FILE);
    }
  } catch {
    // Lock file already gone or unreadable
  }
}

// ── Instance store helpers ────────────────────────────────────────────

async function loadInstances(): Promise<Map<string, Instance>> {
  try {
    const data = await fs.readFile(INSTANCES_FILE, 'utf-8');
    const list = JSON.parse(data) as Instance[];
    return new Map(list.map((p) => [p.id, p]));
  } catch {
    return new Map();
  }
}

async function persistInstances(instances: Map<string, Instance>): Promise<void> {
  const list = [...instances.values()];
  const tmpPath = `${INSTANCES_FILE}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(list, null, 2), 'utf-8');
  await fs.rename(tmpPath, INSTANCES_FILE);
}

// ── Version from package.json ────────────────────────────────────────

function getServerVersion(): string {
  return pkg.version;
}

// ── Hub Server ───────────────────────────────────────────────────────

/**
 * Start the hub server.
 *
 * Central hub for CrossChat: manages agent WebSocket connections, peer registry,
 * rooms, message routing, tasks, and serves the React dashboard frontend.
 */
export async function startHub(): Promise<void> {
  await ensureCrosschatDir();

  // Check for an already-running hub
  const existingLock = await readDashboardLock();
  if (existingLock) {
    log(`Hub already running on port ${existingLock.port} (pid ${existingLock.pid})`);
    process.exit(1);
  }

  // ── State ──────────────────────────────────────────────────────

  const agents = new Map<string, ConnectedAgent>();
  const rooms = new Map<string, Room>();
  const browserClients = new Set<WebSocket>();
  const browserRooms = new WeakMap<WebSocket, Set<string>>();
  const browserTokens = new Map<WebSocket, string>();   // session tokens for permission decisions
  const validTokens = new Set<string>();                 // fast lookup for REST auth
  const pendingPermissions = new Map<string, PendingPermission>();
  const instances = await loadInstances();

  // Initialize TaskManager
  const taskManager = new TaskManager();
  await taskManager.init();

  // Digest tracking: roomId -> taskId of currently active digest task
  const activeDigestTasks = new Map<string, string>();

  // Idle shutdown: auto-shutdown when no agents are connected for IDLE_SHUTDOWN_MS
  let idleShutdownTimer: NodeJS.Timeout | null = null;

  // Ensure digests directory exists
  await fs.mkdir(DIGESTS_DIR, { recursive: true });

  // Seed default rooms
  rooms.set('general', {
    id: 'general',
    name: 'General',
    messages: [],
    createdAt: new Date().toISOString(),
  });
  rooms.set('crosschat', {
    id: 'crosschat',
    name: 'CrossChat Activity',
    messages: [],
    createdAt: new Date().toISOString(),
  });

  // ── Helpers ────────────────────────────────────────────────────

  function sendToWs(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(encodeMessage(msg));
    }
  }

  function sendError(ws: WebSocket, message: string, requestId?: string): void {
    sendToWs(ws, { type: 'error', message, requestId });
  }

  async function autoRegisterInstance(cwd: string): Promise<void> {
    const resolvedPath = path.resolve(cwd);

    // Skip if path has unsafe characters (same check as POST /api/instances)
    if (!/^[a-zA-Z0-9\s/\-_\.~]+$/.test(resolvedPath)) return;

    // Skip if an instance with this path already exists
    for (const existing of instances.values()) {
      if (existing.path === resolvedPath) return;
    }

    // Validate directory exists
    try {
      const stat = await fs.stat(resolvedPath);
      if (!stat.isDirectory()) return;
    } catch {
      return;
    }

    const dirName = resolvedPath.split('/').filter(Boolean).pop() || 'unknown';
    const instance: Instance = {
      id: generateId(),
      name: dirName,
      path: resolvedPath,
      createdAt: new Date().toISOString(),
    };
    instances.set(instance.id, instance);
    await persistInstances(instances);
    log(`Auto-registered instance: ${instance.name} (${instance.path})`);
  }

  function findAgentByWs(ws: WebSocket): ConnectedAgent | undefined {
    for (const agent of agents.values()) {
      if (agent.ws === ws) return agent;
    }
    return undefined;
  }

  function findAgentById(peerId: string): ConnectedAgent | undefined {
    return agents.get(peerId);
  }

  function buildPeerInfo(agent: ConnectedAgent): PeerInfo {
    return {
      peerId: agent.peerId,
      name: agent.name,
      cwd: agent.cwd,
      pid: agent.pid,
      status: agent.status,
      statusDetail: agent.statusDetail,
      currentRoom: agent.currentRoom,
      connectedAt: agent.connectedAt,
    };
  }

  function taskToSummary(task: Task) {
    return {
      taskId: task.taskId,
      roomId: task.roomId,
      creatorId: task.creatorId,
      creatorName: task.creatorName,
      description: task.description,
      context: task.context,
      filter: task.filter,
      status: task.status,
      claimantId: task.claimantId,
      claimantName: task.claimantName,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    };
  }

  // ── Mention parsing ──────────────────────────────────────────

  /**
   * Parse @mentions from message content.
   * Supports @agent-name (targeted) and @here (room broadcast).
   * Returns the list of mentioned agent names and the mention type.
   */
  function parseMentions(content: string): { mentions: string[]; mentionType: 'direct' | 'here' | 'broadcast' } {
    const hasHere = /@here\b/i.test(content);
    if (hasHere) {
      return { mentions: [], mentionType: 'here' };
    }

    // Extract all @mentions from the content
    const mentionPattern = /@([\w-]+)/g;
    const rawMentions: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = mentionPattern.exec(content)) !== null) {
      rawMentions.push(match[1]);
    }

    if (rawMentions.length === 0) {
      return { mentions: [], mentionType: 'broadcast' };
    }

    // Resolve mentions against known agent names (case-insensitive)
    const resolvedNames: string[] = [];
    for (const agent of agents.values()) {
      const agentNameLower = agent.name.toLowerCase();
      for (const mention of rawMentions) {
        if (mention.toLowerCase() === agentNameLower) {
          resolvedNames.push(agent.name);
        }
      }
    }

    if (resolvedNames.length > 0) {
      return { mentions: resolvedNames, mentionType: 'direct' };
    }

    // Mentions didn't match any known agents — treat as broadcast
    return { mentions: [], mentionType: 'broadcast' };
  }

  // ── Broadcasting ───────────────────────────────────────────────

  /** Broadcast a server message to all agents in a specific room. */
  function broadcastToRoomAgents(roomId: string, msg: ServerMessage, excludePeerId?: string): void {
    for (const agent of agents.values()) {
      if (agent.currentRoom === roomId && agent.peerId !== excludePeerId) {
        sendToWs(agent.ws, msg);
      }
    }
  }

  /** Broadcast a JSON payload to all browser clients subscribed to a room. */
  function broadcastToRoomBrowsers(roomId: string, data: Record<string, unknown>): void {
    const payload = JSON.stringify(data);
    for (const client of browserClients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      const joined = browserRooms.get(client);
      if (joined?.has(roomId)) {
        client.send(payload);
      }
    }
  }

  /** Broadcast to ALL browser clients (not filtered by room). */
  function broadcastToAllBrowsers(data: Record<string, unknown>): void {
    const payload = JSON.stringify(data);
    for (const client of browserClients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  /** Broadcast a room message to agents AND browsers in the room, with mention filtering. */
  function broadcastRoomMessage(roomId: string, msg: ChatMessage, excludePeerId?: string): void {
    // Build the protocol message for agents
    const agentMsg: ServerMessage = {
      type: 'room.message',
      roomId: msg.roomId,
      messageId: msg.messageId,
      fromPeerId: msg.fromPeerId,
      fromName: msg.fromName,
      content: msg.content,
      metadata: msg.metadata,
      timestamp: msg.timestamp,
      source: msg.source,
      mentions: msg.mentions,
      mentionType: msg.mentionType,
      importance: msg.importance,
    };

    if (msg.mentionType === 'direct' && msg.mentions && msg.mentions.length > 0) {
      // Direct mention: only deliver to mentioned agents (+ sender echo)
      const mentionedNamesLower = new Set(msg.mentions.map((n) => n.toLowerCase()));
      for (const agent of agents.values()) {
        if (agent.currentRoom !== roomId) continue;
        if (agent.peerId === excludePeerId) continue;
        if (mentionedNamesLower.has(agent.name.toLowerCase()) || agent.peerId === msg.fromPeerId) {
          sendToWs(agent.ws, agentMsg);
        }
      }
    } else {
      // @here or broadcast: deliver to all agents in the room
      broadcastToRoomAgents(roomId, agentMsg, excludePeerId);
    }

    // Always send to all browsers — dashboard users see everything
    broadcastToRoomBrowsers(roomId, {
      type: 'message',
      messageId: msg.messageId,
      roomId: msg.roomId,
      username: msg.fromName,
      text: msg.content,
      timestamp: msg.timestamp,
      source: msg.source,
      mentions: msg.mentions,
      mentionType: msg.mentionType,
      importance: msg.importance,
    });
  }

  // ── Activity room ────────────────────────────────────────────

  /** Post a system event to the CrossChat Activity room. */
  function postActivity(content: string, importance: MessageImportance = 'comment'): void {
    const room = rooms.get('crosschat');
    if (!room) return;

    const msg: ChatMessage = {
      messageId: generateId(),
      roomId: 'crosschat',
      fromPeerId: 'system',
      fromName: 'system',
      content,
      timestamp: new Date().toISOString(),
      source: 'system',
      importance,
    };

    room.messages.push(msg);
    broadcastRoomMessage('crosschat', msg);

    // Drop oldest messages when cap is exceeded (no digest for activity room)
    if (room.messages.length > ROOM_MESSAGE_CAP) {
      room.messages = room.messages.slice(-ROOM_MESSAGE_CAP);
    }
  }

  // ── Digest system ─────────────────────────────────────────────

  /**
   * Enforce the per-room message cap. When exceeded, the oldest messages
   * are moved to a pending digest JSONL file and a digest task is created.
   */
  async function enforceRoomMessageCap(room: Room): Promise<void> {
    if (room.messages.length <= ROOM_MESSAGE_CAP) return;
    if (room.id === 'crosschat') return; // activity room handles its own cap via postActivity()

    const overflow = room.messages.length - ROOM_MESSAGE_CAP;
    const evicted = room.messages.splice(0, overflow);

    // Append evicted messages to pending digest file (one JSON object per line)
    const pendingPath = path.join(DIGESTS_DIR, `${room.id}.jsonl`);
    const lines = evicted.map((m) => JSON.stringify(m)).join('\n') + '\n';
    await fs.appendFile(pendingPath, lines, 'utf-8');

    log(`Room ${room.id}: evicted ${overflow} message(s) to pending digest`);

    // Auto-delegate a digest task if one isn't already active for this room
    const existingTaskId = activeDigestTasks.get(room.id);
    if (existingTaskId) {
      const existingTask = taskManager.get(existingTaskId);
      if (existingTask && (existingTask.status === 'open' || existingTask.status === 'claimed' || existingTask.status === 'in_progress')) {
        // A digest task is already in progress — don't create another
        return;
      }
      // Previous task finished or was archived — allow a new one
      activeDigestTasks.delete(room.id);
    }

    // Read the pending messages as context for the digest task
    let pendingContent: string;
    try {
      pendingContent = await fs.readFile(pendingPath, 'utf-8');
    } catch {
      pendingContent = lines;
    }

    try {
      const task = await taskManager.create({
        roomId: room.id,
        creatorId: 'system',
        creatorName: 'system',
        description: 'Summarize the following room messages into a digest',
        context: pendingContent,
      });

      activeDigestTasks.set(room.id, task.taskId);

      // Broadcast task creation to agents and browsers in the room
      const summary = taskToSummary(task);
      broadcastToRoomAgents(room.id, { type: 'task.created', task: summary });
      broadcastToRoomBrowsers(room.id, { type: 'task.created', task: summary });

      log(`Digest task ${task.taskId} created for room ${room.id}`);
      postActivity(`Room "${room.name}" hit message cap — auto-digest initiated`);
    } catch (err) {
      logError(`Failed to create digest task for room ${room.id}`, err);
    }
  }

  /**
   * Handle digest task completion: persist the full digest to disk,
   * clear the pending file, and insert a system message into the room.
   */
  async function handleDigestCompletion(task: Task): Promise<void> {
    const roomId = task.roomId;
    const digestSummary = task.result ?? '';

    // Read the pending messages that were the basis for this digest
    const pendingPath = path.join(DIGESTS_DIR, `${roomId}.jsonl`);
    let pendingMessages = '';
    try {
      pendingMessages = await fs.readFile(pendingPath, 'utf-8');
    } catch {
      // Pending file may have been cleared already
    }

    // Persist the full digest to ~/.crosschat/digests/{roomId}/{timestamp}.md
    const roomDigestDir = path.join(DIGESTS_DIR, roomId);
    await fs.mkdir(roomDigestDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const digestPath = path.join(roomDigestDir, `${timestamp}.md`);

    // Format original messages for the "Full messages" section
    let formattedMessages = '';
    if (pendingMessages.trim()) {
      const msgLines = pendingMessages.trim().split('\n');
      for (const line of msgLines) {
        try {
          const msg = JSON.parse(line) as ChatMessage;
          formattedMessages += `**${msg.fromName}** (${msg.timestamp}): ${msg.content}\n\n`;
        } catch {
          // Skip malformed lines
        }
      }
    }

    const digestContent = `# Room Digest: ${roomId}\n\n` +
      `Generated: ${new Date().toISOString()}\n\n` +
      `## Summary\n\n${digestSummary}\n\n` +
      `## Full messages\n\n${formattedMessages || '(no messages available)'}`;

    await fs.writeFile(digestPath, digestContent, 'utf-8');

    // Clear the pending file
    try {
      await fs.unlink(pendingPath);
    } catch {
      // Already gone
    }

    // Clean up tracking
    activeDigestTasks.delete(roomId);

    // Insert a system message into the room
    const firstLine = digestSummary.split('\n')[0].slice(0, 200);
    const room = rooms.get(roomId);
    if (room) {
      const sysMsg: ChatMessage = {
        messageId: generateId(),
        roomId,
        fromPeerId: 'system',
        fromName: 'system',
        content: `\u{1F4CB} Room digest: ${firstLine}\n\nFull digest saved to ${digestPath}`,
        timestamp: new Date().toISOString(),
        source: 'system',
        importance: 'important',
      };
      room.messages.push(sysMsg);
      broadcastRoomMessage(roomId, sysMsg);
    }

    log(`Digest completed for room ${roomId}: ${digestPath}`);
    const digestRoom = rooms.get(roomId);
    postActivity(`Digest completed for room "${digestRoom?.name ?? roomId}"`);
  }

  // ── Agent removal ──────────────────────────────────────────────

  function removeAgent(peerId: string): void {
    const agent = agents.get(peerId);
    if (!agent) return;
    agents.delete(peerId);
    log(`Agent disconnected: ${agent.name} (${peerId})`);
    broadcastToAllBrowsers({ type: 'peerDisconnected', peerId, name: agent.name });
    postActivity(`${agent.name} disconnected`);

    // Start idle shutdown timer if no agents remain
    if (agents.size === 0 && !idleShutdownTimer) {
      log(`No agents connected — hub will auto-shutdown in ${IDLE_SHUTDOWN_MS / 1000}s`);
      postActivity(`No agents connected — idle shutdown in ${IDLE_SHUTDOWN_MS / 1000}s`);
      idleShutdownTimer = setTimeout(() => {
        if (agents.size === 0) {
          shutdown('idle (no agents for 5 minutes)');
        }
      }, IDLE_SHUTDOWN_MS);
      idleShutdownTimer.unref();
    }
  }

  // ── Agent message handlers ────────────────────────────────────

  function handleAgentStatus(agent: ConnectedAgent, msg: AgentMessage & { type: 'agent.status' }): void {
    agent.status = msg.status;
    agent.statusDetail = msg.detail;
    log(`Agent ${agent.name} status: ${msg.status}${msg.detail ? ` (${msg.detail})` : ''}`);
    postActivity(`${agent.name} -> ${msg.status}${msg.detail ? ` (${msg.detail})` : ''}`, 'chitchat');
  }

  function handleJoinRoom(agent: ConnectedAgent, msg: AgentMessage & { type: 'agent.joinRoom' }): void {
    const room = rooms.get(msg.roomId);
    if (!room) {
      sendError(agent.ws, `Room not found: ${msg.roomId}`);
      return;
    }

    const oldRoom = agent.currentRoom;
    agent.currentRoom = msg.roomId;

    // Notify the agent
    sendToWs(agent.ws, { type: 'room.joined', roomId: room.id, name: room.name });

    // Notify browsers about room membership change
    if (oldRoom !== msg.roomId) {
      broadcastToRoomBrowsers(oldRoom, {
        type: 'agentLeft',
        roomId: oldRoom,
        peerId: agent.peerId,
        name: agent.name,
      });
      broadcastToRoomBrowsers(msg.roomId, {
        type: 'agentJoined',
        roomId: msg.roomId,
        peerId: agent.peerId,
        name: agent.name,
      });
    }

    log(`Agent ${agent.name} joined room ${msg.roomId}`);
    postActivity(`${agent.name} joined room "${room.name}"`, 'chitchat');
  }

  function handleCreateRoom(agent: ConnectedAgent, msg: AgentMessage & { type: 'agent.createRoom' }): void {
    if (rooms.has(msg.roomId)) {
      sendError(agent.ws, `Room already exists: ${msg.roomId}`);
      return;
    }

    const room: Room = {
      id: msg.roomId,
      name: msg.name ?? msg.roomId,
      messages: [],
      createdAt: new Date().toISOString(),
    };
    rooms.set(msg.roomId, room);

    // Notify the creating agent
    sendToWs(agent.ws, { type: 'room.created', roomId: room.id, name: room.name });

    // Notify all browser clients about the new room
    broadcastToAllBrowsers({
      type: 'roomCreated',
      room: { id: room.id, name: room.name, createdAt: room.createdAt, messageCount: 0 },
    });

    log(`Room created: ${room.id} by ${agent.name}`);
    postActivity(`${agent.name} created room "${room.name}"`);
  }

  function handleSendMessage(agent: ConnectedAgent, msg: AgentMessage & { type: 'agent.sendMessage' }): void {
    const roomId = agent.currentRoom;
    const room = rooms.get(roomId);
    if (!room) {
      sendError(agent.ws, `Room not found: ${roomId}`);
      return;
    }

    const { mentions, mentionType } = parseMentions(msg.content);

    const chatMsg: ChatMessage = {
      messageId: generateId(),
      roomId,
      fromPeerId: agent.peerId,
      fromName: agent.name,
      content: msg.content,
      metadata: msg.metadata,
      timestamp: new Date().toISOString(),
      source: 'agent',
      mentions: mentions.length > 0 ? mentions : undefined,
      mentionType,
      importance: msg.importance,
    };

    room.messages.push(chatMsg);
    enforceRoomMessageCap(room).catch((err) => logError('Error enforcing room message cap', err));
    // Broadcast with mention-based filtering
    broadcastRoomMessage(roomId, chatMsg);
  }

  function handleListPeers(agent: ConnectedAgent, msg: AgentMessage & { type: 'agent.listPeers' }): void {
    const peers: PeerInfo[] = [];
    for (const a of agents.values()) {
      if (a.peerId !== agent.peerId) {
        peers.push(buildPeerInfo(a));
      }
    }
    sendToWs(agent.ws, { type: 'peers', requestId: msg.requestId, peers });
  }

  async function handleTaskCreate(agent: ConnectedAgent, msg: AgentMessage & { type: 'task.create' }): Promise<void> {
    try {
      const task = await taskManager.create({
        roomId: agent.currentRoom,
        creatorId: agent.peerId,
        creatorName: agent.name,
        description: msg.description,
        context: msg.context,
        filter: msg.filter,
      });

      const summary = taskToSummary(task);

      // If the creator sent a requestId, send a direct response so they get the taskId
      if (msg.requestId) {
        sendToWs(agent.ws, { type: 'task.created', requestId: msg.requestId, task: summary });
      }

      // Broadcast to all agents in the room (including creator) and browsers
      broadcastToRoomAgents(agent.currentRoom, { type: 'task.created', task: summary });
      broadcastToRoomBrowsers(agent.currentRoom, { type: 'task.created', task: summary });

      const targetDesc = task.filter?.agentId ? ` -> ${task.filter.agentId}` : '';
      postActivity(`${agent.name} delegated task "${task.description}"${targetDesc}`);
    } catch (err) {
      sendError(agent.ws, err instanceof Error ? err.message : 'Failed to create task', msg.requestId);
    }
  }

  async function handleTaskClaim(agent: ConnectedAgent, msg: AgentMessage & { type: 'task.claim' }): Promise<void> {
    try {
      const task = await taskManager.claim(msg.taskId, agent.peerId, agent.name);

      // Notify the task creator
      const creator = findAgentById(task.creatorId);
      if (creator) {
        sendToWs(creator.ws, {
          type: 'task.claimed',
          taskId: task.taskId,
          claimantId: agent.peerId,
          claimantName: agent.name,
        });
      }

      // Also notify the claimant that the claim was registered
      sendToWs(agent.ws, {
        type: 'task.claimed',
        taskId: task.taskId,
        claimantId: agent.peerId,
        claimantName: agent.name,
      });

      // Broadcast to dashboard
      broadcastToAllBrowsers({ type: 'task.claimed', taskId: task.taskId, claimantId: agent.peerId, claimantName: agent.name });

      postActivity(`${agent.name} claimed task "${task.description}"`, 'chitchat');
    } catch (err) {
      sendError(agent.ws, err instanceof Error ? err.message : 'Failed to claim task');
    }
  }

  async function handleTaskAccept(agent: ConnectedAgent, msg: AgentMessage & { type: 'task.accept' }): Promise<void> {
    try {
      const task = await taskManager.acceptClaim(msg.taskId, agent.peerId);

      // Notify the claimant
      if (task.claimantId) {
        const claimant = findAgentById(task.claimantId);
        if (claimant) {
          sendToWs(claimant.ws, {
            type: 'task.claimAccepted',
            taskId: task.taskId,
            assignedTo: task.claimantId,
          });
        }
      }

      // Acknowledge to the creator
      sendToWs(agent.ws, {
        type: 'task.claimAccepted',
        taskId: task.taskId,
        assignedTo: task.claimantId ?? '',
      });

      // Broadcast to dashboard
      broadcastToAllBrowsers({ type: 'task.claimAccepted', taskId: task.taskId, assignedTo: task.claimantId ?? '' });

      postActivity(`${agent.name} accepted claim from ${task.claimantName ?? 'unknown'}`, 'chitchat');
    } catch (err) {
      sendError(agent.ws, err instanceof Error ? err.message : 'Failed to accept claim');
    }
  }

  async function handleTaskUpdate(agent: ConnectedAgent, msg: AgentMessage & { type: 'task.update' }): Promise<void> {
    try {
      const task = await taskManager.update(
        msg.taskId,
        agent.peerId,
        agent.name,
        msg.content,
        msg.status,
      );

      const lastNote = task.notes[task.notes.length - 1];

      // Notify creator and claimant (if they are different from the author)
      const notifyIds = new Set<string>();
      if (task.creatorId !== agent.peerId) notifyIds.add(task.creatorId);
      if (task.claimantId && task.claimantId !== agent.peerId) notifyIds.add(task.claimantId);

      for (const targetId of notifyIds) {
        const target = findAgentById(targetId);
        if (target) {
          sendToWs(target.ws, {
            type: 'task.updated',
            taskId: task.taskId,
            note: lastNote,
          });
        }
      }

      // Also confirm to the sender
      sendToWs(agent.ws, {
        type: 'task.updated',
        taskId: task.taskId,
        note: lastNote,
      });

      // Broadcast to dashboard
      broadcastToAllBrowsers({ type: 'task.updated', taskId: task.taskId, note: lastNote });
    } catch (err) {
      sendError(agent.ws, err instanceof Error ? err.message : 'Failed to update task');
    }
  }

  async function handleTaskComplete(agent: ConnectedAgent, msg: AgentMessage & { type: 'task.complete' }): Promise<void> {
    try {
      const task = await taskManager.complete(
        msg.taskId,
        agent.peerId,
        agent.name,
        msg.result,
        msg.status,
        msg.error,
      );

      // Notify the creator (skip for system-created digest tasks)
      if (task.creatorId !== 'system') {
        const creator = findAgentById(task.creatorId);
        if (creator) {
          sendToWs(creator.ws, {
            type: 'task.completed',
            taskId: task.taskId,
            status: msg.status,
            result: msg.result,
          });
        }
      }

      // Confirm to the completer
      sendToWs(agent.ws, {
        type: 'task.completed',
        taskId: task.taskId,
        status: msg.status,
        result: msg.result,
      });

      // Broadcast to dashboard
      broadcastToAllBrowsers({ type: 'task.completed', taskId: task.taskId, status: msg.status, result: msg.result });

      if (msg.status === 'completed') {
        postActivity(`${agent.name} completed task "${task.description}"`, 'important');
      } else {
        postActivity(`${agent.name} failed task "${task.description}"`, 'important');
      }

      // Check if this is a digest task completion
      if (msg.status === 'completed' && activeDigestTasks.get(task.roomId) === task.taskId) {
        await handleDigestCompletion(task);
      }
    } catch (err) {
      sendError(agent.ws, err instanceof Error ? err.message : 'Failed to complete task');
    }
  }

  async function handleClearSession(
    agent: ConnectedAgent,
    msg: AgentMessage & { type: 'agent.clearSession' },
  ): Promise<void> {
    const clearMessages = msg.messages !== false; // default true
    const clearTasks = msg.tasks === true;        // default false
    let messagesCleared = 0;
    let tasksArchived = 0;

    if (clearMessages) {
      const room = rooms.get(agent.currentRoom);
      if (room) {
        messagesCleared = room.messages.length;
        room.messages = [];
        // Notify browsers that the room was cleared
        broadcastToRoomBrowsers(agent.currentRoom, {
          type: 'sessionCleared',
          roomId: agent.currentRoom,
          clearedBy: agent.name,
          messagesCleared,
        });
      }
    }

    if (clearTasks) {
      tasksArchived = await taskManager.archiveTerminal(agent.currentRoom);
    }

    sendToWs(agent.ws, {
      type: 'session.cleared',
      requestId: msg.requestId,
      messagesCleared,
      tasksArchived,
    });

    log(`Session cleared by ${agent.name}: ${messagesCleared} message(s), ${tasksArchived} task(s) archived`);
  }

  async function handleRequestDigest(
    agent: ConnectedAgent,
    msg: AgentMessage & { type: 'agent.requestDigest' },
  ): Promise<void> {
    const room = rooms.get(agent.currentRoom);
    if (!room || room.messages.length === 0) {
      sendError(agent.ws, 'No messages in room to digest', msg.requestId);
      return;
    }

    // Check if a digest task is already active for this room
    const existingTaskId = activeDigestTasks.get(agent.currentRoom);
    if (existingTaskId) {
      const existingTask = taskManager.get(existingTaskId);
      if (existingTask && (existingTask.status === 'open' || existingTask.status === 'claimed' || existingTask.status === 'in_progress')) {
        sendError(agent.ws, `A digest task is already in progress for this room (task ${existingTaskId})`, msg.requestId);
        return;
      }
      activeDigestTasks.delete(agent.currentRoom);
    }

    // Capture current messages and write to pending digest file
    const messagesToDigest = [...room.messages];
    const pendingPath = path.join(DIGESTS_DIR, `${room.id}.jsonl`);
    const lines = messagesToDigest.map((m) => JSON.stringify(m)).join('\n') + '\n';
    await fs.appendFile(pendingPath, lines, 'utf-8');

    // Optionally clear room messages
    const clearMessages = msg.clearMessages === true;
    if (clearMessages) {
      room.messages = [];
      broadcastToRoomBrowsers(agent.currentRoom, {
        type: 'sessionCleared',
        roomId: agent.currentRoom,
        clearedBy: agent.name,
        messagesCleared: messagesToDigest.length,
      });
    }

    // Create digest task
    let pendingContent: string;
    try {
      pendingContent = await fs.readFile(pendingPath, 'utf-8');
    } catch {
      pendingContent = lines;
    }

    try {
      const task = await taskManager.create({
        roomId: room.id,
        creatorId: agent.peerId,
        creatorName: agent.name,
        description: 'Summarize the following room messages into a digest',
        context: pendingContent,
      });

      activeDigestTasks.set(room.id, task.taskId);

      // Broadcast task creation
      const summary = taskToSummary(task);
      broadcastToRoomAgents(room.id, { type: 'task.created', task: summary });
      broadcastToRoomBrowsers(room.id, { type: 'task.created', task: summary });

      sendToWs(agent.ws, {
        type: 'digest.requested',
        requestId: msg.requestId,
        taskId: task.taskId,
        messageCount: messagesToDigest.length,
        messagesCleared: clearMessages,
      });

      log(`Digest requested by ${agent.name} for room ${room.id}: ${messagesToDigest.length} message(s), task ${task.taskId}`);
      postActivity(`${agent.name} requested digest for room "${room.name}" (${messagesToDigest.length} messages)`);
    } catch (err) {
      logError(`Failed to create digest task for room ${room.id}`, err);
      sendError(agent.ws, 'Failed to create digest task', msg.requestId);
    }
  }

  function handleGetTask(agent: ConnectedAgent, msg: AgentMessage & { type: 'agent.getTask' }): void {
    const task = taskManager.get(msg.taskId);
    if (!task) {
      sendError(agent.ws, `Task not found: ${msg.taskId}`, msg.requestId);
      return;
    }
    const summary = taskToSummary(task);
    sendToWs(agent.ws, {
      type: 'task.detail',
      requestId: msg.requestId,
      task: { ...summary, notes: task.notes, result: task.result, error: task.error },
    });
  }

  function handleListTasks(agent: ConnectedAgent, msg: AgentMessage & { type: 'agent.listTasks' }): void {
    const filter: { status?: any; roomId?: string; assignedTo?: string } = {};
    if (msg.status) filter.status = msg.status;
    if (msg.roomId) filter.roomId = msg.roomId;
    if (msg.assignedTo) filter.assignedTo = msg.assignedTo;

    const tasks = taskManager.list(Object.keys(filter).length > 0 ? filter : undefined);
    sendToWs(agent.ws, {
      type: 'tasks',
      requestId: msg.requestId,
      tasks: tasks.map(taskToSummary),
    });
  }

  // ── Agent message dispatch ─────────────────────────────────────

  async function handleAgentMessage(ws: WebSocket, raw: string): Promise<void> {
    const agent = findAgentByWs(ws);
    if (!agent) return;

    let msg: AgentMessage;
    try {
      msg = decodeMessage(raw) as AgentMessage;
    } catch {
      sendError(ws, 'Invalid message format');
      return;
    }

    switch (msg.type) {
      case 'agent.heartbeat':
        // Already handled by pong; nothing to do
        break;
      case 'agent.status':
        handleAgentStatus(agent, msg);
        break;
      case 'agent.disconnect':
        removeAgent(agent.peerId);
        ws.close();
        break;
      case 'agent.joinRoom':
        handleJoinRoom(agent, msg);
        break;
      case 'agent.createRoom':
        handleCreateRoom(agent, msg);
        break;
      case 'agent.sendMessage':
        handleSendMessage(agent, msg);
        break;
      case 'agent.listPeers':
        handleListPeers(agent, msg);
        break;
      case 'task.create':
        await handleTaskCreate(agent, msg);
        break;
      case 'task.claim':
        await handleTaskClaim(agent, msg);
        break;
      case 'task.accept':
        await handleTaskAccept(agent, msg);
        break;
      case 'task.update':
        await handleTaskUpdate(agent, msg);
        break;
      case 'task.complete':
        await handleTaskComplete(agent, msg);
        break;
      case 'agent.getTask':
        handleGetTask(agent, msg);
        break;
      case 'agent.listTasks':
        handleListTasks(agent, msg);
        break;
      case 'agent.clearSession':
        await handleClearSession(agent, msg);
        break;
      case 'agent.requestDigest':
        await handleRequestDigest(agent, msg);
        break;
      default:
        sendError(ws, `Unknown message type: ${(msg as any).type}`);
    }
  }

  // ── Express app ────────────────────────────────────────────────

  const app = express();
  app.use(express.json());

  // CORS — restrict to localhost origins only
  const ALLOWED_ORIGINS = new Set([
    'http://localhost',
    'http://127.0.0.1',
    'http://[::1]',
  ]);

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    // Allow requests with no origin (same-origin, curl, agents)
    if (!origin) {
      res.header('Access-Control-Allow-Headers', 'Content-Type');
      res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      next();
      return;
    }
    // Match origin with or without port
    const originBase = origin.replace(/:\d+$/, '');
    if (ALLOWED_ORIGINS.has(originBase)) {
      res.header('Access-Control-Allow-Origin', origin);
      res.header('Access-Control-Allow-Headers', 'Content-Type');
      res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    }
    // Preflight
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // Serve dashboard React frontend
  const distPath = path.join(__dirname, '..', '..', 'dashboard', 'dist');
  app.use(express.static(distPath));

  // ── REST: Rooms ────────────────────────────────────────────────

  app.get('/api/rooms', (_req, res) => {
    const list = [...rooms.values()].map(({ id, name, createdAt, messages }) => ({
      id,
      name,
      createdAt,
      messageCount: messages.length,
    }));
    res.json(list);
  });

  app.post('/api/rooms', (req, res) => {
    const { name } = req.body;
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      res.status(400).json({ error: 'Room name is required' });
      return;
    }
    const id = generateId();
    const room: Room = { id, name: name.trim(), messages: [], createdAt: new Date().toISOString() };
    rooms.set(id, room);
    broadcastToAllBrowsers({
      type: 'roomCreated',
      room: { id, name: room.name, createdAt: room.createdAt, messageCount: 0 },
    });
    res.status(201).json({ id, name: room.name, createdAt: room.createdAt });
  });

  app.get('/api/rooms/:roomId/messages', (req, res) => {
    const room = rooms.get(req.params.roomId);
    if (!room) {
      res.status(404).json({ error: 'Room not found' });
      return;
    }
    // Return in the format the dashboard frontend expects
    const messages = room.messages.map((m) => ({
      messageId: m.messageId,
      roomId: m.roomId,
      username: m.fromName,
      text: m.content,
      timestamp: m.timestamp,
      source: m.source,
      mentions: m.mentions,
      mentionType: m.mentionType,
      importance: m.importance,
    }));
    res.json(messages);
  });

  app.post('/api/rooms/:roomId/messages', (req, res) => {
    const room = rooms.get(req.params.roomId);
    if (!room) {
      res.status(404).json({ error: 'Room not found' });
      return;
    }
    const { username, text } = req.body;
    if (!username || !text) {
      res.status(400).json({ error: 'username and text are required' });
      return;
    }

    const content = (text as string).trim();
    const { mentions, mentionType } = parseMentions(content);

    const chatMsg: ChatMessage = {
      messageId: generateId(),
      roomId: room.id,
      fromPeerId: 'dashboard-user',
      fromName: (username as string).trim(),
      content,
      metadata: undefined,
      timestamp: new Date().toISOString(),
      source: 'user',
      mentions: mentions.length > 0 ? mentions : undefined,
      mentionType,
    };
    room.messages.push(chatMsg);
    enforceRoomMessageCap(room).catch((err) => logError('Error enforcing room message cap', err));

    // Broadcast to agents in this room (with mention filtering)
    broadcastRoomMessage(room.id, chatMsg);

    res.status(201).json({
      messageId: chatMsg.messageId,
      roomId: chatMsg.roomId,
      username: chatMsg.fromName,
      text: chatMsg.content,
      timestamp: chatMsg.timestamp,
      source: chatMsg.source,
      mentions: chatMsg.mentions,
      mentionType: chatMsg.mentionType,
    });
  });

  // ── REST: Peers ────────────────────────────────────────────────

  app.get('/api/peers', (_req, res) => {
    const peers: PeerInfo[] = [];
    for (const agent of agents.values()) {
      peers.push(buildPeerInfo(agent));
    }
    res.json(peers);
  });

  // ── REST: Tasks ────────────────────────────────────────────────

  app.post('/api/tasks', async (req, res) => {
    const { description, context, filter, roomId, creatorName } = req.body || {};
    if (!description || !roomId) {
      res.status(400).json({ error: 'description and roomId are required' });
      return;
    }
    try {
      const task = await taskManager.create({
        roomId,
        creatorId: 'dashboard-user',
        creatorName: creatorName || 'Dashboard',
        description,
        context: context || undefined,
        filter: filter || undefined,
      });
      const summary = taskToSummary(task);
      broadcastToRoomAgents(roomId, { type: 'task.created', task: summary });
      broadcastToRoomBrowsers(roomId, { type: 'task.created', task: summary });
      res.json(summary);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create task';
      res.status(400).json({ error: message });
    }
  });

  app.get('/api/tasks', (req, res) => {
    const filter: { status?: any; roomId?: string; assignedTo?: string } = {};
    if (req.query.status) filter.status = req.query.status as string;
    if (req.query.roomId) filter.roomId = req.query.roomId as string;
    if (req.query.assignedTo) filter.assignedTo = req.query.assignedTo as string;
    const tasks = taskManager.list(Object.keys(filter).length > 0 ? filter : undefined);
    res.json(tasks);
  });

  app.get('/api/tasks/:id', (req, res) => {
    const task = taskManager.get(req.params.id);
    if (!task) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    res.json(task);
  });

  app.post('/api/tasks/:id/archive', async (req, res) => {
    try {
      const task = await taskManager.archive(req.params.id);
      res.json(task);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to archive task';
      res.status(400).json({ error: message });
    }
  });

  // ── REST: Clear session ──────────────────────────────────────────

  app.post('/api/rooms/:roomId/clear', async (req, res) => {
    const room = rooms.get(req.params.roomId);
    if (!room) {
      res.status(404).json({ error: 'Room not found' });
      return;
    }

    const clearMessages = req.body?.messages !== false;
    const clearTasks = req.body?.tasks === true;

    let messagesCleared = 0;
    let tasksArchived = 0;

    if (clearMessages) {
      messagesCleared = room.messages.length;
      room.messages = [];
      broadcastToRoomBrowsers(req.params.roomId, {
        type: 'sessionCleared',
        roomId: req.params.roomId,
        clearedBy: 'dashboard',
        messagesCleared,
      });
    }

    if (clearTasks) {
      tasksArchived = await taskManager.archiveTerminal(req.params.roomId);
    }

    res.json({ messagesCleared, tasksArchived });
  });

  // ── REST: Permissions ────────────────────────────────────────────

  app.get('/api/permissions', (_req, res) => {
    const list = [...pendingPermissions.values()].filter((p) => p.status === 'pending');
    res.json(list);
  });

  app.post('/api/permissions', (req, res) => {
    const { agentName, agentPeerId, toolName, toolInput, description } = req.body;
    if (!toolName) {
      res.status(400).json({ error: 'toolName is required' });
      return;
    }

    const id = generateId();
    const permission: PendingPermission = {
      id,
      agentName: agentName || 'unknown',
      agentPeerId,
      toolName,
      toolInput: toolInput || {},
      description,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    pendingPermissions.set(id, permission);

    // Broadcast to all browser clients
    broadcastToAllBrowsers({
      type: 'permission.request',
      permission,
    });

    log(`Permission request: ${permission.agentName} wants to use ${toolName} (${id})`);
    res.status(201).json(permission);
  });

  app.get('/api/permissions/:id', (req, res) => {
    const permission = pendingPermissions.get(req.params.id);
    if (!permission) {
      res.status(404).json({ error: 'Permission request not found' });
      return;
    }
    res.json(permission);
  });

  app.post('/api/permissions/:id/decide', (req, res) => {
    // Require a valid dashboard session token
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token || !validTokens.has(token)) {
      res.status(401).json({ error: 'Valid dashboard session required' });
      return;
    }

    const permission = pendingPermissions.get(req.params.id);
    if (!permission) {
      res.status(404).json({ error: 'Permission request not found' });
      return;
    }
    if (permission.status !== 'pending') {
      res.status(409).json({ error: `Already decided: ${permission.status}` });
      return;
    }

    const { decision, reason } = req.body;
    if (decision !== 'approved' && decision !== 'denied') {
      res.status(400).json({ error: 'decision must be "approved" or "denied"' });
      return;
    }

    permission.status = decision;
    permission.reason = reason;
    permission.decidedAt = new Date().toISOString();

    // Broadcast decision to all browsers
    broadcastToAllBrowsers({
      type: 'permission.decided',
      id: permission.id,
      status: permission.status,
      reason: permission.reason,
    });

    log(`Permission ${decision}: ${permission.agentName} / ${permission.toolName} (${permission.id})`);
    res.json(permission);

    // Clean up after 60 seconds
    setTimeout(() => pendingPermissions.delete(permission.id), 60_000);
  });

  // ── REST: Instances ──────────────────────────────────────────────

  app.get('/api/instances', (_req, res) => {
    const list = [...instances.values()].map((p) => {
      // Count active agents whose cwd matches this instance path
      let activeAgents = 0;
      for (const agent of agents.values()) {
        if (agent.cwd === p.path) activeAgents++;
      }
      return { ...p, activeAgents };
    });
    list.sort((a, b) => a.name.localeCompare(b.name));
    res.json(list);
  });

  app.post('/api/instances', async (req, res) => {
    const { name, path: instPath, description } = req.body;
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      res.status(400).json({ error: 'Instance name is required' });
      return;
    }
    if (!instPath || typeof instPath !== 'string' || instPath.trim().length === 0) {
      res.status(400).json({ error: 'Instance path is required' });
      return;
    }

    const resolvedPath = path.resolve(instPath.trim());

    // Validate path contains only safe characters (prevent shell injection in launch)
    if (!/^[a-zA-Z0-9\s/\-_\.~]+$/.test(resolvedPath)) {
      res.status(400).json({ error: 'Path contains unsupported characters' });
      return;
    }

    // Validate directory exists
    try {
      const stat = await fs.stat(resolvedPath);
      if (!stat.isDirectory()) {
        res.status(400).json({ error: 'Path is not a directory' });
        return;
      }
    } catch {
      res.status(400).json({ error: 'Directory does not exist' });
      return;
    }

    // Check for duplicate path
    for (const existing of instances.values()) {
      if (existing.path === resolvedPath) {
        res.status(409).json({ error: 'An instance with this path is already registered' });
        return;
      }
    }

    const instance: Instance = {
      id: generateId(),
      name: name.trim(),
      path: resolvedPath,
      description: description?.trim() || undefined,
      createdAt: new Date().toISOString(),
    };
    instances.set(instance.id, instance);
    await persistInstances(instances);

    log(`Instance registered: ${instance.name} (${instance.path})`);
    res.status(201).json(instance);
  });

  app.delete('/api/instances/:id', async (req, res) => {
    const instance = instances.get(req.params.id);
    if (!instance) {
      res.status(404).json({ error: 'Instance not found' });
      return;
    }
    instances.delete(req.params.id);
    await persistInstances(instances);
    log(`Instance removed: ${instance.name} (${instance.path})`);
    res.json({ deleted: true });
  });

  app.post('/api/instances/:id/launch', async (req, res) => {
    const instance = instances.get(req.params.id);
    if (!instance) {
      res.status(404).json({ error: 'Instance not found' });
      return;
    }

    // Re-validate directory
    try {
      const stat = await fs.stat(instance.path);
      if (!stat.isDirectory()) {
        res.status(400).json({ error: 'Instance directory no longer exists' });
        return;
      }
    } catch {
      res.status(400).json({ error: 'Instance directory no longer exists' });
      return;
    }

    if (process.platform !== 'darwin') {
      res.status(501).json({ error: 'Agent launching is currently only supported on macOS' });
      return;
    }

    // Escape path for AppleScript (replace backslashes and double-quotes)
    const escapedPath = instance.path.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const agentName = `agent-${instance.id.slice(0, 8)}`;
    const script = `tell application "Terminal"
  activate
  do script "cd \\"${escapedPath}\\" && CROSSCHAT_AGENT_NAME=${agentName} claude"
end tell`;

    spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' }).unref();

    log(`Launched Claude Code in: ${instance.path}`);
    postActivity(`Launched Claude Code at ${instance.path}`);
    res.json({ launched: true, instanceId: instance.id, path: instance.path });
  });

  // ── REST: Hub control ──────────────────────────────────────────────

  app.post('/api/hub/shutdown', (_req, res) => {
    res.json({ shutting_down: true });
    // Delay slightly so the response is sent before shutdown
    setTimeout(() => shutdown('API request'), 100);
  });

  // ── API 404 — reject unmatched API routes before SPA fallback ──

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'API route not found' });
  });

  // ── SPA fallback ───────────────────────────────────────────────

  app.use((_req, res, next) => {
    const indexPath = path.join(distPath, 'index.html');
    res.sendFile(indexPath, (err) => {
      if (err) next();
    });
  });

  // ── HTTP server ────────────────────────────────────────────────

  const server = http.createServer(app);

  // ── WebSocket servers (noServer mode) ──────────────────────────

  const agentWss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD });
  const browserWss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD });

  // Route upgrade requests to the correct WebSocket server
  server.on('upgrade', (request, socket, head) => {
    const { pathname } = new URL(request.url ?? '/', `http://${request.headers.host}`);

    // Block browser WebSocket upgrades from non-localhost origins
    const origin = request.headers.origin;
    if (origin) {
      const originBase = origin.replace(/:\d+$/, '');
      if (!ALLOWED_ORIGINS.has(originBase)) {
        log(`Rejected WebSocket upgrade from origin: ${origin}`);
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
    }

    if (pathname === '/ws/agent') {
      agentWss.handleUpgrade(request, socket, head, (ws) => {
        agentWss.emit('connection', ws, request);
      });
    } else if (pathname === '/ws') {
      browserWss.handleUpgrade(request, socket, head, (ws) => {
        browserWss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  // ── Agent WebSocket handler ────────────────────────────────────

  agentWss.on('connection', (ws: WebSocket) => {
    let registered = false;

    // Registration timeout: close if not registered within 5 seconds
    const registrationTimer = setTimeout(() => {
      if (!registered) {
        log('Agent connection timed out waiting for registration');
        ws.close(4001, 'Registration timeout');
      }
    }, REGISTER_TIMEOUT_MS);

    ws.on('message', (raw: Buffer) => {
      const data = raw.toString();

      if (!registered) {
        // First message must be agent.register
        try {
          const msg = decodeMessage(data) as AgentMessage;
          if (msg.type !== 'agent.register') {
            sendError(ws, 'First message must be agent.register');
            ws.close(4002, 'Expected agent.register');
            return;
          }

          clearTimeout(registrationTimer);
          registered = true;

          const agent: ConnectedAgent = {
            peerId: msg.peerId,
            name: msg.name,
            cwd: msg.cwd,
            pid: msg.pid,
            ws,
            status: 'available',
            statusDetail: undefined,
            currentRoom: 'general',
            connectedAt: new Date().toISOString(),
          };

          // If an agent with the same peerId is already connected, close the old one
          const existing = agents.get(msg.peerId);
          if (existing) {
            log(`Replacing existing connection for agent ${msg.peerId}`);
            postActivity(`${existing.name} reconnected (replaced existing connection)`);
            existing.ws.close(4003, 'Replaced by new connection');
            agents.delete(msg.peerId);
          }

          agents.set(msg.peerId, agent);

          // Cancel idle shutdown — an agent is here
          if (idleShutdownTimer) {
            clearTimeout(idleShutdownTimer);
            idleShutdownTimer = null;
            log('Idle shutdown cancelled — agent connected');
          }

          sendToWs(ws, {
            type: 'registered',
            peerId: msg.peerId,
            serverVersion: getServerVersion(),
          });

          log(`Agent registered: ${agent.name} (${agent.peerId}), cwd=${agent.cwd}`);
          broadcastToAllBrowsers({ type: 'peerConnected', peer: buildPeerInfo(agent) });
          postActivity(`${agent.name} connected (cwd: ${agent.cwd})`);

          // Auto-register agent's working directory as an instance
          autoRegisterInstance(agent.cwd).catch((err) => {
            logError('Auto-register instance failed', err);
          });
        } catch (err) {
          sendError(ws, 'Invalid registration message');
          ws.close(4002, 'Invalid registration');
        }
        return;
      }

      // Registered — dispatch normally
      handleAgentMessage(ws, data).catch((err) => {
        logError('Error handling agent message', err);
      });
    });

    ws.on('close', () => {
      clearTimeout(registrationTimer);
      const agent = findAgentByWs(ws);
      if (agent) {
        removeAgent(agent.peerId);
      }
    });

    ws.on('error', (err) => {
      logError('Agent WebSocket error', err);
    });

    // Pong handler for liveness
    ws.on('pong', () => {
      // Mark as alive — handled by heartbeat interval
    });
  });

  // ── Browser WebSocket handler ──────────────────────────────────

  browserWss.on('connection', (ws: WebSocket) => {
    browserClients.add(ws);
    browserRooms.set(ws, new Set());

    // Issue a session token for this dashboard connection
    const sessionToken = generateId();
    browserTokens.set(ws, sessionToken);
    validTokens.add(sessionToken);
    ws.send(JSON.stringify({ type: 'session', token: sessionToken }));

    ws.on('message', (raw: Buffer) => {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(raw.toString());
      } catch {
        ws.send(JSON.stringify({ type: 'error', error: 'Invalid JSON' }));
        return;
      }

      switch (data.type) {
        case 'join': {
          const room = rooms.get(data.roomId as string);
          if (!room) {
            ws.send(JSON.stringify({ type: 'error', error: 'Room not found' }));
            return;
          }
          browserRooms.get(ws)!.add(data.roomId as string);
          if (!data.silent) {
            broadcastToRoomBrowsers(data.roomId as string, {
              type: 'userJoined',
              roomId: data.roomId,
              username: data.username || 'Anonymous',
            });
          }
          break;
        }
        case 'message': {
          const room = rooms.get(data.roomId as string);
          if (!room || !data.username || !data.text) return;

          const wsContent = (data.text as string).trim();
          const { mentions: wsMentions, mentionType: wsMentionType } = parseMentions(wsContent);

          const chatMsg: ChatMessage = {
            messageId: generateId(),
            roomId: room.id,
            fromPeerId: 'dashboard-user',
            fromName: (data.username as string).trim(),
            content: wsContent,
            metadata: undefined,
            timestamp: new Date().toISOString(),
            source: 'user',
            mentions: wsMentions.length > 0 ? wsMentions : undefined,
            mentionType: wsMentionType,
          };
          room.messages.push(chatMsg);
          enforceRoomMessageCap(room).catch((err) => logError('Error enforcing room message cap', err));

          // Broadcast with mention filtering
          broadcastRoomMessage(room.id, chatMsg);
          break;
        }
        case 'leave': {
          browserRooms.get(ws)?.delete(data.roomId as string);
          break;
        }
      }
    });

    ws.on('close', () => {
      const token = browserTokens.get(ws);
      if (token) validTokens.delete(token);
      browserTokens.delete(ws);
      browserClients.delete(ws);
      browserRooms.delete(ws);
    });

    ws.on('error', (err) => {
      logError('Browser WebSocket error', err);
    });
  });

  // ── Heartbeat interval ─────────────────────────────────────────

  const heartbeatInterval = setInterval(() => {
    for (const agent of agents.values()) {
      if (agent.ws.readyState === WebSocket.OPEN) {
        let alive = true;
        const pongTimer = setTimeout(() => {
          if (!alive) {
            log(`Agent ${agent.name} (${agent.peerId}) failed heartbeat, terminating`);
            postActivity(`${agent.name} heartbeat failed — disconnecting`, 'important');
            agent.ws.terminate();
            removeAgent(agent.peerId);
          }
        }, PONG_TIMEOUT_MS);

        const onPong = () => {
          alive = true;
          clearTimeout(pongTimer);
          agent.ws.removeListener('pong', onPong);
        };

        alive = false;
        agent.ws.on('pong', onPong);
        agent.ws.ping();
      }
    }
  }, HEARTBEAT_INTERVAL_MS);

  // ── Pending permission sweep ──────────────────────────────────

  const permissionSweepInterval = setInterval(() => {
    const now = Date.now();
    for (const [id, perm] of pendingPermissions) {
      if (perm.status === 'pending' && now - new Date(perm.createdAt).getTime() > PERMISSION_TTL_MS) {
        pendingPermissions.delete(id);
        log(`Expired stale pending permission: ${id} (${perm.toolName})`);
      }
    }
  }, PERMISSION_SWEEP_INTERVAL_MS);

  // ── Start listening ────────────────────────────────────────────

  const configPort = process.env.CROSSCHAT_DASHBOARD_PORT
    ? parseInt(process.env.CROSSCHAT_DASHBOARD_PORT, 10)
    : 0;

  const actualPort = await new Promise<number>((resolve, reject) => {
    let settled = false;

    const onListening = () => {
      if (settled) return;
      settled = true;
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : configPort;
      resolve(port);
    };

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && !settled) {
        log(`Port ${configPort} in use, trying auto-select...`);
        server.listen(0, onListening);
      } else if (!settled) {
        settled = true;
        reject(err);
      }
    });

    server.listen(configPort, onListening);
  });

  await writeDashboardLock(actualPort);
  log(`Hub started on port ${actualPort} (pid ${process.pid})`);

  // Post startup event to the activity room
  postActivity(`Hub started on port ${actualPort}`, 'important');

  // ── Graceful shutdown ──────────────────────────────────────────

  let shuttingDown = false;

  const shutdown = async (signal?: string) => {
    if (shuttingDown) return;
    shuttingDown = true;

    if (signal) {
      log(`Received ${signal}, shutting down...`);
      postActivity(`Hub shutting down (${signal})`, 'important');
    } else {
      log('Shutting down...');
      postActivity('Hub shutting down', 'important');
    }

    // Stop timers
    clearInterval(heartbeatInterval);
    clearInterval(permissionSweepInterval);
    if (idleShutdownTimer) clearTimeout(idleShutdownTimer);

    // Close all agent WebSocket connections
    for (const agent of agents.values()) {
      try {
        agent.ws.close(1001, 'Server shutting down');
      } catch {
        // ignore
      }
    }
    agents.clear();

    // Close all browser WebSocket connections
    for (const client of browserClients) {
      try {
        client.close(1001, 'Server shutting down');
      } catch {
        // ignore
      }
    }
    browserClients.clear();

    // Close WebSocket servers
    agentWss.close();
    browserWss.close();

    // Close HTTP server
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

    await removeDashboardLock();

    log('Hub shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));
}
