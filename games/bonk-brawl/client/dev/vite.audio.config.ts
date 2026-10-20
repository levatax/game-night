import { fileURLToPath } from "node:url";
// Dev-only Vite server for the audio harness (dev/audio.html). Not part of the build.
// Run from the repo root: npx vite --config games/bonk-brawl/client/dev/vite.audio.config.ts
// Then open http://localhost:5185/games/bonk-brawl/dev/audio.html

import { defineConfig, mergeConfig } from "vite";
import base from "../vite.config";

export default mergeConfig(
  base,
  defineConfig({
    // A private cache dir: other agents run their own Vite servers in this checkout concurrently.
    cacheDir: fileURLToPath(new URL("../../../../node_modules/.vite-audio", import.meta.url)),
    server: { port: 5185, strictPort: true },
  }),
);
