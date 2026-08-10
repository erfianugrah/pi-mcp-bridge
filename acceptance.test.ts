// Acceptance gate for the 2026-08-10 cold-start fixes (docs/mcp-review-2026-08-10.md).
// Authored by the operator, OUTSIDE the loop agent's writeScope. Do not edit
// to make it pass - change the extension.
//
// Requires these named exports from extensions/index.ts:
//   discoverAll(servers, makeClient, onError?) => Promise<Record<name, McpTool[]>>
//   cacheKey(cfg) => string (sha256 hex)
//   saveCache(cache, path?) / loadCache(path?)

import { test, expect } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverAll, cacheKey, saveCache, loadCache } from "./extensions/index.ts";

const TOOL = { name: "t", description: "x", inputSchema: { type: "object", properties: {} } };
const mkServers = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ name: `s${i}`, command: ["/bin/true"], env: {} }));

test("discoverAll runs servers concurrently", async () => {
  const DELAY = 400;
  const t0 = performance.now();
  const out = await discoverAll(
    mkServers(4),
    () => ({
      listTools: () => new Promise((res) => setTimeout(() => res([TOOL]), DELAY)),
      stop: () => {},
    }),
    () => {},
  );
  const wall = performance.now() - t0;
  expect(Object.keys(out)).toHaveLength(4);
  // serial would be >= 4 * 400 = 1600ms; parallel should be well under 3x one delay
  expect(wall).toBeLessThan(DELAY * 3);
});

test("discoverAll returns results in CONFIG order, not completion order", async () => {
  // later servers answer FASTER; config order must still win so tool-name
  // collision prefixing stays deterministic across runs
  const out = await discoverAll(
    mkServers(4),
    (cfg: any) => ({
      listTools: () =>
        new Promise((res) => setTimeout(() => res([TOOL]), cfg.name === "s0" ? 300 : 10)),
      stop: () => {},
    }),
    () => {},
  );
  expect(Object.keys(out)).toEqual(["s0", "s1", "s2", "s3"]);
});

test("discoverAll tolerates a failing server and reports it", async () => {
  const servers = [
    { name: "good", command: ["/bin/true"], env: {} },
    { name: "bad", command: ["/bin/false"], env: {} },
  ];
  const errors: string[] = [];
  const out = await discoverAll(
    servers,
    (cfg: any) => ({
      listTools: () =>
        cfg.name === "bad" ? Promise.reject(new Error("boom")) : Promise.resolve([TOOL]),
      stop: () => {},
    }),
    (name: string) => errors.push(name),
  );
  expect(Object.keys(out)).toEqual(["good"]);
  expect(errors).toEqual(["bad"]);
});

test("cacheKey covers command and env, and leaks nothing recoverable", () => {
  const base = { name: "x", command: ["npx", "-y", "mcp-remote", "https://example.com"], env: {} };
  const withSecretArgs = {
    ...base,
    command: [...base.command, "--header", "Authorization: Bearer SECRET-XYZ"],
  };
  const withSecretEnv = { ...base, env: { TOKEN: "SECRET-XYZ" } };
  const k0 = cacheKey(base);
  expect(cacheKey(withSecretArgs)).not.toBe(k0); // arg edits must invalidate
  expect(cacheKey(withSecretEnv)).not.toBe(k0); // env edits must invalidate
  for (const k of [k0, cacheKey(withSecretArgs), cacheKey(withSecretEnv)]) {
    expect(k).toMatch(/^[0-9a-f]{64}$/); // sha256 hex: nothing recoverable on disk
    expect(k).not.toContain("SECRET-XYZ");
  }
  expect(cacheKey(base)).toBe(k0); // deterministic
});

test("saveCache writes mode 0600 and loadCache round-trips", () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-bridge-test-"));
  const p = join(dir, "cache.json");
  const cache = { a: { key: "k", tools: [TOOL] } };
  saveCache(cache, p);
  expect(statSync(p).mode & 0o777).toBe(0o600);
  expect(loadCache(p)).toEqual(cache);
});
