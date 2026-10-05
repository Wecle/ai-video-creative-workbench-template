import { authClient } from "./auth-client";

/** Thrown when there is no signed-in session to exchange for an access token. */
export class AuthRequiredError extends Error {
  constructor() {
    super("Not signed in");
    this.name = "AuthRequiredError";
  }
}

const REFRESH_MARGIN_MS = 60_000;

/** `exp` of a JWT in milliseconds. Decoded only, not verified: the gateway verifies. */
function expiresAtOf(token: string) {
  try {
    const payload = token.split(".")[1] ?? "";
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    const { exp } = JSON.parse(json) as { exp?: unknown };
    return typeof exp === "number" ? exp * 1000 : 0;
  } catch {
    return 0;
  }
}

/**
 * Keeps the access token in memory only (never localStorage/sessionStorage),
 * refreshes it a minute before it expires, and shares one in-flight request
 * between concurrent callers.
 */
export function createAccessTokenProvider(
  fetchToken: () => Promise<string>,
  now: () => number = Date.now,
) {
  let cached: { token: string; expiresAt: number } | undefined;
  let inflight: Promise<string> | undefined;
  // A request started before clear() belongs to the previous user: never cache it.
  let generation = 0;

  function get({ force = false }: { force?: boolean } = {}) {
    if (!force && cached && cached.expiresAt - now() > REFRESH_MARGIN_MS)
      return Promise.resolve(cached.token);
    if (inflight) return inflight;
    const started = generation;
    const request = fetchToken()
      .then((token) => {
        if (started === generation)
          cached = { token, expiresAt: expiresAtOf(token) };
        return token;
      })
      .finally(() => {
        if (inflight === request) inflight = undefined;
      });
    inflight = request;
    return request;
  }

  function clear() {
    generation++;
    cached = undefined;
    inflight = undefined;
  }

  return { get, clear };
}

async function fetchTokenFromSession() {
  const { data, error } = await authClient.$fetch<{ token: string }>("/token", {
    method: "GET",
  });
  if (error || !data?.token) {
    // 401: no valid session. Anything else (5xx, network) is a plain failure.
    if (error?.status === 401 || (!error && !data?.token))
      throw new AuthRequiredError();
    throw new Error(`Token request failed (${error?.status ?? "network"})`);
  }
  return data.token;
}

const provider = createAccessTokenProvider(fetchTokenFromSession);

export const getAccessToken = provider.get;
export const clearAccessToken = provider.clear;
