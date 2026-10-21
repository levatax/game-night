// Dev-only Vite config for the characters harness (dev/characters.html): the six tourists, the monsters and
// the first-person arms with animation buttons. Not part of the game build. Owner: client-characters.
// Serve from the repo root:  npx vite --config games/raft-rush/client/dev/vite.characters.config.ts
// then open http://localhost:5193/games/raft-rush/dev/characters.html
// Build check:              npx vite build --config games/raft-rush/client/dev/vite.characters.config.ts
// (builds into node_modules/.raft-rush-dev-characters so it never touches the game's client/dist).

import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vite";
import base from "../vite.config";

const repo = (p: string): string => fileURLToPath(new URL(`../../../../${p}`, import.meta.url));

export default mergeConfig(
  base,
  defineConfig({
    // Private cache / output dirs: other builders run their own Vite servers in this checkout concurrently.
    cacheDir: repo("node_modules/.vite-raft-rush-characters"),
    server: { port: 5193, strictPort: true },
    preview: { port: 5193, strictPort: true },
    build: {
      outDir: repo("node_modules/.raft-rush-dev-characters"),
      emptyOutDir: true,
      rollupOptions: { input: fileURLToPath(new URL("./characters.html", import.meta.url)) },
    },
  }),
);
