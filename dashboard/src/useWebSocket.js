import { useEffect, useRef, useCallback, useState } from 'react';

// Derive WebSocket URL from current page location so it works on any port
function getWsUrl() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}

const INITIAL_RECONNECT_DELAY = 1000;
const MAX_RECONNECT_DELAY = 30000;

export function useWebSocket(onMessage, onReconnect) {
  const wsRef = useRef(null);
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;
  const onReconnectRef = useRef(onReconnect);
  onReconnectRef.current = onReconnect;
  const [sessionToken, setSessionToken] = useState(null);
  const reconnectDelayRef = useRef(INITIAL_RECONNECT_DELAY);
  const reconnectTimerRef = useRef(null);
  const unmountedRef = useRef(false);
  const hasConnectedRef = useRef(false);

  useEffect(() => {
    unmountedRef.current = false;

    function connect() {
      if (unmountedRef.current) return;

      const ws = new WebSocket(getWsUrl());
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('WebSocket connected');
        reconnectDelayRef.current = INITIAL_RECONNECT_DELAY;

        // On reconnect (not first connect), re-fetch all state
        if (hasConnectedRef.current && onReconnectRef.current) {
          onReconnectRef.current();
        }
        hasConnectedRef.current = true;
      };

      ws.onclose = () => {
        console.log('WebSocket disconnected');
        setSessionToken(null);
        scheduleReconnect();
      };

      ws.onerror = (e) => console.error('WebSocket error', e);

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          // Capture session token from hub
          if (data.type === 'session' && data.token) {
            setSessionToken(data.token);
            return;
          }
          onMessageRef.current(data);
        } catch (err) {
          console.error('Failed to parse WebSocket message', err);
        }
      };
    }

    function scheduleReconnect() {
      if (unmountedRef.current) return;
      const delay = reconnectDelayRef.current;
      reconnectDelayRef.current = Math.min(delay * 2, MAX_RECONNECT_DELAY);
      console.log(`WebSocket reconnecting in ${delay}ms...`);
      reconnectTimerRef.current = setTimeout(connect, delay);
    }

    connect();

    return () => {
      unmountedRef.current = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, []);

  const send = useCallback((data) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }, []);

  return { send, sessionToken };
}
