import { fileURLToPath } from "node:url";
// Dev-only Vite server for the characters harness (dev/client-characters.html). Not part of the build.
// Run from the repo root: npx vite --config games/bonk-brawl/client/dev/vite.client-characters.config.ts
// Then open http://localhost:5182/games/bonk-brawl/dev/client-characters.html

import { defineConfig, mergeConfig } from "vite";
import base from "../vite.config";

export default mergeConfig(
  base,
  defineConfig({
    // A private cache dir: other agents run their own Vite servers in this checkout concurrently.
    cacheDir: fileURLToPath(new URL("../../../../node_modules/.vite-client-characters", import.meta.url)),
    server: { port: 5182, strictPort: true },
  }),
);
