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
import { MessageManager, type Message, type Badge, type TaskFilter, type TaskMeta } from './message-manager.js';
import {
  type AgentMessage,
  type ServerMessage,
  type ChannelMessageMessage,
  type MessagesResponseMessage,
  type PeerInfo,
  type AgentStatus,
  type MessageImportance,
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
  parentPid?: number;
  ws: WebSocket;
  status: AgentStatus;
  statusDetail?: string;
  currentChannel: string;
  connectedAt: string;
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
 * channels, message routing, tasks (via badges), and serves the React dashboard frontend.
 */
export async function startHub(): Promise<void> {
  await ensureCrosschatDir();

  // Copy the permission hook to a stable location (~/.crosschat/hooks/)
  // so settings.json can point to a path that survives package updates.
  try {
    const hooksDir = path.join(CROSSCHAT_DIR, 'hooks');
    await fs.mkdir(hooksDir, { recursive: true });
    const srcHook = path.join(__dirname, '..', 'hooks', 'permission-hook.sh');
    const srcHookAlt = path.join(__dirname, '..', '..', 'hooks', 'permission-hook.sh');
    let hookSource: string | null = null;
    for (const p of [srcHook, srcHookAlt]) {
      try {
        await fs.access(p);
        hookSource = p;
        break;
      } catch { /* try next */ }
    }
    if (hookSource) {
      const destHook = path.join(hooksDir, 'permission-hook.sh');
      await fs.copyFile(hookSource, destHook);
      await fs.chmod(destHook, 0o755);
      log(`Permission hook copied to ${destHook}`);
    }
  } catch (err) {
    logError('Failed to copy permission hook to stable location', err);
  }

  // Check for an already-running hub
  const existingLock = await readDashboardLock();
  if (existingLock) {
    log(`Hub already running on port ${existingLock.port} (pid ${existingLock.pid})`);
    process.exit(1);
  }

  // ── State ──────────────────────────────────────────────────────

  const agents = new Map<string, ConnectedAgent>();
  const channels = new Set<string>();
  const browserClients = new Set<WebSocket>();
  const browserChannels = new WeakMap<WebSocket, Set<string>>();
  const browserTokens = new Map<WebSocket, string>();   // session tokens for permission decisions
  const validTokens = new Set<string>();                 // fast lookup for REST auth
  const pendingPermissions = new Map<string, PendingPermission>();
  const instances = await loadInstances();

  // Initialize MessageManager (replaces TaskManager + in-memory channel messages)
  const messageManager = new MessageManager();
  await messageManager.init();

  // Idle shutdown: auto-shutdown when no agents are connected for IDLE_SHUTDOWN_MS
  let idleShutdownTimer: NodeJS.Timeout | null = null;

  // Ensure digests directory exists
  await fs.mkdir(DIGESTS_DIR, { recursive: true });

  // Seed default channels
  channels.add('general');
  channels.add('crosschat');


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

    // Skip if path has unsafe characters
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
      currentChannel: agent.currentChannel,
      connectedAt: agent.connectedAt,
    };
  }

  // ── Mention parsing ──────────────────────────────────────────

  function parseMentions(content: string): { mentions: string[]; mentionType: 'direct' | 'here' | 'broadcast' } {
    const hasHere = /@here\b/i.test(content);
    if (hasHere) {
      return { mentions: [], mentionType: 'here' };
    }

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

  /** Broadcast a server message to all agents in a specific channel. */
  function broadcastToChannelAgents(channelId: string, msg: ServerMessage, excludePeerId?: string): void {
    for (const agent of agents.values()) {
      if (agent.currentChannel === channelId && agent.peerId !== excludePeerId) {
        sendToWs(agent.ws, msg);
      }
    }
  }

  /** Broadcast a JSON payload to all browser clients subscribed to a channel. */
  function broadcastToChannelBrowsers(channelId: string, data: Record<string, unknown>): void {
    const payload = JSON.stringify(data);
    for (const client of browserClients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      const joined = browserChannels.get(client);
      if (joined?.has(channelId)) {
        client.send(payload);
      }
    }
  }

  /** Broadcast to ALL browser clients (not filtered by channel). */
  function broadcastToAllBrowsers(data: Record<string, unknown>): void {
    const payload = JSON.stringify(data);
    for (const client of browserClients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  /** Broadcast a channel message to agents AND browsers, with mention filtering. */
  function broadcastChannelMessage(channelId: string, msg: Message, excludePeerId?: string): void {
    // Build the protocol message for agents
    const agentMsg: ChannelMessageMessage = {
      type: 'channel.message',
      channelId: msg.channelId,
      messageId: msg.messageId,
      threadId: msg.threadId,
      fromPeerId: msg.fromPeerId,
      fromName: msg.fromName,
      content: msg.content,
      metadata: msg.metadata,
      timestamp: msg.timestamp,
      source: msg.source,
      mentions: msg.mentions,
      mentionType: msg.mentionType,
      importance: msg.metadata?.importance as MessageImportance | undefined,
      badges: msg.badges,
    };

    if (msg.mentionType === 'direct' && msg.mentions && msg.mentions.length > 0) {
      // Direct mention: only deliver to mentioned agents (+ sender echo)
      const mentionedNamesLower = new Set(msg.mentions.map((n) => n.toLowerCase()));
      for (const agent of agents.values()) {
        if (agent.currentChannel !== channelId) continue;
        if (agent.peerId === excludePeerId) continue;
        if (mentionedNamesLower.has(agent.name.toLowerCase()) || agent.peerId === msg.fromPeerId) {
          sendToWs(agent.ws, agentMsg);
        }
      }
    } else {
      // @here or broadcast: deliver to all agents in the channel
      broadcastToChannelAgents(channelId, agentMsg, excludePeerId);
    }

    // Always send to all browsers — dashboard users see everything
    broadcastToChannelBrowsers(channelId, {
      type: 'message',
      messageId: msg.messageId,
      channelId: msg.channelId,
      threadId: msg.threadId,
      username: msg.fromName,
      text: msg.content,
      timestamp: msg.timestamp,
      source: msg.source,
      mentions: msg.mentions,
      mentionType: msg.mentionType,
      importance: msg.metadata?.importance as string | undefined,
      badges: msg.badges,
    });
  }

  // ── Activity channel ────────────────────────────────────────

  /** Post a system event to the CrossChat Activity channel. */
  function postActivity(content: string, importance: MessageImportance = 'comment'): void {
    const msg: Message = {
      messageId: generateId(),
      channelId: 'crosschat',
      fromPeerId: 'system',
      fromName: 'system',
      content,
      timestamp: new Date().toISOString(),
      source: 'system',
      badges: [],
      metadata: { importance },
    };

    messageManager.addMessage(msg).catch((err) =>
      logError('Failed to persist activity message', err),
    );
    broadcastChannelMessage('crosschat', msg);
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
    if (msg.taskMessageId) {
      log(`Agent ${agent.name} status: ${msg.status}${msg.detail ? ` (${msg.detail})` : ''} [task: ${msg.taskMessageId}]`);
    } else {
      log(`Agent ${agent.name} status: ${msg.status}${msg.detail ? ` (${msg.detail})` : ''}`);
    }
    postActivity(`${agent.name} -> ${msg.status}${msg.detail ? ` (${msg.detail})` : ''}`, 'chitchat');
  }

  async function handleSendMessage(agent: ConnectedAgent, msg: AgentMessage & { type: 'agent.sendMessage' }): Promise<void> {
    const channelId = agent.currentChannel;
    const { mentions, mentionType } = parseMentions(msg.content);

    const message: Message = {
      messageId: generateId(),
      channelId,
      threadId: msg.threadId,
      fromPeerId: agent.peerId,
      fromName: agent.name,
      content: msg.content,
      metadata: msg.metadata,
      timestamp: new Date().toISOString(),
      source: 'agent',
      mentions: mentions.length > 0 ? mentions : undefined,
      mentionType,
      badges: [],
    };

    if (msg.importance) {
      message.metadata = { ...message.metadata, importance: msg.importance };
    }

    await messageManager.addMessage(message);
    broadcastChannelMessage(channelId, message);
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

  // ── Badge & Task handlers ─────────────────────────────────────

  /** Broadcast a badge change to all agents in the channel and all browsers. */
  function broadcastBadgeUpdate(channelId: string, messageId: string, badge: Badge, allBadges: Badge[]): void {
    // Notify agents in the channel about the new badge
    broadcastToChannelAgents(channelId, {
      type: 'message.badgeAdded',
      messageId,
      badge,
    });

    // Notify agents with the full badge array
    broadcastToChannelAgents(channelId, {
      type: 'message.updated',
      messageId,
      badges: allBadges,
    });

    // Notify all browsers
    broadcastToAllBrowsers({
      type: 'badgeUpdate',
      messageId,
      badge,
      badges: allBadges,
    });
  }

  async function handleFlagTask(
    agent: ConnectedAgent,
    msg: AgentMessage & { type: 'agent.flagTask' },
  ): Promise<void> {
    try {
      const meta = await messageManager.flagAsTask(msg.messageId, agent.peerId, msg.filter);
      if (!meta) {
        sendError(agent.ws, `Message not found: ${msg.messageId}`, msg.requestId);
        return;
      }

      const message = messageManager.getMessage(msg.messageId);
      const badges = message?.badges ?? [];

      // Respond to requester
      sendToWs(agent.ws, {
        type: 'task.flagged',
        requestId: msg.requestId,
        messageId: msg.messageId,
        badges,
      });

      // Broadcast badge update to channel
      const taskBadge = badges.find((b) => b.type === 'task');
      if (taskBadge && message) {
        broadcastBadgeUpdate(message.channelId, msg.messageId, taskBadge, badges);
      }

      postActivity(`${agent.name} flagged message as task: ${msg.messageId}`);
    } catch (err) {
      sendError(agent.ws, err instanceof Error ? err.message : 'Failed to flag task', msg.requestId);
    }
  }

  async function handleClaimTask(
    agent: ConnectedAgent,
    msg: AgentMessage & { type: 'agent.claimTask' },
  ): Promise<void> {
    try {
      const meta = await messageManager.claimTask(msg.messageId, agent.peerId, agent.name);

      const message = messageManager.getMessage(msg.messageId);
      const badges = message?.badges ?? [];

      // Respond to requester
      sendToWs(agent.ws, {
        type: 'task.claimed',
        requestId: msg.requestId,
        messageId: msg.messageId,
        claimantId: agent.peerId,
        claimantName: agent.name,
      });

      // Notify the message author
      if (message) {
        const author = findAgentById(message.fromPeerId);
        if (author && author.peerId !== agent.peerId) {
          sendToWs(author.ws, {
            type: 'task.claimed',
            requestId: '',
            messageId: msg.messageId,
            claimantId: agent.peerId,
            claimantName: agent.name,
          });
        }

        // Broadcast badge update
        const taskBadge = badges.find((b) => b.type === 'task');
        if (taskBadge) {
          broadcastBadgeUpdate(message.channelId, msg.messageId, taskBadge, badges);
        }
      }

      postActivity(`${agent.name} claimed task on message ${msg.messageId}`, 'chitchat');
    } catch (err) {
      sendError(agent.ws, err instanceof Error ? err.message : 'Failed to claim task', msg.requestId);
    }
  }

  async function handleResolveTask(
    agent: ConnectedAgent,
    msg: AgentMessage & { type: 'agent.resolveTask' },
  ): Promise<void> {
    try {
      const meta = await messageManager.resolveTask(
        msg.messageId,
        agent.peerId,
        msg.status,
        msg.result,
        msg.error,
      );

      const message = messageManager.getMessage(msg.messageId);
      const badges = message?.badges ?? [];

      // Respond to requester
      sendToWs(agent.ws, {
        type: 'task.resolved',
        requestId: msg.requestId,
        messageId: msg.messageId,
        status: msg.status,
        result: msg.result,
      });

      // Notify the message author
      if (message) {
        const author = findAgentById(message.fromPeerId);
        if (author && author.peerId !== agent.peerId) {
          sendToWs(author.ws, {
            type: 'task.resolved',
            requestId: '',
            messageId: msg.messageId,
            status: msg.status,
            result: msg.result,
          });
        }

        // Broadcast badge update
        const taskBadge = badges.find((b) => b.type === 'task');
        if (taskBadge) {
          broadcastBadgeUpdate(message.channelId, msg.messageId, taskBadge, badges);
        }
      }

      if (msg.status === 'completed') {
        postActivity(`${agent.name} completed task on message ${msg.messageId}`, 'important');
      } else {
        postActivity(`${agent.name} failed task on message ${msg.messageId}`, 'important');
      }
    } catch (err) {
      sendError(agent.ws, err instanceof Error ? err.message : 'Failed to resolve task', msg.requestId);
    }
  }

  async function handleAddBadge(
    agent: ConnectedAgent,
    msg: AgentMessage & { type: 'agent.addBadge' },
  ): Promise<void> {
    try {
      const badge: Badge = {
        type: msg.badgeType,
        value: msg.badgeValue,
        label: msg.label,
        addedBy: agent.peerId,
        addedAt: new Date().toISOString(),
      };

      const updatedMessage = await messageManager.addBadge(msg.messageId, badge);
      if (!updatedMessage) {
        sendError(agent.ws, `Message not found: ${msg.messageId}`, msg.requestId);
        return;
      }

      // Respond to requester
      sendToWs(agent.ws, {
        type: 'badge.added',
        requestId: msg.requestId,
        messageId: msg.messageId,
        badge,
      });

      // Broadcast badge update to channel
      broadcastBadgeUpdate(updatedMessage.channelId, msg.messageId, badge, updatedMessage.badges);
    } catch (err) {
      sendError(agent.ws, err instanceof Error ? err.message : 'Failed to add badge', msg.requestId);
    }
  }

  // ── Message retrieval ─────────────────────────────────────────

  function handleGetMessages(
    agent: ConnectedAgent,
    msg: AgentMessage & { type: 'agent.getMessages' },
  ): void {
    let messages: Message[];

    if (msg.threadId) {
      messages = messageManager.getThreadMessages(msg.threadId);
    } else {
      messages = messageManager.getChannelMessages(agent.currentChannel, {
        limit: msg.limit,
        afterMessageId: msg.afterMessageId,
      });
    }

    // Convert Messages to ChannelMessageMessage format for the response
    const protocolMessages: ChannelMessageMessage[] = messages.map((m) => ({
      type: 'channel.message' as const,
      channelId: m.channelId,
      messageId: m.messageId,
      threadId: m.threadId,
      fromPeerId: m.fromPeerId,
      fromName: m.fromName,
      content: m.content,
      metadata: m.metadata,
      timestamp: m.timestamp,
      source: m.source,
      mentions: m.mentions,
      mentionType: m.mentionType,
      importance: m.metadata?.importance as MessageImportance | undefined,
      badges: m.badges,
    }));

    const response: MessagesResponseMessage = {
      type: 'messages',
      requestId: msg.requestId,
      messages: protocolMessages,
      threadId: msg.threadId,
    };

    sendToWs(agent.ws, response);
  }

  // ── Session management ────────────────────────────────────────

  async function handleClearSession(
    agent: ConnectedAgent,
    msg: AgentMessage & { type: 'agent.clearSession' },
  ): Promise<void> {
    const clearMessages = msg.messages !== false; // default true
    let messagesCleared = 0;

    if (clearMessages) {
      messagesCleared = messageManager.clearChannel(agent.currentChannel);

      // Notify browsers that the channel was cleared
      broadcastToChannelBrowsers(agent.currentChannel, {
        type: 'sessionCleared',
        channelId: agent.currentChannel,
        clearedBy: agent.name,
        messagesCleared,
      });
    }

    sendToWs(agent.ws, {
      type: 'session.cleared',
      requestId: msg.requestId,
      messagesCleared,
    });

    log(`Session cleared by ${agent.name}: ${messagesCleared} message(s)`);
  }

  // Return all handler functions so they can be used by dispatch
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
      case 'agent.sendMessage':
        await handleSendMessage(agent, msg);
        break;
      case 'agent.listPeers':
        handleListPeers(agent, msg);
        break;
      case 'agent.getMessages':
        handleGetMessages(agent, msg);
        break;
      case 'agent.flagTask':
        await handleFlagTask(agent, msg);
        break;
      case 'agent.claimTask':
        await handleClaimTask(agent, msg);
        break;
      case 'agent.resolveTask':
        await handleResolveTask(agent, msg);
        break;
      case 'agent.addBadge':
        await handleAddBadge(agent, msg);
        break;
      case 'agent.clearSession':
        await handleClearSession(agent, msg);
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

  // ── REST: Channels ──────────────────────────────────────────────

  app.get('/api/channels', (_req, res) => {
    res.json([...channels].map((id) => ({ id, name: id })));
  });

  app.get('/api/channels/:channelId/messages', (req, res) => {
    const channelId = req.params.channelId;
    if (!channels.has(channelId)) {
      res.status(404).json({ error: 'Channel not found' });
      return;
    }
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    const afterMessageId = req.query.afterMessageId as string | undefined;
    const messages = messageManager.getChannelMessages(channelId, { limit, afterMessageId });
    // Transform to the same shape the WebSocket broadcast uses so the dashboard
    // can rely on a single field name (`text`) regardless of transport.
    const transformed = messages.map((m) => ({
      type: 'message' as const,
      messageId: m.messageId,
      channelId: m.channelId,
      threadId: m.threadId,
      username: m.fromName,
      text: m.content,
      timestamp: m.timestamp,
      source: m.source,
      mentions: m.mentions,
      mentionType: m.mentionType,
      importance: m.metadata?.importance as string | undefined,
      badges: m.badges,
    }));
    res.json(transformed);
  });

  app.post('/api/channels/:channelId/messages', async (req, res) => {
    const channelId = req.params.channelId;
    if (!channels.has(channelId)) {
      res.status(404).json({ error: 'Channel not found' });
      return;
    }
    const { username, text, threadId, metadata } = req.body;
    if (!username || !text) {
      res.status(400).json({ error: 'username and text are required' });
      return;
    }

    const content = (text as string).trim();
    const { mentions, mentionType } = parseMentions(content);

    const message: Message = {
      messageId: generateId(),
      channelId,
      threadId: threadId || undefined,
      fromPeerId: 'dashboard-user',
      fromName: (username as string).trim(),
      content,
      timestamp: new Date().toISOString(),
      source: 'user',
      mentions: mentions.length > 0 ? mentions : undefined,
      mentionType,
      badges: [],
      metadata: metadata || undefined,
    };

    await messageManager.addMessage(message);
    broadcastChannelMessage(channelId, message);

    res.status(201).json(message);
  });

  app.get('/api/channels/:channelId/messages/:messageId/thread', (req, res) => {
    const threadId = req.params.messageId;
    const messages = messageManager.getThreadMessages(threadId);
    res.json(messages);
  });

  app.post('/api/channels/:channelId/messages/:messageId/flag-task', async (req, res) => {
    const messageId = req.params.messageId;
    const { addedBy, filter } = req.body;

    const meta = await messageManager.flagAsTask(
      messageId,
      addedBy || 'dashboard-user',
      filter || undefined,
    );

    if (!meta) {
      res.status(404).json({ error: 'Message not found' });
      return;
    }

    const message = messageManager.getMessage(messageId);
    if (message) {
      broadcastToAllBrowsers({
        type: 'message.updated',
        messageId,
        badges: message.badges,
      });
    }

    res.json(meta);
  });

  app.post('/api/channels/:channelId/messages/:messageId/badges', async (req, res) => {
    const messageId = req.params.messageId;
    const { type: badgeType, value, label, addedBy } = req.body;

    if (!badgeType || !value) {
      res.status(400).json({ error: 'type and value are required' });
      return;
    }

    const badge: Badge = {
      type: badgeType,
      value,
      label: label || undefined,
      addedBy: addedBy || 'dashboard-user',
      addedAt: new Date().toISOString(),
    };

    const message = await messageManager.addBadge(messageId, badge);
    if (!message) {
      res.status(404).json({ error: 'Message not found' });
      return;
    }

    broadcastToAllBrowsers({
      type: 'message.badgeAdded',
      messageId,
      badge,
    });

    res.json({ messageId, badge });
  });

  // ── REST: Peers ────────────────────────────────────────────────

  app.get('/api/peers', (_req, res) => {
    const peers: PeerInfo[] = [];
    for (const agent of agents.values()) {
      peers.push(buildPeerInfo(agent));
    }
    res.json(peers);
  });

  // ── REST: Agent lookup by parent PID (for permission hook) ─────

  app.get('/api/agents/by-parent-pid/:pid', (req, res) => {
    const parentPid = parseInt(req.params.pid, 10);
    if (isNaN(parentPid)) {
      res.status(400).json({ error: 'Invalid PID' });
      return;
    }

    for (const agent of agents.values()) {
      if (agent.parentPid === parentPid) {
        res.json({ peerId: agent.peerId, name: agent.name, cwd: agent.cwd });
        return;
      }
    }

    res.status(404).json({ error: 'No agent found with that parent PID' });
  });

  // ── REST: Tasks ────────────────────────────────────────────────

  app.get('/api/tasks', (req, res) => {
    const filter: { status?: string; channelId?: string; claimantId?: string } = {};
    if (req.query.status) filter.status = req.query.status as string;
    if (req.query.channelId) filter.channelId = req.query.channelId as string;
    if (req.query.claimantId) filter.claimantId = req.query.claimantId as string;
    const tasks = messageManager.listTasks(Object.keys(filter).length > 0 ? filter : undefined);
    res.json(tasks);
  });

  // ── REST: Clear session ──────────────────────────────────────────

  app.post('/api/channels/:channelId/clear', (req, res) => {
    const channelId = req.params.channelId;
    if (!channels.has(channelId)) {
      res.status(404).json({ error: 'Channel not found' });
      return;
    }

    const messagesCleared = messageManager.clearChannel(channelId);

    broadcastToAllBrowsers({
      type: 'sessionCleared',
      channelId,
      clearedBy: 'dashboard',
      messagesCleared,
    });

    res.json({ messagesCleared });
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
  do script "cd \\"${escapedPath}\\" && CROSSCHAT_NAME=${agentName} claude crosschat"
end tell`;

    spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' }).unref();

    log(`Launched Claude Code in: ${instance.path}`);
    postActivity(`Launched Claude Code at ${instance.path}`);
    res.json({ launched: true, instanceId: instance.id, path: instance.path });
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
    } else if (pathname === '/ws' || pathname === '/ws/browser') {
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
            parentPid: msg.parentPid,
            ws,
            status: 'available',
            statusDetail: undefined,
            currentChannel: 'general',
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
    browserChannels.set(ws, new Set());

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
          const channelId = data.channelId as string;
          if (!channelId || !channels.has(channelId)) {
            ws.send(JSON.stringify({ type: 'error', error: 'Channel not found' }));
            return;
          }
          browserChannels.get(ws)!.add(channelId);
          if (!data.silent) {
            broadcastToChannelBrowsers(channelId, {
              type: 'userJoined',
              channelId,
              username: data.username || 'Anonymous',
            });
          }
          break;
        }
        case 'message': {
          const channelId = data.channelId as string;
          if (!channelId || !channels.has(channelId) || !data.username || !data.text) return;

          const wsContent = (data.text as string).trim();
          const { mentions: wsMentions, mentionType: wsMentionType } = parseMentions(wsContent);

          const chatMsg: Message = {
            messageId: generateId(),
            channelId,
            fromPeerId: 'dashboard-user',
            fromName: (data.username as string).trim(),
            content: wsContent,
            metadata: undefined,
            timestamp: new Date().toISOString(),
            source: 'user',
            mentions: wsMentions.length > 0 ? wsMentions : undefined,
            mentionType: wsMentionType,
            badges: [],
          };

          messageManager.addMessage(chatMsg).catch((err) => logError('Error persisting browser message', err));

          // Broadcast with mention filtering
          broadcastChannelMessage(channelId, chatMsg);
          break;
        }
        case 'leave': {
          browserChannels.get(ws)?.delete(data.channelId as string);
          break;
        }
      }
    });

    ws.on('close', () => {
      const token = browserTokens.get(ws);
      if (token) validTokens.delete(token);
      browserTokens.delete(ws);
      browserClients.delete(ws);
      // WeakMap entry for browserChannels is automatically GC'd
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

  // Post startup event to the activity channel
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
