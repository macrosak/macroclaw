import pino from "pino";
import pretty from "pino-pretty";

const prettyStream = pretty({
	ignore: "pid,hostname",
	messageFormat: "[{module}] {msg}",
});

const defaultLevel = (process.env.LOG_LEVEL || "info") as pino.Level;

// Streams accept all levels; logger.level is the sole gate
const streams: pino.StreamEntry[] = [{ level: "trace", stream: prettyStream }];

const logger = pino(
	{ level: defaultLevel },
	pino.multistream(streams),
);

export interface LoggerOptions {
	level?: pino.Level;
	pinoramaUrl?: string;
}

let pinoramaAdded = false;

export async function configureLogger(opts?: LoggerOptions): Promise<void> {
	if (opts?.level) logger.level = opts.level;

	if (opts?.pinoramaUrl && !pinoramaAdded) {
		const { default: pinoramaTransport } = await import("pinorama-transport");
		streams.push({ level: "trace", stream: pinoramaTransport({ url: opts.pinoramaUrl }) });
		pinoramaAdded = true;
	}
}

export function createLogger(module: string) {
	return logger.child({ module });
}
