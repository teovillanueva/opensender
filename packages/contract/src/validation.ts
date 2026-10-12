/**
 * Runtime request validation, compiled directly from the bundled OpenAPI
 * document (SPEC §2: Ajv against the spec's JSON Schemas — never a second
 * hand-written representation). resend.yaml is OpenAPI 3.1 (JSON Schema
 * 2020-12), so Ajv's 2020 dialect applies as-is; `strict: false` only
 * tolerates OpenAPI-specific annotation keywords (`example`, `discriminator`).
 *
 * Validators compile lazily on first use and are memoized by Ajv itself,
 * so a warm Lambda pays the compile cost once per (path, method).
 */
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
// Named deep import dodges ajv-formats' CJS default-export interop, which
// resolves differently under tsc NodeNext vs esbuild; the formats map fed via
// Ajv options is equivalent to calling the plugin for format validation.
import { fullFormats } from "ajv-formats/dist/formats.js";
import openapiJson from "../openapi.json" with { type: "json" };
import publicOpenapiJson from "../openapi.public.json" with { type: "json" };

// The bundle is data to Ajv and to HTTP handlers; typing it as the literal
// 200 KB JSON shape buys nothing and slows every downstream typecheck.
export const openapiDocument: Record<string, unknown> = openapiJson;
export const publicOpenapiDocument: Record<string, unknown> = publicOpenapiJson;

const OPENAPI_SCHEMA_ID = "opensender-contract";

const ajv = new Ajv2020({ strict: false, allErrors: true, formats: fullFormats });
ajv.addSchema(openapiDocument, OPENAPI_SCHEMA_ID);

function escapeJsonPointerSegment(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

/** Compile (or fetch memoized) the validator at a JSON-pointer into the bundle. */
export function schemaValidator(...pointerSegments: string[]): ValidateFunction {
  const pointer = pointerSegments.map(escapeJsonPointerSegment).join("/");
  const ref = `${OPENAPI_SCHEMA_ID}#/${pointer}`;
  const validate = ajv.getSchema(ref);
  if (!validate) {
    throw new Error(`no schema in the contract bundle at ${ref}`);
  }
  return validate;
}

/** Validator for an operation's JSON request body, e.g. ("/emails", "post"). */
export function requestBodyValidator(path: string, method: string): ValidateFunction {
  return schemaValidator(
    "paths",
    path,
    method,
    "requestBody",
    "content",
    "application/json",
    "schema",
  );
}
