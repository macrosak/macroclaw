import { createApp, requireEnv, type AppConfig } from "./index";

const config: AppConfig = {
  botToken: requireEnv("TELEGRAM_BOT_TOKEN"),
  authorizedChatId: requireEnv("AUTHORIZED_CHAT_ID"),
  sessionId: process.env.SESSION_ID || "main",
};

createApp(config).start();
