import { readFileSync } from "fs";
import { join } from "path";
import { CronExpressionParser } from "cron-parser";

interface CronJob {
  cron: string;
  prompt: string;
}

interface CronConfig {
  jobs: CronJob[];
}

interface Queue {
  push(message: string): void;
}

const TICK_INTERVAL = 10_000; // 10 seconds

export function startCron(workspace: string, queue: Queue): () => void {
  let lastMinute = -1;

  const tick = () => {
    const now = new Date();
    const currentMinute = now.getMinutes() + now.getHours() * 60 + now.getDate() * 1440 + now.getMonth() * 43200;

    // Only evaluate once per minute
    if (currentMinute === lastMinute) return;
    lastMinute = currentMinute;

    let config: CronConfig;
    try {
      const raw = readFileSync(join(workspace, ".macroclaw", "cron.json"), "utf-8");
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

    for (const job of config.jobs) {
      try {
        const interval = CronExpressionParser.parse(job.cron);
        const prev = interval.prev();
        const diff = Math.abs(now.getTime() - prev.getTime());
        // Match if the previous occurrence is within the current minute
        if (diff < 60_000) {
          queue.push(`[Tool: cron] ${job.prompt}`);
        }
      } catch (err: any) {
        console.warn(`[cron] Invalid cron expression "${job.cron}":`, err?.message ?? err);
      }
    }
  };

  tick();
  const timer = setInterval(tick, TICK_INTERVAL);

  return () => clearInterval(timer);
}
