import { cpSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { App, type AppConfig } from "./app";
import { createLogger, initLogger } from "./logger";
import { migrateSessionFromSettings } from "./sessions";
import { applyEnvOverrides, loadSettings, printSettings } from "./settings";

await initLogger();
const log = createLogger("index");

const defaultDir = resolve(process.env.HOME || "~", ".macroclaw");

// Migrate sessionId from old settings.json to sessions.json
migrateSessionFromSettings(defaultDir);

let settings = loadSettings(defaultDir);

if (!settings) {
  // TODO: setup wizard (commit 4)
  log.error("No settings.json found. Run the setup wizard first.");
  process.exit(1);
}

const { settings: resolved, overrides } = applyEnvOverrides(settings);
settings = resolved;

printSettings(settings, overrides);

const workspace = resolve(settings.workspace.replace(/^~/, process.env.HOME || "~"));

function initWorkspace(workspace: string) {
  const templateDir = join(dirname(import.meta.dir), "workspace-template");
  const exists = existsSync(workspace);
  const empty = exists && readdirSync(workspace).length === 0;

  if (!exists || empty) {
    log.info({ workspace }, "Initializing workspace from template");
    cpSync(templateDir, workspace, { recursive: true });
    log.info("Workspace initialized");
  }
}

initWorkspace(workspace);

const config: AppConfig = {
  botToken: settings.botToken,
  authorizedChatId: settings.chatId,
  workspace,
  model: settings.model,
};

new App(config).start();
