// Uses relative URLs so it works when served from the same origin as the dashboard server
const API_BASE = '/api';

export async function fetchRooms() {
  const res = await fetch(`${API_BASE}/rooms`);
  if (!res.ok) throw new Error('Failed to fetch rooms');
  return res.json();
}

export async function createRoom(name) {
  const res = await fetch(`${API_BASE}/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error('Failed to create room');
  return res.json();
}

export async function fetchMessages(roomId) {
  const res = await fetch(`${API_BASE}/rooms/${roomId}/messages`);
  if (!res.ok) throw new Error('Failed to fetch messages');
  return res.json();
}

export async function fetchPeers() {
  const res = await fetch(`${API_BASE}/peers`);
  if (!res.ok) throw new Error('Failed to fetch peers');
  return res.json();
}

export async function postMessage(roomId, username, text) {
  const res = await fetch(`${API_BASE}/rooms/${roomId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, text }),
  });
  if (!res.ok) throw new Error('Failed to send message');
  return res.json();
}

export async function fetchTasks() {
  const res = await fetch(`${API_BASE}/tasks`);
  if (!res.ok) throw new Error('Failed to fetch tasks');
  return res.json();
}

export async function fetchTask(taskId) {
  const res = await fetch(`${API_BASE}/tasks/${taskId}`);
  if (!res.ok) throw new Error('Failed to fetch task');
  return res.json();
}

export async function fetchPermissions() {
  const res = await fetch(`${API_BASE}/permissions`);
  if (!res.ok) throw new Error('Failed to fetch permissions');
  return res.json();
}

export async function decidePermission(id, decision, reason, sessionToken) {
  const headers = { 'Content-Type': 'application/json' };
  if (sessionToken) {
    headers['Authorization'] = `Bearer ${sessionToken}`;
  }
  const res = await fetch(`${API_BASE}/permissions/${id}/decide`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ decision, reason }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || 'Failed to decide permission');
  }
  return res.json();
}

export async function fetchInstances() {
  const res = await fetch(`${API_BASE}/instances`);
  if (!res.ok) throw new Error('Failed to fetch instances');
  return res.json();
}

export async function createInstance(name, instPath, description) {
  const res = await fetch(`${API_BASE}/instances`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, path: instPath, description }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || 'Failed to create instance');
  }
  return res.json();
}

export async function deleteInstance(id) {
  const res = await fetch(`${API_BASE}/instances/${id}`, { method: 'DELETE' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || 'Failed to delete instance');
  }
  return res.json();
}

export async function launchInstance(id) {
  const res = await fetch(`${API_BASE}/instances/${id}/launch`, { method: 'POST' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || 'Failed to launch instance');
  }
  return res.json();
}

export async function shutdownHub() {
  const res = await fetch(`${API_BASE}/hub/shutdown`, { method: 'POST' });
  if (!res.ok) throw new Error('Failed to shutdown hub');
  return res.json();
}

export async function archiveTask(taskId) {
  const res = await fetch(`${API_BASE}/tasks/${taskId}/archive`, {
    method: 'POST',
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || 'Failed to archive task');
  }
  return res.json();
}
