import type { NextConfig } from 'next';
import path from 'path';

const nextConfig: NextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  // Pin the file-tracing root to THIS app so Next doesn't infer a parent
  // directory's lockfile as the workspace root (the repo sits under a shared
  // Development/ tree that carries its own package-lock.json).
  outputFileTracingRoot: path.join(__dirname),
};

export default nextConfig;
