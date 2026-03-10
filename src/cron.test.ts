import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CronScheduler } from "./cron";

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

function makeOnJob() {
  return mock((_name: string, _prompt: string, _model?: string) => {});
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

describe("CronScheduler", () => {
  it("calls onJob for matching cron job", () => {
    writeCronConfig({
      jobs: [{ name: "test-job", cron: currentMinuteCron(), prompt: "do something" }],
    });

    const onJob = makeOnJob();
    const cron = new CronScheduler(TEST_DIR, { onJob });
    cron.start();
    cron.stop();

    expect(onJob).toHaveBeenCalledWith("test-job", "do something", undefined);
  });

  it("does not call onJob for non-matching jobs", () => {
    writeCronConfig({
      jobs: [{ name: "later", cron: nonMatchingCron(), prompt: "not now" }],
    });

    const onJob = makeOnJob();
    const cron = new CronScheduler(TEST_DIR, { onJob });
    cron.start();
    cron.stop();

    expect(onJob).not.toHaveBeenCalled();
  });

  it("silently skips when cron.json does not exist", () => {
    rmSync(CRON_FILE, { force: true });

    const onJob = makeOnJob();
    const cron = new CronScheduler(TEST_DIR, { onJob });
    cron.start();
    cron.stop();

    expect(onJob).not.toHaveBeenCalled();
  });

  it("does not call onJob on malformed JSON", () => {
    writeFileSync(CRON_FILE, "not json{{{");

    const onJob = makeOnJob();
    const cron = new CronScheduler(TEST_DIR, { onJob });
    cron.start();
    cron.stop();

    expect(onJob).not.toHaveBeenCalled();
  });

  it("does not call onJob when jobs is not an array", () => {
    writeCronConfig({ jobs: "not-array" });

    const onJob = makeOnJob();
    const cron = new CronScheduler(TEST_DIR, { onJob });
    cron.start();
    cron.stop();

    expect(onJob).not.toHaveBeenCalled();
  });

  it("skips invalid cron expression and processes valid jobs", () => {
    writeCronConfig({
      jobs: [
        { name: "bad", cron: "invalid cron", prompt: "bad" },
        { name: "good", cron: currentMinuteCron(), prompt: "good" },
      ],
    });

    const onJob = makeOnJob();
    const cron = new CronScheduler(TEST_DIR, { onJob });
    cron.start();
    cron.stop();

    expect(onJob).toHaveBeenCalledTimes(1);
    expect(onJob).toHaveBeenCalledWith("good", "good", undefined);
  });

  it("stop clears the interval", () => {
    writeCronConfig({ jobs: [] });

    const onJob = makeOnJob();
    const cron = new CronScheduler(TEST_DIR, { onJob });
    cron.start();
    cron.stop(); // should not throw
  });

  it("only evaluates once per minute", () => {
    writeCronConfig({
      jobs: [{ name: "once", cron: currentMinuteCron(), prompt: "once" }],
    });

    const onJob = makeOnJob();
    const cron = new CronScheduler(TEST_DIR, { onJob });
    cron.start();
    cron.stop();

    expect(onJob).toHaveBeenCalledTimes(1);

    // Start again with a new instance — the lastMinute tracker is per-instance
    const onJob2 = makeOnJob();
    const cron2 = new CronScheduler(TEST_DIR, { onJob: onJob2 });
    cron2.start();
    cron2.stop();

    expect(onJob2).toHaveBeenCalledTimes(1);
  });

  it("handles multiple matching jobs", () => {
    writeCronConfig({
      jobs: [
        { name: "first", cron: currentMinuteCron(), prompt: "first" },
        { name: "second", cron: currentMinuteCron(), prompt: "second" },
      ],
    });

    const onJob = makeOnJob();
    const cron = new CronScheduler(TEST_DIR, { onJob });
    cron.start();
    cron.stop();

    expect(onJob).toHaveBeenCalledTimes(2);
    expect(onJob).toHaveBeenCalledWith("first", "first", undefined);
    expect(onJob).toHaveBeenCalledWith("second", "second", undefined);
  });

  it("passes model override to onJob", () => {
    writeCronConfig({
      jobs: [{ name: "smart", cron: currentMinuteCron(), prompt: "think hard", model: "opus" }],
    });

    const onJob = makeOnJob();
    const cron = new CronScheduler(TEST_DIR, { onJob });
    cron.start();
    cron.stop();

    expect(onJob).toHaveBeenCalledWith("smart", "think hard", "opus");
  });

  it("removes non-recurring job after it fires", () => {
    writeCronConfig({
      jobs: [
        { name: "once", cron: currentMinuteCron(), prompt: "one-time", recurring: false },
        { name: "always", cron: currentMinuteCron(), prompt: "forever" },
      ],
    });

    const onJob = makeOnJob();
    const cron = new CronScheduler(TEST_DIR, { onJob });
    cron.start();
    cron.stop();

    expect(onJob).toHaveBeenCalledTimes(2);

    const updated = readCronConfig();
    expect(updated.jobs).toHaveLength(1);
    expect(updated.jobs[0].name).toBe("always");
  });

  it("keeps recurring jobs (default behavior)", () => {
    writeCronConfig({
      jobs: [{ name: "keeper", cron: currentMinuteCron(), prompt: "stay" }],
    });

    const onJob = makeOnJob();
    const cron = new CronScheduler(TEST_DIR, { onJob });
    cron.start();
    cron.stop();

    const updated = readCronConfig();
    expect(updated.jobs).toHaveLength(1);
    expect(updated.jobs[0].name).toBe("keeper");
  });

  it("keeps jobs with recurring: true", () => {
    writeCronConfig({
      jobs: [{ name: "explicit", cron: currentMinuteCron(), prompt: "stay", recurring: true }],
    });

    const onJob = makeOnJob();
    const cron = new CronScheduler(TEST_DIR, { onJob });
    cron.start();
    cron.stop();

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

    const onJob = makeOnJob();
    const cron = new CronScheduler(TEST_DIR, { onJob });
    cron.start();
    cron.stop();

    chmodSync(CRON_FILE, 0o644);

    expect(onJob).toHaveBeenCalledTimes(1);
  });

  it("does not write file when no non-recurring jobs fired", () => {
    writeCronConfig({
      jobs: [{ name: "recurring", cron: nonMatchingCron(), prompt: "nope", recurring: false }],
    });

    const onJob = makeOnJob();
    const cron = new CronScheduler(TEST_DIR, { onJob });
    cron.start();
    cron.stop();

    // File should remain unchanged (job still present since it didn't fire)
    const updated = readCronConfig();
    expect(updated.jobs).toHaveLength(1);
  });
});
