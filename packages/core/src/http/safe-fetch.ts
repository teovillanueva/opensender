import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Anti-SSRF fetch (SPEC §16) for every user-supplied outbound URL
 * (path-attachment downloads now, webhook dispatch at M4): resolve DNS and
 * reject private/link-local/loopback targets, http(s) only, capped redirects
 * re-validating every hop, short timeout, response size cap. DNS is
 * re-resolved per request; the resolved address is what gets validated
 * (rebinding mitigation).
 */

export class SafeFetchError extends Error {}

const MAX_REDIRECTS = 3;

function isPrivateIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  const [a, b, c] = octets as [number, number, number, number];
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 192 && b === 0 && c === 2) || // TEST-NET-1
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // TEST-NET-3
    a >= 224
  );
}

function isPrivateIpv6(address: string): boolean {
  const lower = address.toLowerCase();
  return (
    lower === "::1" ||
    lower === "::" ||
    lower.startsWith("fe80") ||
    lower.startsWith("fc") ||
    lower.startsWith("fd") ||
    lower.startsWith("::ffff:") // v4-mapped — validated again as v4 below
  );
}

async function assertPublicHost(hostname: string): Promise<void> {
  const literal = isIP(hostname);
  const addresses =
    literal !== 0
      ? [{ address: hostname, family: literal }]
      : await lookup(hostname, { all: true });
  if (addresses.length === 0) throw new SafeFetchError(`cannot resolve ${hostname}`);
  for (const { address, family } of addresses) {
    const mapped = address.toLowerCase().startsWith("::ffff:") ? address.slice(7) : address;
    const effectiveFamily = mapped === address ? family : 4;
    const blocked = effectiveFamily === 4 ? isPrivateIpv4(mapped) : isPrivateIpv6(mapped);
    if (blocked) {
      throw new SafeFetchError(`address ${address} for ${hostname} is not publicly routable`);
    }
  }
}

export interface SafeFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export async function safeFetch(
  url: string,
  {
    timeoutMs = 15_000,
    maxBytes = 25 * 1024 * 1024,
    method = "GET",
    headers,
    body: requestBody,
  }: SafeFetchOptions = {},
): Promise<{ body: Uint8Array; contentType?: string; status?: number }> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let parsed: URL;
    try {
      parsed = new URL(current);
    } catch {
      throw new SafeFetchError(`invalid URL: ${current}`);
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new SafeFetchError(`unsupported protocol ${parsed.protocol}`);
    }
    await assertPublicHost(parsed.hostname);

    const response = await fetch(current, {
      method,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      ...(headers === undefined ? {} : { headers }),
      ...(requestBody === undefined ? {} : { body: requestBody }),
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new SafeFetchError("redirect without location");
      current = new URL(location, current).toString();
      continue;
    }
    if (!response.ok) {
      throw new SafeFetchError(`fetch failed with status ${response.status}`);
    }
    const status = response.status;

    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > maxBytes) throw new SafeFetchError("response exceeds size cap");

    const reader = response.body?.getReader();
    if (!reader) return { body: new Uint8Array(0) };
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new SafeFetchError("response exceeds size cap");
      }
      chunks.push(value);
    }
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const contentType = response.headers.get("content-type") ?? undefined;
    return { body, status, ...(contentType === undefined ? {} : { contentType }) };
  }
  throw new SafeFetchError("too many redirects");
}
