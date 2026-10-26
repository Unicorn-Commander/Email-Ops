'use client';

import { useEffect, useState } from 'react';
import { API_BASE } from '@/lib/api';
import { mcpUrlFromApiBase } from '@/lib/mcpPublicUrl';

/**
 * MCP URL for this page. Absolute `NEXT_PUBLIC_API_URL` is ready on the first
 * render. The same-origin default waits until the browser origin is known so
 * a copy button never offers a host-less path.
 */
export function useMcpUrl(): { url: string; ready: boolean } {
  const configured = /^https?:\/\//i.test(API_BASE.trim());
  const [url, setUrl] = useState(() => mcpUrlFromApiBase(API_BASE));
  const [ready, setReady] = useState(configured);

  useEffect(() => {
    setUrl(mcpUrlFromApiBase(API_BASE, window.location.origin));
    setReady(true);
  }, []);

  return { url, ready };
}
