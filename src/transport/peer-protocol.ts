import type { PeerJsonRpcRequest, PeerJsonRpcResponse } from '../types.js';
import { generateId } from '../util/id.js';

export function createRequest(method: string, params?: Record<string, unknown>): PeerJsonRpcRequest {
  return {
    jsonrpc: '2.0',
    id: generateId(),
    method,
    params,
  };
}

export function createResponse(id: string | number, result: unknown): PeerJsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    result,
  };
}

export function createErrorResponse(
  id: string | number,
  code: number,
  message: string,
  data?: unknown
): PeerJsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: { code, message, data },
  };
}

export function encodeMessage(msg: PeerJsonRpcRequest | PeerJsonRpcResponse): Buffer {
  return Buffer.from(JSON.stringify(msg) + '\n', 'utf-8');
}

export function decodeMessage(line: string): PeerJsonRpcRequest | PeerJsonRpcResponse {
  return JSON.parse(line.trim());
}
