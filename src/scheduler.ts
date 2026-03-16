import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CronExpressionParser } from "cron-parser";
import { z } from "zod/v4";
import { createLogger } from "./logger";

const log = createLogger("scheduler");

const jobSchema = z.object({
	name: z.string(),
	prompt: z.string(),
	model: z.string().optional(),
	cron: z.string().optional(),
	fireAt: z.string().optional(),
});

const scheduleConfigSchema = z.object({
	jobs: z.array(jobSchema),
});

type ScheduleConfig = z.infer<typeof scheduleConfigSchema>;
type Job = z.infer<typeof jobSchema>;

export interface SchedulerConfig {
	onJob: (name: string, prompt: string, model?: string) => void;
}

const TICK_INTERVAL = 10_000; // 10 seconds
const MAX_MISSED_MS = 7 * 24 * 60 * 60 * 1000; // 1 week

export class Scheduler {
	#lastMinute = -1;
	#schedulePath: string;
	#config: SchedulerConfig;
	#timer: Timer | null = null;

	constructor(workspace: string, config: SchedulerConfig) {
		this.#schedulePath = join(workspace, "data", "schedule.json");
		this.#config = config;
	}

	start(): void {
		this.#tick();
		this.#timer = setInterval(() => this.#tick(), TICK_INTERVAL);
	}

	stop(): void {
		if (this.#timer) {
			clearInterval(this.#timer);
			this.#timer = null;
		}
	}

	#tick(): void {
		const now = new Date();
		const currentMinute =
			now.getMinutes() + now.getHours() * 60 + now.getDate() * 1440 + now.getMonth() * 43200;

		// Only evaluate once per minute
		if (currentMinute === this.#lastMinute) return;
		this.#lastMinute = currentMinute;

		let config: ScheduleConfig;
		try {
			const raw = readFileSync(this.#schedulePath, "utf-8");
			const parsed = scheduleConfigSchema.safeParse(JSON.parse(raw));
			if (!parsed.success) {
				log.warn("schedule.json validation failed");
				return;
			}
			config = parsed.data;
		} catch (err) {
			if (err instanceof Error && "code" in err && err.code === "ENOENT") return;
			log.warn({ err: err instanceof Error ? err.message : err }, "Failed to read schedule.json");
			return;
		}

		const removedIndices: number[] = [];

		for (let i = 0; i < config.jobs.length; i++) {
			const job = config.jobs[i];
			if (job.cron && job.fireAt) {
				log.warn({ name: job.name }, "Job has both cron and fireAt, skipping");
				continue;
			}
			if (job.cron) {
				this.#evaluateCronJob(job as Job & { cron: string }, now);
			} else if (job.fireAt) {
				const result = this.#evaluateFireAtJob(job as Job & { fireAt: string }, now);
				if (result === "remove") removedIndices.push(i);
			} else {
				log.warn({ name: job.name }, "Job has neither cron nor fireAt, skipping");
			}
		}

		if (removedIndices.length > 0) {
			for (let i = removedIndices.length - 1; i >= 0; i--) {
				config.jobs.splice(removedIndices[i], 1);
			}
			try {
				writeFileSync(this.#schedulePath, `${JSON.stringify(config, null, 2)}\n`);
			} catch (err) {
				log.warn({ err: err instanceof Error ? err.message : err }, "Failed to write schedule.json");
			}
		}
	}

	#evaluateCronJob(job: { name: string; cron: string; prompt: string; model?: string }, now: Date): void {
		try {
			const interval = CronExpressionParser.parse(job.cron);
			const prev = interval.prev();
			const diff = Math.abs(now.getTime() - prev.getTime());
			if (diff < 60_000) {
				log.debug({ name: job.name, cron: job.cron }, "Cron job triggered");
				this.#config.onJob(job.name, job.prompt, job.model);
			}
		} catch (err) {
			log.warn({ cron: job.cron, err: err instanceof Error ? err.message : err }, "Invalid cron expression");
		}
	}

	#evaluateFireAtJob(
		job: { name: string; fireAt: string; prompt: string; model?: string },
		now: Date,
	): "remove" | "keep" {
		const fireAt = new Date(job.fireAt);
		if (Number.isNaN(fireAt.getTime())) {
			log.warn({ name: job.name, fireAt: job.fireAt }, "Invalid fireAt date");
			return "keep";
		}

		const diff = now.getTime() - fireAt.getTime();

		if (diff < 0) {
			// Upcoming — not yet due
			return "keep";
		}

		if (diff < 60_000) {
			log.debug({ name: job.name, fireAt: job.fireAt }, "One-shot job triggered");
			this.#config.onJob(job.name, job.prompt, job.model);
			return "remove";
		}

		if (diff <= MAX_MISSED_MS) {
			const missedMinutes = Math.round(diff / 60_000);
			const missedPrompt = `[missed event, should have fired ${missedMinutes} min ago at ${job.fireAt}] ${job.prompt}`;
			log.info({ name: job.name, missedMinutes, fireAt: job.fireAt }, "Firing missed one-shot job");
			this.#config.onJob(job.name, missedPrompt, job.model);
			return "remove";
		}

		log.warn({ name: job.name, missedMinutes: Math.round(diff / 60_000) }, "Discarding stale one-shot job");
		return "remove";
	}
}
