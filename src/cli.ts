import {execSync} from "node:child_process";
import {createInterface} from "node:readline";
import {defineCommand} from "citty";
import pkg from "../package.json" with {type: "json"};
import {loadSessions} from "./sessions";
import {SettingsManager} from "./settings";
import {type SetupIo, SetupWizard} from "./setup";
import {SystemServiceManager} from "./system-service";

export class Cli {
	readonly #settingsManager: SettingsManager;
	readonly #setupWizard: SetupWizard;
	readonly #serviceManager: SystemServiceManager;

	constructor(opts?: { wizard?: SetupWizard; settings?: SettingsManager; systemService?: SystemServiceManager }) {
		this.#settingsManager = opts?.settings ?? new SettingsManager();
		this.#setupWizard = opts?.wizard ?? new SetupWizard(createReadlineIo());
		this.#serviceManager = opts?.systemService ?? new SystemServiceManager();
	}

	async setup(): Promise<void> {
		const defaults = this.#settingsManager.loadRaw() ?? undefined;
		const settings = await this.#setupWizard.collectSettings(defaults);
		this.#settingsManager.save(settings);
		await this.#setupWizard.installService();
	}

	claude(): void {
		const settings = this.#settingsManager.load();
		const sessions = loadSessions(this.#settingsManager.dir);
		const args = ["claude"];
		if (sessions.mainSessionId) args.push("--resume", sessions.mainSessionId);
		args.push("--model", settings.model);
		execSync(args.join(" "), { cwd: settings.workspace, stdio: "inherit", env: { ...process.env, CLAUDECODE: "" } });
	}

	service(action: string, token?: string, follow?: boolean): void {
		switch (action) {
			case "install": {
				const logCmd = this.#serviceManager.install(token);
				console.log(`Service installed and started. Check logs:\n  ${logCmd}`);
				break;
			}
			case "uninstall":
				this.#serviceManager.uninstall();
				console.log("Service uninstalled.");
				break;
			case "start": {
				const logCmd = this.#serviceManager.start();
				console.log(`Service started. Check logs:\n  ${logCmd}`);
				break;
			}
			case "stop":
				this.#serviceManager.stop();
				console.log("Service stopped.");
				break;
			case "update": {
				const logCmd = this.#serviceManager.update();
				console.log(`Service updated. Check logs:\n  ${logCmd}`);
				break;
			}
			case "status": {
				const s = this.#serviceManager.status();
				const lines = [
					`Platform: ${s.platform}`,
					`Installed: ${s.installed ? "yes" : "no"}`,
					`Running: ${s.running ? "yes" : "no"}`,
				];
				if (s.pid) lines.push(`PID: ${s.pid}`);
				if (s.uptime) lines.push(`Active since: ${s.uptime}`);
				console.log(lines.join("\n"));
				break;
			}
			case "logs": {
				const cmd = this.#serviceManager.logs(follow);
				console.log(cmd);
				break;
			}
			default:
				throw new Error(`Unknown service action: ${action}`);
		}
	}
}

export function createReadlineIo(): SetupIo {
	let rl: ReturnType<typeof createInterface> | null = null;
	return {
		open: () => { rl = createInterface({ input: process.stdin, output: process.stdout }); },
		close: () => { rl?.close(); rl = null; },
		ask: (question: string): Promise<string> =>
			new Promise((res) => rl?.question(question, (answer: string) => res(answer.trim()))),
		write: (msg: string) => process.stdout.write(msg),
	};
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

const serviceStatusCommand = defineCommand({
	meta: { name: "status", description: "Show service installation and running status" },
	run: () => { try { defaultCli.service("status"); } catch (err) { handleError(err); } },
});

const serviceLogsCommand = defineCommand({
	meta: { name: "logs", description: "Print the command to view service logs" },
	args: {
		follow: { type: "boolean", alias: "f", description: "Follow log output in real-time" },
	},
	run: ({ args }) => { try { defaultCli.service("logs", undefined, args.follow); } catch (err) { handleError(err); } },
});

const serviceCommand = defineCommand({
	meta: { name: "service", description: "Manage macroclaw system service" },
	subCommands: {
		install: serviceInstallCommand,
		uninstall: serviceUninstallCommand,
		start: serviceStartCommand,
		stop: serviceStopCommand,
		update: serviceUpdateCommand,
		status: serviceStatusCommand,
		logs: serviceLogsCommand,
	},
});

export const main = defineCommand({
	meta: { name: pkg.name, description: pkg.description, version: pkg.version },
	subCommands: { start: startCommand, setup: setupCommand, claude: claudeCommand, service: serviceCommand },
});
