import {
  createProjectResponseSchema,
  getCanvasResponseSchema,
  getCanvasRunResponseSchema,
  healthSchema,
  meResponseSchema,
  projectListResponseSchema,
  saveCanvasResponseSchema,
  startCanvasRunResponseSchema,
  type CreateProjectRequest,
  type SaveCanvasRequest,
  type StartCanvasRunRequest,
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
  /** `body` is the parsed JSON error response, when there was one (e.g. 409's `currentVersion`). */
  constructor(
    readonly status: number,
    readonly body?: unknown,
  ) {
    super("Gateway request failed (" + status + ")");
    this.name = "ApiError";
  }
}

type RequestOptions = {
  auth: boolean;
  body?: unknown;
  timeoutMs?: number;
};

export function createApiClient(
  baseUrl = "/gateway",
  fetcher: typeof fetch = fetch,
  { getToken, onUnauthorized }: ApiClientOptions = {},
) {
  function send(
    method: string,
    path: string,
    { body, timeoutMs = 5000 }: RequestOptions,
    token?: string,
  ) {
    const headers: Record<string, string> = {};
    if (token) headers.authorization = "Bearer " + token;
    if (body !== undefined) headers["content-type"] = "application/json";
    return fetcher(baseUrl + path, {
      method,
      signal: AbortSignal.timeout(timeoutMs),
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }
  async function unauthorized(): Promise<never> {
    onUnauthorized?.();
    throw new ApiError(401);
  }
  async function request(
    method: string,
    path: string,
    options: RequestOptions,
  ) {
    let response: Response;
    if (options.auth && getToken) {
      let token: string;
      try {
        token = await getToken();
      } catch {
        return unauthorized();
      }
      response = await send(method, path, options, token);
      if (response.status === 401) {
        // The token may have been revoked or expired early: refresh once and retry.
        try {
          token = await getToken({ force: true });
        } catch {
          return unauthorized();
        }
        response = await send(method, path, options, token);
        if (response.status === 401) return unauthorized();
      }
    } else {
      response = await send(method, path, options);
    }
    if (!response.ok) {
      const body = await response.json().catch(() => undefined);
      throw new ApiError(response.status, body);
    }
    return response.json();
  }
  const get = (path: string, options: { auth: boolean }) =>
    request("GET", path, options);
  const canvasPath = (projectId: string, canvasId: string) =>
    `/api/v1/projects/${encodeURIComponent(projectId)}/canvases/${encodeURIComponent(canvasId)}`;
  return {
    health: async () =>
      healthSchema.parse(await get("/health", { auth: false })),
    me: async () =>
      meResponseSchema.parse(await get("/api/v1/me", { auth: true })),
    listProjects: async () =>
      projectListResponseSchema.parse(
        await get("/api/v1/projects", { auth: true }),
      ),
    createProject: async (input: CreateProjectRequest) =>
      createProjectResponseSchema.parse(
        await request("POST", "/api/v1/projects", { auth: true, body: input }),
      ),
    getCanvas: async (projectId: string, canvasId: string) =>
      getCanvasResponseSchema.parse(
        await get(canvasPath(projectId, canvasId), { auth: true }),
      ),
    /** Throws `ApiError` with status 409 (and `body.currentVersion`) when `baseVersion` is stale. */
    saveCanvas: async (
      projectId: string,
      canvasId: string,
      input: SaveCanvasRequest,
    ) =>
      saveCanvasResponseSchema.parse(
        await request("PUT", canvasPath(projectId, canvasId) + "/state", {
          auth: true,
          body: input,
          timeoutMs: 20000,
        }),
      ),
    startCanvasRun: async (
      projectId: string,
      canvasId: string,
      input?: StartCanvasRunRequest,
    ) =>
      startCanvasRunResponseSchema.parse(
        await request("POST", canvasPath(projectId, canvasId) + "/runs", {
          auth: true,
          body: input ?? {},
        }),
      ),
    getCanvasRun: async (projectId: string, canvasId: string, runId: string) =>
      getCanvasRunResponseSchema.parse(
        await get(
          canvasPath(projectId, canvasId) +
            "/runs/" +
            encodeURIComponent(runId),
          { auth: true },
        ),
      ),
  };
}
