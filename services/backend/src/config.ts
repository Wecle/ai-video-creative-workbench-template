import { z } from "zod";

const secret = z.string().min(32, "must be at least 32 characters");

const schema = z
  .object({
    NODE_ENV: z.string().optional(),
    DATABASE_URL: z.string().min(1),
    WEB_ORIGIN: z.url().default("http://localhost:3000"),
    BETTER_AUTH_SECRET: secret,
    INTERNAL_AUTH_SECRET: secret,
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    TEMPORAL_ADDRESS: z.string().min(1).optional(),
    TEMPORAL_NAMESPACE: z.string().min(1).default("default"),
    ALLOW_MOCK_MODE: z.string().optional(),
    HOST: z.string().default("127.0.0.1"),
    BACKEND_PORT: z.coerce.number().int().min(0).max(65535).default(4001),
  })
  .refine(
    (env) =>
      Boolean(env.GOOGLE_CLIENT_ID) === Boolean(env.GOOGLE_CLIENT_SECRET),
    {
      message: "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together",
      path: ["GOOGLE_CLIENT_ID"],
    },
  );

export type BackendConfig = {
  production: boolean;
  allowMockMode: boolean;
  databaseUrl: string;
  webOrigin: string;
  betterAuthSecret: string;
  internalSecret: string;
  /** Present only when both Google variables are set. */
  google?: { clientId: string; clientSecret: string };
  temporalAddress: string;
  temporalNamespace: string;
  host: string;
  port: number;
};

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): BackendConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid backend configuration: ${details}`);
  }
  const values = parsed.data;
  const production = values.NODE_ENV === "production";
  if (production) {
    const problems = (["BETTER_AUTH_SECRET", "INTERNAL_AUTH_SECRET"] as const)
      .filter((name) => values[name].includes("dev-only"))
      .map((name) => `${name} must not use the dev-only placeholder`);
    if (!values.TEMPORAL_ADDRESS)
      problems.push("TEMPORAL_ADDRESS is required in production");
    if (problems.length > 0)
      throw new Error(`Invalid backend configuration: ${problems.join("; ")}`);
  }
  const allowMockMode = values.ALLOW_MOCK_MODE === "true" || !production;
  return {
    production,
    allowMockMode,
    databaseUrl: values.DATABASE_URL,
    webOrigin: values.WEB_ORIGIN,
    betterAuthSecret: values.BETTER_AUTH_SECRET,
    internalSecret: values.INTERNAL_AUTH_SECRET,
    google: values.GOOGLE_CLIENT_ID
      ? {
          clientId: values.GOOGLE_CLIENT_ID,
          clientSecret: values.GOOGLE_CLIENT_SECRET!,
        }
      : undefined,
    temporalAddress: values.TEMPORAL_ADDRESS ?? "localhost:7233",
    temporalNamespace: values.TEMPORAL_NAMESPACE,
    host: values.HOST,
    port: values.BACKEND_PORT,
  };
}
