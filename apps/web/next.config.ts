import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: [
    "@creative/contracts",
    "@creative/ui",
    "@creative/api-client",
  ],
  async rewrites() {
    const gateway = process.env.GATEWAY_URL ?? "http://127.0.0.1:4000";
    return [
      { source: "/gateway/:path*", destination: gateway + "/:path*" },
      // Same-origin auth routes: the session cookie is set on the web origin.
      { source: "/api/auth/:path*", destination: gateway + "/api/auth/:path*" },
    ];
  },
};
export default nextConfig;
