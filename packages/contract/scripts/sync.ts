/**
 * contract:sync — fetch the upstream resend-openapi HEAD and diff it against
 * our vendored, commit-pinned resend.yaml. Never overwrites: re-pinning is a
 * deliberate act (update PINNED_COMMIT + resend.yaml together, then re-run
 * codegen and the conformance suite).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PINNED_COMMIT = "b3697d45d9d0336bc851ff8f46b1d85e417e5e25";
const UPSTREAM_URL = "https://raw.githubusercontent.com/resend/resend-openapi/main/resend.yaml";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const vendoredPath = join(packageDir, "resend.yaml");

const response = await fetch(UPSTREAM_URL);
if (!response.ok) {
  throw new Error(`upstream fetch failed: ${response.status} ${response.statusText}`);
}
const upstream = await response.text();

if (upstream === readFileSync(vendoredPath, "utf8")) {
  console.warn(`vendored resend.yaml (pin ${PINNED_COMMIT.slice(0, 12)}) matches upstream HEAD`);
  process.exit(0);
}

const upstreamPath = join(mkdtempSync(join(tmpdir(), "resend-openapi-")), "resend.yaml");
writeFileSync(upstreamPath, upstream);
console.warn(`upstream HEAD differs from pin ${PINNED_COMMIT.slice(0, 12)}:\n`);
spawnSync("git", ["diff", "--no-index", "--stat", vendoredPath, upstreamPath], {
  stdio: "inherit",
});
console.warn(`\nfull diff: git diff --no-index ${vendoredPath} ${upstreamPath}`);
