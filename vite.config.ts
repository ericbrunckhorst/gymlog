import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/gymlog/",
  plugins: [react()],
  build: {
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        entryFileNames: "assets/gymlog.js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/gymlog.[ext]"
      }
    }
  }
});
