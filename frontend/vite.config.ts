import { readFileSync } from "fs";
import { resolve } from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Read a value out of the backend env file.
 *
 * The ports are searched for at setup time rather than fixed, because any
 * number we picked would eventually collide with something else running on
 * the machine. Reading them back here keeps the proxy and the passkey origin
 * pointing at whatever was actually free.
 */
function fromBackendEnv(key: string): string | undefined {
  try {
    const contents = readFileSync(resolve(__dirname, "../backend/.env"), "utf-8");
    const line = contents
      .split("\n")
      .find((candidate) => candidate.startsWith(`${key}=`));
    return line?.slice(key.length + 1).trim() || undefined;
  } catch {
    return undefined;
  }
}

const backendPort = process.env.BACKEND_PORT ?? fromBackendEnv("PORT") ?? "3000";
const frontendPort = Number(
  process.env.FRONTEND_PORT ?? fromBackendEnv("FRONTEND_PORT") ?? 5173
);

export default defineConfig({
  plugins: [react()],
  server: {
    port: frontendPort,
    // A passkey is bound to the origin it was registered on, so drifting to
    // the next free port would quietly break owner actions. Better to fail.
    strictPort: true,
    proxy: {
      "/api": `http://localhost:${backendPort}`,
    },
  },
});
