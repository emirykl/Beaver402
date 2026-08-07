import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Ports 3000, 5000 and 5173 are all taken by something on a typical
// machine, so this project sits out of the way. Override either one when
// that is not true.
const backendPort = process.env.BACKEND_PORT ?? "5402";

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.FRONTEND_PORT ?? 5403),
    proxy: {
      "/api": `http://localhost:${backendPort}`,
    },
  },
});
