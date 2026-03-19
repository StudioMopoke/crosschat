// === Registry ===

export type PeerStatus = 'available' | 'busy' | 'offline';

export interface PeerRegistryEntry {
  peerId: string;
  name: string;
  pid: number;
  socketPath: string;
  registeredAt: string;
  status: PeerStatus;
  statusDetail?: string;
  busyWithTaskId?: string;
  orchestratorPeerId?: string;
  metadata?: {
    cwd?: string;
    parentPid?: number;
  };
}

// === Messages ===

export interface PeerMessage {
  messageId: string;
  fromPeerId: string;
  fromName: string;
  content: string;
  metadata?: Record<string, unknown>;
  sentAt: string;
  receivedAt: string;
  read: boolean;
  relatedTaskId?: string;
  replyToMessageId?: string;
  type?: 'message' | 'task_result' | 'task_delegated';
}

// === Tasks ===

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'timed_out';

export interface DelegatedTask {
  taskId: string;
  targetPeerId: string;
  targetName: string;
  description: string;
  context?: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  timeoutMs: number;
  result?: string;
  error?: string;
}

export interface InboundTask {
  taskId: string;
  fromPeerId: string;
  fromName: string;
  description: string;
  context?: string;
  status: TaskStatus;
  receivedAt: string;
}

// === Peer Protocol (UDS JSON-RPC) ===

export interface PeerJsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface PeerJsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface PeerMessageParams {
  messageId: string;
  fromPeerId: string;
  fromName: string;
  content: string;
  metadata?: Record<string, unknown>;
  sentAt: string;
  relatedTaskId?: string;
  replyToMessageId?: string;
}

export interface PeerDelegateTaskParams {
  taskId: string;
  fromPeerId: string;
  fromName: string;
  description: string;
  context?: string;
  timeoutMs: number;
}

export interface PeerTaskUpdateParams {
  taskId: string;
  status: TaskStatus;
  result?: string;
  error?: string;
}

export interface PeerPingParams {
  peerId: string;
}
