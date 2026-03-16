import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Scheduler } from "./scheduler";

const TEST_DIR = join(import.meta.dir, "..", ".test-workspace-scheduler");
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

// Build an ISO fireAt string N minutes in the past with timezone offset
function minutesAgoFireAt(minutesAgo: number): string {
	return toIsoWithOffset(new Date(Date.now() - minutesAgo * 60_000));
}

// Build an ISO fireAt string N days in the past with timezone offset
function daysAgoFireAt(daysAgo: number): string {
	return toIsoWithOffset(new Date(Date.now() - daysAgo * 24 * 60 * 60_000));
}

// Build an ISO fireAt string N minutes in the future with timezone offset
function minutesFromNowFireAt(minutes: number): string {
	return toIsoWithOffset(new Date(Date.now() + minutes * 60_000));
}

// Format a Date as ISO 8601 with +00:00 offset (not Z)
function toIsoWithOffset(date: Date): string {
	return date.toISOString().replace("Z", "+00:00");
}

// Build a fireAt string for ~30 seconds ago (within 60s window)
function justNowFireAt(): string {
	return toIsoWithOffset(new Date(Date.now() - 30_000));
}

beforeEach(() => {
	mkdirSync(SCHEDULE_DIR, { recursive: true });
});

afterEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("Scheduler — cron jobs", () => {
	it("calls onJob for matching cron job", () => {
		writeScheduleConfig({
			jobs: [{ name: "test-job", cron: currentMinuteCron(), prompt: "do something" }],
		});

		const onJob = makeOnJob();
		const s = new Scheduler(TEST_DIR, { onJob });
		s.start();
		s.stop();

		expect(onJob).toHaveBeenCalledWith("test-job", "do something", undefined);
	});

	it("does not call onJob for non-matching jobs", () => {
		writeScheduleConfig({
			jobs: [{ name: "later", cron: nonMatchingCron(), prompt: "not now" }],
		});

		const onJob = makeOnJob();
		const s = new Scheduler(TEST_DIR, { onJob });
		s.start();
		s.stop();

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
		const s = new Scheduler(TEST_DIR, { onJob });
		s.start();
		s.stop();

		expect(onJob).toHaveBeenCalledTimes(1);
		expect(onJob).toHaveBeenCalledWith("good", "good", undefined);
	});

	it("handles multiple matching jobs", () => {
		writeScheduleConfig({
			jobs: [
				{ name: "first", cron: currentMinuteCron(), prompt: "first" },
				{ name: "second", cron: currentMinuteCron(), prompt: "second" },
			],
		});

		const onJob = makeOnJob();
		const s = new Scheduler(TEST_DIR, { onJob });
		s.start();
		s.stop();

		expect(onJob).toHaveBeenCalledTimes(2);
		expect(onJob).toHaveBeenCalledWith("first", "first", undefined);
		expect(onJob).toHaveBeenCalledWith("second", "second", undefined);
	});

	it("passes model override to onJob", () => {
		writeScheduleConfig({
			jobs: [{ name: "smart", cron: currentMinuteCron(), prompt: "think hard", model: "opus" }],
		});

		const onJob = makeOnJob();
		const s = new Scheduler(TEST_DIR, { onJob });
		s.start();
		s.stop();

		expect(onJob).toHaveBeenCalledWith("smart", "think hard", "opus");
	});

	it("never removes cron jobs after firing", () => {
		writeScheduleConfig({
			jobs: [{ name: "keeper", cron: currentMinuteCron(), prompt: "stay" }],
		});

		const onJob = makeOnJob();
		const s = new Scheduler(TEST_DIR, { onJob });
		s.start();
		s.stop();

		const updated = readScheduleConfig();
		expect(updated.jobs).toHaveLength(1);
		expect(updated.jobs[0].name).toBe("keeper");
	});
});

describe("Scheduler — fireAt jobs", () => {
	it("fires one-shot job when fireAt is within 60s of now", () => {
		writeScheduleConfig({
			jobs: [{ name: "now", fireAt: justNowFireAt(), prompt: "do it" }],
		});

		const onJob = makeOnJob();
		const s = new Scheduler(TEST_DIR, { onJob });
		s.start();
		s.stop();

		expect(onJob).toHaveBeenCalledWith("now", "do it", undefined);
	});

	it("removes one-shot job after firing", () => {
		writeScheduleConfig({
			jobs: [
				{ name: "once", fireAt: justNowFireAt(), prompt: "one-time" },
				{ name: "recurring", cron: currentMinuteCron(), prompt: "forever" },
			],
		});

		const onJob = makeOnJob();
		const s = new Scheduler(TEST_DIR, { onJob });
		s.start();
		s.stop();

		expect(onJob).toHaveBeenCalledTimes(2);
		const updated = readScheduleConfig();
		expect(updated.jobs).toHaveLength(1);
		expect(updated.jobs[0].name).toBe("recurring");
	});

	it("skips upcoming fireAt job (in the future)", () => {
		writeScheduleConfig({
			jobs: [{ name: "later", fireAt: minutesFromNowFireAt(60), prompt: "not yet" }],
		});

		const onJob = makeOnJob();
		const s = new Scheduler(TEST_DIR, { onJob });
		s.start();
		s.stop();

		expect(onJob).not.toHaveBeenCalled();

		const updated = readScheduleConfig();
		expect(updated.jobs).toHaveLength(1);
		expect(updated.jobs[0].name).toBe("later");
	});

	it("fires missed one-shot job with missed prefix", () => {
		writeScheduleConfig({
			jobs: [{ name: "reminder", fireAt: minutesAgoFireAt(3), prompt: "buy milk" }],
		});

		const onJob = makeOnJob();
		const s = new Scheduler(TEST_DIR, { onJob });
		s.start();
		s.stop();

		expect(onJob).toHaveBeenCalledTimes(1);
		const call = onJob.mock.calls[0];
		expect(call[0]).toBe("reminder");
		expect(call[1]).toContain("[missed event, should have fired");
		expect(call[1]).toContain("min ago at");
		expect(call[1]).toContain("buy milk");
	});

	it("removes missed one-shot job after firing", () => {
		writeScheduleConfig({
			jobs: [
				{ name: "missed", fireAt: minutesAgoFireAt(3), prompt: "do it" },
				{ name: "keeper", cron: nonMatchingCron(), prompt: "stay" },
			],
		});

		const onJob = makeOnJob();
		const s = new Scheduler(TEST_DIR, { onJob });
		s.start();
		s.stop();

		expect(onJob).toHaveBeenCalledTimes(1);
		const updated = readScheduleConfig();
		expect(updated.jobs).toHaveLength(1);
		expect(updated.jobs[0].name).toBe("keeper");
	});

	it("fires one-shot job missed by 6 days (within week window)", () => {
		writeScheduleConfig({
			jobs: [{ name: "recent", fireAt: daysAgoFireAt(6), prompt: "still valid" }],
		});

		const onJob = makeOnJob();
		const s = new Scheduler(TEST_DIR, { onJob });
		s.start();
		s.stop();

		expect(onJob).toHaveBeenCalledTimes(1);
		const call = onJob.mock.calls[0];
		expect(call[0]).toBe("recent");
		expect(call[1]).toContain("[missed event, should have fired");
		expect(call[1]).toContain("still valid");
	});

	it("discards stale one-shot job (older than a week) without firing", () => {
		writeScheduleConfig({
			jobs: [
				{ name: "stale", fireAt: daysAgoFireAt(10), prompt: "too old" },
				{ name: "keeper", cron: nonMatchingCron(), prompt: "stay" },
			],
		});

		const onJob = makeOnJob();
		const s = new Scheduler(TEST_DIR, { onJob });
		s.start();
		s.stop();

		expect(onJob).not.toHaveBeenCalled();

		const updated = readScheduleConfig();
		expect(updated.jobs).toHaveLength(1);
		expect(updated.jobs[0].name).toBe("keeper");
	});

	it("passes model override for fireAt jobs", () => {
		writeScheduleConfig({
			jobs: [{ name: "smart", fireAt: justNowFireAt(), prompt: "think", model: "opus" }],
		});

		const onJob = makeOnJob();
		const s = new Scheduler(TEST_DIR, { onJob });
		s.start();
		s.stop();

		expect(onJob).toHaveBeenCalledWith("smart", "think", "opus");
	});

	it("still fires when write-back of schedule.json fails", () => {
		writeScheduleConfig({
			jobs: [{ name: "once", fireAt: justNowFireAt(), prompt: "fire" }],
		});

		const { chmodSync } = require("node:fs");
		chmodSync(SCHEDULE_FILE, 0o444);

		const onJob = makeOnJob();
		const s = new Scheduler(TEST_DIR, { onJob });
		s.start();
		s.stop();

		chmodSync(SCHEDULE_FILE, 0o644);

		expect(onJob).toHaveBeenCalledTimes(1);
	});
});

describe("Scheduler — validation and edge cases", () => {
	it("silently skips when schedule.json does not exist", () => {
		rmSync(SCHEDULE_FILE, { force: true });

		const onJob = makeOnJob();
		const s = new Scheduler(TEST_DIR, { onJob });
		s.start();
		s.stop();

		expect(onJob).not.toHaveBeenCalled();
	});

	it("does not call onJob on malformed JSON", () => {
		writeFileSync(SCHEDULE_FILE, "not json{{{");

		const onJob = makeOnJob();
		const s = new Scheduler(TEST_DIR, { onJob });
		s.start();
		s.stop();

		expect(onJob).not.toHaveBeenCalled();
	});

	it("does not call onJob when jobs is not an array", () => {
		writeScheduleConfig({ jobs: "not-array" });

		const onJob = makeOnJob();
		const s = new Scheduler(TEST_DIR, { onJob });
		s.start();
		s.stop();

		expect(onJob).not.toHaveBeenCalled();
	});

	it("skips job with both cron and fireAt", () => {
		writeScheduleConfig({
			jobs: [{ name: "bad", cron: currentMinuteCron(), fireAt: justNowFireAt(), prompt: "oops" }],
		});

		const onJob = makeOnJob();
		const s = new Scheduler(TEST_DIR, { onJob });
		s.start();
		s.stop();

		expect(onJob).not.toHaveBeenCalled();
	});

	it("skips fireAt without timezone offset", () => {
		writeScheduleConfig({
			jobs: [{ name: "bad", fireAt: "2026-03-16T08:00:00", prompt: "no offset" }],
		});

		const onJob = makeOnJob();
		const s = new Scheduler(TEST_DIR, { onJob });
		s.start();
		s.stop();

		expect(onJob).not.toHaveBeenCalled();

		// Job should remain (not removed, just skipped)
		const updated = readScheduleConfig();
		expect(updated.jobs).toHaveLength(1);
	});

	it("skips fireAt with Z suffix (no explicit offset)", () => {
		writeScheduleConfig({
			jobs: [{ name: "bad", fireAt: "2026-03-16T08:00:00Z", prompt: "z suffix" }],
		});

		const onJob = makeOnJob();
		const s = new Scheduler(TEST_DIR, { onJob });
		s.start();
		s.stop();

		expect(onJob).not.toHaveBeenCalled();
	});

	it("stop clears the interval", () => {
		writeScheduleConfig({ jobs: [] });

		const onJob = makeOnJob();
		const s = new Scheduler(TEST_DIR, { onJob });
		s.start();
		s.stop(); // should not throw
	});

	it("only evaluates once per minute", () => {
		writeScheduleConfig({
			jobs: [{ name: "once", cron: currentMinuteCron(), prompt: "once" }],
		});

		const onJob = makeOnJob();
		const s = new Scheduler(TEST_DIR, { onJob });
		s.start();
		s.stop();

		expect(onJob).toHaveBeenCalledTimes(1);

		// Start again with a new instance — the lastMinute tracker is per-instance
		const onJob2 = makeOnJob();
		const s2 = new Scheduler(TEST_DIR, { onJob: onJob2 });
		s2.start();
		s2.stop();

		expect(onJob2).toHaveBeenCalledTimes(1);
	});

	it("does not write file when no one-shot jobs were processed", () => {
		writeScheduleConfig({
			jobs: [{ name: "recurring", cron: nonMatchingCron(), prompt: "nope" }],
		});

		const onJob = makeOnJob();
		const s = new Scheduler(TEST_DIR, { onJob });
		s.start();
		s.stop();

		const updated = readScheduleConfig();
		expect(updated.jobs).toHaveLength(1);
	});
});
