import pino from "pino";

const pinoramaUrl = process.env.PINORAMA_URL;

const transport: pino.TransportSingleOptions | pino.TransportMultiOptions =
	pinoramaUrl
		? {
				targets: [
					{
						target: "pino-pretty",
						options: { ignore: "pid,hostname", messageFormat: "[{module}] {msg}" },
					},
					{ target: "pinorama-transport", options: { url: pinoramaUrl } },
				],
			}
		: {
				target: "pino-pretty",
				options: { ignore: "pid,hostname", messageFormat: "[{module}] {msg}" },
			};

const logger = pino({
	level: process.env.LOG_LEVEL || "debug",
	transport,
});

export function createLogger(module: string) {
	return logger.child({ module });
}
