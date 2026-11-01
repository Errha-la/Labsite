import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

const workerState = mkdtempSync(join(tmpdir(), "labsite-contact-worker-"));
const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const cleanEnvironment = [
  `PATH=${shellQuote(process.env.PATH || "/usr/bin:/bin")}`,
  `HOME=${shellQuote(workerState)}`,
  `XDG_CONFIG_HOME=${shellQuote(workerState)}`,
  "CI=1",
  "WRANGLER_SEND_METRICS=false",
  "VITE_TURNSTILE_SITE_KEY=1x00000000000000000000AA",
].join(" ");
const serveCommand = [
  "./node_modules/.bin/wrangler dev --local --ip 127.0.0.1 --port 8787",
  `--persist-to ${shellQuote(workerState)}`,
  "--var TURNSTILE_SECRET:test-secret",
  "--var TURNSTILE_EXPECTED_HOSTNAME:127.0.0.1",
].join(" ");

export default defineConfig({
  testDir: "./tests",
  testMatch: "contact-worker.spec.js",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:8787",
    browserName: "chromium",
    headless: true,
    trace: "retain-on-failure",
  },
  webServer: {
    command: `env -i ${cleanEnvironment} /bin/sh -c ${shellQuote(`npm run build:cloudflare && ${serveCommand}`)}`,
    url: "http://127.0.0.1:8787/",
    timeout: 30_000,
    reuseExistingServer: false,
  },
});
