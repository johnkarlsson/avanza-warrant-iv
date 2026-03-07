import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  root: ".",
  server: {
    proxy: {
      "/api": {
        target: "https://www.avanza.se",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, "/_api"),
        secure: true,
      },
    },
  },
});
