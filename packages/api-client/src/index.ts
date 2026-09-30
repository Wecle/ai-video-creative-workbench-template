import { canvasDocumentSchema, healthSchema } from "@creative/contracts";

export function createApiClient(
  baseUrl = "/gateway",
  fetcher: typeof fetch = fetch,
) {
  async function get(path: string) {
    const response = await fetcher(baseUrl + path, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok)
      throw new Error("Gateway request failed (" + response.status + ")");
    return response.json();
  }
  return {
    health: async () => healthSchema.parse(await get("/health")),
    demoCanvas: async () =>
      canvasDocumentSchema.parse(await get("/api/v1/canvases/demo/document")),
  };
}
