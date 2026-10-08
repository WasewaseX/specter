import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // The bare relay protocol requires exact paths with trailing slashes
  // (/bare/v1/…) — never let Next normalize them away with 308 redirects.
  skipTrailingSlashRedirect: true,
  async headers() {
    return [
      {
        // Allow the Ultraviolet service worker (served from /uv/sw.js) to
        // register with the narrower /service/ scope it needs to intercept
        // proxied browsing traffic.
        source: "/uv/sw.js",
        headers: [
          { key: "Service-Worker-Allowed", value: "/service/" },
          { key: "Cache-Control", value: "no-store" },
        ],
      },
    ];
  },
  async rewrites() {
    return [
      // Ultraviolet bare relay (mini service on :3030).
      // Proxied server-side by Next so everything stays on the public origin.
      {
        source: "/bare/:path*",
        destination: "http://127.0.0.1:3030/bare/:path*",
      },
    ];
  },
};

export default nextConfig;
