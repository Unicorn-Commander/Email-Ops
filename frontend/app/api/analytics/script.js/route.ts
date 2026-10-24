// SPDX-FileCopyrightText: 2026 Magic Unicorn Unconventional Technology & Stuff Inc.
// SPDX-License-Identifier: Apache-2.0

// First-party Umami tracker proxy — GET /api/analytics/script.js
//
// The landing page loads the tracker from THIS origin, so it is covered by the
// app CSP's `script-src 'self'` and needs no CSP widening (the cockpit CSP
// guards a surface that renders untrusted email HTML — do not loosen it).
// Serving same-origin also survives ad-blockers that filter the analytics host.
//
// Mirrors the production pattern used by majiks.studio and caseylane.site.
// Divergence: UMAMI_URL defaults to the PUBLIC Umami origin because this app
// runs on a different host than the Umami container and has no route to the
// internal `unicorn-umami` service name (verified: does not resolve here).
import { NextResponse } from 'next/server';

const UMAMI_URL = process.env.UMAMI_URL || 'https://analytics.unicorncommander.ai';

// Always fetch at request time; never bake a build-time failure into the image.
export const dynamic = 'force-dynamic';

// A failed fetch must NOT be cacheable. Cloudflare caches this path by its .js
// extension and will honour a multi-hour TTL on whatever it sees — an earlier
// 404 here got pinned at the edge for 4h and silently killed analytics while
// the origin was already healthy. no-store keeps a blip from becoming an outage.
function failure() {
  return new NextResponse('', {
    status: 502,
    headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
  });
}

export async function GET() {
  try {
    const res = await fetch(`${UMAMI_URL}/script.js`, {
      signal: AbortSignal.timeout(5000),
      cache: 'no-store',
    });
    if (!res.ok) return failure();

    const script = await res.text();

    return new NextResponse(script, {
      headers: {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
      },
    });
  } catch {
    return failure();
  }
}
