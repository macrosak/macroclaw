import { describe, it, expect, mock } from "bun:test";
import { createQueue } from "./queue";

describe("createQueue", () => {
  it("processes messages in FIFO order", async () => {
    const queue = createQueue();
    const results: string[] = [];
    queue.setHandler(async (msg) => {
      results.push(msg);
    });

    queue.push("first");
    // Wait for async processing
    await new Promise((r) => setTimeout(r, 10));

    queue.push("second");
    await new Promise((r) => setTimeout(r, 10));

    expect(results).toEqual(["first", "second"]);
  });

  it("processes queued messages serially", async () => {
    const queue = createQueue();
    const order: string[] = [];
    let resolveSecond: (() => void) | null = null;

    queue.setHandler(async (msg) => {
      if (msg === "slow") {
        await new Promise<void>((r) => {
          resolveSecond = r;
        });
      }
      order.push(msg);
    });

    queue.push("slow");
    queue.push("fast");

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
    queue.push("orphan");
    await new Promise((r) => setTimeout(r, 10));
    expect(queue.length).toBe(1);
  });

  it("reports length correctly", () => {
    const queue = createQueue();
    expect(queue.length).toBe(0);
    // No handler set, so items accumulate
    queue.push("a");
    queue.push("b");
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

    queue.push("msg");
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

    queue.push("a");
    await new Promise((r) => setTimeout(r, 10));

    // Push while processing - process() will be called but should no-op
    queue.push("b");
    expect(queue.isProcessing).toBe(true);

    resolve!();
    await new Promise((r) => setTimeout(r, 10));
    // Both messages should have been processed
    expect(callCount).toBe(2);
  });
});
