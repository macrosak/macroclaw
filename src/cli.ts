import {execSync} from "node:child_process";
import {existsSync, readFileSync} from "node:fs";
import {join, resolve} from "node:path";
import {createInterface} from "node:readline";
import {defineCommand} from "citty";
import pkg from "../package.json" with { type: "json" };
import {initLogger} from "./logger";
import {ServiceManager, type SystemService} from "./service";
import {loadSessions} from "./sessions";
import {loadSettings, saveSettings} from "./settings";
import {runSetupWizard} from "./setup";

export interface SetupDeps {
	initLogger: () => Promise<void>;
	saveSettings: (settings: unknown, dir: string) => void;
	loadRawSettings: (dir: string) => Record<string, unknown> | null;
	runSetupWizard: (io: { ask: (q: string) => Promise<string>; write: (m: string) => void; close?: () => void }, opts?: { defaults?: Record<string, unknown>; onSettingsReady?: (settings: unknown) => void }) => Promise<unknown>;
	createReadlineInterface: () => { question: (q: string, cb: (a: string) => void) => void; close: () => void };
	resolveDir: () => string;
}

export function loadRawSettings(dir: string): Record<string, unknown> | null {
	const path = join(dir, "settings.json");
	if (!existsSync(path)) return null;
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8"));
		return typeof raw === "object" && raw !== null ? raw : null;
	} catch {
		return null;
	}
}

function defaultSetupDeps(): SetupDeps {
	return {
		initLogger,
		saveSettings: saveSettings as (settings: unknown, dir: string) => void,
		loadRawSettings,
		runSetupWizard: runSetupWizard as SetupDeps["runSetupWizard"],
		createReadlineInterface: () => createInterface({ input: process.stdin, output: process.stdout }),
		resolveDir: () => resolve(process.env.HOME || "~", ".macroclaw"),
	};
}

function defaultSystemService(): SystemService {
	return new ServiceManager();
}

export class Cli {
	readonly #setupDeps: SetupDeps;
	readonly #systemService: SystemService;

	constructor(setupDeps?: Partial<SetupDeps>, systemService?: SystemService) {
		this.#setupDeps = { ...defaultSetupDeps(), ...setupDeps };
		this.#systemService = systemService ?? defaultSystemService();
	}

	async setup(): Promise<void> {
		await this.#setupDeps.initLogger();
		const rl = this.#setupDeps.createReadlineInterface();
		const io = {
			ask: (question: string): Promise<string> =>
				new Promise((res) => rl.question(question, (answer: string) => res(answer.trim()))),
			write: (msg: string) => process.stdout.write(msg),
			close: () => rl.close(),
		};
		const dir = this.#setupDeps.resolveDir();
		const defaults = this.#setupDeps.loadRawSettings(dir) ?? undefined;
		const settings = await this.#setupDeps.runSetupWizard(io, {
			defaults,
			onSettingsReady: (s) => this.#setupDeps.saveSettings(s, dir),
		});
		this.#setupDeps.saveSettings(settings, dir);
	}

	claude(exec: (cmd: string, opts: object) => void = (cmd, opts) => execSync(cmd, opts)): void {
		const dir = this.#setupDeps.resolveDir();
		const settings = loadSettings(dir);
		if (!settings) throw new Error("Settings not found. Run `macroclaw setup` first.");
		const sessions = loadSessions(dir);
		const args = ["claude"];
		if (sessions.mainSessionId) args.push("--resume", sessions.mainSessionId);
		args.push("--model", settings.model);
		exec(args.join(" "), { cwd: settings.workspace, stdio: "inherit", env: { ...process.env, CLAUDECODE: "" } });
	}

	service(action: string, token?: string): void {
		switch (action) {
			case "install": {
				const logCmd = this.#systemService.install(token);
				console.log(`Service installed and started. Check logs:\n  ${logCmd}`);
				break;
			}
			case "uninstall":
				this.#systemService.uninstall();
				console.log("Service uninstalled.");
				break;
			case "start": {
				const logCmd = this.#systemService.start();
				console.log(`Service started. Check logs:\n  ${logCmd}`);
				break;
			}
			case "stop":
				this.#systemService.stop();
				console.log("Service stopped.");
				break;
			case "update": {
				const logCmd = this.#systemService.update();
				console.log(`Service updated. Check logs:\n  ${logCmd}`);
				break;
			}
			default:
				throw new Error(`Unknown service action: ${action}`);
		}
	}
}

export function handleError(err: unknown): never {
	console.error(err instanceof Error ? err.message : String(err));
	process.exit(1);
}

async function runStart(): Promise<void> {
	const { start } = await import("./index");
	await start();
}

const defaultCli = new Cli();

const startCommand = defineCommand({
	meta: { name: "start", description: "Start the macroclaw bridge" },
	run: () => runStart().catch(handleError),
});

const setupCommand = defineCommand({
	meta: { name: "setup", description: "Run the interactive setup wizard" },
	run: () => defaultCli.setup().catch(handleError),
});

const claudeCommand = defineCommand({
	meta: { name: "claude", description: "Open Claude Code CLI in the main session" },
	run: () => { try { defaultCli.claude(); } catch (err) { handleError(err); } },
});

const serviceInstallCommand = defineCommand({
	meta: { name: "install", description: "Install and start macroclaw as a system service" },
	args: {
		token: { type: "string", description: "Claude OAuth token from `claude setup-token` (required on macOS)" },
	},
	run: ({ args }) => { try { defaultCli.service("install", args.token); } catch (err) { handleError(err); } },
});

const serviceUninstallCommand = defineCommand({
	meta: { name: "uninstall", description: "Stop and remove the system service" },
	run: () => { try { defaultCli.service("uninstall"); } catch (err) { handleError(err); } },
});

const serviceStartCommand = defineCommand({
	meta: { name: "start", description: "Start the system service" },
	run: () => { try { defaultCli.service("start"); } catch (err) { handleError(err); } },
});

const serviceStopCommand = defineCommand({
	meta: { name: "stop", description: "Stop the system service" },
	run: () => { try { defaultCli.service("stop"); } catch (err) { handleError(err); } },
});

const serviceUpdateCommand = defineCommand({
	meta: { name: "update", description: "Reinstall latest version and restart the service" },
	run: () => { try { defaultCli.service("update"); } catch (err) { handleError(err); } },
});

const serviceCommand = defineCommand({
	meta: { name: "service", description: "Manage macroclaw system service" },
	subCommands: {
		install: serviceInstallCommand,
		uninstall: serviceUninstallCommand,
		start: serviceStartCommand,
		stop: serviceStopCommand,
		update: serviceUpdateCommand,
	},
});

export const main = defineCommand({
	meta: { name: pkg.name, description: pkg.description, version: pkg.version },
	subCommands: { start: startCommand, setup: setupCommand, claude: claudeCommand, service: serviceCommand },
});

