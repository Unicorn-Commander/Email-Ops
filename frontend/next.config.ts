import type { NextConfig } from 'next';
import path from 'path';

const nextConfig: NextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  // Pin the file-tracing root to THIS app so Next doesn't infer a parent
  // directory's lockfile as the workspace root (the repo sits under a shared
  // Development/ tree that carries its own package-lock.json).
  outputFileTracingRoot: path.join(__dirname),
  // Local-dev: proxy the API to the backend so the browser calls a same-origin
  // /api/v1/* (no CORS) and Next forwards it server-side. In prod the app is
  // served same-origin (or NEXT_PUBLIC_API_URL is set), so this is dev-only.
  async rewrites() {
    const backend = process.env.BACKEND_ORIGIN || 'http://localhost:3231';
    return [{ source: '/api/v1/:path*', destination: `${backend}/api/v1/:path*` }];
  },
};

export default nextConfig;
