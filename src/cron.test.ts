import { describe, it, expect, mock, spyOn, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { startCron } from "./cron";

const TEST_DIR = join(import.meta.dir, "..", ".test-workspace-cron");
const CRON_DIR = join(TEST_DIR, ".macroclaw");
const CRON_FILE = join(CRON_DIR, "cron.json");

function writeCronConfig(config: any) {
  mkdirSync(CRON_DIR, { recursive: true });
  writeFileSync(CRON_FILE, JSON.stringify(config));
}

function makeQueue() {
  return { push: mock(() => {}) };
}

// Build a cron expression that matches the current minute
function currentMinuteCron(): string {
  const now = new Date();
  return `${now.getMinutes()} ${now.getHours()} * * *`;
}

// Build a cron expression that never matches now
function nonMatchingCron(): string {
  const now = new Date();
  const otherMinute = (now.getMinutes() + 30) % 60;
  return `${otherMinute} ${(now.getHours() + 12) % 24} * * *`;
}

beforeEach(() => {
  mkdirSync(CRON_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("startCron", () => {
  it("pushes matching cron job prompts to queue", () => {
    writeCronConfig({
      jobs: [{ cron: currentMinuteCron(), prompt: "do something" }],
    });

    const queue = makeQueue();
    const stop = startCron(TEST_DIR, queue);
    stop();

    expect(queue.push).toHaveBeenCalledWith("[Tool: cron] do something");
  });

  it("does not push non-matching jobs", () => {
    writeCronConfig({
      jobs: [{ cron: nonMatchingCron(), prompt: "not now" }],
    });

    const queue = makeQueue();
    const stop = startCron(TEST_DIR, queue);
    stop();

    expect(queue.push).not.toHaveBeenCalled();
  });

  it("silently skips when cron.json does not exist", () => {
    rmSync(CRON_FILE, { force: true });

    const queue = makeQueue();
    const stop = startCron(TEST_DIR, queue);
    stop();

    expect(queue.push).not.toHaveBeenCalled();
  });

  it("warns on malformed JSON", () => {
    writeFileSync(CRON_FILE, "not json{{{");

    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const queue = makeQueue();
    const stop = startCron(TEST_DIR, queue);
    stop();

    expect(warnSpy).toHaveBeenCalled();
    const msg = warnSpy.mock.calls[0][0] as string;
    expect(msg).toContain("[cron]");
    warnSpy.mockRestore();
  });

  it("warns when jobs is not an array", () => {
    writeCronConfig({ jobs: "not-array" });

    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const queue = makeQueue();
    const stop = startCron(TEST_DIR, queue);
    stop();

    expect(warnSpy).toHaveBeenCalledWith("[cron] cron.json: 'jobs' is not an array");
    warnSpy.mockRestore();
  });

  it("warns on invalid cron expression and skips that job", () => {
    writeCronConfig({
      jobs: [
        { cron: "invalid cron", prompt: "bad" },
        { cron: currentMinuteCron(), prompt: "good" },
      ],
    });

    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const queue = makeQueue();
    const stop = startCron(TEST_DIR, queue);
    stop();

    expect(warnSpy).toHaveBeenCalled();
    expect(queue.push).toHaveBeenCalledWith("[Tool: cron] good");
    warnSpy.mockRestore();
  });

  it("returns a cleanup function that clears the interval", () => {
    writeCronConfig({ jobs: [] });

    const queue = makeQueue();
    const stop = startCron(TEST_DIR, queue);

    expect(typeof stop).toBe("function");
    stop(); // should not throw
  });

  it("only evaluates once per minute", () => {
    writeCronConfig({
      jobs: [{ cron: currentMinuteCron(), prompt: "once" }],
    });

    const queue = makeQueue();
    // Manually call the tick logic by starting and re-triggering
    // startCron runs tick() immediately on first call
    const stop = startCron(TEST_DIR, queue);
    stop();

    expect(queue.push).toHaveBeenCalledTimes(1);

    // Start again with a new instance — the lastMinute tracker is per-instance
    // so a second start should also fire once
    const queue2 = makeQueue();
    const stop2 = startCron(TEST_DIR, queue2);
    stop2();

    expect(queue2.push).toHaveBeenCalledTimes(1);
  });

  it("handles multiple matching jobs", () => {
    writeCronConfig({
      jobs: [
        { cron: currentMinuteCron(), prompt: "first" },
        { cron: currentMinuteCron(), prompt: "second" },
      ],
    });

    const queue = makeQueue();
    const stop = startCron(TEST_DIR, queue);
    stop();

    expect(queue.push).toHaveBeenCalledTimes(2);
    expect(queue.push).toHaveBeenCalledWith("[Tool: cron] first");
    expect(queue.push).toHaveBeenCalledWith("[Tool: cron] second");
  });
});
