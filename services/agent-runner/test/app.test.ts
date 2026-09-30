import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app";

describe("agent runner", () => {
  it("limits execution requests per IP", async () => {
    const app = buildApp({ logger: false });
    try {
      for (let i = 0; i < 30; i++) {
        expect(
          (
            await app.inject({
              method: "POST",
              url: "/runs",
              payload: { prompt: "Hello" },
            })
          ).statusCode,
        ).toBe(200);
      }
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/runs",
            payload: { prompt: "Hello" },
          })
        ).statusCode,
      ).toBe(429);
    } finally {
      await app.close();
    }
  });
  it("validates prompts", async () => {
    const app = buildApp({ logger: false });
    try {
      expect(
        (await app.inject({ method: "POST", url: "/runs", payload: {} }))
          .statusCode,
      ).toBe(400);
      const response = await app.inject({
        method: "POST",
        url: "/runs",
        payload: { prompt: "Hello" },
      });
      expect(response.json()).toMatchObject({
        run: { status: "completed" },
        mode: "echo",
        result: { message: "Template Agent received: Hello" },
      });
    } finally {
      await app.close();
    }
  });
  it("sanitizes adapter errors", async () => {
    const app = buildApp({
      logger: false,
      adapter: {
        run: async () => {
          throw new Error("secret internal details");
        },
      },
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/runs",
        payload: { prompt: "Hello" },
      });
      expect(response.statusCode).toBe(500);
      expect(response.body).not.toContain("secret");
    } finally {
      await app.close();
    }
  });
});
