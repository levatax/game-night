// Dev-only Vite server for the island render harness (dev/island.html). Not part of the game build.
// Run from the repo root: npx vite --config games/raft-rush/client/dev/vite.island.config.ts
// Then open http://localhost:5191/games/raft-rush/dev/island.html?seed=4471&layout=solo&t=0.3&weather=clear
// `vite build` with this config writes to the OS temp dir (never over the game's client/dist).

import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vite";
import base from "../vite.config";

const here = fileURLToPath(new URL(".", import.meta.url));

export default mergeConfig(
  base,
  defineConfig({
    // A private cache dir: other agents run their own Vite servers in this checkout concurrently.
    cacheDir: path.resolve(here, "../../../../node_modules/.vite-raft-island"),
    server: { port: 5191, strictPort: true },
    build: {
      outDir: path.join(os.tmpdir(), "raft-rush-island-harness"),
      emptyOutDir: true,
      rollupOptions: { input: { island: path.resolve(here, "island.html") } },
    },
  }),
);
