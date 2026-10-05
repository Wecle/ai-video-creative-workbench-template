import {
  canvasDocumentSchema,
  healthSchema,
  meResponseSchema,
} from "@creative/contracts";

export type ApiClientOptions = {
  /**
   * Returns a valid access token. `force` asks for a fresh one (used after a 401).
   * Without it, business requests are sent without credentials.
   */
  getToken?: (options?: { force?: boolean }) => Promise<string>;
  /** Called when the user is no longer authenticated (second 401, or no session). */
  onUnauthorized?: () => void;
};

export class ApiError extends Error {
  constructor(readonly status: number) {
    super("Gateway request failed (" + status + ")");
    this.name = "ApiError";
  }
}

export function createApiClient(
  baseUrl = "/gateway",
  fetcher: typeof fetch = fetch,
  { getToken, onUnauthorized }: ApiClientOptions = {},
) {
  function send(path: string, token?: string) {
    return fetcher(baseUrl + path, {
      signal: AbortSignal.timeout(5000),
      ...(token ? { headers: { authorization: "Bearer " + token } } : {}),
    });
  }
  async function unauthorized(): Promise<never> {
    onUnauthorized?.();
    throw new ApiError(401);
  }
  async function get(path: string, { auth }: { auth: boolean }) {
    let response: Response;
    if (auth && getToken) {
      let token: string;
      try {
        token = await getToken();
      } catch {
        return unauthorized();
      }
      response = await send(path, token);
      if (response.status === 401) {
        // The token may have been revoked or expired early: refresh once and retry.
        try {
          token = await getToken({ force: true });
        } catch {
          return unauthorized();
        }
        response = await send(path, token);
        if (response.status === 401) return unauthorized();
      }
    } else {
      response = await send(path);
    }
    if (!response.ok) throw new ApiError(response.status);
    return response.json();
  }
  return {
    health: async () =>
      healthSchema.parse(await get("/health", { auth: false })),
    me: async () =>
      meResponseSchema.parse(await get("/api/v1/me", { auth: true })),
    demoCanvas: async () =>
      canvasDocumentSchema.parse(
        await get("/api/v1/canvases/demo/document", { auth: true }),
      ),
  };
}
