#!/usr/bin/env python3
"""BAN reverse-geocode runner (T07).

Two modes:

* ``--validate-fixture-only`` — offline. Reads
  ``tools/geocode/test/fixture-4rows.csv``, runs the response parser,
  per-row decision logic, and the score / TTL helpers; prints an
  aligned per-row decision log; exits non-zero on a logic regression.
  NO network. NO DB.

* full run (default) — operates against live Supabase. Ensures the
  ``ban_reverse_geocode`` source row exists, opens a
  ``live.ingestion_runs`` row, pulls work-set rows from
  ``live.stations`` (those with NULL ``consolidated_code_postal``
  AND no existing cache hit at their lon/lat), processes them in
  chunks of ``REVERSE_BATCH_MAX_ROWS`` (1,000) — each chunk a single
  atomic transaction containing INSERT-ON-CONFLICT into
  ``live.geocode_cache`` plus an UPDATE-FROM into ``live.stations``
  guarded by ``confidence_score >= 0.5``. Disk-audit gate every 5
  chunks against ``DISK_GATE_THRESHOLD_BYTES``. Closes the run row
  to a terminal status via ``live.close_ingestion_run`` (E15
  forward-practice).

  Disk-discipline contract: the runner fails loud with state
  preserved when the disk gate trips. Hard rule #1 chunked
  atomicity guarantees committed chunks aren't lost; re-run
  resumes automatically from the remaining work-set.

CRITICAL spec note (surfaced during T07.2 design discovery via a
one-off live probe; documented here so future maintainers don't
chase the same red herring): **the BAN reverse endpoint does NOT
return a ``result_score`` field.** It returns ``result_distance``
(meters from input lon/lat to BAN's matched feature). The forward
``/search/csv/`` endpoint returns ``result_score``; the reverse
endpoint does not. Phase 2 §2.2 step 4 implies a score, which is
where the misreading came from. The ``confidence_score`` value
written into ``live.geocode_cache`` for BAN reverse rows is therefore
a SYNTHESIZED value computed from ``result_distance`` via
``_score_from_reverse_result``. ``confidence_score = 0.95`` for a
BAN reverse row means "≤ 100 m snap distance", not "BAN said 0.95".

Env vars (full run only — T07.3):

* ``SUPABASE_DB_URL``  Postgres URI for the prix-bornes project
  (session pooler — same secret as T06).
* ``GIT_SHA``  workflow commit SHA; fail loud if missing.
* ``BAN_API_BASE_URL``  override for the BAN endpoint host. Defaults
  to ``https://api-adresse.data.gouv.fr``.

The runner never logs ``SUPABASE_DB_URL``; subprocess errors strip it
(same redaction pattern as ``tools/irve-sync/main.py``).
"""

from __future__ import annotations

import argparse
import csv
import io
import os
import re
import subprocess
import sys
import time
from datetime import timedelta
from pathlib import Path
from typing import Iterable

# E13 invariant — stdout command-tag stripping. Same regex as
# tools/irve-sync/main.py. The supavisor session pooler emits these on
# stdout alongside result tuples; direct connection suppresses them.
# Any psql shellout from this codebase forward MUST go through _psql /
# _psql_no_raise (or equivalent stripping) — direct subprocess calls to
# psql outside the helpers are forward bugs.
_PSQL_TAG_RE = re.compile(
    r"^(?:INSERT \d+ \d+|UPDATE \d+|DELETE \d+|SELECT \d+|MERGE \d+|"
    r"COPY \d+|TRUNCATE TABLE|BEGIN|COMMIT|ROLLBACK)$"
)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DEFAULT_BAN_API_BASE_URL = "https://api-adresse.data.gouv.fr"

# Working batch size — BAN's /reverse/csv/ accepts much larger files
# (~50 MB / hundreds of thousands of rows per batch documented), but
# 1,000 rows per call keeps each call under ~10s wallclock for retry
# sanity AND aligns with T07.3's chunked-commit boundary (one BAN batch
# == one DB chunk == one COMMIT).
REVERSE_BATCH_MAX_ROWS = 1000

# Polite inter-batch sleep. BAN docs allow 50 calls / IP / second; we
# stay well below to avoid appearing as a load test in their logs.
INTER_BATCH_SLEEP_SEC = 0.2

# Disk-discipline constants (T07 hard rule #2).
# Working budget: 350 MB. Threshold for the gate: 340 MB (10 MB headroom
# for autovacuum / WAL bursts before SystemExit). Free-tier ceiling: 500 MB.
DISK_GATE_THRESHOLD_BYTES = 340 * 1024 * 1024
DISK_GATE_CHUNK_INTERVAL = 5     # check every Nth chunk
DISK_GATE_PAUSE_SEC = 10         # wait this long for autovacuum, then re-check

# Apply gate threshold (per T07.1 design call (d) + hard rule #6).
# Cache rows below this score are written for forensics but do NOT update
# live.stations.consolidated_code_postal. Threshold lives in SQL too — see
# _build_chunk_sql's UPDATE WHERE clause.
APPLY_SCORE_THRESHOLD = 0.5

# Source slug for live.sources / live.ingestion_runs.source_id.
SOURCE_SLUG = "ban_reverse_geocode"

# Orphan timeout — same as T06 (T06a brief design call #5).
ORPHAN_TIMEOUT_SECONDS = 2 * 3600

FIXTURE_PATH = Path(__file__).resolve().parent / "test" / "fixture-4rows.csv"


# ---------------------------------------------------------------------------
# Pure helpers — single source of truth for T07.1 design calls (b), (d)
# and the spec-discovery synthesis introduced in T07.2.
# ---------------------------------------------------------------------------


def _address_query_for_reverse(lon: float, lat: float) -> str:
    """Canonical cache key for reverse-geocode lookups.

    Format: ``"reverse:{lon:.6f},{lat:.6f}"``. The 6-decimal precision
    matches ``geocode_cache.{latitude,longitude}``'s ``numeric(9,6)``
    storage, so re-encoding a stored lon/lat reproduces the cache key
    bit-exact.

    The ``reverse:`` prefix disambiguates from a future forward-geocode
    cache key (which would be a free-form address string).

    Examples (verified equivalent to Postgres
    ``to_char(value, 'FM999.999990')`` for our value range):

    >>> _address_query_for_reverse(2.349, 48.864)
    'reverse:2.349000,48.864000'
    >>> _address_query_for_reverse(3.13, 50.674)
    'reverse:3.130000,50.674000'
    >>> _address_query_for_reverse(-61.58, 16.243)
    'reverse:-61.580000,16.243000'
    """
    return f"reverse:{lon:.6f},{lat:.6f}"


def _score_from_reverse_result(
    distance_m: float | None, status: str
) -> float | None:
    """Synthesize a confidence score in [0, 1] from BAN reverse response.

    BAN's reverse endpoint does NOT return a ``result_score`` field
    (forward ``/search/csv/`` does). It returns ``result_distance`` in
    meters — the snap-distance from the input lon/lat to BAN's matched
    feature. This function maps that distance to a synthesized score
    using fixed bands aligned with T07.1's TTL design:

      distance ≤   100 m  →  0.95   (housenumber-precision snap;
                                     postal code certainly correct)
      distance ≤  1000 m  →  0.70   (nearby-feature snap; postal still
                                     correct at km scale)
      distance ≤ 10000 m  →  0.30   (long snap; postal may differ)
      distance > 10000 m  →  0.10   (functionally a no-match dressed as
                                     ok-with-huge-distance — e.g. a
                                     coastal / maritime / Channel-Island
                                     point snapping to the nearest
                                     French feature 50 km away)
      status != 'ok'      →  None   (caller skips caching)
      distance is None    →  None   (anomalous: ok status without
                                     distance signal; treat as no-cache)

    Returns None on any uncached path; callers MUST skip writing to
    ``live.geocode_cache`` when this returns None (T07.1 design call (d)).

    The score stored in ``geocode_cache.confidence_score`` for BAN
    reverse rows is COMPUTED, not native to BAN's reverse response.
    Future maintainers reading rows back: ``confidence_score = 0.95``
    means "≤ 100 m snap distance", not "BAN said 0.95 confidence".
    See module docstring for the spec-discovery context.

    >>> _score_from_reverse_result(50, 'ok')
    0.95
    >>> _score_from_reverse_result(100, 'ok')
    0.95
    >>> _score_from_reverse_result(500, 'ok')
    0.7
    >>> _score_from_reverse_result(1000, 'ok')
    0.7
    >>> _score_from_reverse_result(15000, 'ok')
    0.1
    >>> _score_from_reverse_result(50, 'not-found') is None
    True
    """
    if status != "ok":
        return None
    if distance_m is None:
        return None
    if distance_m <= 100:
        return 0.95
    if distance_m <= 1000:
        return 0.70
    if distance_m <= 10000:
        return 0.30
    return 0.10


def _ttl_for_score(score: float) -> timedelta | None:
    """Map a confidence score to an expires_at delta per T07.1 (d).

    Returns:

      * ``None``               for score ≥ 0.8  →  NULL ``expires_at``
                                                  (never expires)
      * ``timedelta(days=90)`` for 0.5 ≤ score < 0.8  →  re-verify
                                                          quarterly
      * ``timedelta(days=30)`` for score < 0.5         →  BAN coverage
                                                          may improve

    Boundary semantics — inclusive on the lower edge of each band:

    >>> _ttl_for_score(0.0)
    datetime.timedelta(days=30)
    >>> _ttl_for_score(0.499)
    datetime.timedelta(days=30)
    >>> _ttl_for_score(0.5)
    datetime.timedelta(days=90)
    >>> _ttl_for_score(0.7999) == timedelta(days=90)
    True
    >>> _ttl_for_score(0.8) is None
    True
    >>> _ttl_for_score(0.95) is None
    True
    >>> _ttl_for_score(1.0) is None
    True
    """
    if score >= 0.8:
        return None
    if score >= 0.5:
        return timedelta(days=90)
    return timedelta(days=30)


# ---------------------------------------------------------------------------
# CSV parsing + per-row decision (shared by fixture and live modes)
# ---------------------------------------------------------------------------


def _parse_ban_response_csv(text: str) -> list[dict[str, str]]:
    """Parse a BAN ``/reverse/csv/`` response body into row dicts.

    The fixture mode treats the on-disk file as if it were a BAN
    response; the parser doesn't care about provenance.
    """
    reader = csv.DictReader(io.StringIO(text))
    return list(reader)


def _decision_for_row(row: dict[str, str]) -> dict[str, object]:
    """Compute the per-row decision for a parsed BAN response row.

    Returns a dict with: ``lon``, ``lat``, ``query``, ``status``,
    ``distance_m``, ``score``, ``postal_code``, ``commune``,
    ``code_insee``, ``normalized_address``, ``expires_at_delta``,
    ``apply``.

    ``apply`` ∈ {``'yes'``, ``'no'``, ``'skip'``}:

    * ``'yes'``  — ``status='ok'`` AND score ≥ 0.5: write cache row
                   with full BAN-returned fields,
                   ``UPDATE live.stations.consolidated_code_postal``.
    * ``'no'``   — ``status='ok'`` AND score < 0.5: write cache row
                   with full BAN-returned fields for forensics, do NOT
                   touch ``live.stations``.
    * ``'skip'`` — any non-``'ok'`` status (``'not-found'``,
                   ``'skipped'``, ``'error'``, future literals) OR
                   ``ok`` with no distance: write a **negative-cache**
                   row (postal/commune/insee/normalized_address all
                   NULL, score 0.0, ttl 30 d) so the work-set query's
                   NOT EXISTS filter excludes the (lon, lat) on
                   subsequent chunks of the same run AND on subsequent
                   runs until the 30 d TTL expires.

    Negative-cache rationale (T07.3 late-discovery refinement,
    overrides T07.1 design call (d)): without caching not-found rows,
    the chunked-loop work-set query re-selects them every chunk,
    creating an infinite loop. Caching with a 30 d TTL solves the
    loop AND preserves the "re-query when BAN coverage improves"
    property — the partial expires_at index makes a periodic eviction
    sweep cheap; after eviction, the next T07 run retries the row.

    The original concern from T07.1 design (d) — "negative cache
    masks future BAN coverage improvements" — is addressed by the
    bounded TTL rather than by absence-of-cache.

    The actual status string is preserved in the returned dict for
    forensics — the function does NOT crash on unknown statuses.
    """
    lon = float(row["longitude"])
    lat = float(row["latitude"])
    query = _address_query_for_reverse(lon, lat)
    status = (row.get("result_status") or "").strip()

    distance_str = (row.get("result_distance") or "").strip()
    try:
        distance_m: float | None = (
            float(distance_str) if distance_str else None
        )
    except ValueError:
        distance_m = None

    score = _score_from_reverse_result(distance_m, status)

    if status != "ok" or score is None:
        # Non-'ok' status (not-found, skipped, error, future literals)
        # OR 'ok' with anomalous missing distance: write a
        # negative-cache row with 30 d TTL.
        apply_decision = "skip"
        ttl_delta: timedelta | None = timedelta(days=30)
    elif score >= 0.5:
        apply_decision = "yes"
        ttl_delta = _ttl_for_score(score)
    else:
        apply_decision = "no"
        ttl_delta = _ttl_for_score(score)

    return {
        "lon": lon,
        "lat": lat,
        "query": query,
        "status": status,
        "distance_m": distance_m,
        "score": score,
        "postal_code": (row.get("result_postcode") or "").strip() or None,
        "commune": (row.get("result_city") or "").strip() or None,
        "code_insee": (row.get("result_citycode") or "").strip() or None,
        "normalized_address": (row.get("result_label") or "").strip() or None,
        "expires_at_delta": ttl_delta,
        "apply": apply_decision,
    }


def _format_decisions_aligned(
    decisions: list[dict[str, object]],
) -> list[str]:
    """Format decisions as aligned-column log lines.

    Column widths derived from the longest stringified value across
    the given decisions. Output shape:

        row N: query=Q  distance=Dm  status=S  score=X  postal=P  \
        commune=C  ttl=T  apply=A

    A single em-dash (``—``) renders for missing values (no distance,
    no score for not-found rows, etc.).
    """
    DASH = "—"
    rendered: list[dict[str, str]] = []
    for d in decisions:
        distance = d["distance_m"]
        score = d["score"]
        ttl = d["expires_at_delta"]
        status = str(d["status"]) or DASH

        # ttl rendering: NULL for never-expires, Nd for finite, dash only
        # if expires_at_delta is None AND apply='skip' would be literally
        # uncached (which post-T07.3 negative-cache no longer happens —
        # skip rows now have ttl=30d).
        if ttl is None and d["apply"] != "skip":
            ttl_str = "NULL"
        elif ttl is not None:
            ttl_str = f"{ttl.days}d"
        else:
            ttl_str = DASH

        rendered.append({
            "query": str(d["query"]),
            "distance": (
                f"{int(distance)}m" if distance is not None else DASH
            ),
            "status": status,
            "score": (f"{score:.2f}" if score is not None else DASH),
            "postal": str(d["postal_code"] or DASH),
            "commune": str(d["commune"] or DASH),
            "ttl": ttl_str,
            "apply": str(d["apply"]),
        })

    if not rendered:
        return []

    cols = (
        "query", "distance", "status", "score",
        "postal", "commune", "ttl", "apply",
    )
    widths = {c: max(len(r[c]) for r in rendered) for c in cols}

    lines: list[str] = []
    for n, r in enumerate(rendered, start=1):
        lines.append("  ".join([
            f"row {n}:",
            f"query={r['query']:<{widths['query']}}",
            f"distance={r['distance']:>{widths['distance']}}",
            f"status={r['status']:<{widths['status']}}",
            f"score={r['score']:<{widths['score']}}",
            f"postal={r['postal']:<{widths['postal']}}",
            f"commune={r['commune']:<{widths['commune']}}",
            f"ttl={r['ttl']:<{widths['ttl']}}",
            f"apply={r['apply']}",
        ]))
    return lines


# ---------------------------------------------------------------------------
# Fixture mode
# ---------------------------------------------------------------------------


def validate_fixture(path: Path = FIXTURE_PATH) -> int:
    """Offline pre-processor smoke. NO network. NO DB.

    Reads the fixture (which mimics a BAN response: input columns +
    ``result_*`` columns), runs ``_decision_for_row`` on each, prints
    aligned per-row decisions, and emits an aggregate summary.

    Returns process exit code.
    """
    if not path.exists():
        print(f"fixture not found: {path}", file=sys.stderr)
        return 1

    text = path.read_text(encoding="utf-8")
    rows = _parse_ban_response_csv(text)

    print(f"# fixture: {path.relative_to(Path.cwd())}")
    print(f"# rows: {len(rows)}")

    if len(rows) == 0:
        print("FAIL: fixture has no data rows", file=sys.stderr)
        return 1

    decisions = [_decision_for_row(r) for r in rows]
    for line in _format_decisions_aligned(decisions):
        print(line)

    apply_yes = sum(1 for d in decisions if d["apply"] == "yes")
    apply_no = sum(1 for d in decisions if d["apply"] == "no")
    apply_skip = sum(1 for d in decisions if d["apply"] == "skip")
    print(
        f"\nrows_seen={len(rows)}, apply_yes={apply_yes}, "
        f"apply_no={apply_no}, apply_skip={apply_skip}"
    )
    return 0


# ---------------------------------------------------------------------------
# psql helpers — laid in place for T07.3, NOT used by T07.2 fixture mode.
# Verbatim port of the contracts in tools/irve-sync/main.py:
#   _psql              — fail-loud default for every shellout that should
#                        abort the runner on SQL error.
#   _psql_no_raise     — variant that returns the exit status; reserved
#                        for paths that must handle non-zero exit
#                        gracefully (E15 post-rollback close pattern).
#   _read_required_env — fail-loud env-var read for full-run mode.
# ---------------------------------------------------------------------------


def _psql(sql: str, *, env: dict[str, str], capture: bool = True) -> str:
    """Run psql with the URL from the env. Never log the URL.

    Fails loud on non-zero exit (raises SystemExit). Default helper for
    every shellout that should abort the runner on SQL error.
    """
    db_url = env.get("SUPABASE_DB_URL")
    if not db_url:
        raise SystemExit("SUPABASE_DB_URL not set")
    cmd = ["psql", db_url, "-v", "ON_ERROR_STOP=1", "-tAc", sql]
    try:
        result = subprocess.run(
            cmd, check=True, capture_output=capture, text=True,
        )
    except subprocess.CalledProcessError as exc:
        stderr = (exc.stderr or "").replace(db_url, "[SUPABASE_DB_URL]")
        raise SystemExit(f"psql failed: {stderr}") from None
    raw = (result.stdout or "").strip()
    return "\n".join(
        line for line in raw.splitlines()
        if line.strip() and not _PSQL_TAG_RE.match(line.strip())
    )


def _psql_no_raise(
    sql: str, *, env: dict[str, str], capture: bool = True,
) -> tuple[int, str, str]:
    """Variant of ``_psql`` that returns the exit status instead of
    raising. Returned tuple is ``(returncode, stdout_stripped,
    stderr_redacted)`` — same shape as
    ``tools/irve-sync/main.py:_psql_no_raise``.

    Use only on paths that need to handle non-zero exit gracefully —
    e.g. T07.3's BAN-batch-then-DB-write loop where a single chunk
    failure must not abort the runner mid-corpus.
    """
    db_url = env.get("SUPABASE_DB_URL")
    if not db_url:
        raise SystemExit("SUPABASE_DB_URL not set")
    cmd = ["psql", db_url, "-v", "ON_ERROR_STOP=1", "-tAc", sql]
    result = subprocess.run(
        cmd, check=False, capture_output=capture, text=True,
    )
    raw_stdout = (result.stdout or "").strip()
    stdout_stripped = "\n".join(
        line for line in raw_stdout.splitlines()
        if line.strip() and not _PSQL_TAG_RE.match(line.strip())
    )
    stderr_redacted = (result.stderr or "").replace(
        db_url, "[SUPABASE_DB_URL]"
    )
    return result.returncode, stdout_stripped, stderr_redacted


def _read_required_env(name: str) -> str:
    """Fail-loud env-var read for full-run mode."""
    value = os.environ.get(name)
    if not value:
        raise SystemExit(
            f"{name} not set. Required in full-run mode "
            f"(use --validate-fixture-only for offline checks)."
        )
    return value


def _quote_sql_literal(value: str | None) -> str:
    """Quote-and-escape a string for inline SQL or return ``NULL``.

    Defense-in-depth (T07.3 design refinement #1) — every BAN-returned
    string field that lands in ``_build_chunk_sql``'s VALUES clause
    goes through this helper. BAN's response is gov-operated and
    trustworthy, but a future commune name like ``L'Île-d'Yeu`` would
    blow up an unescaped chunk SQL. Verbatim port of
    ``tools/irve-sync/main.py:_quote_sql_literal``.
    """
    if value is None:
        return "NULL"
    return "'" + value.replace("'", "''") + "'"


# ---------------------------------------------------------------------------
# T07.3 — DB plumbing helpers (sources, ingestion_runs, work-set, disk gate)
# ---------------------------------------------------------------------------


def _ensure_ban_source_row(env: dict[str, str]) -> None:
    """Idempotent INSERT of the ``ban_reverse_geocode`` source row.

    Per T07.3 design call (5): no migration; the runner ensures its
    own ``live.sources`` row at startup. ``ON CONFLICT DO NOTHING``
    means re-runs are no-ops (slug PK).
    """
    # priority semantic: lower = higher tariff-resolution priority. BAN
    # reverse-geocode is auxiliary (utility, not a tariff source), so
    # priority sits just below irve_consolidated (100) — present in
    # the catalog without competing for tariff resolution.
    sql = (
        "INSERT INTO live.sources "
        "(slug, kind, priority, display_name, description) "
        "VALUES ("
        + _quote_sql_literal(SOURCE_SLUG) + ", "
        + _quote_sql_literal("dataset") + ", "
        + "110, "
        + _quote_sql_literal("BAN reverse-geocode") + ", "
        + _quote_sql_literal(
            "Base Adresse Nationale /reverse/csv/ endpoint. Fills "
            "consolidated_code_postal/commune/INSEE for stations missing "
            "them via lon/lat reverse lookup. confidence_score is "
            "synthesized from result_distance — see "
            "tools/geocode/main.py:_score_from_reverse_result."
        )
        + ") ON CONFLICT (slug) DO NOTHING"
    )
    _psql(sql, env=env)


def _orphan_sweep(env: dict[str, str]) -> int:
    """Mark stuck status='running' BAN rows older than the orphan
    timeout as 'failed'. Returns the number of rows transitioned.

    Same pattern as ``tools/irve-sync/main.py:_orphan_sweep``. T07 is
    one-shot rather than crontab'd, so the practical hit-rate is
    minimal — but the cost is one cheap UPDATE at startup, and if E21
    recurs and leaves a T07 run dangling, the next operator-driven
    re-run picks it up automatically.
    """
    sql = (
        "UPDATE live.ingestion_runs "
        "SET status='failed', "
        "    finished_at=now(), "
        "    error_message=COALESCE(error_message,'') || "
        "      ' superseded by newer run; runner timed out' "
        "WHERE source_id = (SELECT id FROM live.sources WHERE slug = "
        + _quote_sql_literal(SOURCE_SLUG) + ") "
        "  AND status='running' "
        f"  AND started_at < now() - interval '{ORPHAN_TIMEOUT_SECONDS} seconds' "
        "RETURNING id"
    )
    result = _psql(sql, env=env)
    return len([line for line in result.splitlines() if line.strip()])


def _open_run_row(env: dict[str, str], git_sha: str) -> str:
    """INSERT a new ingestion_runs row in status='running'. Returns its
    uuid as a bare string."""
    sql = (
        "INSERT INTO live.ingestion_runs (source_id, status, git_sha) "
        "SELECT id, 'running', "
        + _quote_sql_literal(git_sha)
        + " FROM live.sources WHERE slug = "
        + _quote_sql_literal(SOURCE_SLUG)
        + " RETURNING id"
    )
    return _psql(sql, env=env)


def _short_lived_success_row(
    env: dict[str, str],
    git_sha: str,
    error_message: str,
) -> str:
    """Insert a fully-closed status='success' run row in one shot.

    Used for the work_set=0 case (T07.3 design refinement #3 +
    design call (e)) so the audit trail distinguishes "we ran and had
    nothing to do" from "we ran and processed N rows". The
    error_message column carries the descriptive label.
    """
    sql = (
        "INSERT INTO live.ingestion_runs "
        "(source_id, status, started_at, finished_at, git_sha, error_message) "
        "SELECT id, 'success', now(), now(), "
        + _quote_sql_literal(git_sha)
        + ", "
        + _quote_sql_literal(error_message)
        + " FROM live.sources WHERE slug = "
        + _quote_sql_literal(SOURCE_SLUG)
        + " RETURNING id"
    )
    return _psql(sql, env=env)


def _close_run_row(
    env: dict[str, str],
    run_id: str,
    *,
    status: str,
    counters: dict[str, int],
    error_message: str | None = None,
) -> None:
    """Close an ingestion_runs row to a terminal status via the
    ``live.close_ingestion_run`` SQL function. Counters JSONB shape:
    ``{rows_seen, rows_inserted, rows_updated, rows_skipped}`` — the
    function unpacks each into the corresponding column.
    """
    counters_json = (
        "{"
        + ", ".join(
            f'"{k}": {int(v)}' for k, v in counters.items()
        )
        + "}"
    )
    sql = (
        "SELECT live.close_ingestion_run("
        f"'{run_id}'::uuid, "
        + _quote_sql_literal(status) + ", "
        + _quote_sql_literal(counters_json) + "::jsonb, "
        + _quote_sql_literal(error_message or "")
        + ")"
    )
    _psql(sql, env=env)


def _select_work_set_count(env: dict[str, str]) -> int:
    """Count of stations needing geocoding (NULL postal AND no cache hit)."""
    sql = (
        "SELECT count(*) FROM live.stations s "
        "WHERE (s.consolidated_code_postal IS NULL "
        "       OR s.consolidated_code_postal = '') "
        "  AND NOT EXISTS ("
        "    SELECT 1 FROM live.geocode_cache c "
        "    WHERE c.provider = " + _quote_sql_literal("ban") + " "
        "      AND c.longitude = ST_X(s.geom::geometry)::numeric(9,6) "
        "      AND c.latitude  = ST_Y(s.geom::geometry)::numeric(9,6))"
    )
    result = _psql(sql, env=env)
    return int(result.strip() or "0")


def _select_work_set_chunk(
    env: dict[str, str], limit: int = REVERSE_BATCH_MAX_ROWS,
) -> list[tuple[str, float, float]]:
    """Return up to `limit` work-set rows as (id_station_itinerance, lon, lat).

    Same WHERE clause as `_select_work_set_count` so the chunk is
    drawn from exactly the same set the count enumerates.
    """
    sql = (
        "SELECT s.id_station_itinerance || '|' || "
        "       ST_X(s.geom::geometry)::numeric(9,6) || '|' || "
        "       ST_Y(s.geom::geometry)::numeric(9,6) "
        "FROM live.stations s "
        "WHERE (s.consolidated_code_postal IS NULL "
        "       OR s.consolidated_code_postal = '') "
        "  AND NOT EXISTS ("
        "    SELECT 1 FROM live.geocode_cache c "
        "    WHERE c.provider = " + _quote_sql_literal("ban") + " "
        "      AND c.longitude = ST_X(s.geom::geometry)::numeric(9,6) "
        "      AND c.latitude  = ST_Y(s.geom::geometry)::numeric(9,6)) "
        f"LIMIT {int(limit)}"
    )
    result = _psql(sql, env=env)
    rows: list[tuple[str, float, float]] = []
    for line in result.splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split("|")
        if len(parts) != 3:
            continue
        rows.append((parts[0], float(parts[1]), float(parts[2])))
    return rows


def _disk_audit(env: dict[str, str]) -> tuple[int, str]:
    """Return ``(bytes, pretty_str)`` for the current database size."""
    sql = (
        "SELECT pg_database_size(current_database())::text || '|' || "
        "       pg_size_pretty(pg_database_size(current_database()))"
    )
    result = _psql(sql, env=env).strip()
    bytes_str, pretty = result.split("|", 1)
    return int(bytes_str), pretty


def _disk_gate_check_and_pause(
    env: dict[str, str],
    chunk_n: int,
    total_chunks: int,
) -> None:
    """Implements T07.3 hard rule #2 disk-audit gate.

    If db_size > DISK_GATE_THRESHOLD_BYTES, log a WARN, sleep
    DISK_GATE_PAUSE_SEC, re-check; if still over, ``SystemExit(1)``
    with a recovery-instruction message. Hard rule #1 chunked
    atomicity guarantees committed chunks 1..chunk_n are preserved;
    re-run resumes automatically from the remaining work-set.
    """
    size_bytes, pretty = _disk_audit(env)
    print(f"# disk-gate (post-chunk {chunk_n}/{total_chunks}): {pretty}")
    if size_bytes <= DISK_GATE_THRESHOLD_BYTES:
        return

    print(
        f"# WARN: db_size={pretty} > "
        f"{DISK_GATE_THRESHOLD_BYTES // (1024*1024)} MB threshold; "
        f"pausing {DISK_GATE_PAUSE_SEC}s for autovacuum…",
        file=sys.stderr,
    )
    time.sleep(DISK_GATE_PAUSE_SEC)

    size_bytes_after, pretty_after = _disk_audit(env)
    print(
        f"# disk-gate after pause: {pretty_after}",
        file=sys.stderr,
    )
    if size_bytes_after <= DISK_GATE_THRESHOLD_BYTES:
        return

    raise SystemExit(
        f"Disk budget exceeded mid-run: db_size={pretty_after} > "
        f"{DISK_GATE_THRESHOLD_BYTES // (1024*1024)} MB threshold "
        f"(checked after chunk {chunk_n}/{total_chunks}). Partial "
        f"progress committed through chunk {chunk_n}; re-run resumes "
        f"automatically from remaining work-set. Manual recovery: "
        f"dashboard SQL Editor `set session characteristics as "
        f"transaction read write` + truncate ephemeral data + vacuum."
    )


def _build_chunk_sql(
    decisions: list[dict[str, object]],
) -> str | None:
    """Build the single-statement chunk SQL — multi-VALUES INSERT-ON-
    CONFLICT into ``live.geocode_cache`` plus an UPDATE-FROM into
    ``live.stations`` guarded by ``confidence_score >= APPLY_SCORE_THRESHOLD``.

    Includes apply ∈ {'yes', 'no', 'skip'} — all three produce cache
    rows (T07.3 negative-cache refinement; see ``_decision_for_row``'s
    docstring for the rationale). Skip rows have NULL postal/commune/
    insee/normalized_address and confidence_score = 0.0; the UPDATE
    gate filters them out.

    Dedupes by ``address_query`` within the chunk: stations sharing
    physical coordinates (same site, multiple ``id_station_itinerance``
    values) collapse to one cache row. Postgres's ``INSERT ... ON
    CONFLICT DO UPDATE`` cannot affect the same conflict-target row
    twice in a single statement (SQLSTATE 21000 — same family as
    E17 in T06b.1's first apply). The UPDATE-FROM still matches all
    stations sharing the same coords because the join key is
    (lon, lat), so 1 cache row may update N stations.

    Returns None when there are no cacheable decisions (empty input).
    All BAN-returned strings are escaped via ``_quote_sql_literal``.
    """
    if not decisions:
        return None

    # Dedupe by address_query: keep first occurrence. Cache row count
    # for the run's `rows_inserted` counter is the deduped count, not
    # the raw decision count — matches the SQL reality.
    seen: set[str] = set()
    cache_decisions: list[dict[str, object]] = []
    for d in decisions:
        key = str(d["query"])
        if key in seen:
            continue
        seen.add(key)
        cache_decisions.append(d)

    if not cache_decisions:
        return None

    values_lines: list[str] = []
    for d in cache_decisions:
        ttl = d["expires_at_delta"]
        if ttl is None:
            expires_at_sql = "NULL"
        else:
            expires_at_sql = f"now() + INTERVAL '{int(ttl.days)} days'"
        # Skip rows have score=None per _score_from_reverse_result;
        # store as 0.0 so the UPDATE-gate (>= 0.5) excludes them.
        score = d["score"] if d["score"] is not None else 0.0
        values_lines.append(
            "("
            + _quote_sql_literal(str(d["query"])) + ", "
            + _quote_sql_literal(d["normalized_address"]) + ", "
            + _quote_sql_literal(d["postal_code"]) + ", "
            + _quote_sql_literal(d["commune"]) + ", "
            + _quote_sql_literal(d["code_insee"]) + ", "
            + f"{float(d['lat']):.6f}, "
            + f"{float(d['lon']):.6f}, "
            + f"{float(score):.3f}, "
            + _quote_sql_literal("ban") + ", "
            + expires_at_sql
            + ")"
        )

    return (
        "WITH ins AS ("
        " INSERT INTO live.geocode_cache ("
        "address_query, normalized_address, postal_code, commune, "
        "code_insee, latitude, longitude, confidence_score, provider, "
        "expires_at) VALUES "
        + ",\n    ".join(values_lines)
        + " ON CONFLICT (address_query, provider) DO UPDATE SET"
        " normalized_address = EXCLUDED.normalized_address,"
        " postal_code        = EXCLUDED.postal_code,"
        " commune            = EXCLUDED.commune,"
        " code_insee         = EXCLUDED.code_insee,"
        " latitude           = EXCLUDED.latitude,"
        " longitude          = EXCLUDED.longitude,"
        " confidence_score   = EXCLUDED.confidence_score,"
        " expires_at         = EXCLUDED.expires_at,"
        " updated_at         = now()"
        " RETURNING address_query, postal_code, commune, code_insee,"
        " confidence_score, latitude, longitude"
        ") "
        "UPDATE live.stations s "
        "SET    consolidated_code_postal = ins.postal_code, "
        "       consolidated_commune     = "
        "         COALESCE(NULLIF(s.consolidated_commune, ''), ins.commune), "
        "       code_insee_commune       = "
        "         COALESCE(NULLIF(s.code_insee_commune, ''), ins.code_insee) "
        "FROM   ins "
        f"WHERE  ins.confidence_score >= {APPLY_SCORE_THRESHOLD} "
        "  AND  ins.longitude = ST_X(s.geom::geometry)::numeric(9,6) "
        "  AND  ins.latitude  = ST_Y(s.geom::geometry)::numeric(9,6)"
    )


# ---------------------------------------------------------------------------
# Live BAN client — T07.3 use only. Lazy `requests` import per T07.2 hard
# rule #3: fixture mode never reaches this function so the dep isn't
# pulled. Mirrors tools/irve-sync/main.py per T06a pattern.
# ---------------------------------------------------------------------------


def _ban_reverse_csv(
    rows: list[tuple[float, float]],
    *,
    base_url: str = DEFAULT_BAN_API_BASE_URL,
    timeout_seconds: int = 60,
) -> str:
    """POST a batch of (lon, lat) rows to BAN ``/reverse/csv/``; return
    the raw response CSV text.

    ``requests`` is imported lazily inside this function so fixture-only
    invocations don't require it on PATH (mirrors
    ``tools/irve-sync/main.py`` per T06a pattern). NOT reachable from
    ``--validate-fixture-only``.
    """
    import requests  # lazy

    csv_lines = ["longitude,latitude"]
    for lon, lat in rows:
        csv_lines.append(f"{lon:.6f},{lat:.6f}")
    csv_body = "\n".join(csv_lines) + "\n"

    response = requests.post(
        f"{base_url.rstrip('/')}/reverse/csv/",
        files={"data": ("input.csv", csv_body)},
        data=[("columns", "longitude"), ("columns", "latitude")],
        timeout=timeout_seconds,
    )
    response.raise_for_status()
    return response.text


# ---------------------------------------------------------------------------
# Live runner (T07.3)
# ---------------------------------------------------------------------------


def full_run() -> int:
    """Live BAN reverse-geocode runner.

    Pipeline: ensure source row → orphan sweep → open ingestion_runs
    row → resume-verify (work-set count) → chunk loop (BAN call →
    decisions → cache+stations write in single-statement CTE per
    chunk, atomic) → disk-audit gate every DISK_GATE_CHUNK_INTERVAL
    chunks → close run row.

    Failure modes:

    * BAN HTTP non-2xx mid-chunk: propagates as a SystemExit with a
      clear chunk-N reference. Hard rule #1 atomicity guarantees
      committed chunks 1..N-1 are preserved; re-run resumes
      automatically because the work-set query excludes already-
      cached coords. No retry logic per T07.3 hard rule #8.
    * DB write failure mid-chunk: the chunk's INSERT+UPDATE rolls
      back atomically (single psql -c == single transaction). Same
      resume property as above.
    * Disk gate trip: SystemExit with state-preservation note.
      Re-run resumes automatically.

    Counters at close: rows_seen = work-set size at start;
    rows_inserted = total cache rows written; rows_updated = total
    live.stations UPDATEs; rows_skipped = work-set rows that did not
    produce a station UPDATE (apply='no' + apply='skip'). Status:
    'success' iff rows_skipped == 0; 'partial' iff a chunk completed
    but rows_skipped > 0; 'failed' on any chunk SystemExit.
    """
    env = {k: v for k, v in os.environ.items() if v is not None}
    git_sha = _read_required_env("GIT_SHA")
    _read_required_env("SUPABASE_DB_URL")
    base_url = (
        os.environ.get("BAN_API_BASE_URL") or DEFAULT_BAN_API_BASE_URL
    )

    print(
        f"# T07 BAN reverse-geocode starting "
        f"(git_sha={git_sha[:12]}…, base_url={base_url})"
    )

    _ensure_ban_source_row(env)

    swept = _orphan_sweep(env)
    if swept:
        print(
            f"# orphan sweep: {swept} stuck row(s) transitioned to failed"
        )

    pre_size_bytes, pre_size_pretty = _disk_audit(env)
    print(f"# disk: pre-flight db_size={pre_size_pretty}")

    work_set_size = _select_work_set_count(env)
    if work_set_size == 0:
        run_id = _short_lived_success_row(
            env, git_sha,
            "work-set empty: 0 stations need geocoding "
            "(cache or postal coverage already complete)",
        )
        print(
            f"# work-set: 0 stations need geocoding. Nothing to do. "
            f"ingestion_runs.id={run_id}, status=success"
        )
        return 0

    total_chunks = (work_set_size + REVERSE_BATCH_MAX_ROWS - 1) // REVERSE_BATCH_MAX_ROWS
    print(
        f"# work-set: {work_set_size} stations need geocoding "
        f"(of 52,806 total). Chunks: {total_chunks} × "
        f"{REVERSE_BATCH_MAX_ROWS} rows max."
    )

    run_id = _open_run_row(env, git_sha)
    print(f"# opened ingestion_runs.id={run_id}, status=running")

    rows_inserted_total = 0
    rows_updated_total = 0
    rows_skipped_total = 0
    chunk_n = 0
    t0 = time.monotonic()
    t_ban_total = 0.0
    t_db_total = 0.0

    try:
        while True:
            chunk = _select_work_set_chunk(env, REVERSE_BATCH_MAX_ROWS)
            if not chunk:
                break
            chunk_n += 1
            t_chunk0 = time.monotonic()

            # Step 3: BAN call
            t_ban0 = time.monotonic()
            response_text = _ban_reverse_csv(
                [(lon, lat) for _id, lon, lat in chunk],
                base_url=base_url,
            )
            t_ban = time.monotonic() - t_ban0
            t_ban_total += t_ban

            # Step 4-5: parse + decisions, then merge with our (lon, lat)
            # by row index (BAN echoes input order)
            ban_rows = _parse_ban_response_csv(response_text)
            decisions = []
            for (_id, lon, lat), ban_row in zip(chunk, ban_rows):
                d = _decision_for_row(ban_row)
                # The decision dict carries lon/lat parsed from the BAN
                # response's echoed columns; sanity-check they match the
                # input we sent (defense-in-depth).
                if (
                    abs(d["lon"] - lon) > 1e-6
                    or abs(d["lat"] - lat) > 1e-6
                ):
                    raise SystemExit(
                        f"chunk {chunk_n}: BAN response lon/lat drift "
                        f"input=({lon}, {lat}) response=({d['lon']}, "
                        f"{d['lat']}). Aborting."
                    )
                decisions.append(d)

            # Step 6-7: build chunk SQL + execute
            chunk_apply_yes = sum(1 for d in decisions if d["apply"] == "yes")
            chunk_apply_no = sum(1 for d in decisions if d["apply"] == "no")
            chunk_skip = sum(1 for d in decisions if d["apply"] == "skip")

            # Dedupe-by-address_query for the cache-row counter — stations
            # sharing physical coords (same site, multiple
            # id_station_itinerance) collapse to one cache row in SQL.
            # _build_chunk_sql does the same dedupe defensively. The
            # UPDATE-FROM still runs against ALL stations sharing those
            # coords (join key is lon/lat), so chunk_apply_yes still
            # counts station UPDATEs accurately. All three apply values
            # produce cache rows post-T07.3-negative-cache refinement.
            cache_qs = {str(d["query"]) for d in decisions}
            chunk_cached = len(cache_qs)
            chunk_dupe = len(decisions) - chunk_cached

            t_db0 = time.monotonic()
            chunk_sql = _build_chunk_sql(decisions)
            if chunk_sql is not None:
                _psql(chunk_sql, env=env)
            t_db = time.monotonic() - t_db0
            t_db_total += t_db

            rows_inserted_total += chunk_cached
            rows_updated_total += chunk_apply_yes
            rows_skipped_total += (chunk_apply_no + chunk_skip)

            t_chunk = time.monotonic() - t_chunk0
            dupe_note = f", dupes_collapsed={chunk_dupe}" if chunk_dupe else ""
            print(
                f"# chunk {chunk_n}/{total_chunks}: "
                f"rows_in={len(chunk)}, "
                f"BAN={t_ban:.1f}s, "
                f"rows_cached={chunk_cached}{dupe_note}, "
                f"rows_apply_yes={chunk_apply_yes}, "
                f"rows_apply_no={chunk_apply_no}, "
                f"rows_skip={chunk_skip}, "
                f"DB={t_db:.1f}s, "
                f"total={t_chunk:.1f}s"
            )

            # Polite to BAN (T07.3 soft rule).
            time.sleep(INTER_BATCH_SLEEP_SEC)

            # Disk-audit gate every DISK_GATE_CHUNK_INTERVAL chunks.
            if chunk_n % DISK_GATE_CHUNK_INTERVAL == 0:
                _disk_gate_check_and_pause(env, chunk_n, total_chunks)

    except SystemExit:
        # Mid-chunk SystemExit (BAN HTTP error, DB error, disk gate, or
        # explicit raise above). Hard rule #1 atomicity preserved
        # committed chunks 1..chunk_n. Close the run row to 'failed'
        # with the chunk reference so the audit trail is interpretable.
        _close_run_row(
            env, run_id,
            status="failed",
            counters={
                "rows_seen": work_set_size,
                "rows_inserted": rows_inserted_total,
                "rows_updated": rows_updated_total,
                "rows_skipped": rows_skipped_total,
            },
            error_message=(
                f"chunk {chunk_n}/{total_chunks} aborted "
                f"(committed: cache_rows={rows_inserted_total}, "
                f"stations_updated={rows_updated_total}). "
                f"Re-run resumes automatically."
            ),
        )
        raise

    # All chunks completed.
    t_total = time.monotonic() - t0
    post_size_bytes, post_size_pretty = _disk_audit(env)
    delta_mb = (post_size_bytes - pre_size_bytes) / (1024 * 1024)

    final_status = "success" if rows_skipped_total == 0 else "partial"
    _close_run_row(
        env, run_id,
        status=final_status,
        counters={
            "rows_seen": work_set_size,
            "rows_inserted": rows_inserted_total,
            "rows_updated": rows_updated_total,
            "rows_skipped": rows_skipped_total,
        },
    )

    print(
        f"\n# T07 complete: status={final_status} "
        f"rows_seen={work_set_size} "
        f"rows_cached={rows_inserted_total} "
        f"rows_applied={rows_updated_total} "
        f"rows_skipped={rows_skipped_total}"
    )
    print(
        f"# wall-clock: total={t_total:.1f}s "
        f"(BAN={t_ban_total:.1f}s, DB={t_db_total:.1f}s, "
        f"chunks={chunk_n})"
    )
    print(
        f"# disk: post-flight db_size={post_size_pretty} "
        f"(Δ={delta_mb:+.1f} MB from pre-flight {pre_size_pretty})"
    )
    print(
        f"# ingestion_runs.id={run_id} closed to status={final_status}."
    )

    return 0


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "T07 BAN reverse-geocode runner. "
            "Use --validate-fixture-only for offline CI smoke."
        ),
    )
    parser.add_argument(
        "--validate-fixture-only",
        action="store_true",
        help="Run the response parser, decision logic, and helpers "
             "against the checked-in 4-row fixture. NO network, NO DB. "
             "Exit non-zero on logic regressions.",
    )
    args = parser.parse_args(argv)

    if args.validate_fixture_only:
        return validate_fixture()
    return full_run()


if __name__ == "__main__":
    raise SystemExit(main())
