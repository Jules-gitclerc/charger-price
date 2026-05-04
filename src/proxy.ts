// Next.js 16 Proxy (formerly middleware.ts — renamed per
// node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md).
// File MUST live at src/proxy.ts (sibling of src/app/), function MUST export
// as `proxy`. Default runtime is Node.js; the `runtime` config option is not
// available in Proxy files (it throws if set).
//
// SCOPE (T15.1, W5): basic-auth gate on /internal/* for the M1 demo viewer.
// Not production-grade auth — credentials are static env vars. M2 work will
// replace this with a real auth flow when /internal becomes /admin.
//
// ENV CONTRACT (per docs/03-implementation-plan.md §1 step 11, .env.example):
//   INTERNAL_VIEWER_USER       — basic-auth username
//   INTERNAL_VIEWER_PASSWORD   — basic-auth password
// Both must be set in Vercel project env (Production + Preview) before
// /internal/* is reachable. Local dev: set in .env.local.
//
// FAIL-CLOSED: if either env var is missing (mis-provisioned deployment),
// proxy returns 503. Better than silently allowing access with empty creds.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export const config = {
  matcher: '/internal/:path*',
};

export function proxy(request: NextRequest) {
  const user = process.env.INTERNAL_VIEWER_USER;
  const pass = process.env.INTERNAL_VIEWER_PASSWORD;

  if (!user || !pass) {
    return new NextResponse('Internal viewer not configured', { status: 503 });
  }

  const expected = `Basic ${btoa(`${user}:${pass}`)}`;
  const provided = request.headers.get('authorization');

  if (provided !== expected) {
    return new NextResponse('Unauthorized', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Basic realm="Prix-Bornes Internal"' },
    });
  }

  return NextResponse.next();
}
