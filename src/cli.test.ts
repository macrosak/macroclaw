import { describe, expect, it, mock } from "bun:test";
import { runCommand } from "citty";
import { Cli, createReadlineIo, handleError } from "./cli";
import { SettingsManager } from "./settings";
import type { SetupWizard } from "./setup";
import type { SystemServiceManager } from "./system-service";

// Only mock ./index — safe since no other test imports it
const mockStart = mock(async () => {});
mock.module("./index", () => ({ start: mockStart }));

// Mock child_process so cli.claude() doesn't spawn real processes
const mockExecSync = mock((_cmd: string, _opts?: object) => "");
mock.module("node:child_process", () => ({
	execSync: mockExecSync,
	execFileSync: () => "",
}));

const { main } = await import("./cli");

function createMockWizard(overrides?: { collectSettings?: (defaults?: Record<string, unknown>) => Promise<unknown>; installService?: () => Promise<void>; forceInstallService?: () => Promise<void> }) {
	return {
		collectSettings: overrides?.collectSettings ?? mock(async () => ({ botToken: "tok", chatId: "123" })),
		installService: overrides?.installService ?? mock(async () => {}),
		forceInstallService: overrides?.forceInstallService ?? mock(async () => {}),
	} as unknown as SetupWizard;
}

function createMockSettings(overrides?: Partial<SettingsManager>) {
	return {
		load: mock(() => ({ botToken: "tok", chatId: "123", model: "sonnet", workspace: "/tmp" })),
		loadRaw: mock(() => null),
		save: mock(() => {}),
		applyEnvOverrides: mock((s: unknown) => ({ settings: s, overrides: new Set() })),
		print: mock(() => {}),
		...overrides,
	} as unknown as SettingsManager;
}

describe("CLI routing", () => {
	it("requires a subcommand when no args given", async () => {
		await expect(runCommand(main, { rawArgs: [] })).rejects.toThrow("No command specified");
	});

	it("routes 'start' subcommand to start", async () => {
		mockStart.mockClear();
		await runCommand(main, { rawArgs: ["start"] });
		expect(mockStart).toHaveBeenCalled();
	});

	it("has all subcommands defined", () => {
		expect(main.subCommands).toBeDefined();
		const subs = main.subCommands as Record<string, unknown>;
		expect(subs.start).toBeDefined();
		expect(subs.setup).toBeDefined();
		expect(subs.claude).toBeDefined();
		expect(subs.service).toBeDefined();
	});

	it("has correct meta", () => {
		expect(main.meta).toEqual({
			name: "macroclaw",
			description: "Telegram-to-Claude-Code bridge",
			version: "0.0.0-dev",
		});
	});
});

describe("Cli.setup", () => {
	it("runs wizard and saves settings", async () => {
		const wizard = createMockWizard();
		const settings = createMockSettings();
		const cli = new Cli({ wizard, settings });
		await cli.setup();
		expect((settings.save as ReturnType<typeof mock>)).toHaveBeenCalledWith({ botToken: "tok", chatId: "123" });
	});

	it("passes existing settings as defaults to wizard", async () => {
		const existing = { botToken: "old-tok", chatId: "999" };
		let receivedDefaults: unknown = null;
		const wizard = createMockWizard({
			collectSettings: async (defaults) => { receivedDefaults = defaults; return { botToken: "tok", chatId: "123" }; },
		});
		const settings = createMockSettings({ loadRaw: () => existing } as unknown as Partial<SettingsManager>);
		const cli = new Cli({ wizard, settings });
		await cli.setup();
		expect(receivedDefaults).toEqual(existing);
	});

	it("wizard manages io lifecycle internally", async () => {
		const wizard = createMockWizard();
		const cli = new Cli({ wizard, settings: createMockSettings() });
		await cli.setup();
		expect((wizard.collectSettings as ReturnType<typeof mock>)).toHaveBeenCalled();
		expect((wizard.installService as ReturnType<typeof mock>)).toHaveBeenCalled();
	});

	it("skips service install when --skip-service is set", async () => {
		const wizard = createMockWizard();
		const cli = new Cli({ wizard, settings: createMockSettings() });
		await cli.setup({ skipService: true });
		expect((wizard.collectSettings as ReturnType<typeof mock>)).toHaveBeenCalled();
		expect((wizard.installService as ReturnType<typeof mock>)).not.toHaveBeenCalled();
	});

	it("force installs service when --install-service is set", async () => {
		const forceInstallService = mock(async () => {});
		const wizard = { ...createMockWizard(), forceInstallService } as unknown as SetupWizard;
		const cli = new Cli({ wizard, settings: createMockSettings() });
		await cli.setup({ installService: true });
		expect(forceInstallService).toHaveBeenCalled();
		expect((wizard.installService as ReturnType<typeof mock>)).not.toHaveBeenCalled();
	});

	it("creates default wizard when none provided", () => {
		const cli = new Cli({ settings: createMockSettings() });
		expect(cli).toBeDefined();
	});

	it("createReadlineIo creates functional io", async () => {
		const io = createReadlineIo();
		io.open();
		const answer = io.ask("test? ");
		process.stdin.push("hello\n");
		expect(await answer).toBe("hello");
		io.close();
	});
});

function mockService(overrides?: Record<string, unknown>): SystemServiceManager {
	return {
		install: mock(() => ""),
		uninstall: mock(() => {}),
		start: mock(() => ""),
		stop: mock(() => {}),
		update: mock(() => ({ previousVersion: "0.6.0", currentVersion: "0.7.0" })),
		isRunning: false,
		status: mock(() => ({ installed: false, running: false, platform: "systemd" as const })),
		logs: mock(() => "journalctl -u macroclaw -n 50 --no-pager"),
		...overrides,
	} as unknown as SystemServiceManager;
}

describe("Cli.service", () => {
	it("runs install action", () => {
		const install = mock(() => "tail -f /logs");
		const cli = new Cli({ systemService: mockService({ install }) });
		cli.service("install");
		expect(install).toHaveBeenCalled();
	});

	it("runs uninstall action", () => {
		const uninstall = mock(() => {});
		const cli = new Cli({ systemService: mockService({ uninstall }) });
		cli.service("uninstall");
		expect(uninstall).toHaveBeenCalled();
	});

	it("runs start action", () => {
		const start = mock(() => "tail -f /logs");
		const cli = new Cli({ systemService: mockService({ start }) });
		cli.service("start");
		expect(start).toHaveBeenCalled();
	});

	it("runs stop action", () => {
		const stop = mock(() => {});
		const cli = new Cli({ systemService: mockService({ stop }) });
		cli.service("stop");
		expect(stop).toHaveBeenCalled();
	});

	it("runs update action — stops and starts when running", () => {
		const stop = mock(() => {});
		const start = mock(() => "tail -f /logs");
		const update = mock(() => ({ previousVersion: "0.6.0", currentVersion: "0.7.0" }));
		const cli = new Cli({ systemService: mockService({ stop, start, update, isRunning: true }) });
		cli.service("update");
		expect(stop).toHaveBeenCalled();
		expect(update).toHaveBeenCalled();
		expect(start).toHaveBeenCalled();
	});

	it("runs update action — skips stop but still starts when not running", () => {
		const stop = mock(() => {});
		const start = mock(() => "tail -f /logs");
		const update = mock(() => ({ previousVersion: "0.6.0", currentVersion: "0.7.0" }));
		const cli = new Cli({ systemService: mockService({ stop, start, update, isRunning: false }) });
		cli.service("update");
		expect(stop).not.toHaveBeenCalled();
		expect(update).toHaveBeenCalled();
		expect(start).toHaveBeenCalled();
	});

	it("runs status action", () => {
		const status = mock(() => ({ installed: true, running: true, platform: "systemd" as const, pid: 42, uptime: "Thu 2026-03-12 10:00:00 UTC" }));
		const cli = new Cli({ systemService: mockService({ status }) });
		cli.service("status");
		expect(status).toHaveBeenCalled();
	});

	it("runs logs action", () => {
		const logs = mock(() => "journalctl -u macroclaw -n 50 --no-pager");
		const cli = new Cli({ systemService: mockService({ logs }) });
		cli.service("logs");
		expect(logs).toHaveBeenCalledWith(undefined);
	});

	it("passes follow flag to logs action", () => {
		const logs = mock(() => "journalctl -u macroclaw -f");
		const cli = new Cli({ systemService: mockService({ logs }) });
		cli.service("logs", undefined, true);
		expect(logs).toHaveBeenCalledWith(true);
	});

	it("throws for unknown action", () => {
		const cli = new Cli({ systemService: mockService() });
		expect(() => cli.service("bogus")).toThrow("Unknown service action: bogus");
	});

	it("throws service errors", () => {
		const cli = new Cli({ systemService: mockService({ install: () => { throw new Error("Settings not found."); } }) });
		expect(() => cli.service("install")).toThrow("Settings not found.");
	});
});

describe("Cli.claude", () => {
	it("builds claude command with session and model", async () => {
		const fs = await import("node:fs");
		const dir = `/tmp/macroclaw-test-claude-${Date.now()}`;
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(`${dir}/settings.json`, JSON.stringify({ botToken: "tok", chatId: "123", model: "opus", workspace: "/tmp" }));
		fs.writeFileSync(`${dir}/sessions.json`, JSON.stringify({ mainSessionId: "sess-123" }));

		mockExecSync.mockClear();
		const cli = new Cli({ settings: new SettingsManager(dir) });
		cli.claude();

		fs.rmSync(dir, { recursive: true });

		expect(mockExecSync).toHaveBeenCalledWith(
			"claude --resume sess-123 --model opus",
			expect.objectContaining({ cwd: "/tmp", stdio: "inherit" }),
		);
		const opts = mockExecSync.mock.calls[0][1] as { env: Record<string, string> };
		expect(opts.env.CLAUDECODE).toBe("");
	});

	it("omits --resume when no session exists", async () => {
		const fs = await import("node:fs");
		const dir = `/tmp/macroclaw-test-claude-${Date.now()}`;
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(`${dir}/settings.json`, JSON.stringify({ botToken: "tok", chatId: "123", model: "sonnet", workspace: "/tmp" }));
		fs.writeFileSync(`${dir}/sessions.json`, JSON.stringify({}));

		mockExecSync.mockClear();
		const cli = new Cli({ settings: new SettingsManager(dir) });
		cli.claude();

		fs.rmSync(dir, { recursive: true });

		expect(mockExecSync).toHaveBeenCalledWith(
			"claude --model sonnet",
			expect.objectContaining({ cwd: "/tmp", stdio: "inherit" }),
		);
	});

	it("exits when settings are missing", () => {
		const mockExit = mock((_code?: number) => { throw new Error("exit"); });
		const origExit = process.exit;
		process.exit = mockExit as typeof process.exit;
		const cli = new Cli({ settings: new SettingsManager("/nonexistent/path") });
		expect(() => cli.claude()).toThrow("exit");
		process.exit = origExit;
		expect(mockExit).toHaveBeenCalledWith(1);
	});
});

describe("handleError", () => {
	it("prints error message and exits", () => {
		const mockExit = mock((_code?: number) => { throw new Error("exit"); });
		const mockConsoleError = mock((..._args: unknown[]) => {});
		const origExit = process.exit;
		const origError = console.error;
		process.exit = mockExit as typeof process.exit;
		console.error = mockConsoleError;
		try {
			handleError(new Error("Settings not found."));
		} catch { /* exit throws */ }
		process.exit = origExit;
		console.error = origError;
		expect(mockConsoleError).toHaveBeenCalledWith("Settings not found.");
		expect(mockExit).toHaveBeenCalledWith(1);
	});

	it("handles non-Error values", () => {
		const mockExit = mock((_code?: number) => { throw new Error("exit"); });
		const mockConsoleError = mock((..._args: unknown[]) => {});
		const origExit = process.exit;
		const origError = console.error;
		process.exit = mockExit as typeof process.exit;
		console.error = mockConsoleError;
		try {
			handleError("string error");
		} catch { /* exit throws */ }
		process.exit = origExit;
		console.error = origError;
		expect(mockConsoleError).toHaveBeenCalledWith("string error");
	});
});
