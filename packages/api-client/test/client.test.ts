import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "../src";

const me = {
  user: { id: "u1", name: "A", email: "a@example.test", image: null },
  workspaces: [
    { id: "w1", name: "A's workspace", slug: "ws-u1", role: "owner" },
  ],
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
const authorizationOf = (call: Parameters<typeof fetch>) =>
  new Headers(call[1]?.headers).get("authorization");

describe("API client", () => {
  it("validates health responses", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ status: "ok", service: "gateway" })),
      );
    expect(
      await createApiClient("http://example.test", fetcher).health(),
    ).toEqual({ status: "ok", service: "gateway" });
    expect(fetcher.mock.calls[0]?.[0]).toBe("http://example.test/health");
  });
  it("surfaces non-success responses", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 503 }));
    await expect(createApiClient("", fetcher).health()).rejects.toThrow("503");
  });
  it("rejects incompatible responses", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ status: "fake" })));
    await expect(createApiClient("", fetcher).health()).rejects.toThrow();
  });

  describe("authentication", () => {
    it("sends the Bearer token on business requests but not on health()", async () => {
      const getToken = vi.fn().mockResolvedValue("tok-1");
      const fetcher = vi
        .fn<typeof fetch>()
        .mockImplementation(async (input) =>
          String(input).endsWith("/health")
            ? json({ status: "ok", service: "gateway" })
            : json(me),
        );
      const api = createApiClient("/gateway", fetcher, { getToken });
      await api.health();
      expect(authorizationOf(fetcher.mock.calls[0]!)).toBeNull();
      expect(getToken).not.toHaveBeenCalled();
      expect(await api.me()).toEqual(me);
      expect(fetcher.mock.calls[1]![0]).toBe("/gateway/api/v1/me");
      expect(authorizationOf(fetcher.mock.calls[1]!)).toBe("Bearer tok-1");
    });

    it("validates the /me response", async () => {
      const api = createApiClient(
        "",
        vi.fn<typeof fetch>().mockResolvedValue(json({ user: {} })),
        {
          getToken: async () => "t",
        },
      );
      await expect(api.me()).rejects.toThrow();
    });

    it("refreshes the token and retries once after a 401", async () => {
      const getToken = vi
        .fn<(o?: { force?: boolean }) => Promise<string>>()
        .mockResolvedValueOnce("stale")
        .mockResolvedValueOnce("fresh");
      const onUnauthorized = vi.fn();
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(null, { status: 401 }))
        .mockResolvedValueOnce(json(me));
      const api = createApiClient("", fetcher, { getToken, onUnauthorized });
      expect(await api.me()).toEqual(me);
      expect(getToken.mock.calls).toEqual([[], [{ force: true }]]);
      expect(authorizationOf(fetcher.mock.calls[0]!)).toBe("Bearer stale");
      expect(authorizationOf(fetcher.mock.calls[1]!)).toBe("Bearer fresh");
      expect(onUnauthorized).not.toHaveBeenCalled();
    });

    it("calls onUnauthorized when the retry is also a 401", async () => {
      const onUnauthorized = vi.fn();
      const fetcher = vi
        .fn<typeof fetch>()
        .mockImplementation(async () => new Response(null, { status: 401 }));
      const api = createApiClient("", fetcher, {
        getToken: async () => "t",
        onUnauthorized,
      });
      await expect(api.me()).rejects.toMatchObject({ status: 401 });
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(onUnauthorized).toHaveBeenCalledTimes(1);
    });

    it("calls onUnauthorized when no token can be obtained", async () => {
      const onUnauthorized = vi.fn();
      const fetcher = vi.fn<typeof fetch>();
      const api = createApiClient("", fetcher, {
        getToken: async () => {
          throw new Error("no session");
        },
        onUnauthorized,
      });
      await expect(api.me()).rejects.toMatchObject({ status: 401 });
      expect(fetcher).not.toHaveBeenCalled();
      expect(onUnauthorized).toHaveBeenCalledTimes(1);
    });

    it("does not retry other failures", async () => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status: 503 }));
      const api = createApiClient("", fetcher, { getToken: async () => "t" });
      await expect(api.me()).rejects.toMatchObject({ status: 503 });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
  });
});
