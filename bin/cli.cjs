#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const os = require("os");

const pkg = require("../package.json");

const SETTINGS_GLOBAL = path.join(os.homedir(), ".claude", "settings.json");
const COMMANDS_DIR = path.join(os.homedir(), ".claude", "commands");
const COMMAND_SOURCE = path.join(__dirname, "..", "crosschat.md");
const COMMAND_TARGET = path.join(COMMANDS_DIR, "crosschat.md");
const MCP_KEY = "crosschat";

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

  // 1. Install MCP server config
  const targetPath = getTargetSettingsPath();
  const settings = readSettings(targetPath);

  if (!settings.mcpServers) {
    settings.mcpServers = {};
  }

  const isUpdate = !!settings.mcpServers[MCP_KEY];

  if (serverEntry) {
    // Direct path — works for global installs and local dev
    settings.mcpServers[MCP_KEY] = {
      command: "node",
      args: [serverEntry],
    };
  } else {
    // Fallback to npx — works when installed via npx
    settings.mcpServers[MCP_KEY] = {
      command: "npx",
      args: ["-y", "@studiomopoke/crosschat", "serve"],
    };
  }

  writeSettings(targetPath, settings);

  // 2. Install /crosschat command
  ensureDir(COMMANDS_DIR);
  fs.copyFileSync(COMMAND_SOURCE, COMMAND_TARGET);

  if (isUpdate) {
    console.log("Updated CrossChat in " + targetPath);
  } else {
    console.log("Installed CrossChat to " + targetPath);
  }

  console.log("Installed /crosschat command to " + COMMAND_TARGET);
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
  // 1. Remove MCP server config
  const targetPath = getTargetSettingsPath();
  const settings = readSettings(targetPath);
  let removedConfig = false;

  if (settings.mcpServers && settings.mcpServers[MCP_KEY]) {
    delete settings.mcpServers[MCP_KEY];
    if (Object.keys(settings.mcpServers).length === 0) {
      delete settings.mcpServers;
    }
    writeSettings(targetPath, settings);
    console.log("Removed CrossChat MCP server from " + targetPath);
    removedConfig = true;
  }

  // 2. Remove /crosschat command
  let removedCommand = false;
  if (fs.existsSync(COMMAND_TARGET)) {
    fs.unlinkSync(COMMAND_TARGET);
    console.log("Removed /crosschat command from " + COMMAND_TARGET);
    removedCommand = true;
  }

  if (!removedConfig && !removedCommand) {
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

function status() {
  const globalSettings = readSettings(SETTINGS_GLOBAL);
  const globalConfigured = !!(
    globalSettings.mcpServers && globalSettings.mcpServers[MCP_KEY]
  );

  const projectPath = path.join(process.cwd(), ".claude", "settings.json");
  const projectSettings = readSettings(projectPath);
  const projectConfigured = !!(
    projectSettings.mcpServers && projectSettings.mcpServers[MCP_KEY]
  );

  const commandInstalled = fs.existsSync(COMMAND_TARGET);

  console.log("CrossChat v" + pkg.version);
  console.log("");
  console.log(
    "MCP server:     " +
      (globalConfigured || projectConfigured ? "installed" : "not installed")
  );
  console.log(
    "/crosschat cmd: " + (commandInstalled ? "installed" : "not installed")
  );

  // Check for active peers
  const peersDir = path.join(os.homedir(), ".crosschat", "peers");
  if (fs.existsSync(peersDir)) {
    const files = fs
      .readdirSync(peersDir)
      .filter((f) => f.endsWith(".json"));
    if (files.length > 0) {
      console.log("");
      console.log("Active peers:");
      for (const file of files) {
        try {
          const entry = JSON.parse(
            fs.readFileSync(path.join(peersDir, file), "utf8")
          );
          const peerStatus = entry.status || "available";
          const detail = entry.statusDetail
            ? " (" + entry.statusDetail + ")"
            : "";
          const cwd =
            entry.metadata && entry.metadata.cwd
              ? " — " + entry.metadata.cwd
              : "";
          console.log(
            "  " + entry.name + " [" + peerStatus + detail + "]" + cwd
          );
        } catch {
          // skip malformed
        }
      }
    } else {
      console.log("");
      console.log("No active peers.");
    }
  }
}

function getTargetSettingsPath() {
  const localFlag = process.argv.indexOf("--project");
  if (localFlag !== -1) {
    return path.join(process.cwd(), ".claude", "settings.json");
  }
  return SETTINGS_GLOBAL;
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
