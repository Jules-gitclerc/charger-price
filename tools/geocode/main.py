#!/usr/bin/env python3
"""BAN reverse-geocode runner (T07).

Two modes:

* ``--validate-fixture-only`` — offline. Reads
  ``tools/geocode/test/fixture-4rows.csv``, runs the response parser,
  per-row decision logic, and the score / TTL helpers; prints an
  aligned per-row decision log; exits non-zero on a logic regression.
  NO network. NO DB.

* full run (default) — **NOT IMPLEMENTED in T07.2.** ``full_run()``
  raises ``NotImplementedError``. T07.3 will pull missing-postal
  stations from ``live.stations``, batch-call the BAN
  ``/reverse/csv/`` endpoint, parse, write ``live.geocode_cache``,
  and ``UPDATE live.stations`` in chunked commits.

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

    * ``'yes'``  — ``status='ok'`` AND score ≥ 0.5: write cache row,
                   ``UPDATE live.stations.consolidated_code_postal``.
    * ``'no'``   — ``status='ok'`` AND score < 0.5: write cache row
                   for forensics, do NOT touch ``live.stations``.
    * ``'skip'`` — any non-``'ok'`` status (``'not-found'``,
                   ``'skipped'``, ``'error'``, future literals) OR
                   ``ok`` with no distance: do NOT write a cache row;
                   re-querying on subsequent runs is cheap and avoids
                   masking future BAN coverage improvements with a
                   permanent negative cache entry.

    Per the bonus design call: any non-``'ok'`` status is treated as
    no-cache (same as ``'not-found'``). The actual status string is
    preserved in the returned dict for forensics — the function does
    NOT crash on unknown statuses.
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
        # OR 'ok' with anomalous missing distance: don't cache.
        apply_decision = "skip"
        ttl_delta: timedelta | None = None
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

        if status == "ok" and score is not None:
            ttl_str = "NULL" if ttl is None else f"{ttl.days}d"
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
# Live runner — T07.3 will implement; T07.2 stub raises.
# ---------------------------------------------------------------------------


def full_run() -> int:
    """Live BAN reverse-geocode runner.

    T07.2 stub. T07.3 will implement: pull missing-postal stations from
    ``live.stations``, batch-call ``_ban_reverse_csv``, parse via
    ``_parse_ban_response_csv`` + ``_decision_for_row``, write
    ``live.geocode_cache``, ``UPDATE live.stations``, all in chunked
    commits per T07 design (one BAN batch per chunk per commit).
    """
    raise NotImplementedError(
        "Live runner is T07.3 scope. Use --validate-fixture-only for "
        "T07.2 verification."
    )


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
