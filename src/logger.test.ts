import { describe, expect, it, mock } from "bun:test";

const mockPinoramaTransport = mock(() => ({ write: () => {} }));

mock.module("pinorama-transport", () => ({
  default: mockPinoramaTransport,
}));

const { createLogger, configureLogger } = await import("./logger");

describe("createLogger", () => {
  it("returns a pino child logger with module field", () => {
    const log = createLogger("test-module");
    expect(log).toBeDefined();
    expect(log.bindings().module).toBe("test-module");
  });
});

describe("configureLogger", () => {
  it("does nothing when called without opts", async () => {
    mockPinoramaTransport.mockClear();
    await configureLogger();
    expect(mockPinoramaTransport).not.toHaveBeenCalled();
  });

  it("sets log level from opts", async () => {
    const log = createLogger("opts-level");
    await configureLogger({ level: "warn" });
    expect(log.level).toBe("warn");
    await configureLogger({ level: "info" }); // restore
  });

  it("adds pinorama transport from opts", async () => {
    mockPinoramaTransport.mockClear();
    await configureLogger({ pinoramaUrl: "http://example.com/pinorama" });
    expect(mockPinoramaTransport).toHaveBeenCalledWith({ url: "http://example.com/pinorama" });
  });

  it("does not add duplicate pinorama transport on second call", async () => {
    mockPinoramaTransport.mockClear();
    await configureLogger({ pinoramaUrl: "http://example.com/pinorama" });
    expect(mockPinoramaTransport).not.toHaveBeenCalled();
  });
});
