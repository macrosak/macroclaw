import { cpSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { App, type AppConfig } from "./app";
import { configureLogger, createLogger } from "./logger";
import { SettingsManager } from "./settings";
import { SpeechToText } from "./speech-to-text";

export async function start(): Promise<void> {
  const log = createLogger("index");

  process.on("unhandledRejection", (err) => {
    log.error({ err }, "Unhandled rejection");
  });

  const mgr = new SettingsManager();
  const settings = mgr.load();
  const { settings: resolved, overrides } = mgr.applyEnvOverrides(settings);

  await configureLogger({ level: resolved.logLevel, pinoramaUrl: resolved.pinoramaUrl });
  mgr.print(resolved, overrides);

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
    timeZone: resolved.timeZone,
    stt: resolved.openaiApiKey ? new SpeechToText(resolved.openaiApiKey) : undefined,
  };

  new App(config).start();
}
