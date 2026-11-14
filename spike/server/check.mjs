import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { unstable_startWorker } from "wrangler";

const here = (name) => fileURLToPath(new URL(name, import.meta.url));
const worker = await unstable_startWorker({
  config: here("wrangler.jsonc"),
  dev: { server: { port: 0 }, inspector: false, persist: false, watch: false },
});
let status = 1;
try {
  await worker.ready;
  const url = String(await worker.url);
  const drill = spawn(
    process.execPath,
    [here("drill.mjs"), url, "--changes", "40", "--every-ms", "50", "--kill-s", "3", "--ping-ms", "100"],
    { stdio: "inherit" },
  );
  [status] = await once(drill, "exit");
} finally {
  await worker.dispose();
}
console.log(status === 0 ? "check:spike-server ok" : "check:spike-server FAILED");
process.exit(status);
