import { resolve, dirname } from "path";
import { createApp, requireEnv, type AppConfig } from "./index";

const defaultWorkspace = resolve(dirname(import.meta.dir), "..", "macroclaw-workspace");

const config: AppConfig = {
  botToken: requireEnv("TELEGRAM_BOT_TOKEN"),
  authorizedChatId: requireEnv("AUTHORIZED_CHAT_ID"),
  sessionId: process.env.SESSION_ID || "main",
  workspace: process.env.WORKSPACE || defaultWorkspace,
  model: process.env.MODEL,
};

createApp(config).start();
