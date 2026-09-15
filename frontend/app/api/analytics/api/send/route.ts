// SPDX-FileCopyrightText: 2026 Magic Unicorn Unconventional Technology & Stuff Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later

// First-party Umami beacon proxy — POST /api/analytics/api/send
//
// The tracker resolves its collect endpoint as
//   (data-host-url).replace(/\/$/, '') + '/api/send'
// so data-host-url="/api/analytics" lands here. Same-origin, so the POST is
// covered by the app CSP's `connect-src 'self'` — no CSP widening needed.
//
// Mirrors majiks.studio / caseylane.site, with two deliberate additions:
//  1. User-Agent is forwarded. Umami SILENTLY DROPS events that arrive without
//     a real User-Agent: it still answers 200 while recording nothing.
//  2. X-Forwarded-For / X-Real-IP are forwarded. Without them Umami attributes
//     every visitor to this server's IP, collapsing all geo/visitor data.
import { NextRequest, NextResponse } from 'next/server';

const UMAMI_URL = process.env.UMAMI_URL || 'https://analytics.unicorncommander.ai';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const body = await req.text();

    const ua = req.headers.get('user-agent') || '';
    const xff = req.headers.get('x-forwarded-for') || '';
    const realIp = req.headers.get('x-real-ip') || '';
    // Client IP as seen at our edge: first hop of XFF, else X-Real-IP.
    const clientIp = (xff.split(',')[0] || '').trim() || realIp;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': ua,
    };
    if (xff) headers['X-Forwarded-For'] = xff;
    else if (clientIp) headers['X-Forwarded-For'] = clientIp;
    if (clientIp) headers['X-Real-IP'] = clientIp;
    // NOTE (verified 2026-07-29): the hop from here to the Umami origin goes
    // through Cloudflare, which sets cf-connecting-ip to THIS server's IP, and
    // Umami prefers cf-connecting-ip over x-forwarded-for. So the two headers
    // above are currently overridden and every visitor geo-resolves to this
    // host. X-Client-IP is sent as well so the fix is a single env var on the
    // shared Umami container (CLIENT_IP_HEADER=x-client-ip) rather than a code
    // change here; alternatively route to Umami without traversing Cloudflare.
    if (clientIp) headers['X-Client-IP'] = clientIp;

    const res = await fetch(`${UMAMI_URL}/api/send`, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(5000),
      cache: 'no-store',
    });

    const data = await res.text();
    return new NextResponse(data, {
      status: res.status,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch {
    // Never let analytics break the page.
    return NextResponse.json({ ok: true });
  }
}
