import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CronExpressionParser } from "cron-parser";
import { z } from "zod/v4";
import { createLogger } from "./logger";

const log = createLogger("cron");

const cronJobSchema = z.object({
  name: z.string(),
  cron: z.string(),
  prompt: z.string(),
  recurring: z.boolean().optional(),
  model: z.string().optional(),
});

const cronConfigSchema = z.object({
  jobs: z.array(cronJobSchema),
});

type CronConfig = z.infer<typeof cronConfigSchema>;

export interface CronSchedulerConfig {
  onJob: (name: string, prompt: string, model?: string) => void;
}

const TICK_INTERVAL = 10_000; // 10 seconds

export class CronScheduler {
  #lastMinute = -1;
  #schedulePath: string;
  #config: CronSchedulerConfig;
  #timer: Timer | null = null;

  constructor(workspace: string, config: CronSchedulerConfig) {
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
    const currentMinute = now.getMinutes() + now.getHours() * 60 + now.getDate() * 1440 + now.getMonth() * 43200;

    // Only evaluate once per minute
    if (currentMinute === this.#lastMinute) return;
    this.#lastMinute = currentMinute;

    let config: CronConfig;
    try {
      const raw = readFileSync(this.#schedulePath, "utf-8");
      const parsed = cronConfigSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        log.warn("schedule.json: 'jobs' is not an array");
        return;
      }
      config = parsed.data;
    } catch (err) {
      if (err instanceof Error && "code" in err && err.code === "ENOENT") return;
      log.warn({ err: err instanceof Error ? err.message : err }, "Failed to read schedule.json");
      return;
    }

    const firedNonRecurring: number[] = [];

    for (let i = 0; i < config.jobs.length; i++) {
      const job = config.jobs[i];
      try {
        const interval = CronExpressionParser.parse(job.cron);
        const prev = interval.prev();
        const diff = Math.abs(now.getTime() - prev.getTime());
        // Match if the previous occurrence is within the current minute
        if (diff < 60_000) {
          log.debug({ name: job.name, cron: job.cron }, "Cron job triggered");
          this.#config.onJob(job.name, job.prompt, job.model);
          if (job.recurring === false) {
            firedNonRecurring.push(i);
          }
        } else if (job.recurring === false && diff >= 60_000) {
          // Non-recurring job in the past — fire regardless of how late
          const missedMinutes = Math.round(diff / 60_000);
          const firedAt = prev.toISOString();
          const missedPrompt = `[missed event, should have fired ${missedMinutes} min ago at ${firedAt}] ${job.prompt}`;
          log.info({ name: job.name, missedMinutes, firedAt }, "Firing missed non-recurring job");
          this.#config.onJob(job.name, missedPrompt, job.model);
          firedNonRecurring.push(i);
        }
      } catch (err) {
        log.warn({ cron: job.cron, err: err instanceof Error ? err.message : err }, "Invalid cron expression");
      }
    }

    // Remove fired non-recurring jobs (iterate in reverse to preserve indices)
    if (firedNonRecurring.length > 0) {
      for (let i = firedNonRecurring.length - 1; i >= 0; i--) {
        config.jobs.splice(firedNonRecurring[i], 1);
      }
      try {
        writeFileSync(this.#schedulePath, `${JSON.stringify(config, null, 2)}\n`);
      } catch (err) {
        log.warn({ err: err instanceof Error ? err.message : err }, "Failed to write schedule.json");
      }
    }
  }
}
