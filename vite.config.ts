import { readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

function shipLibrary(): Plugin {
  return {
    name: "ship-library",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "data/library.json",
        source: readFileSync("data/library.json", "utf8"),
      });
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [react(), shipLibrary()],
});
