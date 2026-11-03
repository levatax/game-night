// Dev-only Vite server for the HUD acceptance check (dev/hud-check.html): compass overlap sweep + live storm
// countdown parity. Owner: client-ui. Not part of the game build.
// Run from the repo root: npx vite --config games/raft-rush/client/dev/vite.hud-check.config.ts
// Then open http://localhost:5193/games/raft-rush/dev/hud-check.html and read #result.

import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vite";
import base from "../vite.config";

const here = fileURLToPath(new URL(".", import.meta.url));

export default mergeConfig(
  base,
  defineConfig({
    cacheDir: path.resolve(here, "../../../../node_modules/.vite-raft-hud-check"),
    server: { port: 5193, strictPort: true },
    preview: { port: 5193, strictPort: true },
    build: {
      outDir: path.join(os.tmpdir(), "raft-rush-hud-check"),
      emptyOutDir: true,
      rollupOptions: { input: { hudCheck: path.resolve(here, "hud-check.html") } },
    },
  }),
);
