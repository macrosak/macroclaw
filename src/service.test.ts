import { beforeEach, describe, expect, it, mock } from "bun:test";
import { type ServiceDeps, ServiceManager } from "./service";

const mockExecSync = mock((_cmd: string, _opts?: any) => "");
const mockExistsSync = mock((_path: string) => true);
const mockWriteFileSync = mock((_path: string, _data: string) => {});
const mockMkdirSync = mock((_path: string, _opts?: any) => {});
const mockRmSync = mock((_path: string) => {});
function createManager(overrides?: Partial<ServiceDeps>): ServiceManager {
	return new ServiceManager({
		existsSync: mockExistsSync,
		writeFileSync: mockWriteFileSync,
		mkdirSync: mockMkdirSync,
		rmSync: mockRmSync,
		execSync: mockExecSync,
		tmpdir: () => "/tmp",
		randomUUID: () => "test-uuid",
		userInfo: () => ({ username: "testuser", homedir: "/home/testuser" }),
		platform: "linux",
		home: "/home/testuser",
		...overrides,
	});
}

const LAUNCHD_RUNNING = `{\n\t"PID" = 12345;\n\t"Label" = "com.macroclaw";\n}`;
const LAUNCHD_STOPPED = `{\n\t"Label" = "com.macroclaw";\n}`;
const SYSTEMD_ACTIVE = "active";
const SYSTEMD_INACTIVE = "inactive";

beforeEach(() => {
	mockExecSync.mockClear();
	mockExistsSync.mockClear();
	mockWriteFileSync.mockClear();
	mockMkdirSync.mockClear();
	mockRmSync.mockClear();
	mockExecSync.mockImplementation((_cmd: string, _opts?: any) => "");
	mockExistsSync.mockImplementation(() => true);
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

	it("returns systemd path for systemd", () => {
		const mgr = createManager({ platform: "linux" });
		expect(mgr.serviceFilePath).toBe("/etc/systemd/system/macroclaw.service");
	});
});

describe("isInstalled", () => {
	it("returns true when service file exists", () => {
		mockExistsSync.mockImplementation(() => true);
		const mgr = createManager({ platform: "darwin" });
		expect(mgr.isInstalled).toBe(true);
	});

	it("returns false when service file does not exist", () => {
		mockExistsSync.mockImplementation(() => false);
		const mgr = createManager();
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
			if (cmd === "systemctl is-active macroclaw") return SYSTEMD_ACTIVE;
			return "";
		});
		const mgr = createManager();
		expect(mgr.isRunning).toBe(true);
	});

	it("returns false when systemd service is inactive", () => {
		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd === "systemctl is-active macroclaw") return SYSTEMD_INACTIVE;
			return "";
		});
		const mgr = createManager();
		expect(mgr.isRunning).toBe(false);
	});

	it("returns false when systemctl throws", () => {
		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd === "systemctl is-active macroclaw") throw new Error("not found");
			return "";
		});
		const mgr = createManager();
		expect(mgr.isRunning).toBe(false);
	});
});

describe("install", () => {
	it("throws when settings.json is missing on macOS", () => {
		mockExistsSync.mockImplementation(() => false);
		const mgr = createManager({ platform: "darwin" });
		expect(() => mgr.install()).toThrow(
			"Settings not found. Run `macroclaw setup` first.",
		);
	});

	it("throws when settings.json is missing on Linux", () => {
		mockExistsSync.mockImplementation(() => false);
		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd.startsWith("id -gn")) return "testuser\n";
			return "";
		});
		const mgr = createManager();
		expect(() => mgr.install()).toThrow("Settings not found. Run `macroclaw setup` first.");
	});

	it("runs global install and resolves bun, claude and macroclaw paths", () => {
		mockExistsSync.mockImplementation(() => true);
		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd === "which bun") return "/home/testuser/.bun/bin/bun\n";
			if (cmd === "which claude") return "/home/testuser/.local/bin/claude\n";
			if (cmd === "bun pm bin -g") return "/home/testuser/.bun/bin\n";
			if (cmd.startsWith("id -gn")) return "testuser\n";
			return "";
		});
		const mgr = createManager();
		mgr.install();
		expect(mockExecSync).toHaveBeenCalledWith("bun install -g macroclaw");
		expect(mockExecSync).toHaveBeenCalledWith("which bun");
		expect(mockExecSync).toHaveBeenCalledWith("which claude");
		expect(mockExecSync).toHaveBeenCalledWith("bun pm bin -g");
	});

	it("installs launchd service with PATH and OAuth token", () => {
		mockExistsSync.mockImplementation(() => true);
		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd === "which bun") return "/Users/testuser/.bun/bin/bun\n";
			if (cmd === "which claude") return "/Users/testuser/.local/bin/claude\n";
			if (cmd === "bun pm bin -g") return "/Users/testuser/.bun/bin\n";
			return "";
		});
		const mgr = createManager({ platform: "darwin" });
		mgr.install("sk-test-token");
		expect(mockMkdirSync).toHaveBeenCalled();
		expect(mockWriteFileSync).toHaveBeenCalled();
		const writtenContent = mockWriteFileSync.mock.calls[0]![1] as string;
		expect(writtenContent).toContain("<string>/Users/testuser/.bun/bin/bun</string>");
		expect(writtenContent).toContain("<string>/Users/testuser/.bun/bin/macroclaw</string>");
		expect(writtenContent).toContain("<string>start</string>");
		expect(writtenContent).toContain("<key>KeepAlive</key>");
		expect(writtenContent).toContain(".macroclaw/logs/stdout.log");
		expect(writtenContent).toContain("<key>PATH</key>");
		expect(writtenContent).toContain("/Users/testuser/.bun/bin:/Users/testuser/.local/bin");
		expect(writtenContent).toContain("<key>CLAUDE_CODE_OAUTH_TOKEN</key>");
		expect(writtenContent).toContain("<string>sk-test-token</string>");
		expect(mockExecSync).toHaveBeenCalledWith(expect.stringContaining("launchctl load"));
	});

	it("installs launchd service without token when not provided", () => {
		mockExistsSync.mockImplementation(() => true);
		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd === "which bun") return "/Users/testuser/.bun/bin/bun\n";
			if (cmd === "which claude") return "/Users/testuser/.local/bin/claude\n";
			if (cmd === "bun pm bin -g") return "/Users/testuser/.bun/bin\n";
			return "";
		});
		const mgr = createManager({ platform: "darwin" });
		mgr.install();
		const writtenContent = mockWriteFileSync.mock.calls[0]![1] as string;
		expect(writtenContent).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
	});

	it("stops running launchd service before reinstalling", () => {
		const calls: string[] = [];
		mockExistsSync.mockImplementation(() => true);
		mockExecSync.mockImplementation((cmd: string) => {
			calls.push(cmd);
			if (cmd === "which bun") return "/Users/testuser/.bun/bin/bun\n";
			if (cmd === "which claude") return "/Users/testuser/.local/bin/claude\n";
			if (cmd === "bun pm bin -g") return "/Users/testuser/.bun/bin\n";
			if (cmd.startsWith("launchctl list ")) return LAUNCHD_RUNNING;
			return "";
		});
		const mgr = createManager({ platform: "darwin" });
		mgr.install();
		const unloadIdx = calls.findIndex(c => c.includes("launchctl unload"));
		const loadIdx = calls.findIndex(c => c.includes("launchctl load"));
		expect(unloadIdx).toBeGreaterThan(-1);
		expect(loadIdx).toBeGreaterThan(unloadIdx);
	});

	it("skips unload when launchd service is not running", () => {
		mockExistsSync.mockImplementation(() => true);
		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd === "which bun") return "/Users/testuser/.bun/bin/bun\n";
			if (cmd === "which claude") return "/Users/testuser/.local/bin/claude\n";
			if (cmd === "bun pm bin -g") return "/Users/testuser/.bun/bin\n";
			if (cmd.startsWith("launchctl list ")) return LAUNCHD_STOPPED;
			return "";
		});
		const mgr = createManager({ platform: "darwin" });
		mgr.install();
		expect(mockExecSync).not.toHaveBeenCalledWith(expect.stringContaining("launchctl unload"));
	});

	it("installs systemd service with PATH via temp file and sudo cp", () => {
		mockExistsSync.mockImplementation(() => true);
		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd === "which bun") return "/home/testuser/.bun/bin/bun\n";
			if (cmd === "which claude") return "/home/testuser/.local/bin/claude\n";
			if (cmd === "bun pm bin -g") return "/home/testuser/.bun/bin\n";
			if (cmd.startsWith("id -gn")) return "testuser\n";
			return "";
		});
		const mgr = createManager();
		mgr.install();

		// Unit written to temp file first
		expect(mockWriteFileSync).toHaveBeenCalledWith("/tmp/macroclaw-test-uuid.service", expect.any(String));
		const writtenContent = mockWriteFileSync.mock.calls[0]![1] as string;
		expect(writtenContent).toContain("ExecStart=/home/testuser/.bun/bin/bun /home/testuser/.bun/bin/macroclaw start");
		expect(writtenContent).toContain("User=testuser");
		expect(writtenContent).toContain("Group=testuser");
		expect(writtenContent).toContain("Environment=HOME=/home/testuser");
		expect(writtenContent).toContain("Environment=PATH=/home/testuser/.bun/bin:/home/testuser/.local/bin");
		expect(writtenContent).toContain("WorkingDirectory=/home/testuser");

		// Elevated operations use sudo
		expect(mockExecSync).toHaveBeenCalledWith("sudo cp /tmp/macroclaw-test-uuid.service /etc/systemd/system/macroclaw.service");
		expect(mockExecSync).toHaveBeenCalledWith("sudo systemctl daemon-reload");
		expect(mockExecSync).toHaveBeenCalledWith("sudo systemctl enable macroclaw");
		expect(mockExecSync).toHaveBeenCalledWith("sudo systemctl start macroclaw");

		// Temp file cleaned up
		expect(mockRmSync).toHaveBeenCalledWith("/tmp/macroclaw-test-uuid.service");
	});

	it("cleans up temp file even when sudo cp fails", () => {
		mockExistsSync.mockImplementation(() => true);
		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd.startsWith("id -gn")) return "testuser\n";
			if (cmd === "which bun") return "/home/testuser/.bun/bin/bun\n";
			if (cmd === "which claude") return "/home/testuser/.local/bin/claude\n";
			if (cmd === "bun pm bin -g") return "/home/testuser/.bun/bin\n";
			if (cmd.startsWith("sudo cp")) throw new Error("Permission denied");
			return "";
		});
		const mgr = createManager();
		expect(() => mgr.install()).toThrow("Permission denied");
		expect(mockRmSync).toHaveBeenCalledWith("/tmp/macroclaw-test-uuid.service");
	});

	it("uses os userInfo identity, not environment variables", () => {
		mockExistsSync.mockImplementation(() => true);
		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd === "which bun") return "/usr/local/bin/bun\n";
			if (cmd === "which claude") return "/usr/local/bin/claude\n";
			if (cmd === "bun pm bin -g") return "/usr/local/bin\n";
			if (cmd === "id -gn deploy") return "deploy\n";
			return "";
		});
		const mgr = createManager({
			userInfo: () => ({ username: "deploy", homedir: "/srv/deploy" }),
		});
		mgr.install();
		const writtenContent = mockWriteFileSync.mock.calls[0]![1] as string;
		expect(writtenContent).toContain("User=deploy");
		expect(writtenContent).toContain("Group=deploy");
		expect(writtenContent).toContain("Environment=HOME=/srv/deploy");
		expect(writtenContent).toContain("WorkingDirectory=/srv/deploy");
		expect(mockExistsSync).toHaveBeenCalledWith("/srv/deploy/.macroclaw/settings.json");
	});

	it("does not require sudo for bun install -g", () => {
		mockExistsSync.mockImplementation(() => true);
		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd === "which bun") return "/home/testuser/.bun/bin/bun\n";
			if (cmd === "which claude") return "/home/testuser/.local/bin/claude\n";
			if (cmd === "bun pm bin -g") return "/home/testuser/.bun/bin\n";
			if (cmd.startsWith("id -gn")) return "testuser\n";
			return "";
		});
		const mgr = createManager();
		mgr.install();
		// bun install should NOT be prefixed with sudo
		expect(mockExecSync).toHaveBeenCalledWith("bun install -g macroclaw");
		expect(mockExecSync).not.toHaveBeenCalledWith("sudo bun install -g macroclaw");
	});

	it("throws when bun path cannot be resolved", () => {
		mockExistsSync.mockImplementation(() => true);
		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd.startsWith("id -gn")) return "testuser\n";
			if (cmd === "which bun") throw new Error("not found");
			return "";
		});
		const mgr = createManager();
		expect(() => mgr.install()).toThrow("Could not resolve bun path. Is it installed?");
	});

	it("throws when macroclaw not found in global bin", () => {
		mockExistsSync.mockImplementation((path: string) => {
			if (path.endsWith("/macroclaw")) return false;
			return true;
		});
		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd.startsWith("id -gn")) return "testuser\n";
			if (cmd === "which bun") return "/home/testuser/.bun/bin/bun\n";
			if (cmd === "which claude") return "/home/testuser/.local/bin/claude\n";
			if (cmd === "bun pm bin -g") return "/home/testuser/.bun/bin\n";
			return "";
		});
		const mgr = createManager();
		expect(() => mgr.install()).toThrow("Could not find macroclaw in /home/testuser/.bun/bin");
	});

	it("macOS install does not use sudo", () => {
		mockExistsSync.mockImplementation(() => true);
		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd === "which bun") return "/opt/homebrew/bin/bun\n";
			if (cmd === "which claude") return "/opt/homebrew/bin/claude\n";
			if (cmd === "bun pm bin -g") return "/opt/homebrew/bin\n";
			return "";
		});
		const mgr = createManager({ platform: "darwin" });
		mgr.install();
		for (const call of mockExecSync.mock.calls) {
			expect(call[0]).not.toMatch(/^sudo /);
		}
	});
});

describe("uninstall", () => {
	it("throws when service is not installed", () => {
		mockExistsSync.mockImplementation(() => false);
		const mgr = createManager({ platform: "darwin" });
		expect(() => mgr.uninstall()).toThrow(
			"Service not installed. Run `macroclaw service install` first.",
		);
	});

	it("uninstalls running launchd service", () => {
		mockExistsSync.mockImplementation(() => true);
		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd.startsWith("launchctl list ")) return LAUNCHD_RUNNING;
			return "";
		});
		const mgr = createManager({ platform: "darwin" });
		mgr.uninstall();
		expect(mockExecSync).toHaveBeenCalledWith(expect.stringContaining("launchctl unload"));
		expect(mockRmSync).toHaveBeenCalled();
	});

	it("uninstalls stopped launchd service without unloading", () => {
		mockExistsSync.mockImplementation(() => true);
		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd.startsWith("launchctl list ")) return LAUNCHD_STOPPED;
			return "";
		});
		const mgr = createManager({ platform: "darwin" });
		mgr.uninstall();
		expect(mockExecSync).not.toHaveBeenCalledWith(expect.stringContaining("launchctl unload"));
		expect(mockRmSync).toHaveBeenCalled();
	});

	it("uninstalls running systemd service via sudo", () => {
		mockExistsSync.mockImplementation(() => true);
		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd === "systemctl is-active macroclaw") return SYSTEMD_ACTIVE;
			return "";
		});
		const mgr = createManager();
		mgr.uninstall();
		expect(mockExecSync).toHaveBeenCalledWith("sudo systemctl stop macroclaw");
		expect(mockExecSync).toHaveBeenCalledWith("sudo systemctl disable macroclaw");
		expect(mockExecSync).toHaveBeenCalledWith("sudo rm /etc/systemd/system/macroclaw.service");
		expect(mockExecSync).toHaveBeenCalledWith("sudo systemctl daemon-reload");
	});

	it("uninstalls stopped systemd service without stopping", () => {
		mockExistsSync.mockImplementation(() => true);
		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd === "systemctl is-active macroclaw") return SYSTEMD_INACTIVE;
			return "";
		});
		const mgr = createManager();
		mgr.uninstall();
		expect(mockExecSync).not.toHaveBeenCalledWith("sudo systemctl stop macroclaw");
		expect(mockExecSync).toHaveBeenCalledWith("sudo systemctl disable macroclaw");
	});
});

describe("start", () => {
	it("throws when service is not installed", () => {
		mockExistsSync.mockImplementation(() => false);
		const mgr = createManager({ platform: "darwin" });
		expect(() => mgr.start()).toThrow(
			"Service not installed. Run `macroclaw service install` first.",
		);
	});

	it("throws when service is already running (launchd)", () => {
		mockExistsSync.mockImplementation(() => true);
		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd.startsWith("launchctl list ")) return LAUNCHD_RUNNING;
			return "";
		});
		const mgr = createManager({ platform: "darwin" });
		expect(() => mgr.start()).toThrow("Service is already running.");
	});

	it("throws when service is already running (systemd)", () => {
		mockExistsSync.mockImplementation(() => true);
		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd === "systemctl is-active macroclaw") return SYSTEMD_ACTIVE;
			return "";
		});
		const mgr = createManager();
		expect(() => mgr.start()).toThrow("Service is already running.");
	});

	it("starts launchd service", () => {
		mockExistsSync.mockImplementation(() => true);
		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd.startsWith("launchctl list ")) throw new Error("not loaded");
			return "";
		});
		const mgr = createManager({ platform: "darwin" });
		mgr.start();
		expect(mockExecSync).toHaveBeenCalledWith(expect.stringContaining("launchctl load"));
	});

	it("starts systemd service via sudo", () => {
		mockExistsSync.mockImplementation(() => true);
		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd === "systemctl is-active macroclaw") return SYSTEMD_INACTIVE;
			return "";
		});
		const mgr = createManager();
		mgr.start();
		expect(mockExecSync).toHaveBeenCalledWith("sudo systemctl start macroclaw");
	});
});

describe("stop", () => {
	it("throws when service is not installed", () => {
		mockExistsSync.mockImplementation(() => false);
		const mgr = createManager({ platform: "darwin" });
		expect(() => mgr.stop()).toThrow(
			"Service not installed. Run `macroclaw service install` first.",
		);
	});

	it("throws when service is not running (launchd)", () => {
		mockExistsSync.mockImplementation(() => true);
		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd.startsWith("launchctl list ")) return LAUNCHD_STOPPED;
			return "";
		});
		const mgr = createManager({ platform: "darwin" });
		expect(() => mgr.stop()).toThrow("Service is not running.");
	});

	it("throws when service is not running (systemd)", () => {
		mockExistsSync.mockImplementation(() => true);
		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd === "systemctl is-active macroclaw") return SYSTEMD_INACTIVE;
			return "";
		});
		const mgr = createManager();
		expect(() => mgr.stop()).toThrow("Service is not running.");
	});

	it("stops launchd service", () => {
		mockExistsSync.mockImplementation(() => true);
		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd.startsWith("launchctl list ")) return LAUNCHD_RUNNING;
			return "";
		});
		const mgr = createManager({ platform: "darwin" });
		mgr.stop();
		expect(mockExecSync).toHaveBeenCalledWith(expect.stringContaining("launchctl unload"));
	});

	it("stops systemd service via sudo", () => {
		mockExistsSync.mockImplementation(() => true);
		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd === "systemctl is-active macroclaw") return SYSTEMD_ACTIVE;
			return "";
		});
		const mgr = createManager();
		mgr.stop();
		expect(mockExecSync).toHaveBeenCalledWith("sudo systemctl stop macroclaw");
	});
});

describe("update", () => {
	it("throws when service is not installed", () => {
		mockExistsSync.mockImplementation(() => false);
		const mgr = createManager({ platform: "darwin" });
		expect(() => mgr.update()).toThrow(
			"Service not installed. Run `macroclaw service install` first.",
		);
	});

	it("updates systemd: stops if running, reinstalls, starts", () => {
		mockExistsSync.mockImplementation(() => true);
		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd === "systemctl is-active macroclaw") return SYSTEMD_ACTIVE;
			return "";
		});
		const mgr = createManager();
		mgr.update();
		expect(mockExecSync).toHaveBeenCalledWith("sudo systemctl stop macroclaw");
		expect(mockExecSync).toHaveBeenCalledWith("bun install -g macroclaw@latest");
		expect(mockExecSync).not.toHaveBeenCalledWith("sudo bun install -g macroclaw@latest");
		expect(mockExecSync).toHaveBeenCalledWith("sudo systemctl start macroclaw");
	});

	it("updates systemd: skips stop when not running", () => {
		mockExistsSync.mockImplementation(() => true);
		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd === "systemctl is-active macroclaw") return SYSTEMD_INACTIVE;
			return "";
		});
		const mgr = createManager();
		mgr.update();
		expect(mockExecSync).not.toHaveBeenCalledWith("sudo systemctl stop macroclaw");
		expect(mockExecSync).toHaveBeenCalledWith("bun install -g macroclaw@latest");
		expect(mockExecSync).toHaveBeenCalledWith("sudo systemctl start macroclaw");
	});

	it("updates launchd without sudo", () => {
		mockExistsSync.mockImplementation(() => true);
		mockExecSync.mockImplementation((cmd: string) => {
			if (cmd.startsWith("launchctl list ")) return LAUNCHD_RUNNING;
			return "";
		});
		const mgr = createManager({ platform: "darwin" });
		mgr.update();
		expect(mockExecSync).toHaveBeenCalledWith(expect.stringContaining("launchctl unload"));
		expect(mockExecSync).toHaveBeenCalledWith("bun install -g macroclaw@latest");
		expect(mockExecSync).toHaveBeenCalledWith(expect.stringContaining("launchctl load"));
		for (const call of mockExecSync.mock.calls) {
			expect(call[0]).not.toMatch(/^sudo /);
		}
	});
});
