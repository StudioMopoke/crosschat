import net from 'node:net';
import fs from 'node:fs/promises';
import type { PeerJsonRpcRequest, PeerJsonRpcResponse } from '../types.js';
import { createResponse, createErrorResponse, encodeMessage } from './peer-protocol.js';
import { log, logError } from '../util/logger.js';

export type RequestHandler = (
  method: string,
  params: Record<string, unknown> | undefined
) => Promise<unknown>;

export class UdsServer {
  private server: net.Server | null = null;
  private socketPath: string;
  private handler: RequestHandler;

  constructor(socketPath: string, handler: RequestHandler) {
    this.socketPath = socketPath;
    this.handler = handler;
  }

  async start(): Promise<void> {
    // Clean up any existing socket file
    try {
      await fs.unlink(this.socketPath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }

    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        this.handleConnection(socket);
      });

      this.server.on('error', (err) => {
        logError('UDS server error', err);
        reject(err);
      });

      this.server.listen(this.socketPath, () => {
        log(`UDS server listening on ${this.socketPath}`);
        resolve();
      });
    });
  }

  private handleConnection(socket: net.Socket): void {
    let buffer = '';

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf-8');
      const newlineIdx = buffer.indexOf('\n');
      if (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        this.processRequest(line, socket);
      }
    });

    socket.on('error', (err) => {
      logError('UDS connection error', err);
    });
  }

  private async processRequest(line: string, socket: net.Socket): Promise<void> {
    let request: PeerJsonRpcRequest;
    try {
      request = JSON.parse(line) as PeerJsonRpcRequest;
    } catch {
      const errResp = createErrorResponse(0, -32700, 'Parse error');
      socket.write(encodeMessage(errResp));
      socket.end();
      return;
    }

    let response: PeerJsonRpcResponse;
    try {
      const result = await this.handler(request.method, request.params as Record<string, unknown> | undefined);
      response = createResponse(request.id, result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Internal error';
      response = createErrorResponse(request.id, -32603, message);
    }

    socket.write(encodeMessage(response));
    socket.end();
  }

  async close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => {
        log('UDS server closed');
        resolve();
      });
    });
  }
}
