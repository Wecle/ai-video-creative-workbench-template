import { describe, expect, it, vi } from "vitest";
import { createAccessTokenProvider } from "./access-token";

const b64 = (value: object) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
/** Unsigned JWT-shaped string; only `exp` matters to the cache. */
const tokenExpiring = (expSeconds: number, tag = "t") =>
  `${b64({ alg: "EdDSA" })}.${b64({ exp: expSeconds, tag })}.sig`;

describe("access token provider", () => {
  it("serves the cached token while it is valid", async () => {
    let now = 1_000_000;
    const fetchToken = vi
      .fn<() => Promise<string>>()
      .mockResolvedValue(tokenExpiring(now / 1000 + 600));
    const provider = createAccessTokenProvider(fetchToken, () => now);
    const first = await provider.get();
    now += 60_000;
    expect(await provider.get()).toBe(first);
    expect(fetchToken).toHaveBeenCalledTimes(1);
  });

  it("refreshes when fewer than 60 seconds remain", async () => {
    let now = 1_000_000;
    const fetchToken = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce(tokenExpiring(now / 1000 + 600, "old"))
      .mockResolvedValueOnce(tokenExpiring(now / 1000 + 1200, "new"));
    const provider = createAccessTokenProvider(fetchToken, () => now);
    const old = await provider.get();
    now += 539_000; // 61 s left: still cached
    expect(await provider.get()).toBe(old);
    now += 2_000; // 59 s left: refresh
    expect(await provider.get()).not.toBe(old);
    expect(fetchToken).toHaveBeenCalledTimes(2);
  });

  it("shares one request between concurrent callers", async () => {
    const now = 1_000_000;
    let resolve!: (token: string) => void;
    const fetchToken = vi.fn<() => Promise<string>>(
      () => new Promise<string>((r) => (resolve = r)),
    );
    const provider = createAccessTokenProvider(fetchToken, () => now);
    const calls = [
      provider.get(),
      provider.get(),
      provider.get({ force: true }),
    ];
    resolve(tokenExpiring(now / 1000 + 600));
    const tokens = await Promise.all(calls);
    expect(new Set(tokens).size).toBe(1);
    expect(fetchToken).toHaveBeenCalledTimes(1);
  });

  it("force bypasses a valid cache", async () => {
    const now = 1_000_000;
    const fetchToken = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce(tokenExpiring(now / 1000 + 600, "a"))
      .mockResolvedValueOnce(tokenExpiring(now / 1000 + 600, "b"));
    const provider = createAccessTokenProvider(fetchToken, () => now);
    const a = await provider.get();
    expect(await provider.get({ force: true })).not.toBe(a);
  });

  it("does not cache failures", async () => {
    const now = 1_000_000;
    const fetchToken = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("no session"))
      .mockResolvedValueOnce(tokenExpiring(now / 1000 + 600));
    const provider = createAccessTokenProvider(fetchToken, () => now);
    await expect(provider.get()).rejects.toThrow("no session");
    await expect(provider.get()).resolves.toBeTypeOf("string");
    expect(fetchToken).toHaveBeenCalledTimes(2);
  });

  it("forgets the token on clear, including a request still in flight", async () => {
    const now = 1_000_000;
    let resolveOld!: (token: string) => void;
    const fetchToken = vi
      .fn<() => Promise<string>>()
      .mockImplementationOnce(() => new Promise((r) => (resolveOld = r)))
      .mockResolvedValueOnce(tokenExpiring(now / 1000 + 600, "new-user"));
    const provider = createAccessTokenProvider(fetchToken, () => now);
    const pending = provider.get();
    provider.clear(); // e.g. sign-out while the old user's request is running
    resolveOld(tokenExpiring(now / 1000 + 600, "old-user"));
    await pending;
    // The stale result must not be served to whoever signs in next.
    const next = await provider.get();
    expect(Buffer.from(next.split(".")[1]!, "base64url").toString()).toContain(
      "new-user",
    );
    expect(fetchToken).toHaveBeenCalledTimes(2);
  });

  it("treats a token without a readable exp as already expired", async () => {
    const fetchToken = vi
      .fn<() => Promise<string>>()
      .mockResolvedValue("opaque");
    const provider = createAccessTokenProvider(fetchToken, () => 1_000_000);
    await provider.get();
    await provider.get();
    expect(fetchToken).toHaveBeenCalledTimes(2);
  });
});
