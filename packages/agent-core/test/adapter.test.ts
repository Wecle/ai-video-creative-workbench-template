import { expect, it } from "vitest";
import { EchoAgentAdapter } from "../src";

it("returns a correlated completion event without external calls", async () => {
  const result = await new EchoAgentAdapter().run({
    run: {
      id: "run-1",
      status: "running",
      createdAt: new Date().toISOString(),
    },
    prompt: "hello",
  });
  expect(result.message).toContain("hello");
  expect(result.events[0]).toMatchObject({
    runId: "run-1",
    type: "agent.run.completed",
  });
});
