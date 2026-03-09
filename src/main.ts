import { cpSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type AppConfig, createApp, requireEnv } from "./index";
import { createLogger } from "./logger";

const log = createLogger("main");

const defaultWorkspace = resolve(process.env.HOME || "~", ".macroclaw-workspace");
const workspace = process.env.WORKSPACE || defaultWorkspace;

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
  botToken: requireEnv("TELEGRAM_BOT_TOKEN"),
  authorizedChatId: requireEnv("AUTHORIZED_CHAT_ID"),
  workspace,
  model: process.env.MODEL,
};

createApp(config).start();
