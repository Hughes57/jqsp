const { spawn } = require("node:child_process");

const [, , toolPath, ...toolArgs] = process.argv;
const timeoutMs = Number(process.env.TOOL_TIMEOUT_MS || 30 * 60 * 1000);

if (!toolPath) {
  console.error("Missing Swift tool path.");
  process.exit(2);
}

const child = spawn(toolPath, toolArgs, {
  stdio: ["ignore", "ignore", "pipe"],
});

const timeout = setTimeout(() => {
  child.kill("SIGKILL");
  console.error("Swift tool timed out.");
}, timeoutMs);

child.stderr.on("data", (chunk) => {
  process.stderr.write(chunk);
});

child.on("error", (error) => {
  clearTimeout(timeout);
  console.error(error.message);
  process.exit(1);
});

child.on("close", (code, signal) => {
  clearTimeout(timeout);
  if (signal) {
    console.error(`Swift tool stopped by ${signal}.`);
    process.exit(1);
  }

  process.exit(code ?? 1);
});
