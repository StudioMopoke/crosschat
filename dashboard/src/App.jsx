import { useState, useEffect, useRef, useCallback } from 'react';
import { fetchRooms, createRoom, fetchMessages, postMessage } from './api';
import { useWebSocket } from './useWebSocket';
import './App.css';

function UsernamePrompt({ onSubmit }) {
  const [name, setName] = useState('');
  return (
    <div className="username-overlay">
      <div className="username-modal">
        <h2>CrossChat Dashboard</h2>
        <p>Enter your username to join</p>
        <form onSubmit={(e) => { e.preventDefault(); if (name.trim()) onSubmit(name.trim()); }}>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your username..."
            maxLength={30}
          />
          <button type="submit" disabled={!name.trim()}>Join</button>
        </form>
      </div>
    </div>
  );
}

function Sidebar({ rooms, activeRoomId, onSelectRoom, onCreateRoom }) {
  const [newRoomName, setNewRoomName] = useState('');
  const [creating, setCreating] = useState(false);

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!newRoomName.trim()) return;
    setCreating(true);
    await onCreateRoom(newRoomName.trim());
    setNewRoomName('');
    setCreating(false);
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <h1>CrossChat</h1>
      </div>
      <ul className="room-list">
        {rooms.map((room) => (
          <li
            key={room.id}
            className={`room-item ${room.id === activeRoomId ? 'active' : ''}`}
            onClick={() => onSelectRoom(room.id)}
          >
            <span className="room-name"># {room.name}</span>
          </li>
        ))}
        {rooms.length === 0 && (
          <li className="room-item empty">No rooms yet</li>
        )}
      </ul>
      <form className="create-room-form" onSubmit={handleCreate}>
        <input
          value={newRoomName}
          onChange={(e) => setNewRoomName(e.target.value)}
          placeholder="New room name..."
          maxLength={50}
          disabled={creating}
        />
        <button type="submit" disabled={!newRoomName.trim() || creating}>+</button>
      </form>
    </aside>
  );
}

function ChatArea({ room, messages, username, onSendMessage, events }) {
  const [text, setText] = useState('');
  const messagesEndRef = useRef(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, events]);

  const handleSend = (e) => {
    e.preventDefault();
    if (!text.trim()) return;
    onSendMessage(text.trim());
    setText('');
  };

  if (!room) {
    return (
      <main className="chat-area empty-state">
        <p>Select a room to view agent activity or start chatting</p>
      </main>
    );
  }

  return (
    <main className="chat-area">
      <div className="chat-header">
        <h2># {room.name}</h2>
      </div>
      <div className="messages">
        {messages.map((msg) => (
          <div
            key={msg.id || msg.messageId}
            className={`message ${msg.username === username ? 'own' : ''}`}
          >
            <div className="message-header">
              <span className="message-author">{msg.username}</span>
              <span className="message-time">
                {new Date(msg.timestamp).toLocaleTimeString()}
              </span>
            </div>
            <div className="message-text">{msg.text}</div>
          </div>
        ))}
        {events.map((evt, i) => (
          <div key={`evt-${i}`} className="event-notice">
            {evt.username} joined the room
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>
      <form className="message-form" onSubmit={handleSend}>
        <input
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Type a message..."
        />
        <button type="submit" disabled={!text.trim()}>Send</button>
      </form>
    </main>
  );
}

export default function App() {
  const [username, setUsername] = useState(() => localStorage.getItem('crosschat-username') || '');
  const [rooms, setRooms] = useState([]);
  const [activeRoomId, setActiveRoomId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [events, setEvents] = useState([]);
  const [error, setError] = useState(null);

  const activeRoomIdRef = useRef(activeRoomId);
  activeRoomIdRef.current = activeRoomId;

  const handleWsMessage = useCallback((data) => {
    if (data.type === 'roomCreated') {
      setRooms((prev) => {
        if (prev.some((r) => r.id === data.room.id)) return prev;
        return [...prev, data.room];
      });
      return;
    }

    if (data.roomId !== activeRoomIdRef.current) return;

    if (data.type === 'message') {
      setMessages((prev) => {
        if (prev.some((m) => (m.id || m.messageId) === data.messageId)) return prev;
        return [...prev, data];
      });
    } else if (data.type === 'userJoined') {
      setEvents((prev) => [...prev, data]);
    }
  }, []);

  const { send: wsSend } = useWebSocket(handleWsMessage);

  useEffect(() => {
    if (!username) return;
    fetchRooms()
      .then((fetchedRooms) => {
        setRooms(fetchedRooms);
        // Auto-select the CrossChat Activity room
        const crosschatRoom = fetchedRooms.find((r) => r.id === 'crosschat');
        if (crosschatRoom && !activeRoomId) {
          setActiveRoomId('crosschat');
        }
      })
      .catch((err) => setError(err.message));
  }, [username]);

  useEffect(() => {
    if (!activeRoomId) return;
    setMessages([]);
    setEvents([]);
    fetchMessages(activeRoomId)
      .then(setMessages)
      .catch((err) => setError(err.message));

    wsSend({ type: 'join', roomId: activeRoomId });
  }, [activeRoomId, wsSend]);

  const handleSetUsername = (name) => {
    localStorage.setItem('crosschat-username', name);
    setUsername(name);
  };

  const handleCreateRoom = async (name) => {
    try {
      const room = await createRoom(name);
      setRooms((prev) => [...prev, room]);
      setActiveRoomId(room.id);
    } catch (err) {
      setError(err.message);
    }
  };

  const handleSendMessage = async (text) => {
    try {
      await postMessage(activeRoomId, username, text);
      wsSend({ type: 'message', roomId: activeRoomId, username, text });
    } catch (err) {
      setError(err.message);
    }
  };

  if (!username) {
    return <UsernamePrompt onSubmit={handleSetUsername} />;
  }

  const activeRoom = rooms.find((r) => r.id === activeRoomId) || null;

  return (
    <div className="app">
      {error && (
        <div className="error-banner" onClick={() => setError(null)}>
          {error} (click to dismiss)
        </div>
      )}
      <Sidebar
        rooms={rooms}
        activeRoomId={activeRoomId}
        onSelectRoom={setActiveRoomId}
        onCreateRoom={handleCreateRoom}
      />
      <ChatArea
        room={activeRoom}
        messages={messages}
        username={username}
        onSendMessage={handleSendMessage}
        events={events}
      />
    </div>
  );
}
