import { describe, expect, it, } from "bun:test";
import { createQueue } from "./queue";

describe("createQueue", () => {
  it("processes items in FIFO order", async () => {
    const queue = createQueue();
    const results: string[] = [];
    queue.setHandler(async (item) => {
      results.push(item.message);
    });

    queue.push({ message: "first" });
    await new Promise((r) => setTimeout(r, 10));

    queue.push({ message: "second" });
    await new Promise((r) => setTimeout(r, 10));

    expect(results).toEqual(["first", "second"]);
  });

  it("processes queued items serially", async () => {
    const queue = createQueue();
    const order: string[] = [];
    let resolveSecond: (() => void) | null = null;

    queue.setHandler(async (item) => {
      if (item.message === "slow") {
        await new Promise<void>((r) => {
          resolveSecond = r;
        });
      }
      order.push(item.message);
    });

    queue.push({ message: "slow" });
    queue.push({ message: "fast" });

    // "fast" should be queued, not processed yet
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual([]);
    expect(queue.isProcessing).toBe(true);

    // Release the slow handler
    resolveSecond!();
    await new Promise((r) => setTimeout(r, 10));

    expect(order).toEqual(["slow", "fast"]);
    expect(queue.isProcessing).toBe(false);
  });

  it("does nothing without a handler", async () => {
    const queue = createQueue();
    queue.push({ message: "orphan" });
    await new Promise((r) => setTimeout(r, 10));
    expect(queue.length).toBe(1);
  });

  it("reports length correctly", () => {
    const queue = createQueue();
    expect(queue.length).toBe(0);
    // No handler set, so items accumulate
    queue.push({ message: "a" });
    queue.push({ message: "b" });
    expect(queue.length).toBe(2);
  });

  it("reports isProcessing correctly", async () => {
    const queue = createQueue();
    expect(queue.isProcessing).toBe(false);

    let resolve: (() => void) | null = null;
    queue.setHandler(async () => {
      await new Promise<void>((r) => {
        resolve = r;
      });
    });

    queue.push({ message: "msg" });
    await new Promise((r) => setTimeout(r, 10));
    expect(queue.isProcessing).toBe(true);

    resolve!();
    await new Promise((r) => setTimeout(r, 10));
    expect(queue.isProcessing).toBe(false);
  });

  it("does not re-enter process when already processing", async () => {
    const queue = createQueue();
    let callCount = 0;
    let resolve: (() => void) | null = null;

    queue.setHandler(async () => {
      callCount++;
      if (callCount === 1) {
        await new Promise<void>((r) => {
          resolve = r;
        });
      }
    });

    queue.push({ message: "a" });
    await new Promise((r) => setTimeout(r, 10));

    // Push while processing - process() will be called but should no-op
    queue.push({ message: "b" });
    expect(queue.isProcessing).toBe(true);

    resolve!();
    await new Promise((r) => setTimeout(r, 10));
    // Both items should have been processed
    expect(callCount).toBe(2);
  });

  it("continues processing after handler throws", async () => {
    const queue = createQueue();
    const results: string[] = [];
    queue.setHandler(async (item) => {
      if (item.message === "bad") throw new Error("handler failed");
      results.push(item.message);
    });

    queue.push({ message: "first" });
    await new Promise((r) => setTimeout(r, 10));

    queue.push({ message: "bad" });
    queue.push({ message: "third" });
    await new Promise((r) => setTimeout(r, 10));

    expect(results).toEqual(["first", "third"]);
    expect(queue.isProcessing).toBe(false);
  });

  it("passes source and name through in queue item", async () => {
    const queue = createQueue();
    let receivedSource: string | undefined;
    let receivedName: string | undefined;
    queue.setHandler(async (item) => {
      receivedSource = item.source;
      receivedName = item.name;
    });

    queue.push({ message: "test", source: "cron", name: "daily" });
    await new Promise((r) => setTimeout(r, 10));

    expect(receivedSource).toBe("cron");
    expect(receivedName).toBe("daily");
  });

  it("passes model through in queue item", async () => {
    const queue = createQueue();
    let receivedModel: string | undefined;
    queue.setHandler(async (item) => {
      receivedModel = item.model;
    });

    queue.push({ message: "test", model: "haiku" });
    await new Promise((r) => setTimeout(r, 10));

    expect(receivedModel).toBe("haiku");
  });

  it("passes files through in queue item", async () => {
    const queue = createQueue();
    let receivedFiles: string[] | undefined;
    queue.setHandler(async (item) => {
      receivedFiles = item.files;
    });

    queue.push({ message: "test", files: ["/tmp/photo.jpg"] });
    await new Promise((r) => setTimeout(r, 10));

    expect(receivedFiles).toEqual(["/tmp/photo.jpg"]);
  });
});
