// Dev-only Vite server for the audio harness (dev/audio.html): every SFX, loop, tourist voice, music mood, the
// radio distance and the ambience beds, with a meter and an offline loudness probe. Owner: client-fx-audio. Not
// part of the game build.
// Serve from the repo root:  npx vite --config games/raft-rush/client/dev/vite.audio.config.ts
//   then open http://localhost:5196/games/raft-rush/dev/audio.html
// Build check:               npx vite build --config games/raft-rush/client/dev/vite.audio.config.ts
// (builds into node_modules/.raft-rush-dev-audio so it never touches the game's client/dist).

import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vite";
import base from "../vite.config";

const repo = (p: string): string => fileURLToPath(new URL(`../../../../${p}`, import.meta.url));

export default mergeConfig(
  base,
  defineConfig({
    // Private cache / output dirs: other builders run their own Vite servers in this checkout concurrently.
    cacheDir: repo("node_modules/.vite-raft-rush-audio"),
    server: { port: 5196, strictPort: true },
    preview: { port: 5196, strictPort: true },
    build: {
      outDir: repo("node_modules/.raft-rush-dev-audio"),
      emptyOutDir: true,
      rollupOptions: { input: fileURLToPath(new URL("./audio.html", import.meta.url)) },
    },
  }),
);
