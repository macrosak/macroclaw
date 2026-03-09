import { describe, expect, it } from "bun:test";
import { createQueue } from "./queue";

interface TestItem {
  value: string;
  extra?: number;
}

describe("createQueue", () => {
  it("processes items in FIFO order", async () => {
    const queue = createQueue<TestItem>();
    const results: string[] = [];
    queue.setHandler(async (item) => {
      results.push(item.value);
    });

    queue.push({ value: "first" });
    await new Promise((r) => setTimeout(r, 10));

    queue.push({ value: "second" });
    await new Promise((r) => setTimeout(r, 10));

    expect(results).toEqual(["first", "second"]);
  });

  it("processes queued items serially", async () => {
    const queue = createQueue<TestItem>();
    const order: string[] = [];
    let resolveSecond: (() => void) | null = null;

    queue.setHandler(async (item) => {
      if (item.value === "slow") {
        await new Promise<void>((r) => {
          resolveSecond = r;
        });
      }
      order.push(item.value);
    });

    queue.push({ value: "slow" });
    queue.push({ value: "fast" });

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
    const queue = createQueue<TestItem>();
    queue.push({ value: "orphan" });
    await new Promise((r) => setTimeout(r, 10));
    expect(queue.length).toBe(1);
  });

  it("reports length correctly", () => {
    const queue = createQueue<TestItem>();
    expect(queue.length).toBe(0);
    // No handler set, so items accumulate
    queue.push({ value: "a" });
    queue.push({ value: "b" });
    expect(queue.length).toBe(2);
  });

  it("reports isProcessing correctly", async () => {
    const queue = createQueue<TestItem>();
    expect(queue.isProcessing).toBe(false);

    let resolve: (() => void) | null = null;
    queue.setHandler(async () => {
      await new Promise<void>((r) => {
        resolve = r;
      });
    });

    queue.push({ value: "msg" });
    await new Promise((r) => setTimeout(r, 10));
    expect(queue.isProcessing).toBe(true);

    resolve!();
    await new Promise((r) => setTimeout(r, 10));
    expect(queue.isProcessing).toBe(false);
  });

  it("does not re-enter process when already processing", async () => {
    const queue = createQueue<TestItem>();
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

    queue.push({ value: "a" });
    await new Promise((r) => setTimeout(r, 10));

    // Push while processing - process() will be called but should no-op
    queue.push({ value: "b" });
    expect(queue.isProcessing).toBe(true);

    resolve!();
    await new Promise((r) => setTimeout(r, 10));
    // Both items should have been processed
    expect(callCount).toBe(2);
  });

  it("continues processing after handler throws", async () => {
    const queue = createQueue<TestItem>();
    const results: string[] = [];
    queue.setHandler(async (item) => {
      if (item.value === "bad") throw new Error("handler failed");
      results.push(item.value);
    });

    queue.push({ value: "first" });
    await new Promise((r) => setTimeout(r, 10));

    queue.push({ value: "bad" });
    queue.push({ value: "third" });
    await new Promise((r) => setTimeout(r, 10));

    expect(results).toEqual(["first", "third"]);
    expect(queue.isProcessing).toBe(false);
  });

  it("passes all fields through in queue item", async () => {
    const queue = createQueue<TestItem>();
    let received: TestItem | undefined;
    queue.setHandler(async (item) => {
      received = item;
    });

    queue.push({ value: "test", extra: 42 });
    await new Promise((r) => setTimeout(r, 10));

    expect(received).toEqual({ value: "test", extra: 42 });
  });
});
