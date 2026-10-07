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
    REDIS_URL: z.string().min(1).optional(),
    S3_ENDPOINT: z
      .string()
      .optional()
      .transform((v) => (v && v.trim() !== "" ? v.trim() : undefined)),
    S3_PUBLIC_ENDPOINT: z
      .string()
      .optional()
      .transform((v) => (v && v.trim() !== "" ? v.trim() : undefined)),
    S3_ACCESS_KEY: z
      .string()
      .optional()
      .transform((v) => (v && v.trim() !== "" ? v.trim() : undefined)),
    S3_SECRET_KEY: z
      .string()
      .optional()
      .transform((v) => (v && v.trim() !== "" ? v.trim() : undefined)),
    S3_BUCKET: z
      .string()
      .optional()
      .transform((v) => (v && v.trim() !== "" ? v.trim() : undefined)),
    S3_CONFIGURE_CORS: z
      .string()
      .optional()
      .transform((v) => v === "true"),
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

export type S3Config = {
  endpoint: string;
  publicEndpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  configureCors: boolean;
};

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
  redisUrl?: string;
  s3?: S3Config;
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
    if (!values.REDIS_URL) problems.push("REDIS_URL is required in production");
    if (
      !values.S3_ENDPOINT ||
      !values.S3_ACCESS_KEY ||
      !values.S3_SECRET_KEY ||
      !values.S3_BUCKET
    ) {
      problems.push("S3_* configuration is required in production");
    }
    if (problems.length > 0)
      throw new Error(`Invalid backend configuration: ${problems.join("; ")}`);
  }
  const allowMockMode = values.ALLOW_MOCK_MODE === "true" || !production;
  const s3 =
    values.S3_ENDPOINT &&
    values.S3_ACCESS_KEY &&
    values.S3_SECRET_KEY &&
    values.S3_BUCKET
      ? {
          endpoint: values.S3_ENDPOINT,
          publicEndpoint: values.S3_PUBLIC_ENDPOINT,
          accessKeyId: values.S3_ACCESS_KEY,
          secretAccessKey: values.S3_SECRET_KEY,
          bucket: values.S3_BUCKET,
          configureCors: values.S3_CONFIGURE_CORS ?? false,
        }
      : undefined;

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
    redisUrl: values.REDIS_URL,
    s3,
    host: values.HOST,
    port: values.BACKEND_PORT,
  };
}
