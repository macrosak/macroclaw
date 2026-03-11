import pino from "pino";
import pretty from "pino-pretty";

const prettyStream = pretty({
	ignore: "pid,hostname",
	messageFormat: "[{module}] {msg}",
});

const level = (process.env.LOG_LEVEL || "info") as pino.Level;

const streams: pino.StreamEntry[] = [{ level, stream: prettyStream }];

const logger = pino(
	{ level: process.env.LOG_LEVEL || "info" },
	pino.multistream(streams),
);

export async function initLogger(): Promise<void> {
	const pinoramaUrl = process.env.PINORAMA_URL;
	if (pinoramaUrl) {
		const { default: pinoramaTransport } = await import("pinorama-transport");
		streams.push({ level, stream: pinoramaTransport({ url: pinoramaUrl }) });
	}
}

export function createLogger(module: string) {
	return logger.child({ module });
}
