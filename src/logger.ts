import pino from "pino";
import pretty from "pino-pretty";

const pinoramaUrl = process.env.PINORAMA_URL;

const prettyStream = pretty({
	ignore: "pid,hostname",
	messageFormat: "[{module}] {msg}",
});

const streams: pino.StreamEntry[] = [{ stream: prettyStream }];

if (pinoramaUrl) {
	const { default: pinoramaTransport } = await import("pinorama-transport");
	streams.push({ stream: pinoramaTransport({ url: pinoramaUrl }) });
}

const logger = pino(
	{ level: process.env.LOG_LEVEL || "debug" },
	pino.multistream(streams),
);

export function createLogger(module: string) {
	return logger.child({ module });
}
