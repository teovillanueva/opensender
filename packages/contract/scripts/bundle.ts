/**
 * Bundle resend.yaml (vendored, pinned) + extensions.yaml into:
 *   - openapi.json         full contract (public + x-internal), codegen input
 *   - openapi.public.json  x-internal stripped — served verbatim by GET /openapi.json
 *
 * Deterministic and dependency-light on purpose: redocly `join` only handles
 * disjoint paths and OpenAPI Overlay tooling is immature, while our extension
 * must add responses to existing operations. Collisions with upstream are a
 * hard error — we extend the upstream contract, never silently override it.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

type JsonObject = Record<string, unknown>;

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");

const upstream = parse(readFileSync(join(packageDir, "resend.yaml"), "utf8")) as JsonObject;
const extensions = parse(readFileSync(join(packageDir, "extensions.yaml"), "utf8")) as JsonObject;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deep-merge `addition` into `base`; scalar/array collisions are fatal. */
function mergeStrict(base: JsonObject, addition: JsonObject, path: string): void {
  for (const [key, value] of Object.entries(addition)) {
    if (!(key in base)) {
      base[key] = value;
      continue;
    }
    const existing = base[key];
    if (isObject(existing) && isObject(value)) {
      mergeStrict(existing, value, `${path}/${key}`);
      continue;
    }
    throw new Error(`extensions.yaml collides with resend.yaml at ${path}/${key}`);
  }
}

const bundle = structuredClone(upstream);

for (const section of ["paths", "webhooks", "components"]) {
  const addition = extensions[section];
  if (!isObject(addition)) continue;
  if (!isObject(bundle[section])) bundle[section] = {};
  mergeStrict(bundle[section] as JsonObject, addition, `/${section}`);
}

// Attach the standard error responses to every operation (SPEC §5.1). An
// operation that already declares a status keeps its own definition.
const errorStatuses = extensions["x-standard-error-statuses"];
if (!isObject(errorStatuses)) throw new Error("x-standard-error-statuses missing");

for (const [pathKey, pathItem] of Object.entries(bundle.paths as JsonObject)) {
  if (!isObject(pathItem)) continue;
  for (const method of HTTP_METHODS) {
    const operation = pathItem[method];
    if (!isObject(operation)) continue;
    if (!isObject(operation.responses)) {
      throw new Error(`operation ${method.toUpperCase()} ${pathKey} has no responses`);
    }
    const responses = operation.responses as JsonObject;
    for (const [status, responseName] of Object.entries(errorStatuses)) {
      if (status in responses) continue;
      responses[status] = { $ref: `#/components/responses/${String(responseName)}` };
    }
  }
}

// Public variant: drop operations tagged x-internal, then empty path items.
const publicBundle = structuredClone(bundle);
const publicPaths = publicBundle.paths as JsonObject;
for (const [pathKey, pathItem] of Object.entries(publicPaths)) {
  if (!isObject(pathItem)) continue;
  for (const method of HTTP_METHODS) {
    const operation = pathItem[method];
    if (isObject(operation) && operation["x-internal"] === true) {
      delete pathItem[method];
    }
  }
  if (!HTTP_METHODS.some((method) => method in pathItem)) {
    delete publicPaths[pathKey];
  }
}

writeFileSync(join(packageDir, "openapi.json"), `${JSON.stringify(bundle, null, 2)}\n`);
writeFileSync(
  join(packageDir, "openapi.public.json"),
  `${JSON.stringify(publicBundle, null, 2)}\n`,
);

const opCount = Object.values(bundle.paths as JsonObject)
  .filter(isObject)
  .flatMap((item) => HTTP_METHODS.filter((method) => method in item)).length;
console.warn(
  `bundled openapi.json (${opCount} operations), openapi.public.json (${
    Object.keys(publicPaths).length
  } public paths)`,
);
