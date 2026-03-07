export function createQueue() {
  const items: string[] = [];
  let processing = false;
  let handler: ((message: string) => Promise<void>) | null = null;

  return {
    setHandler(fn: (message: string) => Promise<void>) {
      handler = fn;
    },

    push(message: string) {
      items.push(message);
      this.process();
    },

    async process() {
      if (processing || !handler) return;
      processing = true;

      while (items.length > 0) {
        const message = items.shift()!;
        await handler(message);
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
