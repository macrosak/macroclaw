import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { CronExpressionParser } from "cron-parser";

interface CronJob {
  name: string;
  cron: string;
  prompt: string;
  recurring?: boolean;
  model?: string;
}

interface CronConfig {
  jobs: CronJob[];
}

interface Queue {
  push(item: { message: string; model?: string; source?: string; name?: string }): void;
}

const TICK_INTERVAL = 10_000; // 10 seconds

export function startCron(workspace: string, queue: Queue): () => void {
  let lastMinute = -1;
  const cronPath = join(workspace, ".macroclaw", "cron.json");

  const tick = () => {
    const now = new Date();
    const currentMinute = now.getMinutes() + now.getHours() * 60 + now.getDate() * 1440 + now.getMonth() * 43200;

    // Only evaluate once per minute
    if (currentMinute === lastMinute) return;
    lastMinute = currentMinute;

    let config: CronConfig;
    try {
      const raw = readFileSync(cronPath, "utf-8");
      config = JSON.parse(raw);
    } catch (err: any) {
      if (err?.code === "ENOENT") return; // no config yet
      console.warn("[cron] Failed to read cron.json:", err?.message ?? err);
      return;
    }

    if (!Array.isArray(config.jobs)) {
      console.warn("[cron] cron.json: 'jobs' is not an array");
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
          queue.push({
            message: `[Tool: cron/${job.name}] ${job.prompt}`,
            model: job.model,
            source: "cron",
            name: job.name,
          });
          if (job.recurring === false) {
            firedNonRecurring.push(i);
          }
        }
      } catch (err: any) {
        console.warn(`[cron] Invalid cron expression "${job.cron}":`, err?.message ?? err);
      }
    }

    // Remove fired non-recurring jobs (iterate in reverse to preserve indices)
    if (firedNonRecurring.length > 0) {
      for (let i = firedNonRecurring.length - 1; i >= 0; i--) {
        config.jobs.splice(firedNonRecurring[i], 1);
      }
      try {
        writeFileSync(cronPath, JSON.stringify(config, null, 2) + "\n");
      } catch (err: any) {
        console.warn("[cron] Failed to write cron.json:", err?.message ?? err);
      }
    }
  };

  tick();
  const timer = setInterval(tick, TICK_INTERVAL);

  return () => clearInterval(timer);
}
