import type { NextConfig } from 'next';
import path from 'path';

// Security headers for the webmail chrome — the highest-XSS surface in the
// product (it renders untrusted HTML email, inside a sandboxed srcdoc iframe).
// The CSP is deliberately Next-compatible: 'unsafe-inline'/'unsafe-eval' are
// required for Next hydration + styled-jsx, and frame-src allows the reader's
// sandboxed srcdoc iframe. It still blocks external script origins, plugin
// content, and framing of the app itself. connect-src stays same-origin (+https
// for SSO redirects). Tighten to nonces in a later hardening pass.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https:",
  "frame-src 'self' data: blob:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self' https:",
  "object-src 'none'",
].join('; ');

const SECURITY_HEADERS = [
  { key: 'Content-Security-Policy', value: CSP },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()' },
];

const nextConfig: NextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  // Don't advertise the framework/version.
  poweredByHeader: false,
  async headers() {
    return [{ source: '/:path*', headers: SECURITY_HEADERS }];
  },
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
