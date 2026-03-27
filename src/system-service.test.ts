import { beforeEach, describe, expect, it, mock } from "bun:test";
import { join } from "node:path";

// Capture real fs functions before mocking
const realFs = await import("node:fs");
const { existsSync: realExistsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = realFs;
const existsSync = realExistsSync;

// Mock child_process and os — safe since no other tests depend on real execSync or userInfo
const DEFAULT_LOGIN_PATH = "/usr/local/bin:/usr/bin:/bin";
const DEFAULT_BUN_GLOBAL_BIN = "/home/testuser/.bun/bin";
const DEFAULT_SERVICE_PATH = `${DEFAULT_BUN_GLOBAL_BIN}:${DEFAULT_LOGIN_PATH}`;
const DEFAULT_EXECUTABLE_PATH = `${DEFAULT_BUN_GLOBAL_BIN}/macroclaw`;
const mockExecSync = mock((cmd: string, _opts?: object): string => {
	if (cmd === "/bin/bash -lc 'printf %s \"$PATH\"'") return `${DEFAULT_LOGIN_PATH}\n`;
	if (cmd === "bun pm bin -g") return `${DEFAULT_BUN_GLOBAL_BIN}\n`;
	return "";
});
const mockUserInfo = mock(() => ({ username: "testuser", homedir: "/home/testuser", uid: 1000, gid: 1000, shell: "/bin/bash" }));
const mockExistsSync = mock((path: string) => realExistsSync(path));

mock.module("node:child_process", () => ({
	execSync: (...args: unknown[]) => mockExecSync(args[0] as string, args[1] as object),
}));

mock.module("node:os", () => ({
	userInfo: () => mockUserInfo(),
	tmpdir: () => "/tmp",
}));

mock.module("node:fs", () => {
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(realFs)) {
		result[key] = key === "existsSync" ? (path: string) => mockExistsSync(path) : value;
	}
	return result;
});

const { SystemServiceManager } = await import("./system-service");

function createManager(opts?: { platform?: string; home?: string }): InstanceType<typeof SystemServiceManager> {
	return new SystemServiceManager({ platform: opts?.platform ?? "linux", home: opts?.home ?? "/home/testuser", ...opts });
}

const LAUNCHD_RUNNING = `{\n\t"PID" = 12345;\n\t"Label" = "com.macroclaw";\n}`;
const LAUNCHD_STOPPED = `{\n\t"Label" = "com.macroclaw";\n}`;
const SYSTEMD_ACTIVE = "active";
const SYSTEMD_INACTIVE = "inactive";

beforeEach(() => {
	mockExecSync.mockClear();
	mockUserInfo.mockClear();
	mockExistsSync.mockClear();
	mockExecSync.mockImplementation((cmd: string, _opts?: object): string => {
		if (cmd === "/bin/bash -lc 'printf %s \"$PATH\"'") return `${DEFAULT_LOGIN_PATH}\n`;
		if (cmd === "bun pm bin -g") return `${DEFAULT_BUN_GLOBAL_BIN}\n`;
		return "";
	});
	mockUserInfo.mockImplementation(() => ({ username: "testuser", homedir: "/home/testuser", uid: 1000, gid: 1000, shell: "/bin/bash" }));
	mockExistsSync.mockImplementation((path: string) => realExistsSync(path));
});

describe("constructor", () => {
	it("detects launchd on darwin", () => {
		const mgr = createManager({ platform: "darwin" });
		expect(mgr.platform).toBe("launchd");
	});

	it("detects systemd on linux", () => {
		const mgr = createManager({ platform: "linux" });
		expect(mgr.platform).toBe("systemd");
	});

	it("throws on unsupported platform", () => {
		expect(() => createManager({ platform: "win32" })).toThrow(
			"Unsupported platform. Only macOS (launchd) and Linux (systemd) are supported.",
		);
	});
});

describe("serviceFilePath", () => {
	it("returns plist path for launchd", () => {
		const mgr = createManager({ platform: "darwin" });
		expect(mgr.serviceFilePath).toContain("Library/LaunchAgents/com.macroclaw.plist");
	});

	it("returns user systemd path for systemd", () => {
		const mgr = createManager({ platform: "linux", home: "/home/testuser" });
		expect(mgr.serviceFilePath).toBe("/home/testuser/.config/systemd/user/macroclaw.service");
	});
});

describe("isInstalled", () => {
	it("returns true when service file exists", () => {
		// serviceFilePath for launchd resolves to home + Library/... which won't exist
		// Use systemd path which is /etc/systemd/system/macroclaw.service — also won't exist
		// So we test with a home that has the plist file
		const tmpHome = `/tmp/macroclaw-test-isinstalled-${Date.now()}`;
		const plistDir = join(tmpHome, "Library/LaunchAgents");
		mkdirSync(plistDir, { recursive: true });
		writeFileSync(join(plistDir, "com.macroclaw.plist"), "test");
		const mgr = createManager({ platform: "darwin", home: tmpHome });
		expect(mgr.isInstalled).toBe(true);
		rmSync(tmpHome, { recursive: true });
	});

	it("returns false when service file does not exist", () => {
		const mgr = createManager({ platform: "darwin", home: "/nonexistent" });
		expect(mgr.isInstalled).toBe(false);
	});
});

describe("isRunning", () => {
	it("returns true when launchd service has a PID", () => {
		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd.startsWith("launchctl list ")) return LAUNCHD_RUNNING;
			return "";
		});
		const mgr = createManager({ platform: "darwin" });
		expect(mgr.isRunning).toBe(true);
	});

	it("returns false when launchd service has no PID", () => {
		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd.startsWith("launchctl list ")) return LAUNCHD_STOPPED;
			return "";
		});
		const mgr = createManager({ platform: "darwin" });
		expect(mgr.isRunning).toBe(false);
	});

	it("returns false when launchctl list throws", () => {
		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd.startsWith("launchctl list ")) throw new Error("not found");
			return "";
		});
		const mgr = createManager({ platform: "darwin" });
		expect(mgr.isRunning).toBe(false);
	});

	it("returns true when systemd service is active", () => {
		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd === "systemctl --user is-active macroclaw") return SYSTEMD_ACTIVE;
			return "";
		});
		const mgr = createManager();
		expect(mgr.isRunning).toBe(true);
	});

	it("returns false when systemd service is inactive", () => {
		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd === "systemctl --user is-active macroclaw") return SYSTEMD_INACTIVE;
			return "";
		});
		const mgr = createManager();
		expect(mgr.isRunning).toBe(false);
	});

	it("returns false when systemctl throws", () => {
		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd === "systemctl --user is-active macroclaw") throw new Error("not found");
			return "";
		});
		const mgr = createManager();
		expect(mgr.isRunning).toBe(false);
	});
});

describe("install", () => {
	it("throws when settings.json is missing on macOS", () => {
		const mgr = createManager({ platform: "darwin", home: "/nonexistent" });
		expect(() => mgr.install()).toThrow(
			"Settings not found. Run `macroclaw setup` first.",
		);
	});

	it("throws when settings.json is missing on Linux", () => {
		const mgr = createManager({ home: "/nonexistent" });
		expect(() => mgr.install()).toThrow("Settings not found. Run `macroclaw setup` first.");
	});

	it("runs global install and resolves login shell PATH for systemd", () => {
		const tmpHome = `/tmp/macroclaw-test-install-${Date.now()}`;
		mkdirSync(join(tmpHome, ".macroclaw"), { recursive: true });
		writeFileSync(join(tmpHome, ".macroclaw/settings.json"), "{}");

		mockUserInfo.mockImplementation(() => ({ username: "testuser", homedir: tmpHome, uid: 1000, gid: 1000, shell: "/bin/bash" }));
		// Mock existsSync to handle linger check
		mockExistsSync.mockImplementation((path: string) => {
			if (path === "/var/lib/systemd/linger/testuser") return true; // already lingering
			return realExistsSync(path);
		});
		const mgr = createManager({ home: tmpHome });
		mgr.install();
		rmSync(tmpHome, { recursive: true });

		expect(mockExecSync).toHaveBeenCalledWith("bun install -g macroclaw", expect.anything());
		expect(mockExecSync).toHaveBeenCalledWith("/bin/bash -lc 'printf %s \"$PATH\"'", expect.anything());
		expect(mockExecSync).toHaveBeenCalledWith("bun pm bin -g", expect.anything());
		expect(mockExecSync).not.toHaveBeenCalledWith("which macroclaw", expect.anything());
	});

	it("surfaces login shell PATH resolution failures for systemd", () => {
		const tmpHome = `/tmp/macroclaw-test-install-missing-path-${Date.now()}`;
		mkdirSync(join(tmpHome, ".macroclaw"), { recursive: true });
		writeFileSync(join(tmpHome, ".macroclaw/settings.json"), "{}");

		mockUserInfo.mockImplementation(() => ({ username: "testuser", homedir: tmpHome, uid: 1000, gid: 1000, shell: "/bin/bash" }));
		mockExistsSync.mockImplementation((path: string) => {
			if (path === "/var/lib/systemd/linger/testuser") return true;
			return realExistsSync(path);
		});
		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd === "/bin/bash -lc 'printf %s \"$PATH\"'") throw new Error("not found");
			return "";
		});

		const mgr = createManager({ home: tmpHome });
		expect(() => mgr.install()).toThrow(
			"not found",
		);
		expect(existsSync(join(tmpHome, ".config/systemd/user/macroclaw.service"))).toBe(false);
		expect(mockExecSync).not.toHaveBeenCalledWith("systemctl --user daemon-reload", expect.anything());
		rmSync(tmpHome, { recursive: true });
	});

	it("installs launchd service with direct macroclaw invocation and OAuth token", () => {
		const tmpHome = `/tmp/macroclaw-test-launchd-${Date.now()}`;
		mkdirSync(join(tmpHome, ".macroclaw"), { recursive: true });
		writeFileSync(join(tmpHome, ".macroclaw/settings.json"), "{}");
		const plistDir = join(tmpHome, "Library/LaunchAgents");
		mkdirSync(plistDir, { recursive: true });

		const mgr = createManager({ platform: "darwin", home: tmpHome });
		mgr.install("sk-test-token");

		const plistPath = join(plistDir, "com.macroclaw.plist");
		expect(existsSync(plistPath)).toBe(true);
		const writtenContent = readFileSync(plistPath, "utf-8");
		expect(writtenContent).toContain(`<string>${DEFAULT_EXECUTABLE_PATH}</string>`);
		expect(writtenContent).toContain("<string>start</string>");
		expect(writtenContent).toContain("<key>KeepAlive</key>");
		expect(writtenContent).toContain(".macroclaw/logs/stdout.log");
		expect(writtenContent).toContain("<key>EnvironmentVariables</key>");
		expect(writtenContent).toContain("<key>PATH</key>");
		expect(writtenContent).toContain(`<string>${DEFAULT_SERVICE_PATH}</string>`);
		expect(writtenContent).not.toContain("<key>HOME</key>");
		// OAuth token is preserved
		expect(writtenContent).toContain("<key>CLAUDE_CODE_OAUTH_TOKEN</key>");
		expect(writtenContent).toContain("<string>sk-test-token</string>");
		expect(mockExecSync).toHaveBeenCalledWith(expect.stringContaining("launchctl load"), expect.anything());
		expect(mockExecSync).not.toHaveBeenCalledWith("which macroclaw", expect.anything());
		rmSync(tmpHome, { recursive: true });
	});

	it("surfaces login shell PATH resolution failures for launchd", () => {
		const tmpHome = `/tmp/macroclaw-test-launchd-missing-path-${Date.now()}`;
		mkdirSync(join(tmpHome, ".macroclaw"), { recursive: true });
		writeFileSync(join(tmpHome, ".macroclaw/settings.json"), "{}");
		mkdirSync(join(tmpHome, "Library/LaunchAgents"), { recursive: true });

		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd === "/bin/bash -lc 'printf %s \"$PATH\"'") throw new Error("not found");
			return "";
		});

		const mgr = createManager({ platform: "darwin", home: tmpHome });
		expect(() => mgr.install("sk-test-token")).toThrow(
			"not found",
		);
		expect(existsSync(join(tmpHome, "Library/LaunchAgents/com.macroclaw.plist"))).toBe(false);
		expect(mockExecSync).not.toHaveBeenCalledWith(expect.stringContaining("launchctl load"), expect.anything());
		rmSync(tmpHome, { recursive: true });
	});

	it("surfaces login shell PATH permission failures for launchd", () => {
		const tmpHome = `/tmp/macroclaw-test-launchd-missing-bin-dir-${Date.now()}`;
		mkdirSync(join(tmpHome, ".macroclaw"), { recursive: true });
		writeFileSync(join(tmpHome, ".macroclaw/settings.json"), "{}");
		mkdirSync(join(tmpHome, "Library/LaunchAgents"), { recursive: true });

		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd === "/bin/bash -lc 'printf %s \"$PATH\"'") throw new Error("permission denied");
			return "";
		});

		const mgr = createManager({ platform: "darwin", home: tmpHome });
		expect(() => mgr.install("sk-test-token")).toThrow(
			"permission denied",
		);
		rmSync(tmpHome, { recursive: true });
	});

	it("installs launchd service without token when not provided", () => {
		const tmpHome = `/tmp/macroclaw-test-notoken-${Date.now()}`;
		mkdirSync(join(tmpHome, ".macroclaw"), { recursive: true });
		writeFileSync(join(tmpHome, ".macroclaw/settings.json"), "{}");
		mkdirSync(join(tmpHome, "Library/LaunchAgents"), { recursive: true });

		const mgr = createManager({ platform: "darwin", home: tmpHome });
		mgr.install();
		const writtenContent = readFileSync(join(tmpHome, "Library/LaunchAgents/com.macroclaw.plist"), "utf-8");
		expect(writtenContent).toContain("<key>EnvironmentVariables</key>");
		expect(writtenContent).toContain("<key>PATH</key>");
		expect(writtenContent).toContain(`<string>${DEFAULT_SERVICE_PATH}</string>`);
		expect(writtenContent).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
		rmSync(tmpHome, { recursive: true });
	});

	it("stops running launchd service before reinstalling", () => {
		const tmpHome = `/tmp/macroclaw-test-stopfirst-${Date.now()}`;
		mkdirSync(join(tmpHome, ".macroclaw"), { recursive: true });
		writeFileSync(join(tmpHome, ".macroclaw/settings.json"), "{}");
		mkdirSync(join(tmpHome, "Library/LaunchAgents"), { recursive: true });

		const calls: string[] = [];
		mockExecSync.mockImplementation((cmd: string) => {
			calls.push(cmd);
			if (cmd.startsWith("launchctl list ")) return LAUNCHD_RUNNING;
			return "";
		});
		const mgr = createManager({ platform: "darwin", home: tmpHome });
		mgr.install();
		const unloadIdx = calls.findIndex(c => c.includes("launchctl unload"));
		const loadIdx = calls.findIndex(c => c.includes("launchctl load"));
		expect(unloadIdx).toBeGreaterThan(-1);
		expect(loadIdx).toBeGreaterThan(unloadIdx);
		rmSync(tmpHome, { recursive: true });
	});

	it("skips unload when launchd service is not running", () => {
		const tmpHome = `/tmp/macroclaw-test-skipunload-${Date.now()}`;
		mkdirSync(join(tmpHome, ".macroclaw"), { recursive: true });
		writeFileSync(join(tmpHome, ".macroclaw/settings.json"), "{}");
		mkdirSync(join(tmpHome, "Library/LaunchAgents"), { recursive: true });

		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd.startsWith("launchctl list ")) return LAUNCHD_STOPPED;
			return "";
		});
		const mgr = createManager({ platform: "darwin", home: tmpHome });
		mgr.install();
		expect(mockExecSync).not.toHaveBeenCalledWith(expect.stringContaining("launchctl unload"), expect.anything());
		rmSync(tmpHome, { recursive: true });
	});

	it("installs systemd user service with direct macroclaw invocation and no hardcoded paths", () => {
		const tmpHome = `/tmp/macroclaw-test-systemd-${Date.now()}`;
		mkdirSync(join(tmpHome, ".macroclaw"), { recursive: true });
		writeFileSync(join(tmpHome, ".macroclaw/settings.json"), "{}");

		mockUserInfo.mockImplementation(() => ({ username: "testuser", homedir: tmpHome, uid: 1000, gid: 1000, shell: "/bin/bash" }));
		// Mock existsSync: linger file does not exist (triggers sudo loginctl)
		mockExistsSync.mockImplementation((path: string) => {
			if (path === "/var/lib/systemd/linger/testuser") return false;
			return realExistsSync(path);
		});
		const mgr = createManager({ home: tmpHome });
		mgr.install();

		// Unit file written directly (no sudo cp)
		const unitPath = join(tmpHome, ".config/systemd/user/macroclaw.service");
		expect(existsSync(unitPath)).toBe(true);
		const unitContent = readFileSync(unitPath, "utf-8");
		expect(unitContent).toContain("WantedBy=default.target");
		expect(unitContent).not.toContain("User=");
		expect(unitContent).not.toContain("Group=");
		// systemd snapshots the login shell PATH and ensures Bun's global bin is included
		expect(unitContent).not.toContain("Environment=HOME=");
		expect(unitContent).toContain(`Environment=PATH=${DEFAULT_SERVICE_PATH}`);
		expect(unitContent).toContain("WorkingDirectory=%h");
		expect(unitContent).toContain(`ExecStart=${DEFAULT_EXECUTABLE_PATH} start`);

		// Lingering enabled via sudo
		expect(mockExecSync).toHaveBeenCalledWith("sudo loginctl enable-linger testuser", expect.anything());
		// User systemctl commands (no sudo)
		expect(mockExecSync).toHaveBeenCalledWith("systemctl --user daemon-reload", expect.anything());
		expect(mockExecSync).toHaveBeenCalledWith("systemctl --user enable macroclaw", expect.anything());
		expect(mockExecSync).toHaveBeenCalledWith("systemctl --user start macroclaw", expect.anything());
		// No sudo systemctl calls
		for (const call of mockExecSync.mock.calls) {
			expect(call[0]).not.toMatch(/^sudo systemctl/);
		}
		rmSync(tmpHome, { recursive: true });
	});

	it("skips lingering when already enabled", () => {
		const tmpHome = `/tmp/macroclaw-test-linger-${Date.now()}`;
		mkdirSync(join(tmpHome, ".macroclaw"), { recursive: true });
		writeFileSync(join(tmpHome, ".macroclaw/settings.json"), "{}");

		mockUserInfo.mockImplementation(() => ({ username: "testuser", homedir: tmpHome, uid: 1000, gid: 1000, shell: "/bin/bash" }));
		// Linger already enabled
		mockExistsSync.mockImplementation((path: string) => {
			if (path === "/var/lib/systemd/linger/testuser") return true;
			return realExistsSync(path);
		});
		const mgr = createManager({ home: tmpHome });
		mgr.install();

		expect(mockExecSync).not.toHaveBeenCalledWith("sudo loginctl enable-linger testuser", expect.anything());
		rmSync(tmpHome, { recursive: true });
	});

	it("does not require sudo for bun install -g", () => {
		const tmpHome = `/tmp/macroclaw-test-nosudo-${Date.now()}`;
		mkdirSync(join(tmpHome, ".macroclaw"), { recursive: true });
		writeFileSync(join(tmpHome, ".macroclaw/settings.json"), "{}");

		mockUserInfo.mockImplementation(() => ({ username: "testuser", homedir: tmpHome, uid: 1000, gid: 1000, shell: "/bin/bash" }));
		mockExistsSync.mockImplementation((path: string) => {
			if (path === "/var/lib/systemd/linger/testuser") return true;
			return realExistsSync(path);
		});
		const mgr = createManager({ home: tmpHome });
		mgr.install();
		expect(mockExecSync).toHaveBeenCalledWith("bun install -g macroclaw", expect.anything());
		expect(mockExecSync).not.toHaveBeenCalledWith("sudo bun install -g macroclaw", expect.anything());
		rmSync(tmpHome, { recursive: true });
	});

	it("macOS install does not use sudo", () => {
		const tmpHome = `/tmp/macroclaw-test-macos-${Date.now()}`;
		mkdirSync(join(tmpHome, ".macroclaw"), { recursive: true });
		writeFileSync(join(tmpHome, ".macroclaw/settings.json"), "{}");
		mkdirSync(join(tmpHome, "Library/LaunchAgents"), { recursive: true });

		const mgr = createManager({ platform: "darwin", home: tmpHome });
		mgr.install();
		for (const call of mockExecSync.mock.calls) {
			expect(call[0]).not.toMatch(/^sudo /);
		}
		rmSync(tmpHome, { recursive: true });
	});
});

describe("uninstall", () => {
	it("throws when service is not installed", () => {
		const mgr = createManager({ platform: "darwin", home: "/nonexistent" });
		expect(() => mgr.uninstall()).toThrow(
			"Service not installed. Run `macroclaw service install` first.",
		);
	});

	it("uninstalls running launchd service", () => {
		const tmpHome = `/tmp/macroclaw-test-uninstall-${Date.now()}`;
		const plistDir = join(tmpHome, "Library/LaunchAgents");
		mkdirSync(plistDir, { recursive: true });
		const plistPath = join(plistDir, "com.macroclaw.plist");
		writeFileSync(plistPath, "test");

		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd.startsWith("launchctl list ")) return LAUNCHD_RUNNING;
			return "";
		});
		const mgr = createManager({ platform: "darwin", home: tmpHome });
		mgr.uninstall();
		expect(mockExecSync).toHaveBeenCalledWith(expect.stringContaining("launchctl unload"), expect.anything());
		expect(existsSync(plistPath)).toBe(false);
		rmSync(tmpHome, { recursive: true, force: true });
	});

	it("uninstalls stopped launchd service without unloading", () => {
		const tmpHome = `/tmp/macroclaw-test-uninstall2-${Date.now()}`;
		const plistDir = join(tmpHome, "Library/LaunchAgents");
		mkdirSync(plistDir, { recursive: true });
		writeFileSync(join(plistDir, "com.macroclaw.plist"), "test");

		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd.startsWith("launchctl list ")) return LAUNCHD_STOPPED;
			return "";
		});
		const mgr = createManager({ platform: "darwin", home: tmpHome });
		mgr.uninstall();
		expect(mockExecSync).not.toHaveBeenCalledWith(expect.stringContaining("launchctl unload"), expect.anything());
		rmSync(tmpHome, { recursive: true, force: true });
	});

	it("uninstalls running systemd user service", () => {
		const tmpHome = `/tmp/macroclaw-test-unsys-${Date.now()}`;
		const unitDir = join(tmpHome, ".config/systemd/user");
		mkdirSync(unitDir, { recursive: true });
		const unitPath = join(unitDir, "macroclaw.service");
		writeFileSync(unitPath, "test");

		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd === "systemctl --user is-active macroclaw") return SYSTEMD_ACTIVE;
			return "";
		});
		const mgr = createManager({ platform: "linux", home: tmpHome });
		mgr.uninstall();
		expect(mockExecSync).toHaveBeenCalledWith("systemctl --user stop macroclaw", expect.anything());
		expect(mockExecSync).toHaveBeenCalledWith("systemctl --user disable macroclaw", expect.anything());
		expect(mockExecSync).toHaveBeenCalledWith("systemctl --user daemon-reload", expect.anything());
		expect(existsSync(unitPath)).toBe(false);
		// No sudo for systemctl
		for (const call of mockExecSync.mock.calls) {
			expect(call[0]).not.toMatch(/^sudo /);
		}
		rmSync(tmpHome, { recursive: true, force: true });
	});

	it("uninstalls stopped systemd user service without stopping", () => {
		const tmpHome = `/tmp/macroclaw-test-unsys2-${Date.now()}`;
		const unitDir = join(tmpHome, ".config/systemd/user");
		mkdirSync(unitDir, { recursive: true });
		writeFileSync(join(unitDir, "macroclaw.service"), "test");

		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd === "systemctl --user is-active macroclaw") throw new Error("inactive");
			return "";
		});
		const mgr = createManager({ platform: "linux", home: tmpHome });
		mgr.uninstall();
		expect(mockExecSync).not.toHaveBeenCalledWith("systemctl --user stop macroclaw", expect.anything());
		expect(mockExecSync).toHaveBeenCalledWith("systemctl --user disable macroclaw", expect.anything());
		expect(mockExecSync).toHaveBeenCalledWith("systemctl --user daemon-reload", expect.anything());
		rmSync(tmpHome, { recursive: true, force: true });
	});
});

describe("start", () => {
	it("throws when service is not installed", () => {
		const mgr = createManager({ platform: "darwin", home: "/nonexistent" });
		expect(() => mgr.start()).toThrow(
			"Service not installed. Run `macroclaw service install` first.",
		);
	});

	it("throws when service is already running (launchd)", () => {
		const tmpHome = `/tmp/macroclaw-test-startrun-${Date.now()}`;
		mkdirSync(join(tmpHome, "Library/LaunchAgents"), { recursive: true });
		writeFileSync(join(tmpHome, "Library/LaunchAgents/com.macroclaw.plist"), "test");

		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd.startsWith("launchctl list ")) return LAUNCHD_RUNNING;
			return "";
		});
		const mgr = createManager({ platform: "darwin", home: tmpHome });
		expect(() => mgr.start()).toThrow("Service is already running.");
		rmSync(tmpHome, { recursive: true });
	});

	it("starts launchd service", () => {
		const tmpHome = `/tmp/macroclaw-test-startld-${Date.now()}`;
		mkdirSync(join(tmpHome, "Library/LaunchAgents"), { recursive: true });
		writeFileSync(join(tmpHome, "Library/LaunchAgents/com.macroclaw.plist"), "test");

		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd.startsWith("launchctl list ")) throw new Error("not loaded");
			return "";
		});
		const mgr = createManager({ platform: "darwin", home: tmpHome });
		mgr.start();
		expect(mockExecSync).toHaveBeenCalledWith(expect.stringContaining("launchctl load"), expect.anything());
		rmSync(tmpHome, { recursive: true });
	});

	it("starts systemd user service", () => {
		const tmpHome = `/tmp/macroclaw-test-startsys-${Date.now()}`;
		const unitDir = join(tmpHome, ".config/systemd/user");
		mkdirSync(unitDir, { recursive: true });
		writeFileSync(join(unitDir, "macroclaw.service"), "test");

		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd === "systemctl --user is-active macroclaw") throw new Error("inactive");
			return "";
		});
		const mgr = createManager({ platform: "linux", home: tmpHome });
		mgr.start();
		expect(mockExecSync).toHaveBeenCalledWith("systemctl --user start macroclaw", expect.anything());
		rmSync(tmpHome, { recursive: true });
	});
});

describe("stop", () => {
	it("throws when service is not installed", () => {
		const mgr = createManager({ platform: "darwin", home: "/nonexistent" });
		expect(() => mgr.stop()).toThrow(
			"Service not installed. Run `macroclaw service install` first.",
		);
	});

	it("throws when service is not running (launchd)", () => {
		const tmpHome = `/tmp/macroclaw-test-stopnr-${Date.now()}`;
		mkdirSync(join(tmpHome, "Library/LaunchAgents"), { recursive: true });
		writeFileSync(join(tmpHome, "Library/LaunchAgents/com.macroclaw.plist"), "test");

		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd.startsWith("launchctl list ")) return LAUNCHD_STOPPED;
			return "";
		});
		const mgr = createManager({ platform: "darwin", home: tmpHome });
		expect(() => mgr.stop()).toThrow("Service is not running.");
		rmSync(tmpHome, { recursive: true });
	});

	it("stops launchd service", () => {
		const tmpHome = `/tmp/macroclaw-test-stopld-${Date.now()}`;
		mkdirSync(join(tmpHome, "Library/LaunchAgents"), { recursive: true });
		writeFileSync(join(tmpHome, "Library/LaunchAgents/com.macroclaw.plist"), "test");

		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd.startsWith("launchctl list ")) return LAUNCHD_RUNNING;
			return "";
		});
		const mgr = createManager({ platform: "darwin", home: tmpHome });
		mgr.stop();
		expect(mockExecSync).toHaveBeenCalledWith(expect.stringContaining("launchctl unload"), expect.anything());
		rmSync(tmpHome, { recursive: true });
	});

	it("stops systemd user service", () => {
		const tmpHome = `/tmp/macroclaw-test-stopsys-${Date.now()}`;
		const unitDir = join(tmpHome, ".config/systemd/user");
		mkdirSync(unitDir, { recursive: true });
		writeFileSync(join(unitDir, "macroclaw.service"), "test");

		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd === "systemctl --user is-active macroclaw") return SYSTEMD_ACTIVE;
			return "";
		});
		const mgr = createManager({ platform: "linux", home: tmpHome });
		mgr.stop();
		expect(mockExecSync).toHaveBeenCalledWith("systemctl --user stop macroclaw", expect.anything());
		rmSync(tmpHome, { recursive: true });
	});
});

describe("restart", () => {
	it("throws when service is not installed", () => {
		const mgr = createManager({ platform: "darwin", home: "/nonexistent" });
		expect(() => mgr.restart()).toThrow(
			"Service not installed. Run `macroclaw service install` first.",
		);
	});

	it("stops then starts when running (launchd)", () => {
		const tmpHome = `/tmp/macroclaw-test-restartld-${Date.now()}`;
		mkdirSync(join(tmpHome, "Library/LaunchAgents"), { recursive: true });
		writeFileSync(join(tmpHome, "Library/LaunchAgents/com.macroclaw.plist"), "test");

		let stopped = false;
		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd.startsWith("launchctl list ")) return stopped ? LAUNCHD_STOPPED : LAUNCHD_RUNNING;
			if (cmd.includes("launchctl unload")) { stopped = true; return ""; }
			return "";
		});
		const mgr = createManager({ platform: "darwin", home: tmpHome });
		mgr.restart();
		expect(mockExecSync).toHaveBeenCalledWith(expect.stringContaining("launchctl unload"), expect.anything());
		expect(mockExecSync).toHaveBeenCalledWith(expect.stringContaining("launchctl load"), expect.anything());
		rmSync(tmpHome, { recursive: true });
	});

	it("skips stop and starts when not running (systemd)", () => {
		const tmpHome = `/tmp/macroclaw-test-restartsys-${Date.now()}`;
		const unitDir = join(tmpHome, ".config/systemd/user");
		mkdirSync(unitDir, { recursive: true });
		writeFileSync(join(unitDir, "macroclaw.service"), "test");

		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd === "systemctl --user is-active macroclaw") throw new Error("inactive");
			return "";
		});
		const mgr = createManager({ platform: "linux", home: tmpHome });
		mgr.restart();
		expect(mockExecSync).not.toHaveBeenCalledWith("systemctl --user stop macroclaw", expect.anything());
		expect(mockExecSync).toHaveBeenCalledWith("systemctl --user start macroclaw", expect.anything());
		rmSync(tmpHome, { recursive: true });
	});
});

describe("update", () => {
	it("throws when service is not installed", () => {
		const mgr = createManager({ platform: "darwin", home: "/nonexistent" });
		expect(() => mgr.update()).toThrow(
			"Service not installed. Run `macroclaw service install` first.",
		);
	});

	it("stops, refreshes, and starts the service when updating launchd", () => {
		const tmpHome = `/tmp/macroclaw-test-updateld-${Date.now()}`;
		mkdirSync(join(tmpHome, "Library/LaunchAgents"), { recursive: true });
		writeFileSync(join(tmpHome, "Library/LaunchAgents/com.macroclaw.plist"), "test");

		const calls: string[] = [];
		let running = true;
		mockExecSync.mockImplementation((cmd: string) => {
			calls.push(cmd);
			if (cmd.startsWith("launchctl list ")) return running ? LAUNCHD_RUNNING : LAUNCHD_STOPPED;
			if (cmd === "bun pm ls -g") return "macroclaw@0.6.0\n";
			if (cmd.includes("launchctl unload")) {
				running = false;
				return "";
			}
			if (cmd === "macroclaw service refresh") return "";
			if (cmd.includes("launchctl load")) {
				running = true;
				return "";
			}
			return "";
		});
		const mgr = createManager({ platform: "darwin", home: tmpHome });
		const result = mgr.update();

		expect(mockExecSync).toHaveBeenCalledWith("bun install -g macroclaw@latest", expect.anything());
		expect(mockExecSync).toHaveBeenCalledWith("macroclaw service refresh", expect.anything());
		const unloadIdx = calls.findIndex((call) => call.includes("launchctl unload"));
		const installIdx = calls.indexOf("bun install -g macroclaw@latest");
		const refreshIdx = calls.indexOf("macroclaw service refresh");
		const loadIdx = calls.findIndex((call) => call.includes("launchctl load"));
		expect(unloadIdx).toBeGreaterThan(-1);
		expect(installIdx).toBeGreaterThan(unloadIdx);
		expect(refreshIdx).toBeGreaterThan(installIdx);
		expect(loadIdx).toBeGreaterThan(refreshIdx);
		expect(result.previousVersion).toBe("0.6.0");
		expect(result.currentVersion).toBe("0.6.0");
		expect(result.logTailCommand).toBe(`tail -f ${tmpHome}/.macroclaw/logs/*.log`);
		rmSync(tmpHome, { recursive: true });
	});

	it("returns different versions when update changes version", () => {
		const tmpHome = `/tmp/macroclaw-test-updatever-${Date.now()}`;
		mkdirSync(join(tmpHome, "Library/LaunchAgents"), { recursive: true });
		writeFileSync(join(tmpHome, "Library/LaunchAgents/com.macroclaw.plist"), "test");

		let installCalled = false;
		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd.startsWith("launchctl list ")) return LAUNCHD_STOPPED;
			if (cmd === "bun install -g macroclaw@latest") { installCalled = true; return ""; }
			if (cmd === "macroclaw service refresh") return "";
			if (cmd.includes("launchctl load")) return "";
			if (cmd === "bun pm ls -g") return installCalled ? "macroclaw@0.7.0\n" : "macroclaw@0.6.0\n";
			return "";
		});
		const mgr = createManager({ platform: "darwin", home: tmpHome });
		const result = mgr.update();
		expect(result.previousVersion).toBe("0.6.0");
		expect(result.currentVersion).toBe("0.7.0");
		expect(result.logTailCommand).toBe(`tail -f ${tmpHome}/.macroclaw/logs/*.log`);
		rmSync(tmpHome, { recursive: true });
	});

	it("returns unknown when version query fails", () => {
		const tmpHome = `/tmp/macroclaw-test-updateunk-${Date.now()}`;
		mkdirSync(join(tmpHome, "Library/LaunchAgents"), { recursive: true });
		writeFileSync(join(tmpHome, "Library/LaunchAgents/com.macroclaw.plist"), "test");

		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd.startsWith("launchctl list ")) return LAUNCHD_STOPPED;
			if (cmd === "macroclaw service refresh") return "";
			if (cmd.includes("launchctl load")) return "";
			if (cmd === "bun pm ls -g") throw new Error("command not found");
			return "";
		});
		const mgr = createManager({ platform: "darwin", home: tmpHome });
		const result = mgr.update();
		expect(result.previousVersion).toBe("unknown");
		expect(result.currentVersion).toBe("unknown");
		expect(result.logTailCommand).toBe(`tail -f ${tmpHome}/.macroclaw/logs/*.log`);
		rmSync(tmpHome, { recursive: true });
	});
});

describe("refresh", () => {
	it("throws when service is not installed", () => {
		const mgr = createManager({ platform: "darwin", home: "/nonexistent" });
		expect(() => mgr.refresh()).toThrow(
			"Service not installed. Run `macroclaw service install` first.",
		);
	});

	it("refreshes launchd PATH snapshot and preserves oauth token", () => {
		const tmpHome = `/tmp/macroclaw-test-refresh-launchd-${Date.now()}`;
		const plistDir = join(tmpHome, "Library/LaunchAgents");
		mkdirSync(plistDir, { recursive: true });
		writeFileSync(join(plistDir, "com.macroclaw.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>/old/path</string>
		<key>CLAUDE_CODE_OAUTH_TOKEN</key>
		<string>sk-test-token</string>
	</dict>
</dict>
</plist>
`);

		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd === "/bin/bash -lc 'printf %s \"$PATH\"'") return "/custom/bin:/usr/bin:/bin\n";
			if (cmd === "bun pm bin -g") return "/home/testuser/.bun/bin\n";
			return "";
		});

		const mgr = createManager({ platform: "darwin", home: tmpHome });
		mgr.refresh();
		const plist = readFileSync(join(plistDir, "com.macroclaw.plist"), "utf-8");

		expect(mockExecSync).toHaveBeenCalledWith("/bin/bash -lc 'printf %s \"$PATH\"'", expect.anything());
		expect(mockExecSync).toHaveBeenCalledWith("bun pm bin -g", expect.anything());
		expect(plist).toContain("<string>/home/testuser/.bun/bin:/custom/bin:/usr/bin:/bin</string>");
		expect(plist).toContain("<string>/home/testuser/.bun/bin/macroclaw</string>");
		expect(plist).toContain("<key>CLAUDE_CODE_OAUTH_TOKEN</key>");
		expect(plist).toContain("<string>sk-test-token</string>");
		rmSync(tmpHome, { recursive: true });
	});

	it("refreshes systemd PATH snapshot and reloads daemon", () => {
		const tmpHome = `/tmp/macroclaw-test-refresh-systemd-${Date.now()}`;
		const unitDir = join(tmpHome, ".config/systemd/user");
		mkdirSync(unitDir, { recursive: true });
		writeFileSync(join(unitDir, "macroclaw.service"), "test");

		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd === "/bin/bash -lc 'printf %s \"$PATH\"'") return "/custom/bin:/usr/bin:/bin\n";
			if (cmd === "bun pm bin -g") return "/home/testuser/.bun/bin\n";
			return "";
		});

		const mgr = createManager({ platform: "linux", home: tmpHome });
		mgr.refresh();
		const unitContent = readFileSync(join(unitDir, "macroclaw.service"), "utf-8");

		expect(mockExecSync).toHaveBeenCalledWith("/bin/bash -lc 'printf %s \"$PATH\"'", expect.anything());
		expect(mockExecSync).toHaveBeenCalledWith("bun pm bin -g", expect.anything());
		expect(mockExecSync).toHaveBeenCalledWith("systemctl --user daemon-reload", expect.anything());
		expect(unitContent).toContain("Environment=PATH=/home/testuser/.bun/bin:/custom/bin:/usr/bin:/bin");
		expect(unitContent).toContain("ExecStart=/home/testuser/.bun/bin/macroclaw start");
		rmSync(tmpHome, { recursive: true });
	});

	it("does not duplicate bun global bin when it is already in login shell PATH", () => {
		const tmpHome = `/tmp/macroclaw-test-refresh-systemd-path-present-${Date.now()}`;
		const unitDir = join(tmpHome, ".config/systemd/user");
		mkdirSync(unitDir, { recursive: true });
		writeFileSync(join(unitDir, "macroclaw.service"), "test");

		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd === "/bin/bash -lc 'printf %s \"$PATH\"'") return "/usr/local/bin:/home/testuser/.bun/bin:/usr/bin:/bin\n";
			if (cmd === "bun pm bin -g") return "/home/testuser/.bun/bin\n";
			return "";
		});

		const mgr = createManager({ platform: "linux", home: tmpHome });
		mgr.refresh();
		const unitContent = readFileSync(join(unitDir, "macroclaw.service"), "utf-8");

		expect(unitContent).toContain("Environment=PATH=/home/testuser/.bun/bin:/usr/local/bin:/usr/bin:/bin");
		expect(unitContent).not.toContain("Environment=PATH=/usr/local/bin:/home/testuser/.bun/bin:/usr/local/bin:/usr/bin:/bin");
		rmSync(tmpHome, { recursive: true });
	});

	it("dedupes repeated PATH entries while keeping bun global bin first", () => {
		const tmpHome = `/tmp/macroclaw-test-refresh-systemd-path-dedup-${Date.now()}`;
		const unitDir = join(tmpHome, ".config/systemd/user");
		mkdirSync(unitDir, { recursive: true });
		writeFileSync(join(unitDir, "macroclaw.service"), "test");

		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd === "/bin/bash -lc 'printf %s \"$PATH\"'") {
				return "/home/testuser/.bun/bin:/usr/local/bin:/usr/bin:/usr/local/bin:/usr/bin:/bin:/home/testuser/.bun/bin\n";
			}
			if (cmd === "bun pm bin -g") return "/home/testuser/.bun/bin\n";
			return "";
		});

		const mgr = createManager({ platform: "linux", home: tmpHome });
		mgr.refresh();
		const unitContent = readFileSync(join(unitDir, "macroclaw.service"), "utf-8");

		expect(unitContent).toContain("Environment=PATH=/home/testuser/.bun/bin:/usr/local/bin:/usr/bin:/bin");
		rmSync(tmpHome, { recursive: true });
	});
});

describe("status", () => {
	it("returns not installed, not running when service file missing", () => {
		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd === "systemctl --user is-active macroclaw") throw new Error("not found");
			return "";
		});
		mockExistsSync.mockReturnValue(false);
		const mgr = createManager({ home: "/nonexistent" });
		// Override isInstalled getter — on hosts where macroclaw is installed as a systemd
		// service, existsSync for the user path might still return true
		Object.defineProperty(mgr, "isInstalled", { get: () => false });
		const s = mgr.status();
		expect(s.installed).toBe(false);
		expect(s.running).toBe(false);
		expect(s.platform).toBe("systemd");
		expect(s.pid).toBeUndefined();
		expect(s.uptime).toBeUndefined();
	});

	it("returns pid for running launchd service", () => {
		const tmpHome = `/tmp/macroclaw-test-statuspid-${Date.now()}`;
		mkdirSync(join(tmpHome, "Library/LaunchAgents"), { recursive: true });
		writeFileSync(join(tmpHome, "Library/LaunchAgents/com.macroclaw.plist"), "test");

		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd.startsWith("launchctl list ")) return LAUNCHD_RUNNING;
			return "";
		});
		const mgr = createManager({ platform: "darwin", home: tmpHome });
		const s = mgr.status();
		expect(s.installed).toBe(true);
		expect(s.running).toBe(true);
		expect(s.platform).toBe("launchd");
		expect(s.pid).toBe(12345);
		rmSync(tmpHome, { recursive: true });
	});

	it("handles launchctl list failure gracefully during status", () => {
		const tmpHome = `/tmp/macroclaw-test-statusfail-${Date.now()}`;
		mkdirSync(join(tmpHome, "Library/LaunchAgents"), { recursive: true });
		writeFileSync(join(tmpHome, "Library/LaunchAgents/com.macroclaw.plist"), "test");

		let callCount = 0;
		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd.startsWith("launchctl list ")) {
				callCount++;
				if (callCount === 1) return LAUNCHD_RUNNING;
				throw new Error("failed");
			}
			return "";
		});
		const mgr = createManager({ platform: "darwin", home: tmpHome });
		const s = mgr.status();
		expect(s.running).toBe(true);
		expect(s.pid).toBeUndefined();
		rmSync(tmpHome, { recursive: true });
	});
});

describe("logs", () => {
	it("returns journalctl --user command for systemd", () => {
		const mgr = createManager();
		expect(mgr.logs()).toBe("journalctl --user -u macroclaw -n 50 --no-pager");
	});

	it("returns journalctl --user follow command for systemd", () => {
		const mgr = createManager();
		expect(mgr.logs(true)).toBe("journalctl --user -u macroclaw -f");
	});

	it("returns tail command for launchd", () => {
		const mgr = createManager({ platform: "darwin" });
		expect(mgr.logs()).toBe("tail -n 50 /home/testuser/.macroclaw/logs/stdout.log");
	});

	it("returns tail follow command for launchd", () => {
		const mgr = createManager({ platform: "darwin" });
		expect(mgr.logs(true)).toBe("tail -f /home/testuser/.macroclaw/logs/stdout.log /home/testuser/.macroclaw/logs/stderr.log");
	});
});
