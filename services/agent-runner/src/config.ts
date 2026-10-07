import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const KNOWN_MODELS = ["mock"] as const;

const schema = z.object({
  NODE_ENV: z.string().optional(),
  TEMPORAL_ADDRESS: z.string().min(1).optional(),
  TEMPORAL_NAMESPACE: z.string().min(1).default("default"),
  DATABASE_URL: z.string().min(1).optional(),
  REDIS_URL: z.string().min(1).optional(),
  AGENT_MODEL: z.string().min(1).default("mock"),
  AGENT_MOCK_CHUNK_DELAY_MS: z.coerce.number().int().nonnegative().default(0),
  AGENT_REGION: z.string().min(1).default("default"),
  AGENT_SKILLS_DIR: z.string().min(1).optional(),
});

export type AgentRunnerConfig = {
  production: boolean;
  temporalAddress: string;
  temporalNamespace: string;
  databaseUrl: string;
  redisUrl: string;
  agentModel: string;
  agentMockChunkDelayMs: number;
  agentRegion: string;
  agentSkillsDir: string;
};

function defaultSkillsDir(): string {
  const cwdCandidate = resolve(process.cwd(), "capabilities/skills");
  if (existsSync(cwdCandidate)) return cwdCandidate;
  return resolve(
    fileURLToPath(new URL("../../../capabilities/skills", import.meta.url)),
  );
}

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

  if (production && !values.TEMPORAL_ADDRESS) {
    throw new Error(
      "Invalid agent-runner configuration: TEMPORAL_ADDRESS is required in production",
    );
  }
  if (production && !values.DATABASE_URL) {
    throw new Error(
      "Invalid agent-runner configuration: DATABASE_URL is required in production",
    );
  }
  if (production && !values.REDIS_URL) {
    throw new Error(
      "Invalid agent-runner configuration: REDIS_URL is required in production",
    );
  }

  if (
    !KNOWN_MODELS.includes(values.AGENT_MODEL as (typeof KNOWN_MODELS)[number])
  ) {
    throw new Error(
      `Invalid agent-runner configuration: Unknown AGENT_MODEL '${values.AGENT_MODEL}'. Allowed: ${KNOWN_MODELS.join(", ")}`,
    );
  }

  return {
    production,
    temporalAddress: values.TEMPORAL_ADDRESS ?? "localhost:7233",
    temporalNamespace: values.TEMPORAL_NAMESPACE,
    databaseUrl:
      values.DATABASE_URL ??
      "postgresql://template:template@localhost:5432/template",
    redisUrl: values.REDIS_URL ?? "redis://localhost:6379",
    agentModel: values.AGENT_MODEL,
    agentMockChunkDelayMs: values.AGENT_MOCK_CHUNK_DELAY_MS,
    agentRegion: values.AGENT_REGION,
    agentSkillsDir: values.AGENT_SKILLS_DIR ?? defaultSkillsDir(),
  };
}
