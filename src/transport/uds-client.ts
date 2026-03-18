import net from 'node:net';
import type { PeerJsonRpcResponse } from '../types.js';
import { createRequest, encodeMessage } from './peer-protocol.js';
import { logError } from '../util/logger.js';

const DEFAULT_TIMEOUT_MS = 5000;

export async function sendPeerRequest(
  socketPath: string,
  method: string,
  params?: Record<string, unknown>,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<PeerJsonRpcResponse> {
  return new Promise((resolve, reject) => {
    const request = createRequest(method, params);
    const socket = net.createConnection({ path: socketPath });
    let responseData = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        socket.destroy();
        reject(new Error(`Peer request timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    socket.on('connect', () => {
      socket.write(encodeMessage(request));
    });

    socket.on('data', (chunk) => {
      responseData += chunk.toString('utf-8');
      const newlineIdx = responseData.indexOf('\n');
      if (newlineIdx !== -1) {
        const line = responseData.slice(0, newlineIdx);
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          try {
            const response = JSON.parse(line) as PeerJsonRpcResponse;
            resolve(response);
          } catch (err) {
            reject(new Error('Invalid JSON response from peer'));
          }
          socket.end();
        }
      }
    });

    socket.on('error', (err: NodeJS.ErrnoException) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        logError(`Peer connection error (${socketPath})`, err);
        reject(err);
      }
    });

    socket.on('close', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error('Connection closed before response'));
      }
    });
  });
}
