#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const os = require("os");

const pkg = require("../package.json");

const SETTINGS_GLOBAL = path.join(os.homedir(), ".claude", "settings.json");
const SERVER_ENTRY = path.join(__dirname, "..", "dist", "index.js");
const MCP_KEY = "crosschat";

const command = process.argv[2];

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
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(settings, null, 2) + "\n", "utf8");
}

function install() {
  // Check dist/index.js exists
  if (!fs.existsSync(SERVER_ENTRY)) {
    console.error("Error: dist/index.js not found. Run 'npm run build' first.");
    process.exit(1);
  }

  const targetPath = getTargetSettingsPath();
  const settings = readSettings(targetPath);

  if (!settings.mcpServers) {
    settings.mcpServers = {};
  }

  const isUpdate = !!settings.mcpServers[MCP_KEY];
  settings.mcpServers[MCP_KEY] = {
    command: "node",
    args: [SERVER_ENTRY],
  };
  writeSettings(targetPath, settings);

  if (isUpdate) {
    console.log("Updated CrossChat MCP server in " + targetPath);
  } else {
    console.log("Installed CrossChat MCP server to " + targetPath);
  }

  console.log("");
  console.log("  Server: " + SERVER_ENTRY);
  console.log("");
  console.log(
    "Each instance auto-names itself from its working directory (e.g., my-project-a1b2)."
  );
  console.log(
    "To override, set CROSSCHAT_NAME in the env block of your MCP config."
  );
  console.log("");
  console.log("Restart Claude Code, then tell Claude:");
  console.log('  "Start CrossChat as orchestrator"');
  console.log('  "Start CrossChat as peer"');
}

function uninstall() {
  const targetPath = getTargetSettingsPath();
  const settings = readSettings(targetPath);

  if (!settings.mcpServers || !settings.mcpServers[MCP_KEY]) {
    console.log("CrossChat is not configured — nothing to remove.");
    return;
  }

  delete settings.mcpServers[MCP_KEY];

  // Clean up empty mcpServers object
  if (Object.keys(settings.mcpServers).length === 0) {
    delete settings.mcpServers;
  }

  writeSettings(targetPath, settings);
  console.log("Removed CrossChat MCP server from " + targetPath);
}

function status() {
  const globalSettings = readSettings(SETTINGS_GLOBAL);
  const globalConfigured = !!(
    globalSettings.mcpServers && globalSettings.mcpServers[MCP_KEY]
  );

  // Check for project-level config
  const projectPath = path.join(process.cwd(), ".claude", "settings.json");
  const projectSettings = readSettings(projectPath);
  const projectConfigured = !!(
    projectSettings.mcpServers && projectSettings.mcpServers[MCP_KEY]
  );

  console.log("CrossChat v" + pkg.version);
  console.log("");
  console.log(
    "Global config:  " + (globalConfigured ? "installed" : "not installed")
  );
  if (globalConfigured) {
    const entry = globalSettings.mcpServers[MCP_KEY];
    console.log("  Server: " + (entry.args ? entry.args[0] : "unknown"));
  }

  console.log(
    "Project config: " + (projectConfigured ? "installed" : "not installed")
  );
  if (projectConfigured) {
    const entry = projectSettings.mcpServers[MCP_KEY];
    console.log("  Server: " + (entry.args ? entry.args[0] : "unknown"));
  }

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
          const cwd = entry.metadata && entry.metadata.cwd
            ? " — " + entry.metadata.cwd
            : "";
          console.log(
            "  " +
              entry.name +
              " [" +
              peerStatus +
              detail +
              "]" +
              cwd
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
  console.log("  crosschat install [--project]   Install MCP server config");
  console.log("  crosschat uninstall [--project]  Remove MCP server config");
  console.log("  crosschat status                 Show config and active peers");
  console.log("  crosschat --version              Show version");
  console.log("  crosschat --help                 Show this help");
  console.log("");
  console.log("Options:");
  console.log(
    "  --project   Use project-level settings (.claude/settings.json in cwd)"
  );
  console.log("              Default: global (~/.claude/settings.json)");
  console.log("");
  console.log("Instances auto-name from their working directory at runtime.");
  console.log(
    "To override, set CROSSCHAT_NAME in the env block of your MCP config."
  );
  console.log("");
  console.log("Examples:");
  console.log("  crosschat install");
  console.log("  crosschat install --project");
  console.log("  crosschat status");
  console.log("  crosschat uninstall");
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
