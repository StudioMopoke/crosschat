#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const os = require("os");

const pkg = require("../package.json");

const CLAUDE_JSON = path.join(os.homedir(), ".claude.json");
const SETTINGS_JSON = path.join(os.homedir(), ".claude", "settings.json");
const COMMANDS_DIR = path.join(os.homedir(), ".claude", "commands");
const COMMAND_SOURCE = path.join(__dirname, "..", "crosschat.md");
const COMMAND_TARGET = path.join(COMMANDS_DIR, "crosschat.md");
const HOOK_SOURCE = path.join(__dirname, "..", "hooks", "permission-hook.sh");
const MCP_KEY = "crosschat";

const CROSSCHAT_PERMISSIONS = [
  "mcp__crosschat__wait_for_messages",
  "mcp__crosschat__get_messages",
  "mcp__crosschat__list_peers",
  "mcp__crosschat__send_message",
  "mcp__crosschat__set_status",
  "mcp__crosschat__complete_task",
  "mcp__crosschat__delegate_task",
  "mcp__crosschat__get_task_status",
  "mcp__crosschat__join_room",
  "mcp__crosschat__create_room",
  "mcp__crosschat__claim_task",
  "mcp__crosschat__accept_claim",
  "mcp__crosschat__update_task",
  "mcp__crosschat__list_tasks",
  "mcp__crosschat__clear_session",
  "mcp__crosschat__get_room_digest",
  "mcp__crosschat__request_digest",
];

const { spawn } = require("child_process");

const command = process.argv[2];
const subcommand = process.argv[3];

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readSettings(filePath) {
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return {};
  }
}

function writeSettings(filePath, settings) {
  const dir = path.dirname(filePath);
  ensureDir(dir);
  fs.writeFileSync(filePath, JSON.stringify(settings, null, 2) + "\n", "utf8");
}

function findGlobalBinary() {
  // Check if `crosschat` is available in PATH (from npm install -g)
  const { execFileSync } = require("child_process");
  try {
    const binPath = execFileSync("which", ["crosschat"], { encoding: "utf8" }).trim();
    if (binPath && fs.existsSync(binPath)) {
      return binPath;
    }
  } catch {
    // Not in PATH
  }
  return null;
}

function resolveServerEntry() {
  // Try to find the server in common locations
  const candidates = [
    // Relative to this CLI script (works for global install and local dev)
    path.join(__dirname, "..", "dist", "index.js"),
    // npm root -g based
    path.join(
      process.env.npm_config_prefix || "/usr/local",
      "lib",
      "node_modules",
      "@studiomopoke",
      "crosschat",
      "dist",
      "index.js"
    ),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function install() {
  // 1. Install MCP server config to ~/.claude.json
  const claudeJson = readSettings(CLAUDE_JSON);

  if (!claudeJson.mcpServers) {
    claudeJson.mcpServers = {};
  }

  const isUpdate = !!claudeJson.mcpServers[MCP_KEY];

  // Prefer the global binary (resolves via PATH, so upgrades take effect
  // automatically). Fall back to npx for non-global installs.
  const globalBin = findGlobalBinary();

  if (globalBin) {
    claudeJson.mcpServers[MCP_KEY] = {
      command: "crosschat",
      args: ["serve"],
    };
  } else {
    // Fallback to npx — always pulls the latest version
    claudeJson.mcpServers[MCP_KEY] = {
      command: "npx",
      args: ["-y", "@studiomopoke/crosschat", "serve"],
    };
  }

  writeSettings(CLAUDE_JSON, claudeJson);

  // 2. Add CrossChat tool permissions to ~/.claude/settings.json
  const settings = readSettings(SETTINGS_JSON);
  if (!settings.permissions) settings.permissions = {};
  if (!settings.permissions.allow) settings.permissions.allow = [];
  const existingPerms = new Set(settings.permissions.allow);
  let addedPerms = 0;
  for (const perm of CROSSCHAT_PERMISSIONS) {
    if (!existingPerms.has(perm)) {
      settings.permissions.allow.push(perm);
      addedPerms++;
    }
  }
  // 2b. Add or update permission hook in settings (PreToolUse)
  if (fs.existsSync(HOOK_SOURCE)) {
    if (!settings.hooks) settings.hooks = {};
    if (!settings.hooks.PreToolUse) settings.hooks.PreToolUse = [];

    const hookCommand = HOOK_SOURCE;
    const existingIdx = settings.hooks.PreToolUse.findIndex((entry) =>
      entry.hooks &&
      entry.hooks.some((h) => h.command && h.command.includes("permission-hook.sh"))
    );

    const hookEntry = {
      matcher: "",
      hooks: [
        {
          type: "command",
          command: hookCommand,
          timeout: 300,
        },
      ],
    };

    if (existingIdx >= 0) {
      // Update the path in case it points to a stale installation
      settings.hooks.PreToolUse[existingIdx] = hookEntry;
    } else {
      settings.hooks.PreToolUse.push(hookEntry);
    }
  }

  if (addedPerms > 0 || fs.existsSync(HOOK_SOURCE)) {
    writeSettings(SETTINGS_JSON, settings);
  }

  // 3. Install /crosschat command
  ensureDir(COMMANDS_DIR);
  fs.copyFileSync(COMMAND_SOURCE, COMMAND_TARGET);

  if (isUpdate) {
    console.log("Updated CrossChat in " + CLAUDE_JSON);
  } else {
    console.log("Installed CrossChat MCP server to " + CLAUDE_JSON);
  }

  console.log("Installed /crosschat command to " + COMMAND_TARGET);
  if (fs.existsSync(HOOK_SOURCE)) {
    console.log("Installed permission hook (PreToolUse → dashboard)");
  }
  console.log("");
  if (globalBin) {
    console.log("  MCP server: crosschat serve (global binary)");
  } else {
    console.log("  MCP server: via npx @studiomopoke/crosschat serve");
  }
  console.log("");
  console.log("Restart Claude Code, then run /crosschat to start collaborating.");
}

function uninstall() {
  let removedAnything = false;

  // 1. Remove MCP server config from ~/.claude.json
  const claudeJson = readSettings(CLAUDE_JSON);
  if (claudeJson.mcpServers && claudeJson.mcpServers[MCP_KEY]) {
    delete claudeJson.mcpServers[MCP_KEY];
    if (Object.keys(claudeJson.mcpServers).length === 0) {
      delete claudeJson.mcpServers;
    }
    writeSettings(CLAUDE_JSON, claudeJson);
    console.log("Removed CrossChat MCP server from " + CLAUDE_JSON);
    removedAnything = true;
  }

  // 2. Remove permission hook from settings
  const settings = readSettings(SETTINGS_JSON);
  if (settings.hooks && settings.hooks.PreToolUse) {
    const before = settings.hooks.PreToolUse.length;
    settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter((entry) =>
      !(entry.hooks && entry.hooks.some((h) => h.command && h.command.includes("permission-hook.sh")))
    );
    if (settings.hooks.PreToolUse.length < before) {
      if (settings.hooks.PreToolUse.length === 0) delete settings.hooks.PreToolUse;
      if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
      writeSettings(SETTINGS_JSON, settings);
      console.log("Removed permission hook from " + SETTINGS_JSON);
      removedAnything = true;
    }
  }

  // 3. Remove /crosschat command
  if (fs.existsSync(COMMAND_TARGET)) {
    fs.unlinkSync(COMMAND_TARGET);
    console.log("Removed /crosschat command");
    removedAnything = true;
  }

  if (!removedAnything) {
    console.log("CrossChat is not installed — nothing to remove.");
  }
}

function serve() {
  // MCP server entry point — used when config calls `npx crosschat serve`
  const serverPath = path.join(__dirname, "..", "dist", "index.js");
  if (!fs.existsSync(serverPath)) {
    console.error("Error: dist/index.js not found.");
    process.exit(1);
  }

  // If a hub is already running, stop it first (prevents stale code issues)
  const lock = readLockFile();
  if (lock && lock.pid) {
    let isRunning = false;
    try { process.kill(lock.pid, 0); isRunning = true; } catch {}

    if (isRunning) {
      const staleVersion = lock.version && lock.version !== pkg.version;
      if (staleVersion) {
        console.log("Stopping stale hub (v" + lock.version + " → v" + pkg.version + ", PID " + lock.pid + ")...");
      } else {
        console.log("Stopping existing hub (PID " + lock.pid + ")...");
      }
      stop();
    } else {
      // Stale lock file — clean it up
      const lockFile = path.join(os.homedir(), ".crosschat", "dashboard.lock");
      try { fs.unlinkSync(lockFile); } catch {}
    }
  }

  // Dynamic import of ESM module
  import(
    "file://" + serverPath
  ).catch((err) => {
    console.error("Failed to start CrossChat server:", err.message);
    process.exit(1);
  });
}

async function status() {
  const claudeJson = readSettings(CLAUDE_JSON);
  const mcpConfigured = !!(
    claudeJson.mcpServers && claudeJson.mcpServers[MCP_KEY]
  );
  const commandInstalled = fs.existsSync(COMMAND_TARGET);
  const lock = readLockFile();
  const hubPort = getHubPort();

  console.log("CrossChat v" + pkg.version);
  console.log("");
  console.log("MCP server:     " + (mcpConfigured ? "installed" : "not installed"));
  console.log("/crosschat cmd: " + (commandInstalled ? "installed" : "not installed"));

  if (!hubPort) {
    console.log("Hub:            not running");
    return;
  }

  console.log("Hub:            running on port " + hubPort + " (PID " + lock.pid + ")");
  console.log("Dashboard:      http://localhost:" + hubPort);

  try {
    const [peerList, taskList, roomList] = await Promise.all([
      hubGet(hubPort, "/api/peers"),
      hubGet(hubPort, "/api/tasks"),
      hubGet(hubPort, "/api/rooms"),
    ]);

    const peers = Array.isArray(peerList) ? peerList : [];
    const tasks = Array.isArray(taskList) ? taskList : [];
    const roomArr = Array.isArray(roomList) ? roomList : [];

    console.log("");
    console.log("Agents:         " + peers.length + " connected");
    for (const p of peers) {
      const badge = p.status === "busy" ? "[busy]" : "[avail]";
      console.log("  " + badge + " " + p.name + " — " + (p.cwd || "?"));
    }

    if (tasks.length > 0) {
      const byStatus = {};
      for (const t of tasks) {
        byStatus[t.status] = (byStatus[t.status] || 0) + 1;
      }
      const summary = Object.entries(byStatus).map(([k, v]) => v + " " + k).join(", ");
      console.log("Tasks:          " + tasks.length + " (" + summary + ")");
    }

    console.log("Rooms:          " + roomArr.length);
  } catch {
    console.log("");
    console.log("Hub not responding (port " + hubPort + ").");
  }
}

function readLockFile() {
  const lockFile = path.join(os.homedir(), ".crosschat", "dashboard.lock");
  if (!fs.existsSync(lockFile)) return null;
  try {
    return JSON.parse(fs.readFileSync(lockFile, "utf8"));
  } catch {
    return null;
  }
}

function getHubPort() {
  const lock = readLockFile();
  if (!lock || !lock.port) return null;
  // Verify the process is actually running
  if (lock.pid) {
    try { process.kill(lock.pid, 0); } catch { return null; }
  }
  return lock.port;
}

function hubGet(port, apiPath) {
  const http = require("http");
  return new Promise((resolve, reject) => {
    const req = http.get("http://localhost:" + port + apiPath, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error("Invalid JSON from hub")); }
      });
    });
    req.on("error", reject);
    req.setTimeout(3000, () => { req.destroy(); reject(new Error("Timeout")); });
  });
}

function requireHub() {
  const port = getHubPort();
  if (!port) {
    console.error("Hub is not running. Start it with: crosschat start");
    process.exit(1);
  }
  return port;
}

function timeAgo(isoDate) {
  const seconds = Math.floor((Date.now() - new Date(isoDate).getTime()) / 1000);
  if (seconds < 60) return seconds + "s ago";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + "m ago";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + "h ago";
  return Math.floor(hours / 24) + "d ago";
}

async function start() {
  const existingPort = getHubPort();
  if (existingPort) {
    console.log("Hub already running on port " + existingPort);
    console.log("Dashboard: http://localhost:" + existingPort);
    return;
  }

  // Clean up stale lock file if present
  const lockFile = path.join(os.homedir(), ".crosschat", "dashboard.lock");
  try { fs.unlinkSync(lockFile); } catch {}

  // Resolve hub-main.js
  const candidates = [
    path.join(__dirname, "..", "dist", "hub", "hub-main.js"),
    path.join(__dirname, "hub", "hub-main.js"),
  ];
  let hubPath = null;
  for (const c of candidates) {
    if (fs.existsSync(c)) { hubPath = c; break; }
  }
  if (!hubPath) {
    console.error("Error: hub-main.js not found. Is crosschat built?");
    process.exit(1);
  }

  console.log("Starting hub...");
  const child = spawn(process.execPath, [hubPath], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
  });
  child.unref();

  // Wait for lock file to appear (up to 10s)
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    const lock = readLockFile();
    if (lock && lock.port) {
      console.log("Hub started on port " + lock.port + " (PID " + lock.pid + ")");
      console.log("Dashboard: http://localhost:" + lock.port);
      return;
    }
  }
  console.error("Hub did not start within 10 seconds. Check ~/.crosschat/ for errors.");
  process.exit(1);
}

async function peers() {
  const port = requireHub();
  const data = await hubGet(port, "/api/peers");
  const peerList = Array.isArray(data) ? data : [];

  if (peerList.length === 0) {
    console.log("No connected agents.");
    return;
  }

  console.log("Connected agents (" + peerList.length + "):\n");
  for (const p of peerList) {
    const badge = p.status === "busy" ? "[busy]" : "[available]";
    const detail = p.statusDetail ? " " + p.statusDetail : "";
    console.log("  " + p.name + "  " + badge + detail);
    console.log("    ID:        " + p.peerId);
    console.log("    Room:      " + (p.currentRoom || "—"));
    console.log("    Directory: " + (p.cwd || "—"));
    console.log("    Connected: " + (p.connectedAt ? timeAgo(p.connectedAt) : "—"));
    console.log("");
  }
}

async function tasks() {
  const port = requireHub();
  const filter = subcommand ? "?status=" + subcommand : "";
  const data = await hubGet(port, "/api/tasks" + filter);
  const taskList = Array.isArray(data) ? data : [];

  if (taskList.length === 0) {
    console.log("No tasks" + (subcommand ? " with status '" + subcommand + "'" : "") + ".");
    return;
  }

  console.log("Tasks (" + taskList.length + "):\n");
  for (const t of taskList) {
    const statusTag = {
      open: "OPEN",
      claimed: "CLAIMED",
      in_progress: "IN PROGRESS",
      completed: "DONE",
      failed: "FAILED",
    }[t.status] || t.status.toUpperCase();
    console.log("  [" + statusTag + "] " + t.description);
    console.log("    ID:       " + t.taskId);
    console.log("    Room:     " + (t.roomId || "—"));
    console.log("    Creator:  " + (t.creatorName || "—"));
    if (t.claimantName) {
      console.log("    Assignee: " + t.claimantName);
    }
    console.log("    Created:  " + (t.createdAt ? timeAgo(t.createdAt) : "—"));
    if (t.result) {
      console.log("    Result:   " + t.result.split("\n")[0]);
    }
    console.log("");
  }
}

async function rooms() {
  const port = requireHub();
  const [roomData, peerData] = await Promise.all([
    hubGet(port, "/api/rooms"),
    hubGet(port, "/api/peers"),
  ]);
  const roomList = Array.isArray(roomData) ? roomData : [];
  const peerList = Array.isArray(peerData) ? peerData : [];

  if (roomList.length === 0) {
    console.log("No active rooms.");
    return;
  }

  // Count peers per room
  const peersPerRoom = {};
  for (const p of peerList) {
    const room = p.currentRoom || "general";
    if (!peersPerRoom[room]) peersPerRoom[room] = [];
    peersPerRoom[room].push(p.name);
  }

  console.log("Rooms (" + roomList.length + "):\n");
  for (const r of roomList) {
    const name = r.name || r.id;
    const msgCount = r.messageCount != null ? r.messageCount : "?";
    const roomPeers = peersPerRoom[name] || peersPerRoom[r.id] || [];
    console.log("  " + name);
    console.log("    Messages: " + msgCount + "  Agents: " + roomPeers.length);
    if (roomPeers.length > 0) {
      console.log("    " + roomPeers.join(", "));
    }
    console.log("");
  }
}

function stop() {
  const lock = readLockFile();
  if (!lock || !lock.pid) {
    console.log("No running hub found (no dashboard.lock).");
    return false;
  }

  try {
    // Check if process is still running
    process.kill(lock.pid, 0);
  } catch {
    console.log("Hub process " + lock.pid + " is not running (stale lock file).");
    // Clean up stale lock file
    const lockFile = path.join(os.homedir(), ".crosschat", "dashboard.lock");
    try { fs.unlinkSync(lockFile); } catch {}
    return false;
  }

  console.log("Stopping hub (PID " + lock.pid + ", port " + lock.port + ")...");
  process.kill(lock.pid, "SIGTERM");

  // Wait for process to exit (up to 5 seconds)
  const start = Date.now();
  while (Date.now() - start < 5000) {
    try {
      process.kill(lock.pid, 0);
      // Still running, wait a bit
      const waitUntil = Date.now() + 100;
      while (Date.now() < waitUntil) {} // busy-wait (sync)
    } catch {
      console.log("Hub stopped.");
      return true;
    }
  }

  console.log("Hub did not stop in time — sending SIGKILL...");
  try { process.kill(lock.pid, "SIGKILL"); } catch {}
  console.log("Hub killed.");
  return true;
}

function showHelp() {
  console.log("CrossChat v" + pkg.version);
  console.log("MCP server for inter-instance Claude Code communication");
  console.log("");
  console.log("Setup:");
  console.log("  crosschat install              Install MCP server + /crosschat command");
  console.log("  crosschat uninstall            Remove everything");
  console.log("");
  console.log("Server:");
  console.log("  crosschat start                Start the hub server");
  console.log("  crosschat stop                 Stop the hub server");
  console.log("  crosschat restart              Restart the hub server");
  console.log("");
  console.log("Info:");
  console.log("  crosschat status               Overview of hub, agents, tasks, rooms");
  console.log("  crosschat peers                List connected agents with details");
  console.log("  crosschat tasks [status]       List tasks (optional: open, claimed, completed, failed)");
  console.log("  crosschat rooms                List active rooms");
  console.log("");
  console.log("  crosschat --version            Show version");
  console.log("  crosschat --help               Show this help");
  console.log("");
  console.log("After installing, restart Claude Code and run /crosschat to start.");
}

switch (command) {
  case "install":
  case "update":
    install();
    break;
  case "uninstall":
  case "remove":
    uninstall();
    break;
  case "serve":
    serve();
    break;
  case "start":
    start();
    break;
  case "stop":
    stop();
    break;
  case "restart":
    stop();
    // Give the OS a moment to release the port
    setTimeout(() => start(), 500);
    break;
  case "status":
    status();
    break;
  case "peers":
  case "agents":
    peers();
    break;
  case "tasks":
    tasks();
    break;
  case "rooms":
    rooms();
    break;
  case "--version":
  case "-v":
    console.log(pkg.version);
    break;
  case "--help":
  case "-h":
  case undefined:
    showHelp();
    break;
  default:
    console.error("Unknown command: " + command);
    console.error('Run "crosschat --help" for usage.');
    process.exit(1);
}
