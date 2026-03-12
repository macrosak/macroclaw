import { describe, expect, it, mock } from "bun:test";
import { runCommand } from "citty";
import { Cli, handleError, loadRawSettings, type SetupDeps } from "./cli";
import type { SystemService } from "./service";

// Only mock ./index — safe since no other test imports it
const mockStart = mock(async () => {});
mock.module("./index", () => ({ start: mockStart }));

const { main } = await import("./cli");

function createMockSetupDeps(): SetupDeps & { saved: { settings: unknown; dir: string } | null } {
	const result: SetupDeps & { saved: { settings: unknown; dir: string } | null } = {
		saved: null,
		initLogger: async () => {},
		saveSettings: () => {},
		loadRawSettings: () => null,
		runSetupWizard: async (io) => {
			await io.ask("test?");
			io.write("done");
			io.close?.();
			return { botToken: "tok", chatId: "123" };
		},
		createReadlineInterface: () => ({
			question: (_q: string, cb: (a: string) => void) => cb("answer"),
			close: () => {},
		}),
		resolveDir: () => "/home/test/.macroclaw",
	};
	result.saveSettings = (settings: unknown, dir: string) => { result.saved = { settings, dir }; };
	return result;
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
		const deps = createMockSetupDeps();
		const cli = new Cli(deps);
		await cli.setup();
		expect(deps.saved).toEqual({
			settings: { botToken: "tok", chatId: "123" },
			dir: "/home/test/.macroclaw",
		});
	});

	it("calls initLogger", async () => {
		const deps = createMockSetupDeps();
		const mockInit = mock(async () => {});
		deps.initLogger = mockInit;
		const cli = new Cli(deps);
		await cli.setup();
		expect(mockInit).toHaveBeenCalled();
	});

	it("passes existing settings as defaults to wizard", async () => {
		const existing = { botToken: "old-tok", chatId: "999" };
		let receivedDefaults: unknown = null;
		const deps = createMockSetupDeps();
		deps.loadRawSettings = () => existing;
		deps.runSetupWizard = async (io, opts) => {
			receivedDefaults = opts?.defaults;
			io.close?.();
			return { botToken: "tok", chatId: "123" };
		};
		const cli = new Cli(deps);
		await cli.setup();
		expect(receivedDefaults).toEqual(existing);
	});

	it("closes readline after wizard completes", async () => {
		const deps = createMockSetupDeps();
		const mockClose = mock(() => {});
		deps.createReadlineInterface = () => ({
			question: (_q: string, cb: (a: string) => void) => cb("answer"),
			close: mockClose,
		});
		const cli = new Cli(deps);
		await cli.setup();
		expect(mockClose).toHaveBeenCalled();
	});
});

function mockService(overrides?: Partial<SystemService>): SystemService {
	return {
		install: mock(() => ""),
		uninstall: mock(() => {}),
		start: mock(() => ""),
		stop: mock(() => {}),
		update: mock(() => ""),
		status: mock(() => ({ installed: false, running: false, platform: "systemd" as const })),
		logs: mock(() => "journalctl -u macroclaw -n 50 --no-pager"),
		...overrides,
	};
}

describe("Cli.service", () => {
	it("runs install action", () => {
		const install = mock(() => "tail -f /logs");
		const cli = new Cli(undefined, mockService({ install }));
		cli.service("install");
		expect(install).toHaveBeenCalled();
	});

	it("runs uninstall action", () => {
		const uninstall = mock(() => {});
		const cli = new Cli(undefined, mockService({ uninstall }));
		cli.service("uninstall");
		expect(uninstall).toHaveBeenCalled();
	});

	it("runs start action", () => {
		const start = mock(() => "tail -f /logs");
		const cli = new Cli(undefined, mockService({ start }));
		cli.service("start");
		expect(start).toHaveBeenCalled();
	});

	it("runs stop action", () => {
		const stop = mock(() => {});
		const cli = new Cli(undefined, mockService({ stop }));
		cli.service("stop");
		expect(stop).toHaveBeenCalled();
	});

	it("runs update action", () => {
		const update = mock(() => "tail -f /logs");
		const cli = new Cli(undefined, mockService({ update }));
		cli.service("update");
		expect(update).toHaveBeenCalled();
	});

	it("runs status action", () => {
		const status = mock(() => ({ installed: true, running: true, platform: "systemd" as const, pid: 42, uptime: "Thu 2026-03-12 10:00:00 UTC" }));
		const cli = new Cli(undefined, mockService({ status }));
		cli.service("status");
		expect(status).toHaveBeenCalled();
	});

	it("runs logs action", () => {
		const logs = mock(() => "journalctl -u macroclaw -n 50 --no-pager");
		const cli = new Cli(undefined, mockService({ logs }));
		cli.service("logs");
		expect(logs).toHaveBeenCalledWith(undefined);
	});

	it("passes follow flag to logs action", () => {
		const logs = mock(() => "journalctl -u macroclaw -f");
		const cli = new Cli(undefined, mockService({ logs }));
		cli.service("logs", undefined, true);
		expect(logs).toHaveBeenCalledWith(true);
	});

	it("throws for unknown action", () => {
		const cli = new Cli(undefined, mockService());
		expect(() => cli.service("bogus")).toThrow("Unknown service action: bogus");
	});

	it("throws service errors", () => {
		const cli = new Cli(undefined, mockService({ install: () => { throw new Error("Settings not found."); } }));
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

		let capturedCmd = "";
		let capturedOpts: any = {};
		const exec = mock((cmd: string, opts: object) => { capturedCmd = cmd; capturedOpts = opts; });

		const deps = createMockSetupDeps();
		deps.resolveDir = () => dir;
		const cli = new Cli(deps);
		cli.claude(exec);

		fs.rmSync(dir, { recursive: true });

		expect(capturedCmd).toBe("claude --resume sess-123 --model opus");
		expect(capturedOpts.cwd).toBe("/tmp");
		expect(capturedOpts.stdio).toBe("inherit");
		expect(capturedOpts.env.CLAUDECODE).toBe("");
	});

	it("omits --resume when no session exists", async () => {
		const fs = await import("node:fs");
		const dir = `/tmp/macroclaw-test-claude-${Date.now()}`;
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(`${dir}/settings.json`, JSON.stringify({ botToken: "tok", chatId: "123", model: "sonnet", workspace: "/tmp" }));
		fs.writeFileSync(`${dir}/sessions.json`, JSON.stringify({}));

		let capturedCmd = "";
		const exec = mock((cmd: string, _opts: object) => { capturedCmd = cmd; });

		const deps = createMockSetupDeps();
		deps.resolveDir = () => dir;
		const cli = new Cli(deps);
		cli.claude(exec);

		fs.rmSync(dir, { recursive: true });

		expect(capturedCmd).toBe("claude --model sonnet");
	});

	it("throws when settings are missing", () => {
		const deps = createMockSetupDeps();
		deps.resolveDir = () => "/nonexistent/path";
		const cli = new Cli(deps);
		expect(() => cli.claude(mock())).toThrow("Settings not found");
	});
});

describe("loadRawSettings", () => {
	it("returns null when file does not exist", () => {
		expect(loadRawSettings("/nonexistent/path")).toBeNull();
	});

	it("reads and parses valid settings file", async () => {
		const dir = await import("node:fs").then(fs => {
			const d = `/tmp/macroclaw-test-${Date.now()}`;
			fs.mkdirSync(d, { recursive: true });
			fs.writeFileSync(`${d}/settings.json`, JSON.stringify({ botToken: "tok", chatId: "123" }));
			return d;
		});
		const result = loadRawSettings(dir);
		expect(result).toEqual({ botToken: "tok", chatId: "123" });
		await import("node:fs").then(fs => fs.rmSync(dir, { recursive: true }));
	});

	it("returns null for invalid JSON", async () => {
		const dir = await import("node:fs").then(fs => {
			const d = `/tmp/macroclaw-test-${Date.now()}`;
			fs.mkdirSync(d, { recursive: true });
			fs.writeFileSync(`${d}/settings.json`, "not json");
			return d;
		});
		expect(loadRawSettings(dir)).toBeNull();
		await import("node:fs").then(fs => fs.rmSync(dir, { recursive: true }));
	});

	it("returns null for non-object JSON", async () => {
		const dir = await import("node:fs").then(fs => {
			const d = `/tmp/macroclaw-test-${Date.now()}`;
			fs.mkdirSync(d, { recursive: true });
			fs.writeFileSync(`${d}/settings.json`, '"just a string"');
			return d;
		});
		expect(loadRawSettings(dir)).toBeNull();
		await import("node:fs").then(fs => fs.rmSync(dir, { recursive: true }));
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
