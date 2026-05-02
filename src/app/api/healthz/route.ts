// Liveness probe for the read tier.
// Acceptance criterion (T01, docs/03-implementation-plan.md §3):
// GET /api/healthz returns 200 {ok: true} on a Vercel preview URL.
// Intentionally does NOT touch Supabase — this endpoint must succeed even when
// the database is unavailable, so we can distinguish "Vercel is up" from
// "the data path is broken." A separate /api/healthz/deep endpoint (M1.5+)
// will probe Supabase + freshness.

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  return Response.json({
    ok: true,
    service: 'prix-bornes',
    repo: 'Jules-gitclerc/charger-price',
    docs: 'https://github.com/Jules-gitclerc/charger-price/tree/main/docs',
  });
}
