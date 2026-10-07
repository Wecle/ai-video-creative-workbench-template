import { describe, expect, it } from "vitest";
import {
  INTERNAL_HEADERS,
  verifyInternalIdentity,
} from "@creative/contracts/internal-auth";
import { INTERNAL_SECRET, startGateway, withUpstream } from "./helpers";

async function boot(options: Partial<Parameters<typeof startGateway>[0]> = {}) {
  const upstream = await withUpstream();
  const gateway = await startGateway({ backendUrl: upstream.url, ...options });
  return { upstream, gateway };
}

describe("gateway webhooks proxy", () => {
  it("proxies /api/webhooks without Bearer token and signs internal identity", async () => {
    const { upstream, gateway } = await boot();
    const payload = JSON.stringify({
      externalId: "mock-12345",
      status: "succeeded",
    });

    const response = await fetch(`${gateway.url}/api/webhooks/providers/mock`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-mock-signature": "sha256=abcdef123456",
        "x-mock-timestamp": "1700000000000",
      },
      body: payload,
    });

    expect(response.status).toBe(200);

    const sent = upstream.last();
    expect(sent.method).toBe("POST");
    expect(sent.url).toBe("/api/webhooks/providers/mock");
    expect(sent.headers["x-mock-signature"]).toBe("sha256=abcdef123456");
    expect(sent.headers["x-mock-timestamp"]).toBe("1700000000000");
    expect(sent.body.toString("utf8")).toBe(payload);

    // Verify upstream received valid internal identity signature from gateway
    const verified = verifyInternalIdentity({
      secret: INTERNAL_SECRET,
      method: "POST",
      pathname: "/api/webhooks/providers/mock",
      headers: sent.headers,
    });
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.identity.authType).toBe("anonymous");
    }
  });

  it("strips client-supplied x-internal headers on /api/webhooks", async () => {
    const { upstream, gateway } = await boot();

    await fetch(`${gateway.url}/api/webhooks/providers/mock`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [INTERNAL_HEADERS.signature]: "forged-signature",
        [INTERNAL_HEADERS.userId]: "attacker-user-id",
      },
      body: JSON.stringify({}),
    });

    const sent = upstream.last();
    expect(sent.headers[INTERNAL_HEADERS.userId]).toBeUndefined();

    // The signature must be gateway's own valid signature for anonymous, not the attacker's
    const verified = verifyInternalIdentity({
      secret: INTERNAL_SECRET,
      method: "POST",
      pathname: "/api/webhooks/providers/mock",
      headers: sent.headers,
    });
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.identity.authType).toBe("anonymous");
    }
  });
});
