import { describe, it, expect, mock } from "bun:test";
import { createBackgroundManager } from "./background";
import type { ClaudeResponse } from "./claude";

function mockQueue() {
  const items: { message: string }[] = [];
  return {
    push(item: { message: string }) {
      items.push(item);
    },
    items,
  };
}

describe("createBackgroundManager", () => {
  it("spawns a background agent and feeds result back to queue", async () => {
    let resolvePromise: (r: ClaudeResponse) => void;
    const claudePromise = new Promise<ClaudeResponse>((r) => {
      resolvePromise = r;
    });
    const runClaude = mock(() => claudePromise);
    const queue = mockQueue();
    const mgr = createBackgroundManager(runClaude);

    mgr.spawn("test-task", "do something", "haiku", "/workspace", queue);

    expect(mgr.size).toBe(1);
    expect(mgr.list()[0].name).toBe("test-task");
    expect(runClaude).toHaveBeenCalledTimes(1);
    expect(runClaude.mock.calls[0][0]).toBe("do something");
    expect(runClaude.mock.calls[0][2]).toBe("haiku");
    expect(runClaude.mock.calls[0][3]).toBe("/workspace");
    expect(runClaude.mock.calls[0][4]).toContain("background agent named \"test-task\"");

    resolvePromise!({
      action: "send",
      message: "done!",
      reason: "completed",
    });
    await claudePromise;
    // Allow microtask (.then) to run
    await new Promise((r) => setTimeout(r, 0));

    expect(mgr.size).toBe(0);
    expect(queue.items).toHaveLength(1);
    expect(queue.items[0].message).toBe("[Background: test-task] done!");
  });

  it("feeds error back to queue on failure", async () => {
    let rejectPromise: (e: Error) => void;
    const claudePromise = new Promise<ClaudeResponse>((_, r) => {
      rejectPromise = r;
    });
    const runClaude = mock(() => claudePromise);
    const queue = mockQueue();
    const mgr = createBackgroundManager(runClaude);

    mgr.spawn("failing-task", "do something", undefined, "/workspace", queue);
    expect(mgr.size).toBe(1);

    rejectPromise!(new Error("spawn failed"));
    try {
      await claudePromise;
    } catch {}
    await new Promise((r) => setTimeout(r, 0));

    expect(mgr.size).toBe(0);
    expect(queue.items).toHaveLength(1);
    expect(queue.items[0].message).toContain("[Background: failing-task] [Error]");
  });

  it("sends [No output] when message is empty", async () => {
    const runClaude = mock(() =>
      Promise.resolve<ClaudeResponse>({
        action: "send",
        message: "",
        reason: "empty",
      }),
    );
    const queue = mockQueue();
    const mgr = createBackgroundManager(runClaude);

    mgr.spawn("empty-task", "do something", undefined, "/workspace", queue);
    await new Promise((r) => setTimeout(r, 0));

    expect(queue.items[0].message).toBe("[Background: empty-task] [No output]");
  });

  it("tracks multiple concurrent agents", async () => {
    const promises: Array<{
      resolve: (r: ClaudeResponse) => void;
    }> = [];
    const runClaude = mock(
      () =>
        new Promise<ClaudeResponse>((resolve) => {
          promises.push({ resolve });
        }),
    );
    const queue = mockQueue();
    const mgr = createBackgroundManager(runClaude);

    mgr.spawn("task-a", "prompt a", undefined, "/workspace", queue);
    mgr.spawn("task-b", "prompt b", undefined, "/workspace", queue);
    mgr.spawn("task-c", "prompt c", undefined, "/workspace", queue);

    expect(mgr.size).toBe(3);
    expect(mgr.list().map((t) => t.name)).toEqual([
      "task-a",
      "task-b",
      "task-c",
    ]);

    promises[1].resolve({
      action: "send",
      message: "b done",
      reason: "ok",
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(mgr.size).toBe(2);
    expect(queue.items).toHaveLength(1);
    expect(queue.items[0].message).toBe("[Background: task-b] b done");
  });

  it("passes 30-minute timeout to runClaude", async () => {
    const runClaude = mock(() =>
      Promise.resolve<ClaudeResponse>({
        action: "send",
        message: "done",
        reason: "ok",
      }),
    );
    const queue = mockQueue();
    const mgr = createBackgroundManager(runClaude);

    mgr.spawn("bg-task", "do work", undefined, "/workspace", queue);
    await new Promise((r) => setTimeout(r, 0));

    expect(runClaude.mock.calls[0][5]).toBe(1_800_000);
  });

  it("list returns empty array when no agents are running", () => {
    const mgr = createBackgroundManager(mock());
    expect(mgr.list()).toEqual([]);
    expect(mgr.size).toBe(0);
  });
});
