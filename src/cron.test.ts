import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startCron } from "./cron";

const TEST_DIR = join(import.meta.dir, "..", ".test-workspace-cron");
const CRON_DIR = join(TEST_DIR, ".macroclaw");
const CRON_FILE = join(CRON_DIR, "cron.json");

function writeCronConfig(config: any) {
  mkdirSync(CRON_DIR, { recursive: true });
  writeFileSync(CRON_FILE, JSON.stringify(config));
}

function readCronConfig() {
  return JSON.parse(readFileSync(CRON_FILE, "utf-8"));
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
  it("pushes matching cron job with name in prefix", () => {
    writeCronConfig({
      jobs: [{ name: "test-job", cron: currentMinuteCron(), prompt: "do something" }],
    });

    const queue = makeQueue();
    const stop = startCron(TEST_DIR, queue);
    stop();

    expect(queue.push).toHaveBeenCalledWith({
      type: "cron",
      name: "test-job",
      prompt: "do something",
      model: undefined,
    });
  });

  it("does not push non-matching jobs", () => {
    writeCronConfig({
      jobs: [{ name: "later", cron: nonMatchingCron(), prompt: "not now" }],
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

  it("does not push on malformed JSON", () => {
    writeFileSync(CRON_FILE, "not json{{{");

    const queue = makeQueue();
    const stop = startCron(TEST_DIR, queue);
    stop();

    expect(queue.push).not.toHaveBeenCalled();
  });

  it("does not push when jobs is not an array", () => {
    writeCronConfig({ jobs: "not-array" });

    const queue = makeQueue();
    const stop = startCron(TEST_DIR, queue);
    stop();

    expect(queue.push).not.toHaveBeenCalled();
  });

  it("skips invalid cron expression and processes valid jobs", () => {
    writeCronConfig({
      jobs: [
        { name: "bad", cron: "invalid cron", prompt: "bad" },
        { name: "good", cron: currentMinuteCron(), prompt: "good" },
      ],
    });

    const queue = makeQueue();
    const stop = startCron(TEST_DIR, queue);
    stop();

    expect(queue.push).toHaveBeenCalledTimes(1);
    expect(queue.push).toHaveBeenCalledWith({
      type: "cron",
      name: "good",
      prompt: "good",
      model: undefined,
    });
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
      jobs: [{ name: "once", cron: currentMinuteCron(), prompt: "once" }],
    });

    const queue = makeQueue();
    const stop = startCron(TEST_DIR, queue);
    stop();

    expect(queue.push).toHaveBeenCalledTimes(1);

    // Start again with a new instance — the lastMinute tracker is per-instance
    const queue2 = makeQueue();
    const stop2 = startCron(TEST_DIR, queue2);
    stop2();

    expect(queue2.push).toHaveBeenCalledTimes(1);
  });

  it("handles multiple matching jobs", () => {
    writeCronConfig({
      jobs: [
        { name: "first", cron: currentMinuteCron(), prompt: "first" },
        { name: "second", cron: currentMinuteCron(), prompt: "second" },
      ],
    });

    const queue = makeQueue();
    const stop = startCron(TEST_DIR, queue);
    stop();

    expect(queue.push).toHaveBeenCalledTimes(2);
    expect(queue.push).toHaveBeenCalledWith({ type: "cron", name: "first", prompt: "first", model: undefined });
    expect(queue.push).toHaveBeenCalledWith({ type: "cron", name: "second", prompt: "second", model: undefined });
  });

  it("passes model override through queue item", () => {
    writeCronConfig({
      jobs: [{ name: "smart", cron: currentMinuteCron(), prompt: "think hard", model: "opus" }],
    });

    const queue = makeQueue();
    const stop = startCron(TEST_DIR, queue);
    stop();

    expect(queue.push).toHaveBeenCalledWith({
      type: "cron",
      name: "smart",
      prompt: "think hard",
      model: "opus",
    });
  });

  it("removes non-recurring job after it fires", () => {
    writeCronConfig({
      jobs: [
        { name: "once", cron: currentMinuteCron(), prompt: "one-time", recurring: false },
        { name: "always", cron: currentMinuteCron(), prompt: "forever" },
      ],
    });

    const queue = makeQueue();
    const stop = startCron(TEST_DIR, queue);
    stop();

    expect(queue.push).toHaveBeenCalledTimes(2);

    const updated = readCronConfig();
    expect(updated.jobs).toHaveLength(1);
    expect(updated.jobs[0].name).toBe("always");
  });

  it("keeps recurring jobs (default behavior)", () => {
    writeCronConfig({
      jobs: [{ name: "keeper", cron: currentMinuteCron(), prompt: "stay" }],
    });

    const queue = makeQueue();
    const stop = startCron(TEST_DIR, queue);
    stop();

    const updated = readCronConfig();
    expect(updated.jobs).toHaveLength(1);
    expect(updated.jobs[0].name).toBe("keeper");
  });

  it("keeps jobs with recurring: true", () => {
    writeCronConfig({
      jobs: [{ name: "explicit", cron: currentMinuteCron(), prompt: "stay", recurring: true }],
    });

    const queue = makeQueue();
    const stop = startCron(TEST_DIR, queue);
    stop();

    const updated = readCronConfig();
    expect(updated.jobs).toHaveLength(1);
  });

  it("still fires job when write-back of cron.json fails", () => {
    // Write config to a path that will be read successfully
    writeCronConfig({
      jobs: [{ name: "once", cron: currentMinuteCron(), prompt: "fire", recurring: false }],
    });

    // Make cron.json read-only so writeFileSync fails
    const { chmodSync } = require("node:fs");
    chmodSync(CRON_FILE, 0o444);

    const queue = makeQueue();
    const stop = startCron(TEST_DIR, queue);
    stop();

    chmodSync(CRON_FILE, 0o644);

    expect(queue.push).toHaveBeenCalledTimes(1);
  });

  it("does not write file when no non-recurring jobs fired", () => {
    writeCronConfig({
      jobs: [{ name: "recurring", cron: nonMatchingCron(), prompt: "nope", recurring: false }],
    });

    const queue = makeQueue();
    const stop = startCron(TEST_DIR, queue);
    stop();

    // File should remain unchanged (job still present since it didn't fire)
    const updated = readCronConfig();
    expect(updated.jobs).toHaveLength(1);
  });
});
