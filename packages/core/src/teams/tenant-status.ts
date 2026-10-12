/**
 * SES tenant sending-status EventBridge events (AWS SES Developer Guide,
 * "Tenants" → EventBridge notifications). These fire when a tenant's sending is
 * paused or resumed — customer-managed (operator action) or AWS-managed
 * (reputation policy). We map them onto a team's `active | frozen` status.
 *
 * Wire-format notes that drive this parser:
 *   - source `aws.ses`, detail-type `Sending Status {Enabled,Disabled}`.
 *   - The tenant name is NOT inside `detail`. It is the second-to-last segment
 *     of the tenant ARN in `resources[0]`:
 *       arn:aws:ses:<region>:<account>:tenant/<tenant-name>/<tenant-id>
 *   - `detail.data.record.status` is one of ENABLED | DISABLED | REINSTATED.
 */

export interface ParsedTenantStatusEvent {
  tenantName: string;
  tenantId: string;
  /** Team status implied by the SES sending-status change. */
  status: "active" | "frozen";
  /** Raw SES status (ENABLED | DISABLED | REINSTATED), for logging. */
  sesStatus: string;
  /** CUSTOMER_MANAGED (operator paused) vs AWS_MANAGED (reputation policy). */
  origin: string;
}

interface TenantStatusEnvelope {
  resources?: unknown;
  detail?: { data?: { origin?: unknown; record?: { status?: unknown } } };
}

/** Parse `resources[0]` = arn:...:tenant/<name>/<id> into { name, id }. */
function tenantFromArn(arn: string): { tenantName: string; tenantId: string } | undefined {
  const marker = ":tenant/";
  const at = arn.indexOf(marker);
  if (at === -1) return undefined;
  const [tenantName, tenantId] = arn.slice(at + marker.length).split("/");
  if (!tenantName || !tenantId) return undefined;
  return { tenantName, tenantId };
}

/**
 * Returns the parsed event, or `undefined` if it is not a well-formed SES
 * tenant sending-status event (the handler skips those). DISABLED ⇒ frozen;
 * ENABLED and REINSTATED ⇒ active.
 */
export function parseTenantStatusEvent(event: unknown): ParsedTenantStatusEvent | undefined {
  if (typeof event !== "object" || event === null) return undefined;
  const { resources, detail } = event as TenantStatusEnvelope;
  const arn = Array.isArray(resources) && typeof resources[0] === "string" ? resources[0] : "";
  const tenant = arn ? tenantFromArn(arn) : undefined;
  if (!tenant) return undefined;

  const sesStatus = String(detail?.data?.record?.status ?? "").toUpperCase();
  if (sesStatus === "") return undefined;

  return {
    ...tenant,
    status: sesStatus === "DISABLED" ? "frozen" : "active",
    sesStatus,
    origin: String(detail?.data?.origin ?? "UNKNOWN"),
  };
}
