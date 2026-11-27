import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { init } from "../src/init.js";
import { optionsFromEnv, resolveConfig } from "../src/config.js";
import { memoryStore } from "../src/store.js";

function envOf(dir: string): Record<string, string> {
  return Object.fromEntries(
    readFileSync(join(dir, ".env"), "utf-8")
      .split("\n")
      .filter((l) => /^[A-Z0-9_]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
  );
}

describe("init", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const quiet = { log: () => {}, setupAccount: async () => "funded\nadded the USDC trustline" };

  it("turns an empty folder into a merchant whose configuration passes every check", async () => {
    dir = mkdtempSync(join(tmpdir(), "b402-init-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "my-api" }));
    await init(dir, { ...quiet, confirm: async () => true, fetchFacilitatorKey: async () => "generated-key" });

    const env = envOf(dir);
    expect(env.FACILITATOR_API_KEY).toBe("generated-key");
    expect(env.RECIPIENT_ADDRESS).toMatch(/^G/);
    expect(() => resolveConfig(optionsFromEnv(env, memoryStore()))).not.toThrow();
    expect(existsSync(join(dir, "server.ts"))).toBe(true);
    expect(readFileSync(join(dir, ".gitignore"), "utf-8")).toContain(".env");
    expect(statSync(join(dir, ".env")).mode & 0o077).toBe(0);
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
    expect(pkg.type).toBe("module");
    expect(pkg.scripts.start).toContain("server.ts");
  });

  it("keeps what is already there when run again", async () => {
    dir = mkdtempSync(join(tmpdir(), "b402-init-"));
    await init(dir, { ...quiet, confirm: async () => true, fetchFacilitatorKey: async () => "first" });
    const first = envOf(dir);
    writeFileSync(join(dir, "server.ts"), "// mine");
    await init(dir, { ...quiet, confirm: async () => true, fetchFacilitatorKey: async () => "second" });
    const second = envOf(dir);
    expect(second.MERCHANT_SECRET).toBe(first.MERCHANT_SECRET);
    expect(second.FACILITATOR_API_KEY).toBe("first");
    expect(readFileSync(join(dir, "server.ts"), "utf-8")).toBe("// mine");
  });

  it("asks before getting a facilitator key, and leaves it to the developer on no", async () => {
    dir = mkdtempSync(join(tmpdir(), "b402-init-"));
    let fetched = false;
    await init(dir, { ...quiet, confirm: async () => false, fetchFacilitatorKey: async () => ((fetched = true), "k") });
    expect(fetched).toBe(false);
    expect(envOf(dir).FACILITATOR_API_KEY).toBe("");
  });

  it("saves the new key before going to the network", async () => {
    dir = mkdtempSync(join(tmpdir(), "b402-init-"));
    await expect(
      init(dir, { log: () => {}, setupAccount: async () => Promise.reject(new Error("friendbot down")) })
    ).rejects.toThrow(/friendbot/);
    expect(envOf(dir).MERCHANT_SECRET).toMatch(/^S/);
  });

  it("refuses to set up mainnet", async () => {
    dir = mkdtempSync(join(tmpdir(), "b402-init-"));
    writeFileSync(join(dir, ".env"), "BEAVER402_NETWORK=mainnet\n");
    await expect(init(dir, quiet)).rejects.toThrow(/testnet/);
  });
});

describe("init in GitHub Codespaces", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  it("sets PUBLIC_URL to the codespace's forwarded address", async () => {
    dir = mkdtempSync(join(tmpdir(), "b402-init-"));
    await init(dir, {
      log: () => {},
      setupAccount: async () => "",
      confirm: async () => false,
      env: { CODESPACE_NAME: "fuzzy-space-xyz", GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: "app.github.dev" },
    });
    expect(envOf(dir).PUBLIC_URL).toBe("https://fuzzy-space-xyz-4021.app.github.dev");
  });
  it("leaves PUBLIC_URL empty elsewhere", async () => {
    dir = mkdtempSync(join(tmpdir(), "b402-init-"));
    await init(dir, { log: () => {}, setupAccount: async () => "", confirm: async () => false, env: {} });
    expect(envOf(dir).PUBLIC_URL).toBe("");
  });
});
