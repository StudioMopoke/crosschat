import { useEffect, useRef, useCallback } from 'react';

// Derive WebSocket URL from current page location so it works on any port
function getWsUrl() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}

export function useWebSocket(onMessage) {
  const wsRef = useRef(null);
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  useEffect(() => {
    const ws = new WebSocket(getWsUrl());
    wsRef.current = ws;

    ws.onopen = () => console.log('WebSocket connected');
    ws.onclose = () => console.log('WebSocket disconnected');
    ws.onerror = (e) => console.error('WebSocket error', e);

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        onMessageRef.current(data);
      } catch (err) {
        console.error('Failed to parse WebSocket message', err);
      }
    };

    return () => {
      ws.close();
    };
  }, []);

  const send = useCallback((data) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }, []);

  return { send };
}
