import { describe, expect, it } from "vitest";
import {
  openapiDocument,
  publicOpenapiDocument,
  requestBodyValidator,
  schemaValidator,
} from "../src/validation.js";

const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

type JsonObject = Record<string, unknown>;

function operations(document: Record<string, unknown>): Array<[string, string, JsonObject]> {
  const paths = document.paths as Record<string, JsonObject>;
  return Object.entries(paths).flatMap(([path, item]) =>
    HTTP_METHODS.filter((method) => method in item).map((method): [string, string, JsonObject] => [
      path,
      method,
      item[method] as JsonObject,
    ]),
  );
}

describe("bundled contract", () => {
  it("carries the standard error contract on every operation", () => {
    for (const [path, method, operation] of operations(openapiDocument)) {
      const responses = operation.responses as JsonObject;
      for (const status of ["401", "404", "422", "429", "500"]) {
        expect(responses[status], `${method.toUpperCase()} ${path} ${status}`).toBeDefined();
      }
    }
  });

  it("keeps x-internal operations in the full bundle only", () => {
    const fullPaths = openapiDocument.paths as JsonObject;
    const publicPaths = publicOpenapiDocument.paths as JsonObject;
    expect(fullPaths["/health"]).toBeDefined();
    expect(publicPaths["/health"]).toBeUndefined();
    expect(operations(publicOpenapiDocument).some(([, , op]) => op["x-internal"] === true)).toBe(
      false,
    );
  });

  it("keeps the Resend surface in the public bundle", () => {
    const publicPaths = publicOpenapiDocument.paths as JsonObject;
    for (const path of ["/emails", "/emails/batch", "/domains", "/api-keys", "/broadcasts"]) {
      expect(publicPaths[path], path).toBeDefined();
    }
  });
});

describe("ajv validators from the bundle", () => {
  it("validates a POST /emails body that matches fixture 25's request", () => {
    const validate = requestBodyValidator("/emails", "post");
    expect(
      validate({
        from: "onboarding@resend.dev",
        to: ["ops@example.com"],
        subject: "opensender fixture capture",
        html: "<p>Golden fixture capture. Ignore.</p>",
      }),
    ).toBe(true);
  });

  it("rejects a POST /emails body with a wrong-typed `to` (fixture 09 shape)", () => {
    const validate = requestBodyValidator("/emails", "post");
    expect(validate({ from: "a@b.co", to: 42, subject: "x", html: "y" })).toBe(false);
  });

  it("throws on a pointer that does not exist in the bundle", () => {
    expect(() => schemaValidator("paths", "/nope", "get")).toThrow(/no schema/);
  });
});
