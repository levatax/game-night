import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: here,
  base: "/games/raft-rush/",
  publicDir: "public",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    chunkSizeWarningLimit: 1500,
    // three.js in its own chunk: it changes far less often than the game code, so browsers keep it cached.
    rollupOptions: { output: { manualChunks: { three: ["three"] } } },
  },
});
