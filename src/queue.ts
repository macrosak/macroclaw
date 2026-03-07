export interface QueueItem {
  message: string;
  model?: string;
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
        const item = items.shift()!;
        await handler(item);
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
