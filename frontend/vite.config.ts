import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Port 3000 is a popular default, so set BACKEND_PORT when something else
// on the machine already has it.
const backendPort = process.env.BACKEND_PORT ?? "3000";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": `http://localhost:${backendPort}`,
    },
  },
});
