// Dev mode: rebuild game clients on change and restart the hub server on change.
// Everything is served from one port (http://localhost:3000), same as production.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gamesDir = path.join(root, "games");
const children = [];

const run = (label, cmd, args) => {
  const child = spawn(cmd, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"], shell: false });
  const prefix = (chunk) =>
    chunk
      .toString()
      .split("\n")
      .filter(Boolean)
      .map((line) => `[${label}] ${line}`)
      .join("\n") + "\n";
  child.stdout.on("data", (d) => process.stdout.write(prefix(d)));
  child.stderr.on("data", (d) => process.stderr.write(prefix(d)));
  children.push(child);
};

const bin = (name) => path.join(root, "node_modules", ".bin", name);

for (const id of fs.readdirSync(gamesDir)) {
  const manifestPath = path.join(gamesDir, id, "game.json");
  if (!fs.existsSync(manifestPath)) continue;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!manifest.viteConfig || manifest.status === "soon") continue;
  run(id, bin("vite"), ["build", "--watch", "--config", path.join("games", id, manifest.viteConfig)]);
}
run("hub", bin("tsx"), ["watch", "--clear-screen=false", "server/index.ts"]);

const stop = () => {
  for (const child of children) child.kill("SIGINT");
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
