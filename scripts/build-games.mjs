// Builds the client of every game that has a `viteConfig` in its game.json.
// Usage: npm run build            (all games)
//        npm run build bonk-brawl (just one)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gamesDir = path.join(root, "games");
const only = process.argv.slice(2);

let built = 0;
for (const id of fs.readdirSync(gamesDir)) {
  const manifestPath = path.join(gamesDir, id, "game.json");
  if (!fs.existsSync(manifestPath)) continue;
  if (only.length && !only.includes(id)) continue;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!manifest.viteConfig || manifest.status === "soon") continue;

  console.log(`\n▶ building ${id}`);
  await build({ configFile: path.join(gamesDir, id, manifest.viteConfig), logLevel: "warn" });
  console.log(`✔ ${id} → ${path.join("games", id, manifest.clientDist ?? "client/dist")}`);
  built++;
}
console.log(`\nBuilt ${built} game client${built === 1 ? "" : "s"}.`);
