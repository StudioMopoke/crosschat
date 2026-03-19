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
