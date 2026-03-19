import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { generateId } from '../util/id.js';
import { log, logError } from '../util/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface ChatMessage {
  messageId: string;
  roomId: string;
  username: string;
  text: string;
  timestamp: string;
}

interface ChatRoom {
  id: string;
  name: string;
  createdAt: string;
  messages: ChatMessage[];
}

export class DashboardServer {
  private app: express.Express;
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private rooms: Map<string, ChatRoom> = new Map();
  private clientRooms: WeakMap<WebSocket, Set<string>> = new WeakMap();
  private port: number;

  constructor(port: number = 3002) {
    this.port = port;
    this.app = express();
    this.setupMiddleware();
    this.setupRoutes();
    this.seedRooms();
  }

  private seedRooms(): void {
    this.rooms.set('general', {
      id: 'general',
      name: 'General',
      createdAt: new Date().toISOString(),
      messages: [],
    });
    this.rooms.set('crosschat', {
      id: 'crosschat',
      name: 'CrossChat Activity',
      createdAt: new Date().toISOString(),
      messages: [],
    });
  }

  private setupMiddleware(): void {
    this.app.use(express.json());
    this.app.use((_req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Headers', 'Content-Type');
      res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      next();
    });

    // Serve static frontend files
    const distPath = path.join(__dirname, '..', '..', 'dashboard', 'dist');
    this.app.use(express.static(distPath));
  }

  private setupRoutes(): void {
    // List rooms
    this.app.get('/api/rooms', (_req, res) => {
      const list = [...this.rooms.values()].map(({ id, name, createdAt, messages }) => ({
        id,
        name,
        createdAt,
        messageCount: messages.length,
      }));
      res.json(list);
    });

    // Create room
    this.app.post('/api/rooms', (req, res) => {
      const { name } = req.body;
      if (!name || typeof name !== 'string' || name.trim().length === 0) {
        res.status(400).json({ error: 'Room name is required' });
        return;
      }
      const id = generateId();
      const room: ChatRoom = { id, name: name.trim(), createdAt: new Date().toISOString(), messages: [] };
      this.rooms.set(id, room);
      this.broadcast({ type: 'roomCreated', room: { id, name: room.name, createdAt: room.createdAt, messageCount: 0 } });
      res.status(201).json({ id, name: room.name, createdAt: room.createdAt });
    });

    // Get messages
    this.app.get('/api/rooms/:roomId/messages', (req, res) => {
      const room = this.rooms.get(req.params.roomId);
      if (!room) { res.status(404).json({ error: 'Room not found' }); return; }
      res.json(room.messages);
    });

    // Post message
    this.app.post('/api/rooms/:roomId/messages', (req, res) => {
      const room = this.rooms.get(req.params.roomId);
      if (!room) { res.status(404).json({ error: 'Room not found' }); return; }
      const { username, text } = req.body;
      if (!username || !text) { res.status(400).json({ error: 'username and text are required' }); return; }
      const message: ChatMessage = {
        messageId: generateId(),
        roomId: room.id,
        username: username.trim(),
        text: text.trim(),
        timestamp: new Date().toISOString(),
      };
      room.messages.push(message);
      this.broadcast({ type: 'message', ...message }, room.id);
      res.status(201).json(message);
    });

    // Fallback to index.html for SPA routing
    this.app.use((_req, res, next) => {
      const indexPath = path.join(__dirname, '..', '..', 'dashboard', 'dist', 'index.html');
      res.sendFile(indexPath, (err) => {
        if (err) next();
      });
    });
  }

  private broadcast(data: Record<string, unknown>, filterRoomId?: string): void {
    if (!this.wss) return;
    const payload = JSON.stringify(data);
    this.wss.clients.forEach((client) => {
      if (client.readyState !== WebSocket.OPEN) return;
      if (filterRoomId) {
        const joined = this.clientRooms.get(client);
        if (!joined?.has(filterRoomId)) return;
      }
      client.send(payload);
    });
  }

  /** Post a message to a room programmatically (used by the message bridge) */
  postToRoom(roomId: string, username: string, text: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    const message: ChatMessage = {
      messageId: generateId(),
      roomId: room.id,
      username,
      text,
      timestamp: new Date().toISOString(),
    };
    room.messages.push(message);
    this.broadcast({ type: 'message', ...message }, room.id);
  }

  private setupWebSocket(): void {
    if (!this.server) return;
    this.wss = new WebSocketServer({ server: this.server, path: '/ws' });

    this.wss.on('connection', (ws: WebSocket) => {
      this.clientRooms.set(ws, new Set());

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
            const room = this.rooms.get(data.roomId as string);
            if (!room) { ws.send(JSON.stringify({ type: 'error', error: 'Room not found' })); return; }
            this.clientRooms.get(ws)!.add(data.roomId as string);
            this.broadcast(
              { type: 'userJoined', roomId: data.roomId, username: data.username || 'Anonymous' },
              data.roomId as string
            );
            break;
          }
          case 'message': {
            const room = this.rooms.get(data.roomId as string);
            if (!room || !data.username || !data.text) return;
            const message: ChatMessage = {
              messageId: generateId(),
              roomId: room.id,
              username: (data.username as string).trim(),
              text: (data.text as string).trim(),
              timestamp: new Date().toISOString(),
            };
            room.messages.push(message);
            this.broadcast({ type: 'message', ...message }, room.id);
            break;
          }
          case 'leave': {
            this.clientRooms.get(ws)?.delete(data.roomId as string);
            break;
          }
        }
      });

      ws.on('close', () => {
        this.clientRooms.delete(ws);
      });
    });
  }

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer(this.app);

      let settled = false;
      const onListening = () => {
        if (settled) return;
        settled = true;
        const addr = this.server!.address();
        const actualPort = typeof addr === 'object' && addr ? addr.port : this.port;
        this.port = actualPort;
        this.setupWebSocket();
        log(`Dashboard running on http://localhost:${actualPort}`);
        resolve(actualPort);
      };

      this.server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && !settled) {
          log(`Port ${this.port} in use, trying auto-select...`);
          this.server!.listen(0, onListening);
        } else if (!settled) {
          settled = true;
          reject(err);
        }
      });

      this.server.listen(this.port, onListening);
    });
  }

  async close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.wss) {
        this.wss.close();
      }
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  getPort(): number {
    return this.port;
  }
}
