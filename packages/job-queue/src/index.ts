import { Queue } from "bullmq";

export function createJobQueue(name: string, redisUrl: string) {
  const url = new URL(redisUrl);
  if (!["redis:", "rediss:"].includes(url.protocol))
    throw new Error("Expected a Redis URL");
  return new Queue(name, {
    connection: {
      host: url.hostname,
      port: Number(url.port || 6379),
      db: Number(url.pathname.slice(1) || 0),
      username: url.username ? decodeURIComponent(url.username) : undefined,
      password: url.password ? decodeURIComponent(url.password) : undefined,
      tls: url.protocol === "rediss:" ? {} : undefined,
      maxRetriesPerRequest: 1,
    },
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 1000 },
      removeOnComplete: 100,
      removeOnFail: 1000,
    },
  });
}
