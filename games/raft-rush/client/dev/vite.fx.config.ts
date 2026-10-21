// Dev-only Vite server for the fx harness (dev/fx.html): every burst, pop-text style, item mesh, projectile state,
// ping balloon, bobber and the arc preview, on a small hand-made beach. Owner: client-fx-audio. Not part of the
// game build.
// Serve from the repo root:  npx vite --config games/raft-rush/client/dev/vite.fx.config.ts
//   then open http://localhost:5194/games/raft-rush/dev/fx.html
// Build check:               npx vite build --config games/raft-rush/client/dev/vite.fx.config.ts
// (builds into node_modules/.raft-rush-dev-fx so it never touches the game's client/dist).

import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vite";
import base from "../vite.config";

const repo = (p: string): string => fileURLToPath(new URL(`../../../../${p}`, import.meta.url));

export default mergeConfig(
  base,
  defineConfig({
    // Private cache / output dirs: other builders run their own Vite servers in this checkout concurrently.
    cacheDir: repo("node_modules/.vite-raft-rush-fx"),
    server: { port: 5194, strictPort: true },
    preview: { port: 5194, strictPort: true },
    build: {
      outDir: repo("node_modules/.raft-rush-dev-fx"),
      emptyOutDir: true,
      rollupOptions: { input: fileURLToPath(new URL("./fx.html", import.meta.url)) },
    },
  }),
);
