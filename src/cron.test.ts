import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CronScheduler } from "./cron";

const TEST_DIR = join(import.meta.dir, "..", ".test-workspace-cron");
const SCHEDULE_DIR = join(TEST_DIR, "data");
const SCHEDULE_FILE = join(SCHEDULE_DIR, "schedule.json");

function writeScheduleConfig(config: any) {
  mkdirSync(SCHEDULE_DIR, { recursive: true });
  writeFileSync(SCHEDULE_FILE, JSON.stringify(config));
}

function readScheduleConfig() {
  return JSON.parse(readFileSync(SCHEDULE_FILE, "utf-8"));
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

// Build a cron expression that matched N minutes ago
function minutesAgoCron(minutesAgo: number): string {
  const past = new Date(Date.now() - minutesAgo * 60_000);
  return `${past.getMinutes()} ${past.getHours()} ${past.getDate()} ${past.getMonth() + 1} *`;
}

beforeEach(() => {
  mkdirSync(SCHEDULE_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("CronScheduler", () => {
  it("calls onJob for matching cron job", () => {
    writeScheduleConfig({
      jobs: [{ name: "test-job", cron: currentMinuteCron(), prompt: "do something" }],
    });

    const onJob = makeOnJob();
    const cron = new CronScheduler(TEST_DIR, { onJob });
    cron.start();
    cron.stop();

    expect(onJob).toHaveBeenCalledWith("test-job", "do something", undefined);
  });

  it("does not call onJob for non-matching jobs", () => {
    writeScheduleConfig({
      jobs: [{ name: "later", cron: nonMatchingCron(), prompt: "not now" }],
    });

    const onJob = makeOnJob();
    const cron = new CronScheduler(TEST_DIR, { onJob });
    cron.start();
    cron.stop();

    expect(onJob).not.toHaveBeenCalled();
  });

  it("silently skips when schedule.json does not exist", () => {
    rmSync(SCHEDULE_FILE, { force: true });

    const onJob = makeOnJob();
    const cron = new CronScheduler(TEST_DIR, { onJob });
    cron.start();
    cron.stop();

    expect(onJob).not.toHaveBeenCalled();
  });

  it("does not call onJob on malformed JSON", () => {
    writeFileSync(SCHEDULE_FILE, "not json{{{");

    const onJob = makeOnJob();
    const cron = new CronScheduler(TEST_DIR, { onJob });
    cron.start();
    cron.stop();

    expect(onJob).not.toHaveBeenCalled();
  });

  it("does not call onJob when jobs is not an array", () => {
    writeScheduleConfig({ jobs: "not-array" });

    const onJob = makeOnJob();
    const cron = new CronScheduler(TEST_DIR, { onJob });
    cron.start();
    cron.stop();

    expect(onJob).not.toHaveBeenCalled();
  });

  it("skips invalid cron expression and processes valid jobs", () => {
    writeScheduleConfig({
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
    writeScheduleConfig({ jobs: [] });

    const onJob = makeOnJob();
    const cron = new CronScheduler(TEST_DIR, { onJob });
    cron.start();
    cron.stop(); // should not throw
  });

  it("only evaluates once per minute", () => {
    writeScheduleConfig({
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
    writeScheduleConfig({
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
    writeScheduleConfig({
      jobs: [{ name: "smart", cron: currentMinuteCron(), prompt: "think hard", model: "opus" }],
    });

    const onJob = makeOnJob();
    const cron = new CronScheduler(TEST_DIR, { onJob });
    cron.start();
    cron.stop();

    expect(onJob).toHaveBeenCalledWith("smart", "think hard", "opus");
  });

  it("removes non-recurring job after it fires", () => {
    writeScheduleConfig({
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

    const updated = readScheduleConfig();
    expect(updated.jobs).toHaveLength(1);
    expect(updated.jobs[0].name).toBe("always");
  });

  it("keeps recurring jobs (default behavior)", () => {
    writeScheduleConfig({
      jobs: [{ name: "keeper", cron: currentMinuteCron(), prompt: "stay" }],
    });

    const onJob = makeOnJob();
    const cron = new CronScheduler(TEST_DIR, { onJob });
    cron.start();
    cron.stop();

    const updated = readScheduleConfig();
    expect(updated.jobs).toHaveLength(1);
    expect(updated.jobs[0].name).toBe("keeper");
  });

  it("keeps jobs with recurring: true", () => {
    writeScheduleConfig({
      jobs: [{ name: "explicit", cron: currentMinuteCron(), prompt: "stay", recurring: true }],
    });

    const onJob = makeOnJob();
    const cron = new CronScheduler(TEST_DIR, { onJob });
    cron.start();
    cron.stop();

    const updated = readScheduleConfig();
    expect(updated.jobs).toHaveLength(1);
  });

  it("still fires job when write-back of schedule.json fails", () => {
    writeScheduleConfig({
      jobs: [{ name: "once", cron: currentMinuteCron(), prompt: "fire", recurring: false }],
    });

    const { chmodSync } = require("node:fs");
    chmodSync(SCHEDULE_FILE, 0o444);

    const onJob = makeOnJob();
    const cron = new CronScheduler(TEST_DIR, { onJob });
    cron.start();
    cron.stop();

    chmodSync(SCHEDULE_FILE, 0o644);

    expect(onJob).toHaveBeenCalledTimes(1);
  });

  it("does not write file when no non-recurring jobs fired", () => {
    writeScheduleConfig({
      jobs: [{ name: "recurring", cron: nonMatchingCron(), prompt: "nope", recurring: false }],
    });

    const onJob = makeOnJob();
    const cron = new CronScheduler(TEST_DIR, { onJob });
    cron.start();
    cron.stop();

    const updated = readScheduleConfig();
    expect(updated.jobs).toHaveLength(1);
  });
});

describe("missed non-recurring events", () => {
  it("fires missed non-recurring job with missed prefix", () => {
    writeScheduleConfig({
      jobs: [{ name: "reminder", cron: minutesAgoCron(3), prompt: "buy milk", recurring: false }],
    });

    const onJob = makeOnJob();
    const cron = new CronScheduler(TEST_DIR, { onJob });
    cron.start();
    cron.stop();

    expect(onJob).toHaveBeenCalledTimes(1);
    const call = onJob.mock.calls[0];
    expect(call[0]).toBe("reminder");
    expect(call[1]).toContain("[missed event, should have fired");
    expect(call[1]).toContain("min ago at");
    expect(call[1]).toContain("buy milk");
  });

  it("removes missed non-recurring job after firing", () => {
    writeScheduleConfig({
      jobs: [
        { name: "missed", cron: minutesAgoCron(3), prompt: "do it", recurring: false },
        { name: "keeper", cron: nonMatchingCron(), prompt: "stay" },
      ],
    });

    const onJob = makeOnJob();
    const cron = new CronScheduler(TEST_DIR, { onJob });
    cron.start();
    cron.stop();

    expect(onJob).toHaveBeenCalledTimes(1);
    const updated = readScheduleConfig();
    expect(updated.jobs).toHaveLength(1);
    expect(updated.jobs[0].name).toBe("keeper");
  });

  it("does not fire missed recurring jobs", () => {
    writeScheduleConfig({
      jobs: [{ name: "recurring", cron: minutesAgoCron(3), prompt: "repeat" }],
    });

    const onJob = makeOnJob();
    const cron = new CronScheduler(TEST_DIR, { onJob });
    cron.start();
    cron.stop();

    expect(onJob).not.toHaveBeenCalled();
  });

  it("does not fire non-recurring jobs older than threshold", () => {
    writeScheduleConfig({
      jobs: [{ name: "old", cron: minutesAgoCron(10), prompt: "too late", recurring: false }],
    });

    const onJob = makeOnJob();
    const cron = new CronScheduler(TEST_DIR, { onJob });
    cron.start();
    cron.stop();

    expect(onJob).not.toHaveBeenCalled();
    const updated = readScheduleConfig();
    expect(updated.jobs).toHaveLength(1);
  });
});
