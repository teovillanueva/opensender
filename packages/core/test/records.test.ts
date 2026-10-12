import { describe, expect, it } from "vitest";
import { buildDomainRecords, domainStatus } from "../src/domains/records.js";

describe("domain records builder (fixture-31 shapes)", () => {
  const records = buildDomainRecords({
    region: "us-east-1",
    dkimTokens: ["t1", "t2", "t3"],
    signingHostedZone: "dkim.amazonses.com",
    dkimStatus: "SUCCESS",
    mailFromStatus: "PENDING",
  });

  it("builds 3 DKIM CNAMEs from the signing hosted zone, never hardcoded", () => {
    const dkim = records.filter((record) => record.record === "DKIM");
    expect(dkim).toHaveLength(3);
    expect(dkim[0]).toEqual({
      record: "DKIM",
      name: "t1._domainkey",
      type: "CNAME",
      ttl: "Auto",
      status: "verified",
      value: "t1.dkim.amazonses.com",
    });
  });

  it("tags the MAIL FROM MX as record SPF with a separate numeric priority", () => {
    const mx = records.find((record) => record.type === "MX");
    expect(mx).toEqual({
      record: "SPF",
      name: "send",
      type: "MX",
      ttl: "60",
      status: "pending",
      value: "feedback-smtp.us-east-1.amazonses.com",
      priority: 10,
    });
  });

  it("includes the SPF TXT and the never-verified DMARC suggestion", () => {
    expect(records.find((r) => r.type === "TXT" && r.record === "SPF")).toMatchObject({
      name: "send",
      ttl: "60",
      value: "v=spf1 include:amazonses.com ~all",
    });
    expect(records.find((r) => r.record === "DMARC")).toMatchObject({
      name: "_dmarc",
      status: "not_started",
    });
  });
});

describe("inbound MX record", () => {
  it("uses the amazonAWS inbound host and the DNS-observed status", () => {
    const records = buildDomainRecords({
      region: "us-east-1",
      dkimTokens: ["t1"],
      signingHostedZone: "dkim.amazonses.com",
      dkimStatus: "SUCCESS",
      mailFromStatus: "SUCCESS",
      inboundEnabled: true,
      inboundMxStatus: "SUCCESS",
    });
    const inboundMx = records.find((record) => record.record === "MX");
    expect(inboundMx).toEqual({
      record: "MX",
      name: "",
      type: "MX",
      ttl: "Auto",
      status: "verified",
      value: "inbound-smtp.us-east-1.amazonaws.com",
      priority: 10,
    });
  });

  it("is binary — pending when never observed, never mail-from derived", () => {
    const records = buildDomainRecords({
      region: "us-east-1",
      dkimTokens: ["t1"],
      signingHostedZone: "dkim.amazonses.com",
      dkimStatus: "SUCCESS",
      mailFromStatus: "FAILED",
      inboundEnabled: true,
    });
    expect(records.find((record) => record.record === "MX")?.status).toBe("pending");
  });

  it("omits the inbound MX when inbound is disabled", () => {
    const records = buildDomainRecords({
      region: "us-east-1",
      dkimTokens: ["t1"],
      signingHostedZone: "dkim.amazonses.com",
      dkimStatus: "SUCCESS",
      mailFromStatus: "SUCCESS",
    });
    expect(records.some((record) => record.record === "MX")).toBe(false);
  });
});

describe("domain status derivation", () => {
  it("is verified only when DKIM and MAIL FROM both succeed", () => {
    expect(domainStatus("SUCCESS", "SUCCESS")).toBe("verified");
    expect(domainStatus("SUCCESS", "PENDING")).toBe("pending");
    expect(domainStatus("FAILED", "SUCCESS")).toBe("failed");
    expect(domainStatus("TEMPORARY_FAILURE", "PENDING")).toBe("temporary_failure");
    expect(domainStatus("NOT_STARTED", "NOT_STARTED")).toBe("not_started");
  });
});
