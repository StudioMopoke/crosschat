import { useState, useEffect, useRef, useCallback } from 'react';
import { fetchRooms, createRoom, fetchMessages, postMessage, fetchPeers, fetchTasks, fetchTask, createTask, archiveTask, fetchPermissions, decidePermission, fetchInstances, createInstance, deleteInstance, launchInstance, shutdownHub } from './api';
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

function Sidebar({ rooms, activeRoomId, onSelectRoom, onCreateRoom, peers, onMentionPeer }) {
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
      <PeersBar peers={peers} onMentionPeer={onMentionPeer} />
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

function ChatArea({ room, messages, username, onSendMessage, events, replyTarget, onClearReply, peers }) {
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

  if (!room) {
    return (
      <main className="chat-area empty-state">
        <p>Select a room to view agent activity or start chatting</p>
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
              <MessageBadges username={msg.username} peers={peers} />
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
          </div>
        ))}
        {events.map((evt, i) => (
          <div key={`evt-${i}`} className="event-notice">
            {evt.username} joined the room
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

// ── Message Badges ──────────────────────────────────────────────────

function MessageBadges({ username, peers }) {
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

// ── Mention highlighting ────────────────────────────────────────────

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

// ── Status helpers ──────────────────────────────────────────────────

const STATUS_LABELS = {
  open: 'Open',
  claimed: 'Claimed',
  in_progress: 'In Progress',
  completed: 'Completed',
  failed: 'Failed',
  archived: 'Archived',
};

const STATUS_ORDER = ['open', 'claimed', 'in_progress', 'completed', 'failed'];

function StatusBadge({ status }) {
  return (
    <span className={`status-badge ${status}`}>
      {STATUS_LABELS[status] || status}
    </span>
  );
}

function FilterBadges({ filter }) {
  if (!filter) return null;
  const badges = [];
  if (filter.agentId) badges.push({ label: 'Agent', value: filter.agentId });
  if (filter.workingDirReq) badges.push({ label: 'Dir', value: filter.workingDirReq });
  if (filter.gitProject) badges.push({ label: 'Git', value: filter.gitProject });
  if (badges.length === 0) return null;
  return (
    <div className="filter-badges">
      {badges.map((b, i) => (
        <span key={i} className="filter-badge" title={`${b.label}: ${b.value}`}>
          {b.label}: {b.value}
        </span>
      ))}
    </div>
  );
}

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ── Task Card ───────────────────────────────────────────────────────

function TaskCard({ task, onExpand, expanded, onArchive }) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(false);
  const [archiving, setArchiving] = useState(false);

  useEffect(() => {
    if (expanded && !detail) {
      setLoading(true);
      fetchTask(task.taskId)
        .then(setDetail)
        .catch(() => {})
        .finally(() => setLoading(false));
    }
  }, [expanded, task.taskId]);

  // Re-fetch detail when task updates come in
  useEffect(() => {
    if (expanded && detail) {
      fetchTask(task.taskId)
        .then(setDetail)
        .catch(() => {});
    }
  }, [task.updatedAt]);

  const handleArchive = async () => {
    setArchiving(true);
    try {
      await onArchive(task.taskId);
    } finally {
      setArchiving(false);
    }
  };

  const canArchive = task.status === 'completed' || task.status === 'failed';

  return (
    <div className={`task-card ${expanded ? 'expanded' : ''}`}>
      <div className="task-card-header" onClick={() => onExpand(expanded ? null : task.taskId)}>
        <div className="task-card-top">
          <StatusBadge status={task.status} />
          <span className="task-card-time">{formatTime(task.createdAt)}</span>
        </div>
        <div className="task-card-description">{task.description}</div>
        <div className="task-card-meta">
          <span className="task-meta-item">by {task.creatorName}</span>
          {task.claimantName && (
            <span className="task-meta-item">assigned: {task.claimantName}</span>
          )}
          <span className="task-meta-item">#{task.roomId}</span>
        </div>
        <FilterBadges filter={task.filter} />
      </div>

      {expanded && (
        <div className="task-card-detail">
          {loading && <div className="task-loading">Loading...</div>}
          {detail && (
            <>
              {detail.context && (
                <div className="task-context">
                  <div className="task-section-label">Context</div>
                  <div className="task-context-text">{detail.context}</div>
                </div>
              )}

              {detail.result && (
                <div className="task-result">
                  <div className="task-section-label">Result</div>
                  <div className="task-result-text">{detail.result}</div>
                </div>
              )}

              {detail.notes && detail.notes.length > 0 && (
                <div className="task-notes">
                  <div className="task-section-label">Notes ({detail.notes.length})</div>
                  {[...detail.notes].reverse().map((note) => (
                    <div key={note.noteId} className="task-note">
                      <div className="task-note-header">
                        <span className="task-note-author">{note.authorName}</span>
                        <span className="task-note-time">{formatTime(note.timestamp)}</span>
                      </div>
                      <div className="task-note-content">{note.content}</div>
                    </div>
                  ))}
                </div>
              )}

              {canArchive && (
                <button
                  className="archive-btn"
                  onClick={handleArchive}
                  disabled={archiving}
                >
                  {archiving ? 'Archiving...' : 'Archive Task'}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Tasks Panel ─────────────────────────────────────────────────────

function TasksPanel({ tasks, onTasksChange, peers, rooms, activeRoomId, username }) {
  const [statusFilter, setStatusFilter] = useState('all');
  const [expandedTaskId, setExpandedTaskId] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [newDesc, setNewDesc] = useState('');
  const [newContext, setNewContext] = useState('');
  const [targetAgent, setTargetAgent] = useState('');
  const [targetRoom, setTargetRoom] = useState(activeRoomId || 'general');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState(null);
  const loading = tasks.length === 0 && statusFilter === 'all';

  useEffect(() => {
    if (activeRoomId) setTargetRoom(activeRoomId);
  }, [activeRoomId]);

  const handleArchive = async (taskId) => {
    try {
      await archiveTask(taskId);
      if (onTasksChange) onTasksChange();
      if (expandedTaskId === taskId) setExpandedTaskId(null);
    } catch (err) {
      console.error('Failed to archive task:', err);
    }
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!newDesc.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const filter = targetAgent ? { agentId: targetAgent } : undefined;
      await createTask(targetRoom, newDesc.trim(), newContext.trim() || undefined, filter, username);
      setNewDesc('');
      setNewContext('');
      setTargetAgent('');
      setShowForm(false);
      if (onTasksChange) onTasksChange();
    } catch (err) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  };

  const filtered = statusFilter === 'all'
    ? tasks.filter((t) => t.status !== 'archived')
    : tasks.filter((t) => t.status === statusFilter);

  const statusCounts = {};
  for (const t of tasks) {
    if (t.status !== 'archived') {
      statusCounts[t.status] = (statusCounts[t.status] || 0) + 1;
    }
  }

  return (
    <main className="tasks-panel">
      <div className="tasks-header">
        <div className="tasks-filters">
          <button
            className={`tasks-filter-btn ${statusFilter === 'all' ? 'active' : ''}`}
            onClick={() => setStatusFilter('all')}
          >
            All ({tasks.filter((t) => t.status !== 'archived').length})
          </button>
          {STATUS_ORDER.map((s) => (
            <button
              key={s}
              className={`tasks-filter-btn ${statusFilter === s ? 'active' : ''}`}
              onClick={() => setStatusFilter(s)}
            >
              {STATUS_LABELS[s]} ({statusCounts[s] || 0})
            </button>
          ))}
        </div>
        <button
          className="tasks-add-btn"
          onClick={() => setShowForm(!showForm)}
        >
          {showForm ? 'Cancel' : '+ New Task'}
        </button>
      </div>

      {error && (
        <div className="tasks-error" onClick={() => setError(null)}>
          {error}
        </div>
      )}

      {showForm && (
        <form className="task-form" onSubmit={handleCreate}>
          <textarea
            autoFocus
            value={newDesc}
            onChange={(e) => setNewDesc(e.target.value)}
            placeholder="Task description — what needs to be done..."
            rows={2}
            maxLength={500}
            disabled={creating}
          />
          <textarea
            value={newContext}
            onChange={(e) => setNewContext(e.target.value)}
            placeholder="Context (optional) — background, constraints, details..."
            rows={2}
            maxLength={2000}
            disabled={creating}
          />
          <div className="task-form-row">
            <select
              value={targetRoom}
              onChange={(e) => setTargetRoom(e.target.value)}
              disabled={creating}
            >
              {rooms.map((r) => (
                <option key={r.id} value={r.id}>#{r.name}</option>
              ))}
            </select>
            <select
              value={targetAgent}
              onChange={(e) => setTargetAgent(e.target.value)}
              disabled={creating}
            >
              <option value="">Any agent</option>
              {peers.map((p) => (
                <option key={p.peerId} value={p.peerId}>
                  {p.name} ({p.status})
                </option>
              ))}
            </select>
            <button type="submit" disabled={!newDesc.trim() || creating}>
              {creating ? 'Creating...' : 'Delegate Task'}
            </button>
          </div>
        </form>
      )}

      <div className="tasks-list">
        {loading && tasks.length === 0 && (
          <div className="tasks-empty">Loading tasks...</div>
        )}
        {!loading && filtered.length === 0 && (
          <div className="tasks-empty">No tasks{statusFilter !== 'all' ? ` with status "${STATUS_LABELS[statusFilter]}"` : ''}</div>
        )}
        {filtered.map((task) => (
          <TaskCard
            key={task.taskId}
            task={task}
            expanded={expandedTaskId === task.taskId}
            onExpand={setExpandedTaskId}
            onArchive={handleArchive}
          />
        ))}
      </div>
    </main>
  );
}

// ── Instances Panel ───────────────────────────────────────────────────

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

// ── Permission Popup ─────────────────────────────────────────────────

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

// ── Main App ────────────────────────────────────────────────────────

export default function App() {
  const [username, setUsername] = useState(() => localStorage.getItem('crosschat-username') || '');
  const [rooms, setRooms] = useState([]);
  const [activeRoomId, setActiveRoomId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [events, setEvents] = useState([]);
  const [peers, setPeers] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [error, setError] = useState(null);
  const [activeTab, setActiveTab] = useState('chat');
  const [replyTarget, setReplyTarget] = useState(null);
  const [permissions, setPermissions] = useState([]);

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

    // Task events — update in-place for real-time dashboard
    if (data.type === 'task.created') {
      setTasks((prev) => {
        if (prev.some((t) => t.taskId === data.task.taskId)) return prev;
        return [data.task, ...prev];
      });
      return;
    }
    if (data.type === 'task.claimed') {
      setTasks((prev) => prev.map((t) =>
        t.taskId === data.taskId ? { ...t, status: 'claimed', claimantId: data.claimantId, claimantName: data.claimantName } : t
      ));
      return;
    }
    if (data.type === 'task.claimAccepted') {
      setTasks((prev) => prev.map((t) =>
        t.taskId === data.taskId ? { ...t, status: 'in_progress' } : t
      ));
      return;
    }
    if (data.type === 'task.updated') {
      setTasks((prev) => prev.map((t) =>
        t.taskId === data.taskId ? { ...t, updatedAt: data.note?.timestamp || new Date().toISOString() } : t
      ));
      return;
    }
    if (data.type === 'task.completed') {
      setTasks((prev) => prev.map((t) =>
        t.taskId === data.taskId ? { ...t, status: data.status, result: data.result } : t
      ));
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

  const handleWsReconnect = useCallback(() => {
    // Re-fetch all state on WebSocket reconnect to clear stale data
    fetchPeers().then(setPeers).catch(() => {});
    fetchTasks().then(setTasks).catch(() => {});
    fetchPermissions().then(setPermissions).catch(() => {});
  }, []);

  const { send: wsSend, sessionToken } = useWebSocket(handleWsMessage, handleWsReconnect);

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

    // Initial fetch for peers, tasks, and permissions — then rely on WebSocket events
    fetchPeers().then(setPeers).catch(() => {});
    fetchTasks().then(setTasks).catch(() => {});
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
      <PermissionPopups permissions={permissions} onDecide={handlePermissionDecide} />
      {error && (
        <div className="error-banner" onClick={() => setError(null)}>
          {error} (click to dismiss)
        </div>
      )}
      <Sidebar
        rooms={rooms}
        activeRoomId={activeRoomId}
        onSelectRoom={(id) => { setActiveRoomId(id); setActiveTab('chat'); }}
        onCreateRoom={handleCreateRoom}
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
              Chat{activeRoom ? ` — #${activeRoom.name}` : ''}
            </button>
            <button
              className={`tab-item ${activeTab === 'tasks' ? 'active' : ''}`}
              onClick={() => setActiveTab('tasks')}
            >
              Tasks
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
            room={activeRoom}
            messages={messages}
            username={username}
            onSendMessage={handleSendMessage}
            events={events}
            replyTarget={replyTarget}
            onClearReply={() => setReplyTarget(null)}
            peers={peers}
          />
        ) : activeTab === 'tasks' ? (
          <TasksPanel
            tasks={tasks}
            onTasksChange={() => fetchTasks().then(setTasks).catch(() => {})}
            peers={peers}
            rooms={rooms}
            activeRoomId={activeRoomId}
            username={username}
          />
        ) : (
          <InstancesPanel peers={peers} />
        )}
      </div>
    </div>
  );
}
