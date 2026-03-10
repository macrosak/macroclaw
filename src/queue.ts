import { createLogger } from "./logger";

const log = createLogger("queue");

export class Queue<T> {
  #items: T[] = [];
  #processing = false;
  #handler: ((item: T) => Promise<void>) | null = null;

  setHandler(fn: (item: T) => Promise<void>) {
    this.#handler = fn;
  }

  push(item: T) {
    this.#items.push(item);
    this.process();
  }

  async process() {
    if (this.#processing || !this.#handler) return;
    this.#processing = true;

    while (this.#items.length > 0) {
      const item = this.#items.shift() as T;
      try {
        await this.#handler(item);
      } catch (err) {
        log.error({ err }, "Handler error");
      }
    }

    this.#processing = false;
  }

  get length() {
    return this.#items.length;
  }

  get isProcessing() {
    return this.#processing;
  }
}
