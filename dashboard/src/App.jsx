import { useState, useEffect, useRef, useCallback } from 'react';
import { fetchChannels, fetchMessages, postMessage, fetchPeers, fetchThreadMessages, flagAsTask, addBadge, fetchPermissions, decidePermission, fetchInstances, createInstance, deleteInstance, launchInstance, shutdownHub, clearChannel } from './api';
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

function PeerBadge({ icon, label, detail, variant }) {
  return (
    <span className={`peer-badge ${variant || ''}`}>
      <span className="peer-badge-icon">{icon}</span>
      <span className="peer-badge-label">{label}</span>
      {detail && <span className="peer-badge-tooltip">{detail}</span>}
    </span>
  );
}

function shortDir(cwd) {
  if (!cwd) return '?';
  const parts = cwd.split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : '/';
}

function timeSince(isoDate) {
  if (!isoDate) return 'unknown';
  const seconds = Math.floor((Date.now() - new Date(isoDate).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function PeersBar({ peers, onMentionPeer }) {
  if (!peers.length) return null;
  return (
    <div className="peers-bar">
      <div className="peers-label">Agents</div>
      <div className="peers-list">
        {peers.map((peer) => (
          <div
            key={peer.peerId}
            className={`peer-item ${peer.status}`}
            onClick={() => onMentionPeer && onMentionPeer(peer.name)}
            style={{ cursor: 'pointer' }}
          >
            <div className={`peer-icon ${peer.status}`}>
              <span className="peer-icon-letter">{peer.name.charAt(0).toUpperCase()}</span>
              <span className={`peer-status-dot ${peer.status}`} />
            </div>
            <div className="peer-info">
              <span className="peer-name">{peer.name}</span>
              <div className="peer-badges">
                <PeerBadge
                  icon="&#128193;"
                  label={shortDir(peer.cwd)}
                  detail={peer.cwd || 'Unknown directory'}
                  variant="dir"
                />
                <PeerBadge
                  icon={peer.status === 'available' ? '&#9679;' : '&#9679;'}
                  label={peer.status}
                  detail={peer.statusDetail || `Status: ${peer.status}`}
                  variant={peer.status}
                />
                <PeerBadge
                  icon="&#128337;"
                  label={timeSince(peer.connectedAt)}
                  detail={`Connected since ${peer.connectedAt ? new Date(peer.connectedAt).toLocaleString() : 'unknown'}`}
                  variant="session"
                />
                {peer.statusDetail && (
                  <PeerBadge
                    icon="&#128736;"
                    label="Task"
                    detail={peer.statusDetail}
                    variant="task"
                  />
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Sidebar({ peers, onMentionPeer }) {
  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <h1>CrossChat</h1>
      </div>
      <PeersBar peers={peers} onMentionPeer={onMentionPeer} />
      <ul className="channel-list">
        <li className="channel-item active">
          <span className="channel-name"># General</span>
        </li>
      </ul>
      <div className="sidebar-footer">
        <button
          className="hub-shutdown-btn"
          onClick={() => {
            if (window.confirm('Shut down the CrossChat hub? All agents will be disconnected.')) {
              shutdownHub().catch(() => {});
            }
          }}
        >
          Shutdown Hub
        </button>
      </div>
    </aside>
  );
}

// -- Badge color map ----------------------------------------------------------

const BADGE_COLORS = {
  task: 'blue',
  'importance:high': 'red',
  'importance:normal': 'gray',
  question: 'purple',
  'git-commit': 'green',
  project: 'orange',
};

function badgeColorKey(badge) {
  if (badge.type === 'importance') return `importance:${badge.value}`;
  return badge.type;
}

function MessageBadgeList({ badges }) {
  if (!badges || !badges.length) return null;
  return (
    <span className="message-badge-list">
      {badges.map((badge, i) => {
        const key = badgeColorKey(badge);
        const color = BADGE_COLORS[key] || 'gray';
        return (
          <span key={i} className={`badge badge-${badge.type}`} style={{ color }}>
            {badge.label || badge.value || badge.type}
          </span>
        );
      })}
    </span>
  );
}

// -- Thread indicator ---------------------------------------------------------

function ThreadIndicator({ replyCount }) {
  if (!replyCount || replyCount <= 0) return null;
  return (
    <span className="thread-indicator">
      {replyCount} {replyCount === 1 ? 'reply' : 'replies'}
    </span>
  );
}

function ChatArea({ channel, messages, username, onSendMessage, events, replyTarget, onClearReply, peers }) {
  const [text, setText] = useState('');
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, events]);

  // When replyTarget changes (from peer click or message reply), focus the input
  useEffect(() => {
    if (replyTarget) {
      inputRef.current?.focus();
    }
  }, [replyTarget]);

  const handleSend = (e) => {
    e.preventDefault();
    if (!text.trim()) return;
    onSendMessage(text.trim());
    setText('');
    if (onClearReply) onClearReply();
  };

  const handleReply = (msg) => {
    setText(`@${msg.username} `);
    inputRef.current?.focus();
  };

  if (!channel) {
    return (
      <main className="chat-area empty-state">
        <p>Select a channel to view agent activity or start chatting</p>
      </main>
    );
  }

  return (
    <main className="chat-area">
      <div className="messages">
        {messages.map((msg) => (
          <div
            key={msg.id || msg.messageId}
            className={`message ${msg.username === username ? 'own' : ''}`}
          >
            <div className="message-header">
              <span className="message-author">{msg.username}</span>
              <MessageAuthorBadges username={msg.username} peers={peers} />
              <span className="message-time">
                {new Date(msg.timestamp).toLocaleTimeString()}
              </span>
              {msg.username !== username && (
                <button
                  className="reply-btn"
                  onClick={() => handleReply(msg)}
                  title={`Reply to ${msg.username}`}
                >
                  Reply
                </button>
              )}
            </div>
            <div className="message-text">{renderMessageText(msg.text)}</div>
            <MessageBadgeList badges={msg.badges} />
            <ThreadIndicator replyCount={msg.threadReplyCount} />
          </div>
        ))}
        {events.map((evt, i) => (
          <div key={`evt-${i}`} className="event-notice">
            {evt.username} joined the channel
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>
      {replyTarget && (
        <div className="reply-bar">
          <span className="reply-bar-text">Replying to <strong>@{replyTarget}</strong></span>
          <button className="reply-bar-close" onClick={onClearReply}>&times;</button>
        </div>
      )}
      <form className="message-form" onSubmit={handleSend}>
        <input
          ref={inputRef}
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={replyTarget ? `Reply to @${replyTarget}...` : 'Type a message...'}
        />
        <button type="submit" disabled={!text.trim()}>Send</button>
      </form>
    </main>
  );
}

// -- Message Author Badges (peer info next to author name) --------------------

function MessageAuthorBadges({ username, peers }) {
  if (!peers || !peers.length) return null;
  const peer = peers.find((p) => p.name === username);
  if (!peer) return null;

  return (
    <span className="message-badges">
      <PeerBadge
        icon="&#128193;"
        label={shortDir(peer.cwd)}
        detail={peer.cwd || 'Unknown directory'}
        variant="dir"
      />
      <PeerBadge
        icon={'\u25CF'}
        label={peer.status}
        detail={peer.statusDetail || `Status: ${peer.status}`}
        variant={peer.status}
      />
      {peer.statusDetail && (
        <PeerBadge
          icon="&#128736;"
          label="Task"
          detail={peer.statusDetail}
          variant="task"
        />
      )}
    </span>
  );
}

// -- Mention highlighting -----------------------------------------------------

function renderMessageText(text) {
  const parts = text.split(/(@[\w-]+)/g);
  return parts.map((part, i) => {
    if (/^@[\w-]+$/.test(part)) {
      const cls = part.toLowerCase() === '@here' ? 'mention mention-here' : 'mention';
      return <span key={i} className={cls}>{part}</span>;
    }
    return part;
  });
}

// -- Instances Panel ----------------------------------------------------------

function InstanceCard({ instance, onLaunch, onRemove }) {
  const [launching, setLaunching] = useState(false);
  const [removing, setRemoving] = useState(false);

  const handleLaunch = async () => {
    setLaunching(true);
    try {
      await onLaunch(instance.id);
    } finally {
      setTimeout(() => setLaunching(false), 2000);
    }
  };

  const handleRemove = async () => {
    setRemoving(true);
    try {
      await onRemove(instance.id);
    } finally {
      setRemoving(false);
    }
  };

  const dirName = instance.path.split('/').filter(Boolean).pop() || instance.path;

  return (
    <div className="instance-card">
      <div className="instance-card-header">
        <div className="instance-card-top">
          <span className="instance-card-name">{instance.name}</span>
          {instance.activeAgents > 0 && (
            <span className="instance-active-indicator">
              <span className="instance-active-dot" />
              {instance.activeAgents} agent{instance.activeAgents !== 1 ? 's' : ''}
            </span>
          )}
        </div>
        <div className="instance-card-path" title={instance.path}>
          {instance.path}
        </div>
        {instance.description && (
          <div className="instance-card-description">{instance.description}</div>
        )}
      </div>
      <div className="instance-card-actions">
        <button
          className="instance-launch-btn"
          onClick={handleLaunch}
          disabled={launching}
        >
          {launching ? 'Launching...' : 'Launch'}
        </button>
        <button
          className="instance-remove-btn"
          onClick={handleRemove}
          disabled={removing}
        >
          Remove
        </button>
      </div>
    </div>
  );
}

function InstancesPanel({ peers }) {
  const [instances, setInstances] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPath, setNewPath] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState(null);

  const loadInstances = useCallback(() => {
    fetchInstances()
      .then((data) => { setInstances(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadInstances();
    const interval = setInterval(loadInstances, 10000);
    return () => clearInterval(interval);
  }, [loadInstances]);

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!newName.trim() || !newPath.trim()) return;
    setCreating(true);
    setError(null);
    try {
      await createInstance(newName.trim(), newPath.trim(), newDesc.trim() || undefined);
      setNewName('');
      setNewPath('');
      setNewDesc('');
      setShowForm(false);
      loadInstances();
    } catch (err) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  };

  const handleLaunch = async (id) => {
    try {
      await launchInstance(id);
    } catch (err) {
      setError(err.message);
    }
  };

  const handleRemove = async (id) => {
    try {
      await deleteInstance(id);
      loadInstances();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <main className="instances-panel">
      <div className="instances-header">
        <span className="instances-title">Registered Instances</span>
        <button
          className="instances-add-btn"
          onClick={() => setShowForm(!showForm)}
        >
          {showForm ? 'Cancel' : '+ Register'}
        </button>
      </div>

      {error && (
        <div className="instances-error" onClick={() => setError(null)}>
          {error}
        </div>
      )}

      {showForm && (
        <form className="instance-form" onSubmit={handleCreate}>
          <input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Instance name..."
            maxLength={60}
            disabled={creating}
          />
          <input
            value={newPath}
            onChange={(e) => setNewPath(e.target.value)}
            placeholder="Absolute path (e.g. /Users/you/project)..."
            disabled={creating}
          />
          <input
            value={newDesc}
            onChange={(e) => setNewDesc(e.target.value)}
            placeholder="Description (optional)..."
            maxLength={200}
            disabled={creating}
          />
          <button type="submit" disabled={!newName.trim() || !newPath.trim() || creating}>
            {creating ? 'Registering...' : 'Register Instance'}
          </button>
        </form>
      )}

      <div className="instances-list">
        {loading && instances.length === 0 && (
          <div className="instances-empty">Loading instances...</div>
        )}
        {!loading && instances.length === 0 && !showForm && (
          <div className="instances-empty">No instances registered yet. Click + Register to add one.</div>
        )}
        {instances.map((instance) => (
          <InstanceCard
            key={instance.id}
            instance={instance}
            onLaunch={handleLaunch}
            onRemove={handleRemove}
          />
        ))}
      </div>
    </main>
  );
}

// -- Permission Popup ---------------------------------------------------------

function toolInputSummary(toolName, toolInput) {
  if (!toolInput) return null;
  if (toolName === 'Bash' && toolInput.command) return toolInput.command;
  if ((toolName === 'Edit' || toolName === 'Write' || toolName === 'Read') && toolInput.file_path) return toolInput.file_path;
  if (toolName === 'Glob' && toolInput.pattern) return toolInput.pattern;
  if (toolName === 'Grep' && toolInput.pattern) return toolInput.pattern;
  if (toolName === 'WebFetch' && toolInput.url) return toolInput.url;
  if (toolName === 'WebSearch' && toolInput.query) return toolInput.query;
  // MCP tools
  if (toolName.startsWith('mcp__')) return JSON.stringify(toolInput).slice(0, 120);
  // Fallback: show first string value
  const firstVal = Object.values(toolInput).find((v) => typeof v === 'string');
  return firstVal || null;
}

function PermissionToast({ permission, onDecide }) {
  const [deciding, setDeciding] = useState(false);

  const handle = async (decision) => {
    setDeciding(true);
    await onDecide(permission.id, decision);
  };

  const summary = toolInputSummary(permission.toolName, permission.toolInput);

  return (
    <div className={`permission-toast ${deciding ? 'deciding' : ''}`}>
      <div className="permission-toast-header">
        <span className="permission-agent-badge">
          <span className="permission-agent-letter">{(permission.agentName || '?').charAt(0).toUpperCase()}</span>
          {permission.agentName}
        </span>
        <span className="permission-tool-badge">{permission.toolName}</span>
      </div>
      {permission.description && (
        <div className="permission-description">{permission.description}</div>
      )}
      {summary && (
        <div className="permission-context"><code>{summary}</code></div>
      )}
      <div className="permission-actions">
        <button
          className="permission-btn allow"
          onClick={() => handle('approved')}
          disabled={deciding}
        >
          Allow
        </button>
        <button
          className="permission-btn deny"
          onClick={() => handle('denied')}
          disabled={deciding}
        >
          Deny
        </button>
      </div>
    </div>
  );
}

function PermissionPopups({ permissions, onDecide }) {
  if (!permissions.length) return null;
  return (
    <div className="permission-popups">
      {permissions.map((p) => (
        <PermissionToast key={p.id} permission={p} onDecide={onDecide} />
      ))}
    </div>
  );
}

// -- Main App -----------------------------------------------------------------

export default function App() {
  const [username, setUsername] = useState(() => localStorage.getItem('crosschat-username') || '');
  const [channels, setChannels] = useState([]);
  const [activeChannelId, setActiveChannelId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [events, setEvents] = useState([]);
  const [peers, setPeers] = useState([]);
  const [error, setError] = useState(null);
  const [activeTab, setActiveTab] = useState('chat');
  const [replyTarget, setReplyTarget] = useState(null);
  const [permissions, setPermissions] = useState([]);

  const activeChannelIdRef = useRef(activeChannelId);
  activeChannelIdRef.current = activeChannelId;

  const handleWsMessage = useCallback((data) => {
    // Permission events
    if (data.type === 'permission.request') {
      setPermissions((prev) => {
        if (prev.some((p) => p.id === data.permission.id)) return prev;
        return [...prev, data.permission];
      });
      return;
    }
    if (data.type === 'permission.decided') {
      setPermissions((prev) => prev.filter((p) => p.id !== data.id));
      return;
    }

    // Peer events
    if (data.type === 'peerConnected') {
      setPeers((prev) => {
        if (prev.some((p) => p.peerId === data.peer.peerId)) return prev;
        return [...prev, data.peer];
      });
      return;
    }
    if (data.type === 'peerDisconnected') {
      setPeers((prev) => prev.filter((p) => p.peerId !== data.peerId));
      return;
    }

    // Badge added to a message
    if (data.type === 'message.badgeAdded' || data.type === 'badgeUpdate') {
      setMessages((prev) => prev.map((m) => {
        const msgId = m.id || m.messageId;
        if (msgId === data.messageId) {
          const existingBadges = m.badges || [];
          const newBadge = data.badge;
          if (newBadge && !existingBadges.some((b) => b.type === newBadge.type && b.value === newBadge.value)) {
            return { ...m, badges: [...existingBadges, newBadge] };
          }
        }
        return m;
      }));
      return;
    }

    // Message updated (e.g. badge list replaced, content edited)
    if (data.type === 'message.updated') {
      setMessages((prev) => prev.map((m) => {
        const msgId = m.id || m.messageId;
        if (msgId === data.messageId) {
          return { ...m, ...data.message };
        }
        return m;
      }));
      return;
    }

    // Only process channel-scoped events for the active channel
    if (data.channelId !== activeChannelIdRef.current && data.roomId !== activeChannelIdRef.current) return;

    if (data.type === 'message') {
      setMessages((prev) => {
        if (prev.some((m) => (m.id || m.messageId) === data.messageId)) return prev;
        return [...prev, data];
      });
    } else if (data.type === 'userJoined') {
      setEvents((prev) => [...prev, data]);
    }
  }, []);

  const handleWsReconnect = useCallback(() => {
    // Re-fetch all state on WebSocket reconnect to clear stale data
    fetchPeers().then(setPeers).catch(() => {});
    fetchPermissions().then(setPermissions).catch(() => {});
  }, []);

  const { send: wsSend, sessionToken } = useWebSocket(handleWsMessage, handleWsReconnect);

  useEffect(() => {
    if (!username) return;
    fetchChannels()
      .then((fetchedChannels) => {
        setChannels(fetchedChannels);
        // Auto-select the general channel
        const generalChannel = fetchedChannels.find((c) => c.id === 'general') || fetchedChannels.find((c) => c.id === 'crosschat');
        if (generalChannel && !activeChannelId) {
          setActiveChannelId(generalChannel.id);
        } else if (fetchedChannels.length > 0 && !activeChannelId) {
          setActiveChannelId(fetchedChannels[0].id);
        }
      })
      .catch((err) => setError(err.message));

    // Initial fetch for peers and permissions — then rely on WebSocket events
    fetchPeers().then(setPeers).catch(() => {});
    fetchPermissions().then(setPermissions).catch(() => {});
  }, [username]);

  const handlePermissionDecide = async (id, decision) => {
    try {
      await decidePermission(id, decision, undefined, sessionToken);
      setPermissions((prev) => prev.filter((p) => p.id !== id));
    } catch (err) {
      setError(err.message);
    }
  };

  useEffect(() => {
    if (!activeChannelId) return;
    setMessages([]);
    setEvents([]);
    fetchMessages(activeChannelId)
      .then(setMessages)
      .catch((err) => setError(err.message));

    wsSend({ type: 'join', channelId: activeChannelId });
  }, [activeChannelId, wsSend]);

  const handleSetUsername = (name) => {
    localStorage.setItem('crosschat-username', name);
    setUsername(name);
  };

  const handleSendMessage = async (text) => {
    try {
      await postMessage(activeChannelId, username, text);
    } catch (err) {
      setError(err.message);
    }
  };

  if (!username) {
    return <UsernamePrompt onSubmit={handleSetUsername} />;
  }

  const activeChannel = channels.find((c) => c.id === activeChannelId) || null;

  return (
    <div className="app">
      <PermissionPopups permissions={permissions} onDecide={handlePermissionDecide} />
      {error && (
        <div className="error-banner" onClick={() => setError(null)}>
          {error} (click to dismiss)
        </div>
      )}
      <Sidebar
        peers={peers}
        onMentionPeer={(name) => { setReplyTarget(name); setActiveTab('chat'); }}
      />
      <div className="main-content">
        <div className="tab-bar">
          <div className="tab-bar-left">
            <button
              className={`tab-item ${activeTab === 'chat' ? 'active' : ''}`}
              onClick={() => setActiveTab('chat')}
            >
              Chat{activeChannel ? ` — #${activeChannel.name}` : ''}
            </button>
            <button
              className={`tab-item ${activeTab === 'instances' ? 'active' : ''}`}
              onClick={() => setActiveTab('instances')}
            >
              Instances
            </button>
          </div>
        </div>

        {activeTab === 'chat' ? (
          <ChatArea
            channel={activeChannel}
            messages={messages}
            username={username}
            onSendMessage={handleSendMessage}
            events={events}
            replyTarget={replyTarget}
            onClearReply={() => setReplyTarget(null)}
            peers={peers}
          />
        ) : (
          <InstancesPanel peers={peers} />
        )}
      </div>
    </div>
  );
}
