import { describe, expect, it, mock } from "bun:test";

const mockPinoramaTransport = mock(() => ({ write: () => {} }));

mock.module("pinorama-transport", () => ({
  default: mockPinoramaTransport,
}));

const { createLogger, initLogger } = await import("./logger");

describe("createLogger", () => {
  it("returns a pino child logger with module field", () => {
    const log = createLogger("test-module");
    expect(log).toBeDefined();
    expect(log.bindings().module).toBe("test-module");
  });
});

describe("initLogger", () => {
  it("adds pinorama transport when PINORAMA_URL is set", async () => {
    process.env.PINORAMA_URL = "http://localhost:6200/pinorama";
    await initLogger();
    expect(mockPinoramaTransport).toHaveBeenCalledWith({ url: "http://localhost:6200/pinorama" });
    delete process.env.PINORAMA_URL;
  });

  it("does nothing when PINORAMA_URL is not set", async () => {
    delete process.env.PINORAMA_URL;
    mockPinoramaTransport.mockClear();
    await initLogger();
    expect(mockPinoramaTransport).not.toHaveBeenCalled();
  });
});
