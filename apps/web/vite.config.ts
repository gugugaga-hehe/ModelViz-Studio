import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const serverPort = Number(process.env.MODELVIZ_PORT ?? 5174);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { "/ws": { target: `ws://127.0.0.1:${serverPort}`, ws: true } },
  },
});
