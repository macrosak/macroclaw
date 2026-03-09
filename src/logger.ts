import pino from "pino";

const logger = pino({
	level: process.env.LOG_LEVEL || "debug",
	transport: {
		target: "pino-pretty",
		options: {
			ignore: "pid,hostname",
			messageFormat: "[{module}] {msg}",
		},
	},
});

export function createLogger(module: string) {
	return logger.child({ module });
}
