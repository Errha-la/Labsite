import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const workerState = mkdtempSync(join(tmpdir(), "labsite-counter-vitest-"));

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: "./wrangler.jsonc" },
    miniflare: {
      bindings: {
        CONTACT_IDEMPOTENCY_HMAC_KEY: "test-only-hmac-key-at-least-32-bytes-long",
        CONTACT_ENVIRONMENT: "production",
        CONTACT_TEST_CLOCK: "enabled",
      },
      isolatedResourcePersistencePath: workerState,
    },
  })],
  test: {
    include: ["tests/contact-case-counter.spec.js"],
    reporters: ["default"],
  },
});
