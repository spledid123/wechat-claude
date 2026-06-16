import { loadRuntimeEnv } from "./runtime/env.js";
import { WechatClaudeService } from "./runtime/service.js";

loadRuntimeEnv({ appRoot: process.cwd() });

const service = new WechatClaudeService();
let shutdownRequested = false;

process.on("SIGINT", () => {
  void requestShutdown("SIGINT");
});
process.on("SIGTERM", () => {
  void requestShutdown("SIGTERM");
});

process.on("uncaughtException", (err) => {
  console.error(`Uncaught exception: ${err.stack ?? err.message}`);
});

process.on("unhandledRejection", (reason) => {
  console.error(`Unhandled rejection: ${String(reason)}`);
});

await service.start();
const status = service.getStatus();
console.log(`State       : ${status.state}`);
console.log(`Admin panel : ${status.adminUrl ?? "(not started)"}`);
console.log(`Data dir    : ${status.paths.dataDir}`);
console.log(`Log file    : ${status.logFile}`);

await service.waitUntilStopped();

async function requestShutdown(signalName: string): Promise<void> {
  if (shutdownRequested) {
    console.log(`${signalName} received again; forcing exit.`);
    process.exit(130);
  }
  shutdownRequested = true;
  console.log(`${signalName} received; stopping service...`);
  await service.stop();
}
