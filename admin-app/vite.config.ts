import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The built app is committed into server/app-dist/ and served by the
// existing Node server — no build step on Render, no deploy config to
// change. Assets are referenced from /app-assets/ (a path the server
// maps straight at server/app-dist/assets/), while every /app/* route
// serves index.html so client-side routing survives a refresh.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "/app-assets/",
  build: {
    outDir: "../server/app-dist",
    emptyOutDir: true,
    assetsDir: "assets"
  },
  server: {
    port: 5173,
    // Local dev only: talk to the real Node server for data.
    proxy: {
      "/api": { target: "http://localhost:3000", changeOrigin: false }
    }
  }
});
