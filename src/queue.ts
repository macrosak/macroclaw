import { createLogger } from "./logger";

const log = createLogger("queue");

export function createQueue<T>() {
  const items: T[] = [];
  let processing = false;
  let handler: ((item: T) => Promise<void>) | null = null;

  return {
    setHandler(fn: (item: T) => Promise<void>) {
      handler = fn;
    },

    push(item: T) {
      items.push(item);
      this.process();
    },

    async process() {
      if (processing || !handler) return;
      processing = true;

      while (items.length > 0) {
        const item = items.shift() as T;
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
