import { ChangeResourceRecordSetsCommand, Route53Client } from "@aws-sdk/client-route-53";

/**
 * Verify-gate helper (SPEC M2): simulate the customer loading the domain's
 * DNS records at their provider — here, the instance's own Route53 zone.
 *
 * Usage:
 *   tsx src/apply-domain-records.ts <apiBaseUrl> <apiKey> <domainId> <hostedZoneId>
 */

const [apiBaseUrl, apiKey, domainId, hostedZoneId] = process.argv.slice(2);
if (!apiBaseUrl || !apiKey || !domainId || !hostedZoneId) {
  console.error("usage: apply-domain-records <apiBaseUrl> <apiKey> <domainId> <hostedZoneId>");
  process.exit(1);
}

interface WireRecord {
  record: string;
  name: string;
  type: string;
  ttl: string;
  value: string;
  priority?: number;
}

const response = await fetch(`${apiBaseUrl}/domains/${domainId}`, {
  headers: { authorization: `Bearer ${apiKey}` },
});
if (!response.ok) throw new Error(`GET /domains/${domainId} -> ${response.status}`);
const domain = (await response.json()) as { name: string; records: WireRecord[] };

const route53 = new Route53Client({});
const changes = domain.records
  .filter((record) => record.record !== "DMARC")
  .map((record) => {
    const fqdn = `${record.name}.${domain.name}.`;
    const value =
      record.type === "MX"
        ? `${record.priority ?? 10} ${record.value}`
        : record.type === "TXT"
          ? `"${record.value}"`
          : record.value;
    return {
      Action: "UPSERT" as const,
      ResourceRecordSet: {
        Name: fqdn,
        Type: record.type as "CNAME" | "MX" | "TXT",
        TTL: record.ttl === "Auto" ? 300 : Number(record.ttl),
        ResourceRecords: [{ Value: value }],
      },
    };
  });

await route53.send(
  new ChangeResourceRecordSetsCommand({
    HostedZoneId: hostedZoneId,
    ChangeBatch: { Changes: changes },
  }),
);
console.warn(`applied ${changes.length} records for ${domain.name} to zone ${hostedZoneId}`);
