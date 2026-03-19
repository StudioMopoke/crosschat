import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
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

// ── Constants ────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CROSSCHAT_DIR = path.join(os.homedir(), '.crosschat');
const DASHBOARD_LOCK_FILE = path.join(CROSSCHAT_DIR, 'dashboard.lock');
const REGISTER_TIMEOUT_MS = 5_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 10_000;

// ── Types ────────────────────────────────────────────────────────────

interface DashboardLock {
  pid: number;
  port: number;
  startedAt: string;
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

interface ChatMessage {
  messageId: string;
  roomId: string;
  fromPeerId: string;
  fromName: string;
  content: string;
  metadata?: Record<string, unknown>;
  timestamp: string;
  source: 'agent' | 'user';
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

// ── Version from package.json ────────────────────────────────────────

function getServerVersion(): string {
  return '0.6.2';
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

  // Initialize TaskManager
  const taskManager = new TaskManager();
  await taskManager.init();

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

  /** Broadcast a room message to all agents AND browsers in the room. */
  function broadcastRoomMessage(roomId: string, msg: ChatMessage, excludePeerId?: string): void {
    // Send to agents as a room.message protocol message
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
    };
    broadcastToRoomAgents(roomId, agentMsg, excludePeerId);

    // Send to browsers in the existing dashboard format
    broadcastToRoomBrowsers(roomId, {
      type: 'message',
      messageId: msg.messageId,
      roomId: msg.roomId,
      username: msg.fromName,
      text: msg.content,
      timestamp: msg.timestamp,
      source: msg.source,
    });
  }

  // ── Agent removal ──────────────────────────────────────────────

  function removeAgent(peerId: string): void {
    const agent = agents.get(peerId);
    if (!agent) return;
    agents.delete(peerId);
    log(`Agent disconnected: ${agent.name} (${peerId})`);
  }

  // ── Agent message handlers ────────────────────────────────────

  function handleAgentStatus(agent: ConnectedAgent, msg: AgentMessage & { type: 'agent.status' }): void {
    agent.status = msg.status;
    agent.statusDetail = msg.detail;
    log(`Agent ${agent.name} status: ${msg.status}${msg.detail ? ` (${msg.detail})` : ''}`);
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
  }

  function handleSendMessage(agent: ConnectedAgent, msg: AgentMessage & { type: 'agent.sendMessage' }): void {
    const roomId = agent.currentRoom;
    const room = rooms.get(roomId);
    if (!room) {
      sendError(agent.ws, `Room not found: ${roomId}`);
      return;
    }

    const chatMsg: ChatMessage = {
      messageId: generateId(),
      roomId,
      fromPeerId: agent.peerId,
      fromName: agent.name,
      content: msg.content,
      metadata: msg.metadata,
      timestamp: new Date().toISOString(),
      source: 'agent',
    };

    room.messages.push(chatMsg);
    // Broadcast to everyone in the room (including the sender, so they get the messageId echo)
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

      // Broadcast to all agents in the room (including creator) and browsers
      broadcastToRoomAgents(agent.currentRoom, { type: 'task.created', task: summary });
      broadcastToRoomBrowsers(agent.currentRoom, { type: 'task.created', task: summary });
    } catch (err) {
      sendError(agent.ws, err instanceof Error ? err.message : 'Failed to create task');
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

      // Notify the creator
      const creator = findAgentById(task.creatorId);
      if (creator) {
        sendToWs(creator.ws, {
          type: 'task.completed',
          taskId: task.taskId,
          status: msg.status,
          result: msg.result,
        });
      }

      // Confirm to the completer
      sendToWs(agent.ws, {
        type: 'task.completed',
        taskId: task.taskId,
        status: msg.status,
        result: msg.result,
      });
    } catch (err) {
      sendError(agent.ws, err instanceof Error ? err.message : 'Failed to complete task');
    }
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
      case 'agent.listTasks':
        handleListTasks(agent, msg);
        break;
      default:
        sendError(ws, `Unknown message type: ${(msg as any).type}`);
    }
  }

  // ── Express app ────────────────────────────────────────────────

  const app = express();
  app.use(express.json());

  // CORS
  app.use((_req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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

    const chatMsg: ChatMessage = {
      messageId: generateId(),
      roomId: room.id,
      fromPeerId: 'dashboard-user',
      fromName: (username as string).trim(),
      content: (text as string).trim(),
      metadata: undefined,
      timestamp: new Date().toISOString(),
      source: 'user',
    };
    room.messages.push(chatMsg);

    // Broadcast to agents in this room
    broadcastRoomMessage(room.id, chatMsg);

    res.status(201).json({
      messageId: chatMsg.messageId,
      roomId: chatMsg.roomId,
      username: chatMsg.fromName,
      text: chatMsg.content,
      timestamp: chatMsg.timestamp,
      source: chatMsg.source,
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

  const agentWss = new WebSocketServer({ noServer: true });
  const browserWss = new WebSocketServer({ noServer: true });

  // Route upgrade requests to the correct WebSocket server
  server.on('upgrade', (request, socket, head) => {
    const { pathname } = new URL(request.url ?? '/', `http://${request.headers.host}`);

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
            existing.ws.close(4003, 'Replaced by new connection');
            agents.delete(msg.peerId);
          }

          agents.set(msg.peerId, agent);

          sendToWs(ws, {
            type: 'registered',
            peerId: msg.peerId,
            serverVersion: getServerVersion(),
          });

          log(`Agent registered: ${agent.name} (${agent.peerId}), cwd=${agent.cwd}`);
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

          const chatMsg: ChatMessage = {
            messageId: generateId(),
            roomId: room.id,
            fromPeerId: 'dashboard-user',
            fromName: (data.username as string).trim(),
            content: (data.text as string).trim(),
            metadata: undefined,
            timestamp: new Date().toISOString(),
            source: 'user',
          };
          room.messages.push(chatMsg);

          // Broadcast to all agents and browsers in this room
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

  // Post a startup message to the crosschat room
  const startupMsg: ChatMessage = {
    messageId: generateId(),
    roomId: 'crosschat',
    fromPeerId: 'system',
    fromName: 'system',
    content: `Hub started on port ${actualPort}`,
    timestamp: new Date().toISOString(),
    source: 'agent',
  };
  const crosschatRoom = rooms.get('crosschat');
  if (crosschatRoom) {
    crosschatRoom.messages.push(startupMsg);
  }

  // ── Graceful shutdown ──────────────────────────────────────────

  let shuttingDown = false;

  const shutdown = async (signal?: string) => {
    if (shuttingDown) return;
    shuttingDown = true;

    if (signal) {
      log(`Received ${signal}, shutting down...`);
    } else {
      log('Shutting down...');
    }

    // Stop heartbeat
    clearInterval(heartbeatInterval);

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
