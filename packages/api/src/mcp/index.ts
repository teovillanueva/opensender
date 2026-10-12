import { StreamableHTTPTransport } from "@hono/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { publicOpenapiDocument } from "@opensender/contract";
import type {
  BroadcastsPort,
  ContactsPort,
  DomainsPort,
  EmailsPort,
  QuotaUsage,
  RateLimiterPort,
  SegmentsPort,
  TeamsPort,
} from "@opensender/core";
import {
  parseScheduledAt,
  SendRejectedError,
  SendValidationError,
  validateSendRequest,
} from "@opensender/core";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { ResendApiError, sendJson } from "../errors.js";
import { type AuthenticateDeps, authenticate } from "../middleware/authenticate.js";
import { rateLimit } from "../middleware/rate-limit.js";
import type { BroadcastSenderPort } from "../routes/broadcasts.js";

/**
 * MCP server (SPEC §14). `POST /mcp` exposes the platform to agents over
 * Streamable HTTP, driven by the same bearer keys and per-team rate limits as
 * the REST surface. Tools call the `core` service layer directly — the single
 * source of truth — and return compact, agent-friendly summaries (never full
 * HTML bodies) with an explanatory next step on error.
 */

export interface McpRouteDeps extends AuthenticateDeps {
  /** Public API origin — the request URL shows the Lambda URL behind the router. */
  apiOrigin?: string | undefined;
  emails: EmailsPort;
  domains: DomainsPort;
  segments: SegmentsPort;
  contacts: ContactsPort;
  broadcasts: BroadcastsPort;
  broadcastSender: BroadcastSenderPort;
  teams: TeamsPort;
  rateLimiter: RateLimiterPort;
  quotaUsage: (teamId: string) => Promise<QuotaUsage>;
  now: () => Date;
}

interface ToolContext {
  deps: McpRouteDeps;
  teamId: string;
  /** OAuth grants narrowed to specific sending domains. */
  allowedDomainIds?: string[] | undefined;
}

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function fail(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/** Map a thrown service error to a compact message plus a suggested next step. */
function toToolError(error: unknown, hint: string): ToolResult {
  if (
    error instanceof ResendApiError ||
    error instanceof SendValidationError ||
    error instanceof SendRejectedError
  ) {
    return fail(`${error.message} ${hint}`.trim());
  }
  // Untyped throws are internal invariants — surface a generic message rather
  // than echoing internal wording back to the agent.
  return fail(`The request could not be completed. ${hint}`.trim());
}

async function runTool(hint: string, fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (error) {
    return toToolError(error, hint);
  }
}

const recipient = z.union([z.string(), z.array(z.string())]);

/** send_email is the only tool a `sending_access` key may see or call. */
function registerSendTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "send_email",
    {
      title: "Send email",
      description:
        "Send a transactional email from a verified domain. Provide `from`, `to`, `subject` and at least one of `html`/`text`. Returns the email id and its delivery status.",
      inputSchema: {
        from: z.string().describe("Sender, e.g. 'Acme <hi@acme.com>'. Domain must be verified."),
        to: recipient.describe("Recipient address or list of addresses."),
        subject: z.string(),
        html: z.string().optional().describe("HTML body. Provide html or text."),
        text: z.string().optional().describe("Plain-text body. Provide html or text."),
        cc: recipient.optional(),
        bcc: recipient.optional(),
        reply_to: recipient.optional(),
        scheduled_at: z
          .string()
          .optional()
          .describe("ISO 8601 instant or natural language ('in 1 hour') to schedule the send."),
        tags: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
      },
    },
    (args) =>
      runTool("Check the `from` domain is verified and the body is under 256 KB.", async () => {
        const request = validateSendRequest(args);
        if (request.scheduledAt !== undefined) {
          request.scheduledAt = parseScheduledAt(request.scheduledAt, ctx.deps.now());
        }
        const { email } = await ctx.deps.emails.send(ctx.teamId, request, {
          enforceSync: true,
          allowedDomainIds: ctx.allowedDomainIds,
        });
        return ok(`Email accepted. id=${email.emailId}, status=${email.status}.`);
      }),
  );
}

function registerAdminTools(server: McpServer, ctx: ToolContext): void {
  const { deps, teamId } = ctx;

  server.registerTool(
    "get_email",
    {
      title: "Get email",
      description:
        "Fetch one email's status and delivery timeline by id. Returns a compact summary (no HTML body).",
      inputSchema: {
        id: z.string().describe("The email id returned by send_email or list_emails."),
      },
    },
    ({ id }) =>
      runTool("Use list_emails to find valid email ids.", async () => {
        const email = await deps.emails.getEmail(teamId, id);
        if (!email) return fail(`No email found with id ${id}. Use list_emails to find valid ids.`);
        const events = await deps.emails.listEvents(teamId, id);
        return ok(
          JSON.stringify({
            id: email.emailId,
            direction: email.direction,
            from: email.from,
            to: email.to,
            subject: email.subject,
            status: email.status,
            created_at: email.createdAt,
            timeline: events.map((event) => ({ type: event.type, at: event.occurredAt })),
          }),
        );
      }),
  );

  server.registerTool(
    "list_emails",
    {
      title: "List emails",
      description:
        "List recent sent emails (newest first) as compact summaries. Use get_email for a single email's full timeline.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe("Max rows (default 20)."),
      },
    },
    ({ limit }) =>
      runTool("", async () => {
        const { emails } = await deps.emails.listEmails(teamId, limit ?? 20);
        return ok(
          JSON.stringify(
            emails.map((email) => ({
              id: email.emailId,
              to: email.to,
              subject: email.subject,
              status: email.status,
              created_at: email.createdAt,
            })),
          ),
        );
      }),
  );

  server.registerTool(
    "create_domain",
    {
      title: "Create domain",
      description:
        "Register a sending domain. Returns the DNS records the user must add at their DNS provider; then call verify_domain.",
      inputSchema: {
        name: z.string().describe("The domain, e.g. 'acme.com'."),
        open_tracking: z.boolean().optional(),
        click_tracking: z.boolean().optional(),
      },
    },
    ({ name, open_tracking, click_tracking }) =>
      runTool(
        "Domain names must be unique per instance and in this instance's region.",
        async () => {
          const domain = await deps.domains.createDomain({
            teamId,
            name,
            ...(open_tracking === undefined ? {} : { openTracking: open_tracking }),
            ...(click_tracking === undefined ? {} : { clickTracking: click_tracking }),
          });
          return ok(
            JSON.stringify({
              id: domain.domainId,
              name: domain.name,
              status: domain.status,
              region: domain.region,
              records: deps.domains.recordsFor(domain).map((record) => ({
                type: record.type,
                name: record.name,
                value: record.value,
                ...(record.priority === undefined ? {} : { priority: record.priority }),
              })),
              next_step: "Add these DNS records, then call verify_domain with this id.",
            }),
          );
        },
      ),
  );

  server.registerTool(
    "list_domains",
    {
      title: "List domains",
      description: "List the team's sending domains and their verification status.",
      inputSchema: {},
    },
    () =>
      runTool("", async () => {
        const domains = await deps.domains.listDomains(teamId);
        return ok(
          JSON.stringify(
            domains.map((domain) => ({
              id: domain.domainId,
              name: domain.name,
              status: domain.status,
              region: domain.region,
            })),
          ),
        );
      }),
  );

  server.registerTool(
    "verify_domain",
    {
      title: "Verify domain",
      description:
        "Ask the provider to re-check a domain's DNS records and return the updated status. Run after adding the records from create_domain.",
      inputSchema: { id: z.string().describe("The domain id from create_domain or list_domains.") },
    },
    ({ id }) =>
      runTool("Use list_domains to find valid domain ids.", async () => {
        const domain = await deps.domains.getDomain(teamId, id);
        if (!domain)
          return fail(`No domain found with id ${id}. Use list_domains to find valid ids.`);
        const updated = await deps.domains.requestVerification(domain);
        return ok(
          `Verification requested for ${updated.name}. status=${updated.status}. Re-run verify_domain after DNS propagates if still pending.`,
        );
      }),
  );

  server.registerTool(
    "list_segments",
    {
      title: "List audiences",
      description: "List the team's audiences (segments) for broadcasts and contacts.",
      inputSchema: {},
    },
    () =>
      runTool("", async () => {
        const segments = await deps.segments.list(teamId);
        return ok(
          JSON.stringify(
            segments.map((segment) => ({
              id: segment.segmentId,
              name: segment.name,
              created_at: segment.createdAt,
            })),
          ),
        );
      }),
  );

  server.registerTool(
    "add_contact",
    {
      title: "Add contact",
      description: "Add a contact to an audience. Returns the contact id.",
      inputSchema: {
        audience_id: z.string().describe("The audience (segment) id from list_segments."),
        email: z.string().describe("Contact email address."),
        first_name: z.string().optional(),
        last_name: z.string().optional(),
        unsubscribed: z.boolean().optional(),
      },
    },
    ({ audience_id, email, first_name, last_name, unsubscribed }) =>
      runTool("Use list_segments to find valid audience ids.", async () => {
        const segment = await deps.segments.get(teamId, audience_id);
        if (!segment) {
          return fail(
            `No audience found with id ${audience_id}. Use list_segments to find valid ids.`,
          );
        }
        const contact = await deps.contacts.create({
          teamId,
          segmentId: audience_id,
          email,
          ...(first_name === undefined ? {} : { firstName: first_name }),
          ...(last_name === undefined ? {} : { lastName: last_name }),
          ...(unsubscribed === undefined ? {} : { unsubscribed }),
        });
        return ok(`Contact added. id=${contact.contactId}, email=${contact.email}.`);
      }),
  );

  server.registerTool(
    "unsubscribe_contact",
    {
      title: "Unsubscribe contact",
      description: "Mark a contact in an audience as unsubscribed so broadcasts skip them.",
      inputSchema: {
        audience_id: z.string().describe("The audience (segment) id."),
        contact: z.string().describe("The contact id or email address."),
      },
    },
    ({ audience_id, contact }) =>
      runTool("Use add_contact/list_segments to confirm the audience and contact.", async () => {
        const segment = await deps.segments.get(teamId, audience_id);
        if (!segment) {
          return fail(
            `No audience found with id ${audience_id}. Use list_segments to find valid ids.`,
          );
        }
        const record = await deps.contacts.getByIdOrEmail(teamId, audience_id, contact);
        if (!record) return fail(`No contact '${contact}' found in audience ${audience_id}.`);
        const updated = await deps.contacts.setUnsubscribed(record, true);
        return ok(`Contact ${updated.email} is now unsubscribed.`);
      }),
  );

  server.registerTool(
    "create_broadcast",
    {
      title: "Create broadcast",
      description:
        "Create a broadcast (marketing campaign) targeting an audience. Returns the broadcast id; call send_broadcast to deliver it.",
      inputSchema: {
        audience_id: z.string().describe("The audience (segment) id from list_segments."),
        from: z.string().describe("Sender from a verified domain."),
        subject: z.string(),
        html: z.string().optional(),
        text: z.string().optional(),
        name: z.string().optional().describe("Internal name for the broadcast."),
        reply_to: z.string().optional(),
      },
    },
    ({ audience_id, from, subject, html, text, name, reply_to }) =>
      runTool("Use list_segments to find valid audience ids.", async () => {
        const segment = await deps.segments.get(teamId, audience_id);
        if (!segment) {
          return fail(
            `No audience found with id ${audience_id}. Use list_segments to find valid ids.`,
          );
        }
        const broadcast = await deps.broadcasts.create({
          teamId,
          segmentId: audience_id,
          from,
          subject,
          ...(html === undefined ? {} : { html }),
          ...(text === undefined ? {} : { text }),
          ...(name === undefined ? {} : { name }),
          ...(reply_to === undefined ? {} : { replyTo: reply_to }),
        });
        return ok(
          `Broadcast created. id=${broadcast.broadcastId}. Call send_broadcast with this id to deliver it.`,
        );
      }),
  );

  server.registerTool(
    "send_broadcast",
    {
      title: "Send broadcast",
      description:
        "Deliver a broadcast to its audience now, or schedule it for later with `scheduled_at`.",
      inputSchema: {
        id: z.string().describe("The broadcast id from create_broadcast."),
        scheduled_at: z
          .string()
          .optional()
          .describe("ISO 8601 instant or natural language to defer the send. Omit to send now."),
      },
    },
    ({ id, scheduled_at }) =>
      runTool("Use create_broadcast to obtain a broadcast id.", async () => {
        const broadcast = await deps.broadcasts.get(teamId, id);
        if (!broadcast) return fail(`No broadcast found with id ${id}.`);
        if (scheduled_at === undefined) {
          await deps.broadcasts.markStatus(broadcast.broadcastId, "sending");
          await deps.broadcastSender.send(broadcast.broadcastId, teamId);
          return ok(`Broadcast ${broadcast.broadcastId} is sending now.`);
        }
        const scheduledAt = parseScheduledAt(scheduled_at, deps.now());
        await deps.broadcasts.setSchedule(broadcast.broadcastId, scheduledAt);
        await deps.broadcastSender.send(broadcast.broadcastId, teamId, scheduledAt);
        return ok(`Broadcast ${broadcast.broadcastId} scheduled for ${scheduledAt}.`);
      }),
  );

  server.registerTool(
    "get_usage_stats",
    {
      title: "Get usage stats",
      description: "Report the team's emails sent today/this month and the account limits.",
      inputSchema: {},
    },
    () =>
      runTool("", async () => {
        const team = await deps.teams.getTeam(teamId);
        if (!team) return fail("Team not found.");
        const usage = await deps.quotaUsage(teamId);
        const limits = deps.teams.quotasFor(team);
        return ok(
          JSON.stringify({
            sent: { daily: usage.daily, monthly: usage.monthly },
            limits: {
              daily_email_limit: limits.dailyEmailLimit,
              api_rate_limit_per_second: limits.apiRateLimitPerSecond,
            },
          }),
        );
      }),
  );
}

/** Expose the public OpenAPI document as an MCP resource (SPEC §14). */
function registerResources(server: McpServer): void {
  const body = JSON.stringify(publicOpenapiDocument);
  server.registerResource(
    "openapi",
    "openapi://opensender",
    {
      title: "OpenSender OpenAPI specification",
      description: "The public REST API contract these tools are built on.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "application/json", text: body }],
    }),
  );
}

/**
 * Build a fresh, per-request MCP server scoped to the principal. Stateless
 * transports handle exactly one request each (SPEC §14), so a new server per
 * call is the correct shape and also implements permission filtering: a
 * `sending_access` key only ever gets `send_email` registered — admin tools are
 * invisible in tools/list and unknown (rejected) if named directly.
 */
function createMcpServer(
  deps: McpRouteDeps,
  principal: {
    teamId: string;
    permission: "full_access" | "sending_access";
    allowedDomainIds?: string[] | undefined;
  },
): McpServer {
  const server = new McpServer({ name: "opensender", version: "1.0.0" });
  const ctx: ToolContext = {
    deps,
    teamId: principal.teamId,
    allowedDomainIds: principal.allowedDomainIds,
  };
  registerSendTools(server, ctx);
  if (principal.permission === "full_access") registerAdminTools(server, ctx);
  // The OpenAPI contract is already public; expose it as a resource to every
  // key (SPEC §14), independent of the tool permission filter.
  registerResources(server);
  return server;
}

async function handleMcpPost(c: Context, deps: McpRouteDeps): Promise<Response> {
  const server = createMcpServer(deps, c.get("principal"));
  // Stateless Streamable HTTP: omitting `sessionIdGenerator` disables session
  // management (stateless), and `enableJsonResponse` buffers a single JSON body
  // instead of an SSE stream — exactly Lambda's request/response model (SPEC §14).
  const transport = new StreamableHTTPTransport({ enableJsonResponse: true });
  await server.connect(transport);
  // A body with only notifications/responses yields 202 with no Response object.
  const response = await transport.handleRequest(c);
  return response ?? c.body(null, 202);
}

/**
 * `/mcp` surface. Bearer auth + per-team rate limiting are reused from the REST
 * middleware; `enforceKeyPermissions` (the path-based REST guard) is deliberately
 * NOT applied — MCP restricts capability by which tools get registered, not by
 * path. GET returns 405 (no SSE stream in stateless mode).
 */
export function mcpRoutes(deps: McpRouteDeps): Hono {
  const app = new Hono();

  app.get("/", (c) =>
    sendJson(c, 405, {
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method Not Allowed. Use POST for MCP Streamable HTTP." },
      id: null,
    }),
  );

  // MCP connect flow (RFC 9728): a failed auth advertises where the
  // protected-resource metadata lives so hosts can discover the OAuth server
  // and run the authorize flow instead of asking the user for a pasted key.
  const authMiddleware = authenticate(deps);
  app.use("*", async (c, next) => {
    try {
      await authMiddleware(c, next);
    } catch (error) {
      const origin = deps.apiOrigin ?? new URL(c.req.url).origin;
      c.header(
        "WWW-Authenticate",
        `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
      );
      throw error;
    }
  });
  app.use("*", rateLimit(deps));
  app.post("/", (c) => handleMcpPost(c, deps));

  return app;
}
