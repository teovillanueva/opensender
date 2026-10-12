import { timingSafeEqual } from "node:crypto";
import type { Auth } from "./auth.js";

/**
 * One-time admin bootstrap (SPEC §13.2, Grafana-style): while the instance
 * has zero users, a deploy-emitted token creates the first admin. The moment
 * any user exists this whole surface answers "already bootstrapped" — the
 * token is not a credential afterwards.
 */

export class BootstrapUnavailableError extends Error {}
export class BootstrapTokenMismatchError extends Error {}

export interface BootstrapDeps {
  auth: Auth;
  /** Reads the expected token (SSM SecureString) — resolved per cold start. */
  expectedToken: () => Promise<string>;
}

function tokensMatch(presented: string, expected: string): boolean {
  const presentedBuffer = Buffer.from(presented);
  const expectedBuffer = Buffer.from(expected);
  return (
    presentedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(presentedBuffer, expectedBuffer)
  );
}

export class BootstrapService {
  constructor(private readonly deps: BootstrapDeps) {}

  async needsBootstrap(): Promise<boolean> {
    const context = await this.deps.auth.$context;
    const total = await context.adapter.count({ model: "user" });
    return total === 0;
  }

  async createFirstAdmin(input: {
    token: string;
    email: string;
    password: string;
    name: string;
  }): Promise<{ userId: string }> {
    if (!(await this.needsBootstrap())) {
      throw new BootstrapUnavailableError("instance already has users");
    }
    const expected = await this.deps.expectedToken();
    if (!tokensMatch(input.token, expected)) {
      throw new BootstrapTokenMismatchError("bootstrap token mismatch");
    }
    // Server-side call (no request/headers) — bypasses the admin plugin's
    // session guard by design, and works while disableSignUp is on.
    const result = await this.deps.auth.api.createUser({
      body: {
        email: input.email,
        password: input.password,
        name: input.name,
        role: "admin",
      },
    });
    return { userId: result.user.id };
  }
}
