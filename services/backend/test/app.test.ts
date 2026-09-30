import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";

describe("backend", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => app.close());
  it("reports health", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ok", service: "backend" });
  });
  it("serves only the demo document", async () => {
    expect(
      (await app.inject("/api/v1/canvases/demo/document")).json().canvasId,
    ).toBe("demo");
    expect(
      (await app.inject("/api/v1/canvases/missing/document")).statusCode,
    ).toBe(404);
  });
  it("publishes OpenAPI", async () => {
    expect((await app.inject("/docs/json")).json().openapi).toMatch(/^3/);
    expect((await app.inject("/docs/json")).json().paths).toHaveProperty(
      "/api/v1/canvases/{canvasId}/document",
    );
  });
  it("adds security headers", async () => {
    expect(
      (await app.inject("/health")).headers["x-content-type-options"],
    ).toBe("nosniff");
  });
});
