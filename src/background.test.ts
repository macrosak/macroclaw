import { describe, expect, it, mock } from "bun:test";
import { BackgroundManager, type BackgroundQueueItem } from "./background";
import type { ClaudeResponse, OrchestratorRequest } from "./orchestrator";

function mockOrchestrator(handler: (request: OrchestratorRequest) => Promise<ClaudeResponse>) {
  return { processRequest: mock(handler) };
}

function mockQueue() {
  const items: BackgroundQueueItem[] = [];
  return {
    push(item: BackgroundQueueItem) {
      items.push(item);
    },
    items,
  };
}

describe("BackgroundManager", () => {
  it("spawns a background agent and feeds result back to queue", async () => {
    let resolvePromise: (r: ClaudeResponse) => void;
    const claudePromise = new Promise<ClaudeResponse>((r) => {
      resolvePromise = r;
    });
    const orchestrator = mockOrchestrator(() => claudePromise);
    const queue = mockQueue();
    const mgr = new BackgroundManager(orchestrator);

    mgr.spawn("test-task", "do something", "haiku", "/workspace", queue);

    expect(mgr.size).toBe(1);
    expect(mgr.list()[0].name).toBe("test-task");
    expect(orchestrator.processRequest).toHaveBeenCalledTimes(1);
    const request = orchestrator.processRequest.mock.calls[0][0];
    expect(request.type).toBe("bg-task");
    if (request.type === "bg-task") {
      expect(request.name).toBe("test-task");
      expect(request.prompt).toBe("do something");
      expect(request.model).toBe("haiku");
    }

    resolvePromise!({
      action: "send",
      message: "done!",
      actionReason: "completed",
    });
    await claudePromise;
    // Allow microtask (.then) to run
    await new Promise((r) => setTimeout(r, 0));

    expect(mgr.size).toBe(0);
    expect(queue.items).toHaveLength(1);
    expect(queue.items[0]).toEqual({ type: "background", name: "test-task", result: "done!" });
  });

  it("feeds error back to queue on failure", async () => {
    let rejectPromise: (e: Error) => void;
    const claudePromise = new Promise<ClaudeResponse>((_, r) => {
      rejectPromise = r;
    });
    const orchestrator = mockOrchestrator(() => claudePromise);
    const queue = mockQueue();
    const mgr = new BackgroundManager(orchestrator);

    mgr.spawn("failing-task", "do something", undefined, "/workspace", queue);
    expect(mgr.size).toBe(1);

    rejectPromise!(new Error("spawn failed"));
    try {
      await claudePromise;
    } catch {}
    await new Promise((r) => setTimeout(r, 0));

    expect(mgr.size).toBe(0);
    expect(queue.items).toHaveLength(1);
    expect(queue.items[0].name).toBe("failing-task");
    expect(queue.items[0].result).toContain("[Error]");
  });

  it("sends [No output] when message is empty", async () => {
    const orchestrator = mockOrchestrator(async () => ({
      action: "send" as const,
      message: "",
      actionReason: "empty",
    }));
    const queue = mockQueue();
    const mgr = new BackgroundManager(orchestrator);

    mgr.spawn("empty-task", "do something", undefined, "/workspace", queue);
    await new Promise((r) => setTimeout(r, 0));

    expect(queue.items[0]).toEqual({ type: "background", name: "empty-task", result: "[No output]" });
  });

  it("tracks multiple concurrent agents", async () => {
    const promises: Array<{
      resolve: (r: ClaudeResponse) => void;
    }> = [];
    const orchestrator = mockOrchestrator(
      () =>
        new Promise<ClaudeResponse>((resolve) => {
          promises.push({ resolve });
        }),
    );
    const queue = mockQueue();
    const mgr = new BackgroundManager(orchestrator);

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
      actionReason: "ok",
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(mgr.size).toBe(2);
    expect(queue.items).toHaveLength(1);
    expect(queue.items[0]).toEqual({ type: "background", name: "task-b", result: "b done" });
  });

  it("adopt registers an already-running process and feeds result back", async () => {
    let resolvePromise: (r: ClaudeResponse) => void;
    const completion = new Promise<ClaudeResponse>((r) => {
      resolvePromise = r;
    });
    const orchestrator = mockOrchestrator(async () => ({ action: "send" as const, message: "", actionReason: "" }));
    const queue = mockQueue();
    const mgr = new BackgroundManager(orchestrator);

    mgr.adopt("timeout-task", "session-123", completion, queue);

    expect(mgr.size).toBe(1);
    expect(mgr.list()[0].name).toBe("timeout-task");
    expect(mgr.hasSessionId("session-123")).toBe(true);
    expect(mgr.hasSessionId("other")).toBe(false);

    resolvePromise!({ action: "send", message: "completed!", actionReason: "ok" });
    await completion;
    await new Promise((r) => setTimeout(r, 0));

    expect(mgr.size).toBe(0);
    expect(queue.items).toHaveLength(1);
    expect(queue.items[0]).toEqual({ type: "background", name: "timeout-task", result: "completed!", sessionId: "session-123" });
  });

  it("adopt feeds error back on failure", async () => {
    let rejectPromise: (e: Error) => void;
    const completion = new Promise<ClaudeResponse>((_, r) => {
      rejectPromise = r;
    });
    const orchestrator = mockOrchestrator(async () => ({ action: "send" as const, message: "", actionReason: "" }));
    const queue = mockQueue();
    const mgr = new BackgroundManager(orchestrator);

    mgr.adopt("fail-task", "session-456", completion, queue);
    expect(mgr.size).toBe(1);

    rejectPromise!(new Error("crash"));
    try { await completion; } catch {}
    await new Promise((r) => setTimeout(r, 0));

    expect(mgr.size).toBe(0);
    expect(queue.items[0].result).toContain("[Error]");
    expect(queue.items[0].sessionId).toBe("session-456");
  });

  it("list returns empty array when no agents are running", () => {
    const orchestrator = mockOrchestrator(async () => ({ action: "send" as const, message: "", actionReason: "" }));
    const mgr = new BackgroundManager(orchestrator);
    expect(mgr.list()).toEqual([]);
    expect(mgr.size).toBe(0);
  });
});
