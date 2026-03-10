import pino from "pino";

const pinoramaUrl = process.env.PINORAMA_URL;

const prettyTarget: pino.TransportTargetOptions = {
	target: "pino-pretty",
	options: {
		ignore: "pid,hostname",
		messageFormat: "[{module}] {msg}",
	},
};

const targets: pino.TransportTargetOptions[] = pinoramaUrl
	? [prettyTarget, { target: "pinorama-transport", options: { url: pinoramaUrl } }]
	: [prettyTarget];

const logger = pino({
	level: process.env.LOG_LEVEL || "debug",
	transport: { targets },
});

export function createLogger(module: string) {
	return logger.child({ module });
}
