import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.string().optional(),
  TEMPORAL_ADDRESS: z.string().min(1).optional(),
  TEMPORAL_NAMESPACE: z.string().min(1).default("default"),
});

export type AgentRunnerConfig = {
  production: boolean;
  temporalAddress: string;
  temporalNamespace: string;
};

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): AgentRunnerConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid agent-runner configuration: ${details}`);
  }
  const values = parsed.data;
  const production = values.NODE_ENV === "production";
  if (production && !values.TEMPORAL_ADDRESS)
    throw new Error(
      "Invalid agent-runner configuration: TEMPORAL_ADDRESS is required in production",
    );
  return {
    production,
    temporalAddress: values.TEMPORAL_ADDRESS ?? "localhost:7233",
    temporalNamespace: values.TEMPORAL_NAMESPACE,
  };
}
