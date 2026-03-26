import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { userInfo as osUserInfo } from "node:os";
import { dirname, resolve } from "node:path";
import { createLogger } from "./logger";

const log = createLogger("service");
const LAUNCHD_LABEL = "com.macroclaw";

export type Platform = "launchd" | "systemd";

export interface ServiceStatus {
	installed: boolean;
	running: boolean;
	platform: Platform;
	pid?: number;
	uptime?: string;
}

export interface UpdateResult {
	previousVersion: string;
	currentVersion: string;
}

export class SystemServiceManager {
	readonly #platform: Platform;
	readonly #home: string;

	constructor(opts?: { platform?: string; home?: string }) {
		this.#platform = SystemServiceManager.#detectPlatform(opts?.platform ?? process.platform);
		this.#home = opts?.home ?? process.env.HOME ?? "~";
	}

	static #detectPlatform(platform: string): Platform {
		if (platform === "darwin") return "launchd";
		if (platform === "linux") return "systemd";
		throw new Error("Unsupported platform. Only macOS (launchd) and Linux (systemd) are supported.");
	}

	get platform(): Platform {
		return this.#platform;
	}

	get serviceFilePath(): string {
		return this.#platform === "launchd"
			? resolve(this.#home, "Library/LaunchAgents/com.macroclaw.plist")
			: resolve(this.#home, ".config/systemd/user/macroclaw.service");
	}

	get isInstalled(): boolean {
		return existsSync(this.serviceFilePath);
	}

	get isRunning(): boolean {
		if (this.#platform === "launchd") {
			try {
				const out = this.#exec(`launchctl list ${LAUNCHD_LABEL}`);
				return /"PID"\s*=\s*\d+/.test(out);
			} catch {
				return false;
			}
		}
		try {
			const out = this.#exec("systemctl --user is-active macroclaw");
			return out.trim() === "active";
		} catch {
			return false;
		}
	}

	install(): string {
		if (this.#platform === "launchd") {
			this.#installLaunchd();
		} else {
			this.#installSystemd();
		}
		log.debug("Service installed and started");
		return this.#logTailCommand();
	}

	#installLaunchd(): void {
		const settingsPath = resolve(this.#home, ".macroclaw/settings.json");
		if (!existsSync(settingsPath)) {
			throw new Error("Settings not found. Run `macroclaw setup` first.");
		}

		this.#exec("bun install -g macroclaw");

		const logDir = resolve(this.#home, ".macroclaw/logs");
		mkdirSync(logDir, { recursive: true });
		if (this.isRunning) {
			this.#exec(`launchctl unload ${this.serviceFilePath}`);
		}

		writeFileSync(this.serviceFilePath, this.#generateLaunchdPlist());
		log.debug({ filePath: this.serviceFilePath }, "Wrote launchd plist");
		this.#exec(`launchctl load ${this.serviceFilePath}`);
	}

	#installSystemd(): void {
		const settingsPath = resolve(this.#home, ".macroclaw/settings.json");
		if (!existsSync(settingsPath)) {
			throw new Error("Settings not found. Run `macroclaw setup` first.");
		}

		if (this.isRunning) {
			this.#exec("systemctl --user stop macroclaw");
		}

		this.#exec("bun install -g macroclaw");

		// Enable lingering so user services run without an active login session
		const username = osUserInfo().username;
		if (!existsSync(`/var/lib/systemd/linger/${username}`)) {
			this.#sudo(`loginctl enable-linger ${username}`);
		}

		const unitContent = this.#generateSystemdUnit();
		mkdirSync(dirname(this.serviceFilePath), { recursive: true });
		writeFileSync(this.serviceFilePath, unitContent);
		log.debug({ filePath: this.serviceFilePath }, "Wrote systemd unit");
		this.#exec("systemctl --user daemon-reload");
		this.#exec("systemctl --user enable macroclaw");
		this.#exec("systemctl --user start macroclaw");
	}

	uninstall(): void {
		this.#requireInstalled();

		if (this.#platform === "launchd") {
			if (this.isRunning) {
				this.#exec(`launchctl unload ${this.serviceFilePath}`);
			}
			rmSync(this.serviceFilePath);
		} else {
			if (this.isRunning) {
				this.#exec("systemctl --user stop macroclaw");
			}
			try { this.#exec("systemctl --user disable macroclaw"); } catch { /* already disabled */ }
			rmSync(this.serviceFilePath);
			this.#exec("systemctl --user daemon-reload");
		}

		log.debug("Service uninstalled");
	}

	start(): string {
		this.#requireInstalled();

		if (this.isRunning) {
			throw new Error("Service is already running.");
		}

		if (this.#platform === "launchd") {
			this.#exec(`launchctl load ${this.serviceFilePath}`);
		} else {
			this.#exec("systemctl --user start macroclaw");
		}

		log.debug("Service started");
		return this.#logTailCommand();
	}

	restart(): string {
		this.#requireInstalled();

		if (this.isRunning) {
			this.stop();
		}

		return this.start();
	}

	stop(): void {
		this.#requireInstalled();

		if (!this.isRunning) {
			throw new Error("Service is not running.");
		}

		if (this.#platform === "launchd") {
			this.#exec(`launchctl unload ${this.serviceFilePath}`);
		} else {
			this.#exec("systemctl --user stop macroclaw");
		}

		log.debug("Service stopped");
	}

	update(): UpdateResult {
		this.#requireInstalled();

		const previousVersion = this.#getInstalledVersion();
		this.#exec("bun install -g macroclaw@latest");
		const currentVersion = this.#getInstalledVersion();

		log.debug({ previousVersion, currentVersion }, "Service updated");
		return { previousVersion, currentVersion };
	}

	status(): ServiceStatus {
		const result: ServiceStatus = {
			installed: this.isInstalled,
			running: this.isRunning,
			platform: this.#platform,
		};

		if (result.running) {
			if (this.#platform === "launchd") {
				try {
					const out = this.#exec(`launchctl list ${LAUNCHD_LABEL}`);
					const pidMatch = /"PID"\s*=\s*(\d+)/.exec(out);
					if (pidMatch) result.pid = Number(pidMatch[1]);
				} catch { /* best effort */ }
			} else {
				try {
					const out = this.#exec("systemctl --user show macroclaw --property=MainPID,ActiveEnterTimestamp --no-pager");
					const pidMatch = /MainPID=(\d+)/.exec(out);
					if (pidMatch && pidMatch[1] !== "0") result.pid = Number(pidMatch[1]);
					const tsMatch = /ActiveEnterTimestamp=(.+)/.exec(out);
					if (tsMatch?.[1].trim()) result.uptime = tsMatch[1].trim();
				} catch { /* best effort */ }
			}
		}

		return result;
	}

	logs(follow = false): string {
		if (this.#platform === "launchd") {
			const logDir = resolve(this.#home, ".macroclaw/logs");
			return follow
				? `tail -f ${logDir}/stdout.log ${logDir}/stderr.log`
				: `tail -n 50 ${logDir}/stdout.log`;
		}
		return follow
			? "journalctl --user -u macroclaw -f"
			: "journalctl --user -u macroclaw -n 50 --no-pager";
	}

	#exec(cmd: string): string {
		return execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).toString();
	}


	#getInstalledVersion(): string {
		try {
			const output = this.#exec("bun pm ls -g");
			const match = /macroclaw@(\S+)/.exec(output);
			return match?.[1] ?? "unknown";
		} catch {
			return "unknown";
		}
	}

	#requireInstalled(): void {
		if (!this.isInstalled) {
			throw new Error("Service not installed. Run `macroclaw service install` first.");
		}
	}

	#logTailCommand(): string {
		if (this.#platform === "launchd") {
			const logDir = resolve(this.#home, ".macroclaw/logs");
			return `tail -f ${logDir}/*.log`;
		}
		return "journalctl --user -u macroclaw -f";
	}

	#sudo(cmd: string): void {
		this.#exec(`sudo ${cmd}`);
	}

	#generateLaunchdPlist(): string {
		const logDir = resolve(this.#home, ".macroclaw/logs");
		return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>com.macroclaw</string>
	<key>ProgramArguments</key>
	<array>
		<string>/bin/bash</string>
		<string>-lc</string>
		<string>exec bun macroclaw start</string>
	</array>
	<key>KeepAlive</key>
	<true/>
	<key>StandardOutPath</key>
	<string>${logDir}/stdout.log</string>
	<key>StandardErrorPath</key>
	<string>${logDir}/stderr.log</string>
</dict>
</plist>
`;
	}

	#generateSystemdUnit(): string {
		return `[Unit]
Description=Macroclaw - Telegram-to-Claude-Code bridge
After=network.target

[Service]
Type=simple
WorkingDirectory=%h
ExecStart=/bin/bash -lc 'exec bun macroclaw start'
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
	}
}
