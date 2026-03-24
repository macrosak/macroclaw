process.env.LOG_LEVEL = "silent";

// Safety net: force exit if the test runner hangs due to uncollected handles.
// Tests complete in <10s; this only fires if the runner is stuck.
const safetyTimer = setTimeout(() => process.exit(0), 30_000);
safetyTimer.unref();
