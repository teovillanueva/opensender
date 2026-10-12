import assert from "node:assert/strict";
import { instanceConfig } from "../../../instance.config.js";

/**
 * One-time Better Stack (Uptime) setup (SPEC §15). Idempotently creates:
 *   - a monitor polling GET https://api.<domain>/health every 3 minutes
 *   - a public status page that reports that monitor
 *
 * Run locally with the operator's token in the environment:
 *   BETTERSTACK_API_TOKEN=... pnpm --filter @opensender/scripts exec \
 *     tsx src/setup-betterstack.ts
 *
 * The token is a Better Stack Uptime API token (Uptime → Settings → API
 * tokens); it never enters git (kept in .env). Re-running is safe: existing
 * resources with the same URL / name are reused, not duplicated.
 */

const API = "https://uptime.betterstack.com/api/v2";
const token = process.env.BETTERSTACK_API_TOKEN;
assert.ok(token, "BETTERSTACK_API_TOKEN is not set (put it in .env)");

const healthUrl = `https://api.${instanceConfig.domain}/health`;
const statusSubdomain = `${instanceConfig.domain.replace(/\./g, "-")}-status`;

async function bs<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) {
    throw new Error(`Better Stack ${method} ${path} -> ${res.status}: ${await res.text()}`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

interface Resource {
  id: string;
  attributes: Record<string, unknown>;
}
interface ListResponse {
  data: Resource[];
  pagination?: { next?: string | null };
}

/** All pages of a Better Stack collection. */
async function listAll(path: string): Promise<Resource[]> {
  const out: Resource[] = [];
  let next: string | null | undefined = `${API}${path}`;
  while (next) {
    const res = await fetch(next, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Better Stack GET ${next} -> ${res.status}: ${await res.text()}`);
    const page = (await res.json()) as ListResponse;
    out.push(...page.data);
    next = page.pagination?.next ?? null;
  }
  return out;
}

// 1. Monitor on GET /health (reuse by URL).
const monitors = await listAll("/monitors");
let monitor = monitors.find((m) => m.attributes.url === healthUrl);
if (monitor) {
  console.warn(`✓ monitor already exists for ${healthUrl} (id=${monitor.id})`);
} else {
  const created = await bs<{ data: Resource }>("POST", "/monitors", {
    monitor_type: "status",
    url: healthUrl,
    pronounceable_name: `opensender ${instanceConfig.domain} /health`,
    check_frequency: 180,
    request_timeout: 15,
    confirmation_period: 0,
    http_method: "get",
    email: true,
  });
  monitor = created.data;
  console.warn(`✓ created monitor for ${healthUrl} (id=${monitor.id})`);
}

// 2. Public status page (reuse by subdomain).
const pages = await listAll("/status-pages");
let page = pages.find((p) => p.attributes.subdomain === statusSubdomain);
if (page) {
  console.warn(`✓ status page already exists (subdomain=${statusSubdomain}, id=${page.id})`);
} else {
  const created = await bs<{ data: Resource }>("POST", "/status-pages", {
    company_name: instanceConfig.instanceName,
    subdomain: statusSubdomain,
    timezone: "UTC",
    history: 90,
  });
  page = created.data;
  console.warn(`✓ created status page (subdomain=${statusSubdomain}, id=${page.id})`);
}

// 3. Report the monitor on the status page (reuse by resource id).
const resources = await listAll(`/status-pages/${page.id}/resources`);
const already = resources.some(
  (r) =>
    String(r.attributes.resource_id) === monitor.id && r.attributes.resource_type === "Monitor",
);
if (already) {
  console.warn("✓ monitor already reported on the status page");
} else {
  await bs("POST", `/status-pages/${page.id}/resources`, {
    resource_id: Number(monitor.id),
    resource_type: "Monitor",
    public_name: "API",
    widget_type: "response_times",
  });
  console.warn("✓ added the monitor to the status page");
}

console.warn(
  `\nBetter Stack setup complete. Status page: https://${statusSubdomain}.betteruptime.com`,
);
