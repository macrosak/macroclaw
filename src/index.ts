import { cpSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { App, type AppConfig } from "./app";
import { createLogger, initLogger } from "./logger";
import { migrateSessionFromSettings } from "./sessions";
import { applyEnvOverrides, loadSettings, printSettings, saveSettings } from "./settings";
import { runSetupWizard } from "./setup";

await initLogger();
const log = createLogger("index");

const defaultDir = resolve(process.env.HOME || "~", ".macroclaw");

// Migrate sessionId from old settings.json to sessions.json
migrateSessionFromSettings(defaultDir);

let settings = loadSettings(defaultDir);

if (!settings) {
  log.info("No settings.json found, starting setup wizard");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const io = {
    ask: (question: string): Promise<string> =>
      new Promise((resolve) => rl.question(question, (answer) => resolve(answer.trim()))),
    write: (msg: string) => process.stdout.write(msg),
  };
  settings = await runSetupWizard(io);
  rl.close();
  saveSettings(settings, defaultDir);
  log.info("Settings saved");
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
