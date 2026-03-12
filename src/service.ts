import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { userInfo as osUserInfo, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createLogger } from "./logger";

const log = createLogger("service");
const LAUNCHD_LABEL = "com.macroclaw";

export type Platform = "launchd" | "systemd";

export interface ServiceDeps {
	existsSync: (path: string) => boolean;
	writeFileSync: (path: string, data: string) => void;
	mkdirSync: (path: string, opts?: { recursive: boolean }) => void;
	rmSync: (path: string) => void;
	execSync: (cmd: string, opts?: object) => string;
	tmpdir: () => string;
	randomUUID: () => string;
	userInfo: () => { username: string; homedir: string };
	platform: string;
	home: string;
}

function defaultDeps(): ServiceDeps {
	return {
		existsSync,
		writeFileSync,
		mkdirSync: (path, opts) => mkdirSync(path, opts),
		rmSync,
		execSync: (cmd, opts) => execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], ...opts }).toString(),
		tmpdir,
		randomUUID,
		userInfo: () => ({ username: osUserInfo().username, homedir: osUserInfo().homedir }),
		platform: process.platform,
		home: process.env.HOME || "~",
	};
}

function detectPlatform(platform: string): Platform {
	if (platform === "darwin") return "launchd";
	if (platform === "linux") return "systemd";
	throw new Error("Unsupported platform. Only macOS (launchd) and Linux (systemd) are supported.");
}

interface LinuxUser {
	user: string;
	group: string;
	home: string;
}

export interface SystemService {
	install: (oauthToken?: string) => string;
	uninstall: () => void;
	start: () => string;
	stop: () => void;
	update: () => string;
}

export class ServiceManager implements SystemService {
	readonly #deps: ServiceDeps;
	readonly #platform: Platform;

	constructor(deps?: Partial<ServiceDeps>) {
		this.#deps = { ...defaultDeps(), ...deps };
		this.#platform = detectPlatform(this.#deps.platform);
	}

	get platform(): Platform {
		return this.#platform;
	}

	get serviceFilePath(): string {
		return this.#platform === "launchd"
			? resolve(this.#deps.home, "Library/LaunchAgents/com.macroclaw.plist")
			: "/etc/systemd/system/macroclaw.service";
	}

	get isInstalled(): boolean {
		return this.#deps.existsSync(this.serviceFilePath);
	}

	get isRunning(): boolean {
		if (this.#platform === "launchd") {
			try {
				const out = this.#deps.execSync(`launchctl list ${LAUNCHD_LABEL}`);
				// If the PID line shows a number (not "-"), the service is running
				return /"PID"\s*=\s*\d+/.test(out);
			} catch {
				return false;
			}
		}
		try {
			const out = this.#deps.execSync("systemctl is-active macroclaw");
			return out.trim() === "active";
		} catch {
			return false;
		}
	}

	install(oauthToken?: string): string {
		if (this.#platform === "launchd") {
			this.#installLaunchd(oauthToken);
		} else {
			this.#installSystemd();
		}
		log.debug("Service installed and started");
		return this.#logTailCommand();
	}

	#installLaunchd(oauthToken?: string): void {
		const settingsPath = resolve(this.#deps.home, ".macroclaw/settings.json");
		if (!this.#deps.existsSync(settingsPath)) {
			throw new Error("Settings not found. Run `macroclaw setup` first.");
		}

		this.#deps.execSync("bun install -g macroclaw");
		const bunPath = this.#resolvePath("bun");
		const claudePath = this.#resolvePath("claude");
		const macroclawPath = this.#resolveGlobalBinPath("macroclaw");

		const pathDirs = [...new Set([dirname(bunPath), dirname(claudePath), dirname(macroclawPath)])];

		const logDir = resolve(this.#deps.home, ".macroclaw/logs");
		this.#deps.mkdirSync(logDir, { recursive: true });
		if (this.isRunning) {
			this.#deps.execSync(`launchctl unload ${this.serviceFilePath}`);
		}

		this.#deps.writeFileSync(this.serviceFilePath, this.#generateLaunchdPlist(bunPath, macroclawPath, pathDirs, oauthToken));
		log.debug({ filePath: this.serviceFilePath }, "Wrote launchd plist");
		this.#deps.execSync(`launchctl load ${this.serviceFilePath}`);
	}

	#installSystemd(): void {
		const target = this.#resolveLinuxUser();

		if (this.isRunning) {
			this.#sudo("systemctl stop macroclaw");
		}

		this.#deps.execSync("bun install -g macroclaw");
		const bunPath = this.#resolvePath("bun");
		const claudePath = this.#resolvePath("claude");
		const macroclawPath = this.#resolveGlobalBinPath("macroclaw");

		const pathDirs = [...new Set([dirname(bunPath), dirname(claudePath), dirname(macroclawPath)])];

		const unitContent = this.#generateSystemdUnit(bunPath, macroclawPath, target, pathDirs);
		this.#writeSystemdUnit(unitContent);
		log.debug({ filePath: this.serviceFilePath, user: target.user }, "Wrote systemd unit");
		this.#sudo("systemctl daemon-reload");
		this.#sudo("systemctl enable macroclaw");
		this.#sudo("systemctl start macroclaw");
	}

	uninstall(): void {
		this.#requireInstalled();

		if (this.#platform === "launchd") {
			if (this.isRunning) {
				this.#deps.execSync(`launchctl unload ${this.serviceFilePath}`);
			}
			this.#deps.rmSync(this.serviceFilePath);
		} else {
			if (this.isRunning) {
				this.#sudo("systemctl stop macroclaw");
			}
			try { this.#sudo("systemctl disable macroclaw"); } catch { /* already disabled */ }
			this.#sudo(`rm ${this.serviceFilePath}`);
			this.#sudo("systemctl daemon-reload");
		}

		log.debug("Service uninstalled");
	}

	start(): string {
		this.#requireInstalled();

		if (this.isRunning) {
			throw new Error("Service is already running.");
		}

		if (this.#platform === "launchd") {
			this.#deps.execSync(`launchctl load ${this.serviceFilePath}`);
		} else {
			this.#sudo("systemctl start macroclaw");
		}

		log.debug("Service started");
		return this.#logTailCommand();
	}

	stop(): void {
		this.#requireInstalled();

		if (!this.isRunning) {
			throw new Error("Service is not running.");
		}

		if (this.#platform === "launchd") {
			this.#deps.execSync(`launchctl unload ${this.serviceFilePath}`);
		} else {
			this.#sudo("systemctl stop macroclaw");
		}

		log.debug("Service stopped");
	}

	update(): string {
		this.#requireInstalled();

		if (this.#platform === "launchd") {
			if (this.isRunning) {
				this.#deps.execSync(`launchctl unload ${this.serviceFilePath}`);
			}
			this.#deps.execSync("bun install -g macroclaw@latest");
			this.#deps.execSync(`launchctl load ${this.serviceFilePath}`);
		} else {
			if (this.isRunning) {
				this.#sudo("systemctl stop macroclaw");
			}
			this.#deps.execSync("bun install -g macroclaw@latest");
			this.#sudo("systemctl start macroclaw");
		}

		log.debug("Service updated (reinstalled, restarted)");
		return this.#logTailCommand();
	}

	#resolvePath(binary: string): string {
		try {
			return this.#deps.execSync(`which ${binary}`).trim();
		} catch {
			throw new Error(`Could not resolve ${binary} path. Is it installed?`);
		}
	}

	#resolveGlobalBinPath(binary: string): string {
		const binDir = this.#deps.execSync("bun pm bin -g").trim();
		const binPath = join(binDir, binary);
		if (!this.#deps.existsSync(binPath)) {
			throw new Error(`Could not find ${binary} in ${binDir}. Is it installed?`);
		}
		return binPath;
	}


	#requireInstalled(): void {
		if (!this.isInstalled) {
			throw new Error("Service not installed. Run `macroclaw service install` first.");
		}
	}

	#logTailCommand(): string {
		if (this.#platform === "launchd") {
			const logDir = resolve(this.#deps.home, ".macroclaw/logs");
			return `tail -f ${logDir}/*.log`;
		}
		return "journalctl -u macroclaw -f";
	}

	#sudo(cmd: string): void {
		this.#deps.execSync(`sudo ${cmd}`);
	}

	/** Write unit content to a temp file, then sudo-copy it into /etc/systemd/system/. */
	#writeSystemdUnit(content: string): void {
		const tmpPath = join(this.#deps.tmpdir(), `macroclaw-${this.#deps.randomUUID()}.service`);
		this.#deps.writeFileSync(tmpPath, content);
		try {
			this.#sudo(`cp ${tmpPath} ${this.serviceFilePath}`);
		} finally {
			try { this.#deps.rmSync(tmpPath); } catch { /* best-effort cleanup */ }
		}
	}

	#resolveLinuxUser(): LinuxUser {
		const info = this.#deps.userInfo();
		const user = info.username;
		const home = info.homedir;
		const group = this.#deps.execSync(`id -gn ${user}`).trim();

		const settingsPath = resolve(home, ".macroclaw/settings.json");
		if (!this.#deps.existsSync(settingsPath)) {
			throw new Error(`Settings not found. Run \`macroclaw setup\` first.`);
		}

		return { user, group, home };
	}

	#generateLaunchdPlist(bunPath: string, macroclawPath: string, pathDirs: string[], oauthToken?: string): string {
		const logDir = resolve(this.#deps.home, ".macroclaw/logs");
		const tokenEnv = oauthToken ? `\n\t\t<key>CLAUDE_CODE_OAUTH_TOKEN</key>\n\t\t<string>${oauthToken}</string>` : "";
		return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>com.macroclaw</string>
	<key>ProgramArguments</key>
	<array>
		<string>${bunPath}</string>
		<string>${macroclawPath}</string>
		<string>start</string>
	</array>
	<key>KeepAlive</key>
	<true/>
	<key>StandardOutPath</key>
	<string>${logDir}/stdout.log</string>
	<key>StandardErrorPath</key>
	<string>${logDir}/stderr.log</string>
	<key>EnvironmentVariables</key>
	<dict>
		<key>HOME</key>
		<string>${this.#deps.home}</string>
		<key>PATH</key>
		<string>${pathDirs.join(":")}</string>${tokenEnv}
	</dict>
</dict>
</plist>
`;
	}

	#generateSystemdUnit(bunPath: string, macroclawPath: string, target: LinuxUser, pathDirs: string[]): string {
		return `[Unit]
Description=Macroclaw - Telegram-to-Claude-Code bridge
After=network.target

[Service]
Type=simple
User=${target.user}
Group=${target.group}
Environment=HOME=${target.home}
Environment=PATH=${pathDirs.join(":")}
WorkingDirectory=${target.home}
ExecStart=${bunPath} ${macroclawPath} start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
`;
	}
}
