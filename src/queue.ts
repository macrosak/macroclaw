import { createLogger } from "./logger";

const log = createLogger("queue");

export interface QueueItem {
  message: string;
  model?: string;
  source?: "user" | "cron" | "background" | "timeout";
  name?: string;
  files?: string[];
}

export function createQueue() {
  const items: QueueItem[] = [];
  let processing = false;
  let handler: ((item: QueueItem) => Promise<void>) | null = null;

  return {
    setHandler(fn: (item: QueueItem) => Promise<void>) {
      handler = fn;
    },

    push(item: QueueItem) {
      items.push(item);
      this.process();
    },

    async process() {
      if (processing || !handler) return;
      processing = true;

      while (items.length > 0) {
        const item = items.shift() as QueueItem;
        try {
          await handler(item);
        } catch (err) {
          log.error({ err }, "Handler error");
        }
      }

      processing = false;
    },

    get length() {
      return items.length;
    },

    get isProcessing() {
      return processing;
    },
  };
}
