import { describe, expect, it } from "vitest";
import { toWireTimestamp } from "../src/wire.js";

describe("wire timestamps", () => {
  it("serializes Postgres-style, microsecond precision, +00 offset", () => {
    expect(toWireTimestamp(new Date("2026-08-08T17:58:15.369Z"))).toBe(
      "2026-08-08 17:58:15.369000+00",
    );
  });

  it("keeps zero milliseconds explicit", () => {
    expect(toWireTimestamp(new Date("2026-01-02T03:04:05.000Z"))).toBe(
      "2026-01-02 03:04:05.000000+00",
    );
  });
});
