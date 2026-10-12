import { requestBodyValidator } from "@opensender/contract";
import type { Domain, DomainsPort } from "@opensender/core";
import {
  DomainAlreadyExistsError,
  toWireTimestamp,
  UnsupportedRegionError,
} from "@opensender/core";
import { Hono } from "hono";
import { errors, sendJson } from "../errors.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Upstream's region enum (docs); anything else is 422 invalid_region. */
const KNOWN_REGIONS = ["us-east-1", "eu-west-1", "sa-east-1", "ap-northeast-1"];

interface DomainsRouteDeps {
  domains: DomainsPort;
}

function domainSummary(domain: Domain) {
  return {
    id: domain.domainId,
    name: domain.name,
    status: domain.status,
    created_at: toWireTimestamp(new Date(domain.createdAt)),
    region: domain.region,
    capabilities: {
      sending: "enabled",
      receiving: domain.inboundEnabled ? "enabled" : "disabled",
    },
  };
}

function domainDetail(deps: DomainsRouteDeps, domain: Domain, withObject: boolean) {
  return {
    // The create response carries no `object` key; GET does (fixture 31 vs
    // the documented create example).
    ...(withObject ? { object: "domain" } : {}),
    id: domain.domainId,
    name: domain.name,
    created_at: toWireTimestamp(new Date(domain.createdAt)),
    status: domain.status,
    capabilities: {
      sending: "enabled",
      receiving: domain.inboundEnabled ? "enabled" : "disabled",
    },
    records: deps.domains.recordsFor(domain),
    region: domain.region,
    open_tracking: domain.openTracking,
    click_tracking: domain.clickTracking,
  };
}

async function requireDomain(deps: DomainsRouteDeps, teamId: string, id: string): Promise<Domain> {
  if (!UUID_PATTERN.test(id)) {
    throw errors.invalidParameter("The `id` must be a valid UUID.");
  }
  const domain = await deps.domains.getDomain(teamId, id);
  if (!domain) throw errors.notFound("Domain not found");
  return domain;
}

/** Resend surface §5.8. */
export function domainRoutes(deps: DomainsRouteDeps): Hono {
  const app = new Hono();
  const validateCreate = requestBodyValidator("/domains", "post");

  app.post("/", async (c) => {
    const body = (await c.req.json().catch(() => {
      throw errors.validationError(400, "Request body must be valid JSON.");
    })) as { name?: unknown; region?: unknown; click_tracking?: unknown; open_tracking?: unknown };

    if (typeof body.region === "string" && !KNOWN_REGIONS.includes(body.region)) {
      throw errors.invalidRegion();
    }
    if (!validateCreate(body)) {
      throw errors.validationError(422, "Invalid request body");
    }

    const principal = c.get("principal");
    try {
      const domain = await deps.domains.createDomain({
        teamId: principal.teamId,
        name: String(body.name),
        ...(body.region === undefined ? {} : { region: String(body.region) }),
        ...(typeof body.click_tracking === "boolean" ? { clickTracking: body.click_tracking } : {}),
        ...(typeof body.open_tracking === "boolean" ? { openTracking: body.open_tracking } : {}),
      });
      return sendJson(c, 201, domainDetail(deps, domain, false));
    } catch (error) {
      if (error instanceof UnsupportedRegionError) {
        throw errors.validationError(422, error.message);
      }
      if (error instanceof DomainAlreadyExistsError) {
        throw errors.validationError(403, "This domain is already registered");
      }
      throw error;
    }
  });

  app.get("/", async (c) => {
    const principal = c.get("principal");
    const list = await deps.domains.listDomains(principal.teamId);
    return sendJson(c, 200, {
      object: "list",
      has_more: false,
      data: list.map(domainSummary),
    });
  });

  app.get("/:id", async (c) => {
    const principal = c.get("principal");
    const domain = await requireDomain(deps, principal.teamId, c.req.param("id"));
    return sendJson(c, 200, domainDetail(deps, domain, true));
  });

  app.post("/:id/verify", async (c) => {
    const principal = c.get("principal");
    const domain = await requireDomain(deps, principal.teamId, c.req.param("id"));
    await deps.domains.requestVerification(domain);
    return sendJson(c, 200, { object: "domain", id: domain.domainId });
  });

  app.patch("/:id", async (c) => {
    const principal = c.get("principal");
    const domain = await requireDomain(deps, principal.teamId, c.req.param("id"));
    const body = (await c.req.json().catch(() => {
      throw errors.validationError(400, "Request body must be valid JSON.");
    })) as {
      click_tracking?: unknown;
      open_tracking?: unknown;
      tls?: unknown;
      inbound_enabled?: unknown;
    };
    if (body.tls !== undefined && body.tls !== "opportunistic" && body.tls !== "enforced") {
      throw errors.validationError(422, "The `tls` field must be 'opportunistic' | 'enforced'.");
    }
    // Inbound toggle is an opensender extension (dashboard inbound switch,
    // SPEC §9/§13) — flips the flag, capability, and the receiving MX record.
    if (typeof body.inbound_enabled === "boolean") {
      await deps.domains.setInboundEnabled(domain, body.inbound_enabled);
    }
    await deps.domains.updateDomain(domain, {
      ...(typeof body.click_tracking === "boolean" ? { clickTracking: body.click_tracking } : {}),
      ...(typeof body.open_tracking === "boolean" ? { openTracking: body.open_tracking } : {}),
      ...(body.tls === undefined ? {} : { tls: body.tls as "opportunistic" | "enforced" }),
    });
    return sendJson(c, 200, { object: "domain", id: domain.domainId });
  });

  app.delete("/:id", async (c) => {
    const principal = c.get("principal");
    const domain = await requireDomain(deps, principal.teamId, c.req.param("id"));
    await deps.domains.deleteDomain(domain);
    return sendJson(c, 200, { object: "domain", id: domain.domainId, deleted: true });
  });

  return app;
}
