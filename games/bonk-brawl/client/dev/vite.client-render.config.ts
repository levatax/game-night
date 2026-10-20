import { fileURLToPath } from "node:url";
// Dev-only Vite server for the render harness (dev/client-render.html). Not part of the build.
// Run from the repo root: npx vite --config games/bonk-brawl/client/dev/vite.client-render.config.ts
// Then open http://localhost:5181/games/bonk-brawl/dev/client-render.html

import { defineConfig, mergeConfig } from "vite";
import base from "../vite.config";

export default mergeConfig(
  base,
  defineConfig({
    // A private cache dir: other agents run their own Vite servers in this checkout concurrently.
    cacheDir: fileURLToPath(new URL("../../../../node_modules/.vite-client-render", import.meta.url)),
    server: { port: 5181, strictPort: true },
  }),
);
