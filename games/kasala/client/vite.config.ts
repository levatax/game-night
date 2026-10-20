import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const here = fileURLToPath(new URL(".", import.meta.url));

/**
 * Writes audio/spiker/manifest.json = { lines: ["mac_basi_01", …] } listing the announcer mp3s that exist in
 * public/audio/spiker/, so the client only requests recorded lines (no 404 noise). Drop new mp3s in that
 * folder and rebuild.
 */
function spikerManifest(): Plugin {
  return {
    name: "kasala-spiker-manifest",
    generateBundle() {
      const dir = path.join(here, "public", "audio", "spiker");
      const lines = fs.existsSync(dir)
        ? fs
            .readdirSync(dir)
            .filter((f) => f.toLowerCase().endsWith(".mp3"))
            .map((f) => f.slice(0, -4))
            .sort()
        : [];
      this.emitFile({ type: "asset", fileName: "audio/spiker/manifest.json", source: JSON.stringify({ lines }) });
    },
  };
}

export default defineConfig({
  root: here,
  base: "/games/kasala/",
  publicDir: "public",
  plugins: [spikerManifest()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    chunkSizeWarningLimit: 1500,
  },
});
