#!/usr/bin/env python3
"""Operator alias resolver runner (T08.2).

Single-mode runner — operates against live Supabase. Pre-flight gates on
``live.operator_aliases`` non-emptiness, opens a ``live.ingestion_runs``
row tied to source ``operator_resolver`` (registered in migration 0016),
issues a single-statement atomic UPDATE that resolves
``live.stations.operator_id`` for every station whose
``lower(btrim(nom_enseigne))`` matches an alias, then closes the run row
to a terminal status via ``live.close_ingestion_run`` (E15).

Per Hard Rule #7 in T08's brief: single chunk, single transaction. The
UPDATE either lands wholly or rolls back wholly — psql's
``ON_ERROR_STOP=1`` plus Postgres's implicit-transaction-per-statement
gives us atomic single-chunk behavior without explicit BEGIN/COMMIT.
~52k UPDATE rows is comfortably within E21's WAL envelope (much smaller
than T06b's 211k swap).

T07-vs-T08 status semantics divergence: T08 uses ``status='success'``
even when ``rows_skipped > 0``. T07's skipped rows were "BAN failed to
resolve" (failure mode); T08's skipped rows are "no curated alias for
this enseigne — long tail by design per T08.0 Q4 + E23 forward-flag".
Don't conflate "intentional gap" with "partial run".

Re-run idempotence: the UPDATE WHERE clause includes
``s.operator_id IS NULL``, so a second invocation UPDATEs 0 rows. The
ingestion_runs row still opens and closes cleanly with
``rows_updated=0``, ``status='success'``. Documented in T08 brief
Q5 design call (d).

Acceptance bar (T08.1, query a, locked at commit b9c92c2): post-resolve
``count(*) FROM live.stations WHERE operator_id IS NOT NULL`` must
equal the JOIN forecast computed against the seed in migration 0016.
The runner re-derives this expected value at startup (no hardcoded
constant — self-correcting against future seed expansions per T08.2 R2)
and WARNs on drift after the COMMIT lands.

Env vars:

* ``SUPABASE_DB_URL``  Postgres URI for the prix-bornes project
  (session pooler — same secret as T06/T07).
* ``GIT_SHA``  workflow commit SHA; fail loud if missing. Stamped on
  ingestion_runs.git_sha for audit trail. For local invocation,
  ``git rev-parse HEAD`` works.

Exit codes: 0 on success, 1 on any failure (assertion, psql error,
exception). The ingestion_runs row is closed to ``'failed'`` via a
separate post-rollback statement on exception (E15 forward practice).
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from collections.abc import Iterable

# ---------------------------------------------------------------------------
# psql output sanitization — verbatim port from tools/geocode/main.py.
# Strips supavisor session-pooler tag lines that arrive on stdout
# alongside result tuples. Direct connection doesn't emit them; pooler
# does. Any psql shellout from this codebase MUST go through _psql /
# _psql_no_raise — direct subprocess.run calls to psql outside helpers
# are forward bugs.
# ---------------------------------------------------------------------------
_PSQL_TAG_RE = re.compile(
    r"^(?:INSERT \d+ \d+|UPDATE \d+|DELETE \d+|SELECT \d+|MERGE \d+|"
    r"COPY \d+|TRUNCATE TABLE|BEGIN|COMMIT|ROLLBACK)$"
)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

SOURCE_SLUG = "operator_resolver"

# Single-tx UPDATE shouldn't outlive 30 min on M1's 52k-row scale. The
# orphan sweep at startup will close any older 'running' row from a
# prior runner that crashed before finally{}-block closure.
ORPHAN_TIMEOUT_SECONDS = 30 * 60

# Top-N to print in the per-operator distribution report.
REPORT_TOP_N = 10


# ---------------------------------------------------------------------------
# psql helpers — verbatim port from tools/geocode/main.py
# ---------------------------------------------------------------------------


def _psql(sql: str, *, env: dict[str, str], capture: bool = True) -> str:
    """Run psql with the URL from the env. Never log the URL.

    Fails loud on non-zero exit (raises SystemExit).
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
    """Variant that returns the exit status instead of raising. Used on
    paths that need to handle non-zero exit gracefully — here, only the
    post-rollback failure-path close where we don't want a secondary
    SystemExit to mask the original error.
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
    """Fail-loud env-var read."""
    value = os.environ.get(name)
    if not value:
        raise SystemExit(f"{name} not set. Required for T08.2 full run.")
    return value


def _quote_sql_literal(value: str | None) -> str:
    """Quote-and-escape a string for inline SQL or return ``NULL``.

    Defense-in-depth for git_sha and error_message strings that land in
    the ingestion_runs INSERT / close calls. Verbatim port of
    ``tools/geocode/main.py:_quote_sql_literal``.
    """
    if value is None:
        return "NULL"
    return "'" + value.replace("'", "''") + "'"


# ---------------------------------------------------------------------------
# T08.2 — DB plumbing
# ---------------------------------------------------------------------------


def _assert_aliases_seeded(env: dict[str, str]) -> int:
    """Pre-flight gate: live.operator_aliases must be non-empty.

    Protects against running the resolver against a pre-T08.1 DB state
    (e.g. forgot to apply migration 0016). Returns the alias count for
    use in the report.
    """
    count = int(_psql("SELECT count(*) FROM live.operator_aliases", env=env))
    if count == 0:
        raise SystemExit(
            "live.operator_aliases is empty — has migration 0016 been applied? "
            "Run `psql -f supabase/migrations/0016_operator_aliases.sql` then retry."
        )
    return count


def _orphan_sweep(env: dict[str, str]) -> int:
    """Mark stuck status='running' resolver rows older than the orphan
    timeout as 'failed'. Returns the number of rows transitioned.

    Same pattern as tools/geocode/main.py:_orphan_sweep. T08 is one-shot
    rather than crontab'd, but if a prior run was killed mid-flight the
    next operator-driven re-run picks it up automatically.
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
    uuid as a bare string.
    """
    sql = (
        "INSERT INTO live.ingestion_runs (source_id, status, git_sha) "
        "SELECT id, 'running', "
        + _quote_sql_literal(git_sha)
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
    live.close_ingestion_run SQL function. Counters JSONB shape:
    {rows_seen, rows_inserted, rows_updated, rows_skipped}.
    """
    counters_json = (
        "{"
        + ", ".join(f'"{k}": {int(v)}' for k, v in counters.items())
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


def _close_run_row_post_rollback(
    env: dict[str, str],
    run_id: str,
    error_message: str,
) -> None:
    """Failure-path close: separate post-rollback statement (E15).

    Uses _psql_no_raise so a secondary failure here doesn't mask the
    original error. The orphan sweep on the next runner invocation will
    catch any row that this couldn't close.
    """
    counters_json = '{"rows_seen": null, "rows_inserted": 0, "rows_updated": 0, "rows_skipped": null}'
    # null is not valid in our counters JSON since close_ingestion_run
    # casts ->>'k'::int and null would NULL the column — which is
    # actually the right semantic for "we don't know how far we got".
    sql = (
        "SELECT live.close_ingestion_run("
        f"'{run_id}'::uuid, "
        + _quote_sql_literal("failed") + ", "
        + _quote_sql_literal(counters_json) + "::jsonb, "
        + _quote_sql_literal(error_message)
        + ")"
    )
    rc, _stdout, stderr = _psql_no_raise(sql, env=env)
    if rc != 0:
        print(
            f"# WARN: failure-path close also failed (run {run_id}): {stderr}",
            file=sys.stderr,
        )


# ---------------------------------------------------------------------------
# State capture
# ---------------------------------------------------------------------------


def _capture_state(env: dict[str, str]) -> dict[str, object]:
    """Snapshot db_size + station counts for pre/post comparison."""
    sql = (
        "SELECT pg_database_size(current_database())::text || '|' || "
        "       pg_size_pretty(pg_database_size(current_database())) || '|' || "
        "       (SELECT count(*) FROM live.stations WHERE operator_id IS NULL)::text || '|' || "
        "       (SELECT count(*) FROM live.stations WHERE operator_id IS NOT NULL)::text"
    )
    raw = _psql(sql, env=env).strip()
    bytes_str, pretty, null_count, not_null_count = raw.split("|", 3)
    return {
        "db_size_bytes": int(bytes_str),
        "db_size_pretty": pretty,
        "stations_null": int(null_count),
        "stations_not_null": int(not_null_count),
    }


def _compute_expected_resolved(env: dict[str, str]) -> int:
    """Forecast: stations whose lower(btrim(nom_enseigne)) matches some
    alias_text. Deterministic property of the seed × live.stations join;
    must equal post-resolve count(*) WHERE operator_id IS NOT NULL.

    Computed at runtime rather than hardcoded as a constant (T08.2 R2)
    so future alias additions (M1.5 prefix-rule, M2 networks) are
    self-correcting — no maintenance burden on this runner.
    """
    sql = (
        "SELECT count(*) FROM live.stations s "
        "JOIN live.operator_aliases a "
        "  ON a.alias_text = lower(btrim(s.nom_enseigne))"
    )
    return int(_psql(sql, env=env))


def _forecast_top_n_by_operator(
    env: dict[str, str], n: int = REPORT_TOP_N,
) -> list[tuple[str, str, int]]:
    """Forecast: per-operator station count from the deterministic JOIN.
    Doesn't depend on resolver having run. Returns [(slug, display_name, count)].
    """
    sql = (
        "SELECT o.slug || '|' || o.display_name || '|' || count(*)::text "
        "FROM live.stations s "
        "JOIN live.operator_aliases a ON a.alias_text = lower(btrim(s.nom_enseigne)) "
        "JOIN live.operators o ON o.id = a.operator_id "
        "GROUP BY o.slug, o.display_name "
        "ORDER BY count(*) DESC, o.slug "
        f"LIMIT {n}"
    )
    raw = _psql(sql, env=env)
    rows: list[tuple[str, str, int]] = []
    for line in raw.splitlines():
        if not line.strip():
            continue
        slug, display_name, count_str = line.split("|", 2)
        rows.append((slug, display_name, int(count_str)))
    return rows


def _measured_top_n_by_operator(
    env: dict[str, str], n: int = REPORT_TOP_N,
) -> list[tuple[str, str, int]]:
    """Measured: per-operator station count from live.stations.operator_id.
    Pre-resolve this is all zeros (or close to it); post-resolve it should
    match the forecast for every operator.
    """
    sql = (
        "SELECT o.slug || '|' || o.display_name || '|' || count(s.id_station_itinerance)::text "
        "FROM live.operators o "
        "LEFT JOIN live.stations s ON s.operator_id = o.id "
        "GROUP BY o.slug, o.display_name "
        "ORDER BY count(s.id_station_itinerance) DESC NULLS LAST, o.slug "
        f"LIMIT {n}"
    )
    raw = _psql(sql, env=env)
    rows: list[tuple[str, str, int]] = []
    for line in raw.splitlines():
        if not line.strip():
            continue
        slug, display_name, count_str = line.split("|", 2)
        rows.append((slug, display_name, int(count_str)))
    return rows


# ---------------------------------------------------------------------------
# The atomic UPDATE
# ---------------------------------------------------------------------------


def _run_resolve_update(env: dict[str, str]) -> int:
    """The single-statement, single-implicit-transaction UPDATE.

    Returns rows_updated. psql ON_ERROR_STOP=1 + Postgres's implicit
    txn-per-statement means: the UPDATE either lands wholly or rolls
    back wholly. No half-updated state is possible.
    """
    sql = (
        "WITH resolved AS ("
        "  UPDATE live.stations s "
        "     SET operator_id = a.operator_id, "
        "         updated_at  = now() "
        "    FROM live.operator_aliases a "
        "   WHERE s.operator_id IS NULL "
        "     AND a.alias_text = lower(btrim(s.nom_enseigne)) "
        "  RETURNING 1"
        ") "
        "SELECT count(*) FROM resolved"
    )
    return int(_psql(sql, env=env))


# ---------------------------------------------------------------------------
# Long-tail audit (per T08.2 hard expectation #4 → E23 forward-flag)
# ---------------------------------------------------------------------------


def _audit_long_tail(env: dict[str, str]) -> dict[str, int]:
    """Captures concrete volumes for the M1.5 prefix-rule prioritization
    argument. Run post-resolve; numbers go directly into E23 wording in
    the W4 closing bundle.
    """
    sql = (
        "SELECT "
        "  count(*) FILTER (WHERE lower(btrim(nom_enseigne)) LIKE 'réseau de recharge %')::text || '|' || "
        "  count(*) FILTER (WHERE lower(btrim(nom_enseigne)) LIKE 'allego - %')::text           || '|' || "
        "  count(*) FILTER (WHERE lower(btrim(nom_enseigne)) LIKE 'totalenergies - %')::text    || '|' || "
        "  count(*) FILTER (WHERE lower(btrim(nom_enseigne)) LIKE 'fastned %')::text            || '|' || "
        "  count(*)::text "
        "FROM live.stations "
        "WHERE operator_id IS NULL"
    )
    raw = _psql(sql, env=env).strip()
    parts = raw.split("|", 4)
    return {
        "reseau_de_recharge_null":  int(parts[0]),
        "allego_prefix":            int(parts[1]),
        "totalenergies_prefix":     int(parts[2]),
        "fastned_prefix":           int(parts[3]),
        "total_null_post_t08":      int(parts[4]),
    }


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------


def _print_report(
    *,
    pre: dict[str, object],
    post: dict[str, object],
    run_id: str,
    counters: dict[str, int],
    expected: int,
    forecast_top: list[tuple[str, str, int]],
    measured_top: list[tuple[str, str, int]],
    audit: dict[str, int],
    aliases_count: int,
    orphans_swept: int,
) -> None:
    pre_size = pre["db_size_pretty"]
    post_size = post["db_size_pretty"]
    print()
    print("─" * 78)
    print(f"T08.2 operator-resolver — run {run_id}")
    print("─" * 78)
    print()
    print("Pre-flight:")
    print(f"  live.operator_aliases:     {aliases_count}")
    print(f"  orphan rows swept:         {orphans_swept}")
    print()
    print(f"{'State':<32}{'Pre':>12}{'Post':>14}")
    print(f"  {'db_size':<30}{pre_size:>12}{post_size:>14}")
    print(f"  {'operator_id IS NULL':<30}{pre['stations_null']:>12d}{post['stations_null']:>14d}")
    print(f"  {'operator_id IS NOT NULL':<30}{pre['stations_not_null']:>12d}{post['stations_not_null']:>14d}")
    print()
    print("Counters (ingestion_runs):")
    for k in ("rows_seen", "rows_inserted", "rows_updated", "rows_skipped"):
        print(f"  {k:<14} {counters[k]:>10d}")
    print()
    expected_delta = expected - int(pre["stations_not_null"])
    bar_ok = "✓" if int(post["stations_not_null"]) == expected else "✗ DRIFT"
    delta_ok = "✓" if counters["rows_updated"] == expected_delta else "✗ DRIFT"
    print("Sanity checks:")
    print(f"  post.operator_id IS NOT NULL == expected ({expected}): {bar_ok}")
    print(f"  rows_updated == expected_delta ({expected_delta}):     {delta_ok}")
    print()
    print("Long-tail audit (E23 forward-flag, post-resolve):")
    print(f"  total stations operator_id NULL:        {audit['total_null_post_t08']}")
    print(f"    réseau de recharge <small-CPO>:       {audit['reseau_de_recharge_null']}")
    print(f"    allego site-suffix:                   {audit['allego_prefix']}")
    print(f"    totalenergies site-suffix:            {audit['totalenergies_prefix']}")
    print(f"    fastned site-suffix:                  {audit['fastned_prefix']}")
    print()
    print(f"Top {REPORT_TOP_N} operators by station count (forecast vs measured):")
    print(f"  {'slug':<22}{'display_name':<38}{'forecast':>10}{'measured':>10}  ✓")
    forecast_by_slug = {slug: (dn, n) for slug, dn, n in forecast_top}
    measured_by_slug = {slug: (dn, n) for slug, dn, n in measured_top}
    all_slugs_ordered = [s for s, _, _ in forecast_top] + [
        s for s, _, _ in measured_top if s not in {x for x, _, _ in forecast_top}
    ]
    for slug in all_slugs_ordered[:REPORT_TOP_N]:
        f_dn, f_n = forecast_by_slug.get(slug, ("?", 0))
        _m_dn, m_n = measured_by_slug.get(slug, (f_dn, 0))
        check = "✓" if f_n == m_n else "✗"
        display = (f_dn or "?")[:36]
        print(f"  {slug:<22}{display:<38}{f_n:>10d}{m_n:>10d}  {check}")
    print()


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------


def full_run() -> int:
    db_url = _read_required_env("SUPABASE_DB_URL")
    git_sha = _read_required_env("GIT_SHA")
    env = {"SUPABASE_DB_URL": db_url}

    aliases_count = _assert_aliases_seeded(env)
    orphans = _orphan_sweep(env)

    pre = _capture_state(env)
    expected = _compute_expected_resolved(env)
    forecast_top = _forecast_top_n_by_operator(env)

    run_id = _open_run_row(env, git_sha)
    print(f"# T08.2 run opened: {run_id}", file=sys.stderr)

    try:
        rows_updated = _run_resolve_update(env)
    except SystemExit as exc:
        # E15: separate post-rollback statement to mark the run failed.
        # The UPDATE's implicit txn is already rolled back by Postgres
        # at this point; only ingestion_runs needs explicit closure.
        _close_run_row_post_rollback(env, run_id, str(exc))
        raise

    rows_seen = pre["stations_null"]
    counters = {
        "rows_seen":     int(rows_seen),
        "rows_inserted": 0,
        "rows_updated":  int(rows_updated),
        "rows_skipped":  int(rows_seen) - int(rows_updated),
    }
    _close_run_row(env, run_id, status="success", counters=counters)

    post = _capture_state(env)
    measured_top = _measured_top_n_by_operator(env)
    audit = _audit_long_tail(env)

    _print_report(
        pre=pre,
        post=post,
        run_id=run_id,
        counters=counters,
        expected=expected,
        forecast_top=forecast_top,
        measured_top=measured_top,
        audit=audit,
        aliases_count=aliases_count,
        orphans_swept=orphans,
    )

    # Drift surfaces in stdout above. Don't fail the runner — data is
    # committed. Operator inspects the report and decides next steps.
    return 0


def main(argv: Iterable[str] | None = None) -> int:
    args = list(argv) if argv is not None else sys.argv[1:]
    if args and args[0] in {"-h", "--help"}:
        print(__doc__)
        return 0
    return full_run()


if __name__ == "__main__":
    sys.exit(main())
