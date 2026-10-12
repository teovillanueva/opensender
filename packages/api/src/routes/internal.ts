import type { BootstrapPort } from "@opensender/core";
import { BootstrapTokenMismatchError, BootstrapUnavailableError } from "@opensender/core";
import { Hono } from "hono";
import { errors, sendJson } from "../errors.js";

/**
 * x-internal first-run surface (SPEC §13.2). Unauthenticated by design: the
 * dashboard needs the status before any user can exist, and the create call
 * is gated by the deploy-emitted token plus the zero-users invariant.
 */
export function bootstrapRoutes(deps: { bootstrap: BootstrapPort }): Hono {
  const app = new Hono();

  app.get("/", async (c) =>
    sendJson(c, 200, { needs_bootstrap: await deps.bootstrap.needsBootstrap() }),
  );

  app.post("/", async (c) => {
    const body = await c.req.json().catch(() => {
      throw errors.validationError(400, "Request body must be valid JSON.");
    });
    const { token, email, password, name } = body as Record<string, unknown>;
    for (const [field, value] of Object.entries({ token, email, password, name })) {
      if (typeof value !== "string" || value.length === 0) {
        throw errors.validationError(422, `Missing \`${field}\` field.`);
      }
    }
    try {
      const created = await deps.bootstrap.createFirstAdmin({
        token: token as string,
        email: email as string,
        password: password as string,
        name: name as string,
      });
      return sendJson(c, 201, { user_id: created.userId });
    } catch (error) {
      if (error instanceof BootstrapUnavailableError) {
        throw errors.validationError(403, "Instance already has users");
      }
      if (error instanceof BootstrapTokenMismatchError) {
        throw errors.validationError(403, "Bootstrap token mismatch");
      }
      throw error;
    }
  });

  return app;
}
