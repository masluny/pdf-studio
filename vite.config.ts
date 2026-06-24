import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";

// Tauri expects a fixed port and no clearing of the screen.
export default defineConfig({
  plugins: [tailwindcss()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    target: "es2021",
    outDir: "dist",
    sourcemap: false,
  },
});
