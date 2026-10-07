import { z } from "zod";

const secret = z.string().min(32, "must be at least 32 characters");

const schema = z.object({
  NODE_ENV: z.string().optional(),
  BACKEND_URL: z.url().default("http://127.0.0.1:4001"),
  REDIS_URL: z.string().min(1).optional(),
  WEB_ORIGIN: z.url().default("http://localhost:3000"),
  INTERNAL_AUTH_SECRET: secret,
  GATEWAY_TICKET_SECRET: secret,
  GATEWAY_PUBLIC_URL: z.url().default("http://localhost:4000"),
  REALTIME_MAX_CONNECTION_SECONDS: z.coerce.number().int().positive().default(3600),
  TRUST_PROXY: z.string().min(1).optional(),
  HOST: z.string().default("127.0.0.1"),
  GATEWAY_PORT: z.coerce.number().int().min(0).max(65535).default(4000),
});

export type GatewayConfig = {
  production: boolean;
  backendUrl: string;
  redisUrl?: string;
  webOrigin: string;
  internalSecret: string;
  ticketSecret: string;
  gatewayPublicUrl: string;
  realtimeMaxConnectionSeconds: number;
  trustProxy: boolean | string | string[];
  host: string;
  port: number;
};

/** Fastify `trustProxy`: "true"/"false" or a comma-separated list of addresses/CIDRs. */
export function parseTrustProxy(
  value: string | undefined,
): GatewayConfig["trustProxy"] {
  if (value === undefined) return false;
  const trimmed = value.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^\d+$/.test(trimmed))
    throw new Error(
      "TRUST_PROXY hop counts are not supported; use the CIDR of the proxy",
    );
  const list = trimmed
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return list.length === 1 ? list[0]! : list;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): GatewayConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid gateway configuration: ${details}`);
  }
  const values = parsed.data;
  if (values.GATEWAY_TICKET_SECRET === values.INTERNAL_AUTH_SECRET) {
    throw new Error(
      "Invalid gateway configuration: GATEWAY_TICKET_SECRET must be different from INTERNAL_AUTH_SECRET",
    );
  }
  const production = values.NODE_ENV === "production";
  if (production) {
    const problems: string[] = [];
    if (values.INTERNAL_AUTH_SECRET.includes("dev-only"))
      problems.push(
        "INTERNAL_AUTH_SECRET must not use the dev-only placeholder",
      );
    if (values.GATEWAY_TICKET_SECRET.includes("dev-only"))
      problems.push(
        "GATEWAY_TICKET_SECRET must not use the dev-only placeholder",
      );
    if (!values.REDIS_URL) problems.push("REDIS_URL is required");
    if (!values.TRUST_PROXY)
      problems.push(
        "TRUST_PROXY is required (CIDR of the proxy or load balancer in front of the gateway)",
      );
    if (problems.length > 0)
      throw new Error(`Invalid gateway configuration: ${problems.join("; ")}`);
  }
  return {
    production,
    backendUrl: values.BACKEND_URL,
    redisUrl: values.REDIS_URL,
    webOrigin: values.WEB_ORIGIN,
    internalSecret: values.INTERNAL_AUTH_SECRET,
    ticketSecret: values.GATEWAY_TICKET_SECRET,
    gatewayPublicUrl: values.GATEWAY_PUBLIC_URL,
    realtimeMaxConnectionSeconds: values.REALTIME_MAX_CONNECTION_SECONDS,
    trustProxy: parseTrustProxy(values.TRUST_PROXY),
    host: values.HOST,
    port: values.GATEWAY_PORT,
  };
}
