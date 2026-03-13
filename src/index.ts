import { cpSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { App, type AppConfig } from "./app";
import { createLogger, initLogger } from "./logger";
import { applyEnvOverrides, loadSettings, printSettings } from "./settings";
import { SpeechToText } from "./speech-to-text";

export async function start(): Promise<void> {
  const log = createLogger("index");

  const defaultDir = resolve(process.env.HOME || "~", ".macroclaw");

  const settings = loadSettings(defaultDir);

  if (!settings) {
    log.error("No settings found. Run `macroclaw setup` first.");
    process.exit(1);
  }

  const { settings: resolved, overrides } = applyEnvOverrides(settings);

  await initLogger({ level: resolved.logLevel, pinoramaUrl: resolved.pinoramaUrl });
  printSettings(resolved, overrides);

  const workspace = resolve(resolved.workspace.replace(/^~/, process.env.HOME || "~"));

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
    botToken: resolved.botToken,
    authorizedChatId: resolved.chatId,
    workspace,
    model: resolved.model,
    stt: resolved.openaiApiKey ? new SpeechToText(resolved.openaiApiKey) : undefined,
  };

  new App(config).start();
}
