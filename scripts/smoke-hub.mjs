// Smoke test for the compiled hub, the code path the Docker image runs (plain node on dist/, no tsx, no vitest):
// boots it on a free port, waits for /healthz and fails unless that answers 200, the hub said it listens on that
// port (not some other server that happened to answer there) and every game with a server logged
// "[hub] registered <id>". Exits 1 on any failure, and stops the hub it started in every case: success, failure,
// the 60 s deadline (each /healthz request is bounded by it too), an exception here, Ctrl-C or a CI cancel.
// CI runs it after `npm run build && npm run build:server`.
//   node scripts/smoke-hub.mjs [hub entry, default dist/server/index.js]
// SMOKE_PORT picks the port; default a free one from the OS. PORT is ignored, so a dev server's PORT in the
// shell never collides.
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gamesDir = path.join(root, "games");
const entry = path.resolve(root, process.argv[2] ?? "dist/server/index.js");
const TIMEOUT_MS = 60_000;
const KILL_GRACE_MS = 5_000;

/** A port nobody listens on right now (the OS picks it), for the hub to take a moment later. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// Same rule as server/index.ts: every game with a server module that isn't a "soon" teaser gets registered.
const expected = [];
for (const id of fs.readdirSync(gamesDir)) {
  const manifestPath = path.join(gamesDir, id, "game.json");
  if (!fs.existsSync(manifestPath)) continue;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.server && manifest.status !== "soon") expected.push(manifest.id);
}

const port = process.env.SMOKE_PORT ? Number(process.env.SMOKE_PORT) : await freePort();

let log = "";
let exited = false;
const hub = spawn(process.execPath, [entry], {
  cwd: root,
  env: { ...process.env, PORT: String(port) },
  stdio: ["ignore", "pipe", "pipe"],
});
hub.stdout.on("data", (d) => (log += d));
hub.stderr.on("data", (d) => (log += d));
const closed = new Promise((resolve) => hub.on("close", resolve));
hub.on("exit", () => (exited = true));
hub.on("error", (err) => {
  // Could not spawn at all ("exit" may never follow): nothing to wait for.
  log += `[smoke] could not start the hub: ${err.message}\n`;
  exited = true;
});

// Last resorts: whatever ends this script, the hub goes with it.
process.on("exit", () => {
  if (!exited) hub.kill("SIGKILL");
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    console.log(`[smoke] ${signal}: stopping the hub`);
    process.exit(1);
  });
}

// The hub only starts listening after every game server has been registered (or has failed to).
async function waitForHealthz() {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline && !exited) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      });
      return { status: res.status, body: await res.text() };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  return { status: 0, body: exited ? "the hub exited before it answered" : `no answer within ${TIMEOUT_MS / 1000}s` };
}

/** SIGTERM, then SIGKILL after KILL_GRACE_MS; resolves once the hub is gone and all its output has been read. */
async function stopHub() {
  if (!exited) hub.kill("SIGTERM");
  const forceKill = setTimeout(() => hub.kill("SIGKILL"), KILL_GRACE_MS);
  // A hub that never spawned emits no "close"; one that did always does.
  await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, KILL_GRACE_MS * 2))]);
  clearTimeout(forceKill);
}

let result = { status: 0, body: "the smoke script failed" };
try {
  result = await waitForHealthz();
} catch (err) {
  console.error("[smoke] error:", err);
} finally {
  await stopHub();
}

const { status, body } = result;
const registered = [...log.matchAll(/\[hub\] registered (\S+)/g)].map((m) => m[1]);
const missing = expected.filter((id) => !registered.includes(id));
const listening = new RegExp(`is running at http://localhost:${port}(?!\\d)`).test(log);
process.stdout.write(log);
console.log(`[smoke] /healthz on port ${port} ${status || "unreachable"}: ${body}`);
if (missing.length) console.log(`[smoke] not registered: ${missing.join(", ")}`);
if (status && !listening) console.log(`[smoke] the hub never said it listens on ${port}: another server answered`);
const ok = status === 200 && listening && missing.length === 0;
console.log(ok ? `[smoke] ok: ${registered.length} game servers registered` : "[smoke] FAILED");
process.exit(ok ? 0 : 1);
