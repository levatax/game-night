// Dev-only Vite server for the UI harness (dev/ui.html): every screen, HUD state, panel, wheel and reel from mock
// models, no server needed. Owner: client-ui. Not part of the game build.
// Run from the repo root: npx vite --config games/raft-rush/client/dev/vite.ui.config.ts
// Then open http://localhost:5192/games/raft-rush/dev/ui.html?state=hud-day (see the panel for every state).
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
    cacheDir: path.resolve(here, "../../../../node_modules/.vite-raft-ui"),
    server: { port: 5192, strictPort: true },
    preview: { port: 5192, strictPort: true },
    build: {
      outDir: path.join(os.tmpdir(), "raft-rush-ui-harness"),
      emptyOutDir: true,
      rollupOptions: { input: { ui: path.resolve(here, "ui.html") } },
    },
  }),
);
