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
];

const command = process.argv[2];

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

function resolveServerEntry() {
  // Try to find the server in common locations
  const candidates = [
    // Global install
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
  const serverEntry = resolveServerEntry();

  // 1. Install MCP server config to ~/.claude.json
  const claudeJson = readSettings(CLAUDE_JSON);

  if (!claudeJson.mcpServers) {
    claudeJson.mcpServers = {};
  }

  const isUpdate = !!claudeJson.mcpServers[MCP_KEY];

  if (serverEntry) {
    // Direct path — works for global installs and local dev
    claudeJson.mcpServers[MCP_KEY] = {
      command: "node",
      args: [serverEntry],
    };
  } else {
    // Fallback to npx — works when installed via npx
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
  // 2b. Add permission hook to settings (PreToolUse)
  if (fs.existsSync(HOOK_SOURCE)) {
    if (!settings.hooks) settings.hooks = {};
    if (!settings.hooks.PreToolUse) settings.hooks.PreToolUse = [];

    const hookCommand = HOOK_SOURCE;
    const alreadyInstalled = settings.hooks.PreToolUse.some((entry) =>
      entry.hooks &&
      entry.hooks.some((h) => h.command && h.command.includes("permission-hook.sh"))
    );

    if (!alreadyInstalled) {
      settings.hooks.PreToolUse.push({
        matcher: "",
        hooks: [
          {
            type: "command",
            command: hookCommand,
            timeout: 300,
          },
        ],
      });
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
  if (serverEntry) {
    console.log("  MCP server: " + serverEntry);
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

  console.log("CrossChat v" + pkg.version);
  console.log("");
  console.log("MCP server:     " + (mcpConfigured ? "installed" : "not installed"));
  console.log("/crosschat cmd: " + (commandInstalled ? "installed" : "not installed"));

  // Read dashboard.lock to find the hub port
  const lockFile = path.join(os.homedir(), ".crosschat", "dashboard.lock");
  let hubPort = null;
  if (fs.existsSync(lockFile)) {
    try {
      const lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
      hubPort = lock.port;
    } catch {
      // malformed lock file
    }
  }

  if (!hubPort) {
    console.log("Hub:            not running");
    return;
  }

  console.log("Hub:            running on port " + hubPort);
  console.log("Dashboard:      http://localhost:" + hubPort);

  // Query the hub for active peers
  try {
    const http = require("http");
    const data = await new Promise((resolve, reject) => {
      const req = http.get(
        "http://localhost:" + hubPort + "/api/peers",
        (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => {
            try {
              resolve(JSON.parse(body));
            } catch {
              reject(new Error("Invalid JSON response"));
            }
          });
        }
      );
      req.on("error", reject);
      req.setTimeout(3000, () => {
        req.destroy();
        reject(new Error("Timeout"));
      });
    });

    const peers = Array.isArray(data) ? data : [];
    if (peers.length > 0) {
      console.log("");
      console.log("Active peers:");
      for (const peer of peers) {
        const peerStatus = peer.status || "available";
        const detail = peer.statusDetail
          ? " (" + peer.statusDetail + ")"
          : "";
        const room = peer.currentRoom
          ? " [room: " + peer.currentRoom + "]"
          : "";
        const cwd = peer.cwd ? " — " + peer.cwd : "";
        console.log(
          "  " + peer.name + " [" + peerStatus + detail + "]" + room + cwd
        );
      }
    } else {
      console.log("");
      console.log("No active peers.");
    }
  } catch {
    console.log("");
    console.log("Hub not responding (port " + hubPort + ").");
  }
}

function showHelp() {
  console.log("CrossChat v" + pkg.version);
  console.log("MCP server for inter-instance Claude Code communication");
  console.log("");
  console.log("Usage:");
  console.log(
    "  crosschat install [--project]   Install MCP server + /crosschat command"
  );
  console.log("  crosschat uninstall [--project]  Remove everything");
  console.log(
    "  crosschat status                 Show config and active peers"
  );
  console.log("  crosschat --version              Show version");
  console.log("  crosschat --help                 Show this help");
  console.log("");
  console.log(
    "After installing, restart Claude Code and run /crosschat to start."
  );
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
  case "status":
    status();
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
