#!/usr/bin/env python3
"""tools/load-tarification-from-cache/main.py — T13.0.5

M1 WORKAROUND for E21 free-tier disk pressure.

This runner loads live.stations.tarification directly from the local IRVE CSV
cache (.cache/irve.csv), bypassing the staging.irve_raw swap pipeline that
hits FileFallocate disk-full failures on Supabase free-tier and Pro-tier
projects with insufficient disk allocation.

The canonical T13.0 path is live.copy_tarification_from_staging() called by
tools/irve-sync/main.py between run_irve_swap() and TRUNCATE staging. That
path is preserved unchanged. This loader is a parallel temporary path
maintained until disk pressure resolves.

M1.5 REMOVAL TRIGGERS (any one):
  - Supabase Pro tier disk allocation verified at 8 GB and IRVE sync
    succeeds without FileFallocate
  - Chunked-swap refactor of run_irve_swap() landed
  - Migration to a non-free-tier hosted Postgres

Until then: this runner is the sole writer of live.stations.tarification.
Operator triggers manually before each parser orchestrator run (T13.2).

USAGE (M1):
  1. Ensure .cache/irve.csv exists (run tools/irve-sync if not, accepting it
     will fail at swap stage but still leaves the CSV cached).
  2. Run this loader:
       python3 tools/load-tarification-from-cache/main.py
  3. Verify:
       SELECT count(*) FROM live.stations
        WHERE tarification IS NOT NULL AND btrim(tarification) != '';
       -- expect ≈ 14,151
  4. Run T13.2 parser orchestrator (tools/run-parsers/main.ts).

This loader replaces the swap → copy_tarification_from_staging() → truncate
sequence of tools/irve-sync until E21 disk pressure resolves. The IRVE sync
runner is NOT modified — its swap path remains in code, dormant.

ENV REQUIREMENTS:
  SUPABASE_DB_URL  Postgres URI for the prix-bornes project
  GIT_SHA          (optional) git commit for ingestion_runs.git_sha audit

DESIGN NOTES:
  - Self-contained: no imports from tools/irve-sync. Helpers (_psql,
    _quote_sql_literal, PSQL_TAG_RE) are copy-pasted to make M1.5 removal
    a clean file-delete with no orphan references.
  - Canonical-row strategy: dict-based dedupe keyed by id_station_itinerance,
    keeping max(date_maj) per station. Replicates exactly the
    `DISTINCT ON (id_station_itinerance) ORDER BY date_maj DESC NULLS LAST`
    semantic of live.copy_tarification_from_staging().
  - E17 format gate: id_station_itinerance must match `^FR[A-Z0-9]`,
    same regex as the SQL function. Filters sentinel placeholders.
  - SQL injection defense: all string fields go through _quote_sql_literal
    (T07 BAN runner pattern). Tarification text contains apostrophes,
    accents, JSON-like braces, multi-clause separators, etc.
  - Chunked UPDATE via WITH-CTE for affected-row count capture without
    the PSQL_TAG_RE filter stripping it (E12/E13 pooler tag leakage).
  - Pre-run + every-5-chunks disk-audit gate at 340 MB threshold (T07
    pattern). Aborts cleanly with terminal close if exceeded.
  - E15 atomicity contract: caller-controlled chunk transactions (psql
    auto-commit per statement); single ingestion_runs row tracks the
    cumulative work. On failure, post-rollback issues UPDATE to close
    run as 'failed' with diagnostic.
"""

import argparse
import csv
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Dict, List, Optional, Tuple

# ─── Constants ────────────────────────────────────────────────────────

CSV_PATH = Path('.cache/irve.csv')
CHUNK_SIZE = 5_000
DISK_GATE_BYTES = 340 * 1024 * 1024  # 340 MB threshold
DISK_GATE_INTERVAL_CHUNKS = 5
SOURCE_SLUG = 'tarification_loader_local'
RUNNER_VERSION = 'tarification-loader-v1'

# E12/E13 PSQL_TAG_RE filter — strips command tags from Supavisor pooler
# stdout (which leaks INSERT 0 N / UPDATE N / etc. on -tA mode).
PSQL_TAG_RE = re.compile(
    r'^(?:INSERT \d+ \d+|UPDATE \d+|DELETE \d+|SELECT \d+|MERGE \d+|'
    r'COPY \d+|TRUNCATE TABLE|BEGIN|COMMIT|ROLLBACK)$',
    re.MULTILINE,
)

# E17 format gate — same as live.copy_tarification_from_staging()
ID_FORMAT_REGEX = re.compile(r'^FR[A-Z0-9]')

# Source-row description — mirrors migration COMMENT for audit trail.
SOURCE_ROW_DESCRIPTION = (
    'M1 workaround for E21 free-tier disk pressure: loads '
    'live.stations.tarification directly from .cache/irve.csv bypassing '
    'staging.irve_raw swap. Uses same canonical-row strategy as '
    'live.copy_tarification_from_staging() (DISTINCT ON id_station_itinerance '
    'ORDER BY date_maj DESC NULLS LAST). M1.5 cleanup: remove this loader '
    'once disk pressure resolved (Pro tier upgrade or chunked-swap refactor); '
    'resume copy_tarification_from_staging() in irve-sync runner.'
)

# ─── Helpers (self-contained; no imports from tools/irve-sync) ────────

def _quote_sql_literal(s: str) -> str:
    """Escape a string for SQL literal: double single quotes, wrap in quotes.

    Defensive pattern from T07 BAN runner. Tarification text is operator-
    published data containing apostrophes, accents, JSON-like braces,
    multi-clause separators, etc. All string interpolations into VALUES
    clauses MUST go through this.
    """
    return "'" + s.replace("'", "''") + "'"


def _psql(sql: str, *, env: dict, capture: bool = True) -> str:
    """Shellout to psql via stdin (avoids ARG_MAX for large VALUES lists).

    Returns filtered stdout (E12/E13 PSQL_TAG_RE applied). Raises
    RuntimeError on non-zero exit, with SUPABASE_DB_URL redacted from
    stderr for safe logging.
    """
    db_url = env.get('SUPABASE_DB_URL')
    if not db_url:
        raise SystemExit('SUPABASE_DB_URL not set')
    try:
        r = subprocess.run(
            ['psql', db_url, '-tA', '-v', 'ON_ERROR_STOP=1'],
            input=sql,
            capture_output=capture,
            env=env,
            text=True,
            check=True,
        )
        if capture:
            return PSQL_TAG_RE.sub('', r.stdout).strip('\n')
        return ''
    except subprocess.CalledProcessError as exc:
        stderr = (exc.stderr or '').replace(db_url, '[SUPABASE_DB_URL]')
        raise RuntimeError(f'psql failed (rc={exc.returncode}): {stderr}') from exc


def _get_db_size_bytes(env: dict) -> int:
    out = _psql('SELECT pg_database_size(current_database());', env=env)
    return int(out.strip())


def _disk_audit_gate(env: dict, label: str) -> None:
    bytes_used = _get_db_size_bytes(env)
    mb = bytes_used / 1024 / 1024
    print(f'# disk audit ({label}): {mb:.1f} MB')
    if bytes_used > DISK_GATE_BYTES:
        raise RuntimeError(
            f'disk audit failed: {mb:.1f} MB > '
            f'{DISK_GATE_BYTES // 1024 // 1024} MB threshold ({label})'
        )


# ─── Source row + ingestion_runs lifecycle ────────────────────────────

def _ensure_source_row(env: dict) -> None:
    """Runtime INSERT ON CONFLICT for tarification_loader_local source.

    Idempotent. Lives in code (not migration) to keep the workaround
    path self-contained and removable without a follow-up migration.
    """
    sql = (
        'INSERT INTO live.sources (slug, kind, priority, display_name, description) '
        'VALUES ('
        f"{_quote_sql_literal(SOURCE_SLUG)}, "
        f"{_quote_sql_literal('dataset')}, "
        '105, '
        f"{_quote_sql_literal('Local tarification loader (E21 workaround)')}, "
        f'{_quote_sql_literal(SOURCE_ROW_DESCRIPTION)}'
        ') ON CONFLICT (slug) DO NOTHING;'
    )
    _psql(sql, env=env, capture=False)


def _open_run(env: dict) -> str:
    """Open ingestion_runs row, return run id (uuid string)."""
    git_sha = env.get('GIT_SHA', 'unknown')
    sql = (
        'INSERT INTO live.ingestion_runs (source_id, status, started_at, git_sha) '
        'VALUES ('
        f"(SELECT id FROM live.sources WHERE slug={_quote_sql_literal(SOURCE_SLUG)}), "
        f"{_quote_sql_literal('running')}, "
        'now(), '
        f'{_quote_sql_literal(git_sha)}'
        ') RETURNING id;'
    )
    return _psql(sql, env=env).strip()


def _close_run(
    env: dict,
    run_id: str,
    status: str,
    counters: Dict[str, int],
    error_message: Optional[str] = None,
) -> None:
    """Terminal close of ingestion_runs row (E15 contract)."""
    parts = [
        f'status={_quote_sql_literal(status)}',
        'finished_at=now()',
        f"rows_seen={counters['rows_seen']}",
        f"rows_updated={counters['rows_updated']}",
        f"rows_skipped={counters['rows_skipped']}",
    ]
    if error_message is not None:
        # Truncate to fit reasonable column width; full diagnostic remains in
        # stderr.
        parts.append(f'error_message={_quote_sql_literal(error_message[:5000])}')
    set_clause = ', '.join(parts)
    sql = (
        f'UPDATE live.ingestion_runs SET {set_clause} '
        f'WHERE id={_quote_sql_literal(run_id)};'
    )
    _psql(sql, env=env, capture=False)


# ─── CSV loading + canonical-row dedupe ───────────────────────────────

def _load_csv_into_dedupe_dict(
    csv_path: Path,
) -> Tuple[Dict[str, Tuple[str, Optional[str]]], int, int, int]:
    """Stream-read CSV, apply E17 format gate + content filter +
    canonical-row dedupe.

    Returns: (dedupe_dict, filtered_count, dedup_collapsed_count, csv_row_count)

    Canonical-row strategy: for each id_station_itinerance, keep the row with
    max(date_maj). Empty/None date_maj sorts as NULLS LAST. This replicates
    exactly the `DISTINCT ON (id_station_itinerance) ORDER BY date_maj DESC
    NULLS LAST` semantic of live.copy_tarification_from_staging().

    NULLS LAST in this context means: a row with non-null date_maj wins over
    a row with null date_maj for the same station; among non-null, the
    lexically-greater date string wins (ISO8601 sorts correctly lexically).
    """
    csv.field_size_limit(sys.maxsize)

    dedupe: Dict[str, Tuple[str, Optional[str]]] = {}
    csv_row_count = 0
    filtered_count = 0
    dedup_collapsed_count = 0

    with open(csv_path, encoding='utf-8') as f:
        rd = csv.DictReader(f)
        for row in rd:
            csv_row_count += 1
            sid = (row.get('id_station_itinerance') or '').strip()
            tarif_raw = row.get('tarification') or ''
            date_maj_raw = (row.get('date_maj') or '').strip()
            date_maj: Optional[str] = date_maj_raw if date_maj_raw else None

            # Filter: empty/whitespace tarif
            if not tarif_raw or not tarif_raw.strip():
                filtered_count += 1
                continue
            # Filter: E17 format gate
            if not ID_FORMAT_REGEX.match(sid):
                filtered_count += 1
                continue

            existing = dedupe.get(sid)
            if existing is None:
                dedupe[sid] = (tarif_raw, date_maj)
                continue

            # Collision — apply NULLS LAST max(date_maj) selection
            dedup_collapsed_count += 1
            _, existing_date = existing
            if date_maj is None and existing_date is None:
                # Both null; keep first (arbitrary; insertion order)
                pass
            elif date_maj is None:
                # Incoming null, existing non-null: existing wins (NULLS LAST)
                pass
            elif existing_date is None:
                # Incoming non-null, existing null: incoming wins (NULLS LAST)
                dedupe[sid] = (tarif_raw, date_maj)
            elif date_maj > existing_date:
                # Both non-null, incoming has lexically-greater date
                dedupe[sid] = (tarif_raw, date_maj)
            # else: existing wins

    return dedupe, filtered_count, dedup_collapsed_count, csv_row_count


# ─── Chunked UPDATE ───────────────────────────────────────────────────

def _build_chunk_sql(chunk: List[Tuple[str, str]]) -> str:
    """Build UPDATE-via-VALUES SQL with affected-row count capture.

    Wrapped in WITH-CTE so the affected-row count is returned via SELECT
    count(*) (single-line numeric stdout); avoids E12/E13 PSQL_TAG_RE
    filter stripping the UPDATE n command tag.

    All string fields (id_station_itinerance, tarification) are escaped
    via _quote_sql_literal — defensive against operator-published data
    containing apostrophes, JSON, accents, multi-clause separators.
    """
    values_parts = []
    for sid, tarif in chunk:
        values_parts.append(
            f'({_quote_sql_literal(sid)}, {_quote_sql_literal(tarif)})'
        )
    values_clause = ',\n  '.join(values_parts)
    return (
        'WITH upd AS (\n'
        '  UPDATE live.stations s\n'
        '    SET tarification = v.tarification\n'
        '    FROM (VALUES\n'
        f'  {values_clause}\n'
        '    ) v(id_station_itinerance, tarification)\n'
        '    WHERE s.id_station_itinerance = v.id_station_itinerance\n'
        '    RETURNING 1\n'
        ')\n'
        'SELECT count(*) FROM upd;\n'
    )


# ─── Main ─────────────────────────────────────────────────────────────

def main() -> int:
    parser = argparse.ArgumentParser(
        description='M1 workaround loader for live.stations.tarification (E21).',
    )
    parser.add_argument(
        '--csv',
        default=str(CSV_PATH),
        help=f'CSV path (default: {CSV_PATH}).',
    )
    parser.add_argument(
        '--dry-run',
        action='store_true',
        help='Read + dedupe + print forecast counts. NO DB writes.',
    )
    args = parser.parse_args()

    env = os.environ.copy()
    if not env.get('SUPABASE_DB_URL'):
        print('FATAL: SUPABASE_DB_URL not set in env', file=sys.stderr)
        return 2

    csv_path = Path(args.csv)
    if not csv_path.exists():
        print(
            f'FATAL: {csv_path} does not exist. Run tools/irve-sync first to '
            f'populate the cache (it will fail at swap stage on free tier but '
            f'leaves the CSV downloaded).',
            file=sys.stderr,
        )
        return 2

    print(
        f'# tarification loader starting (csv={csv_path}, '
        f'runner_version={RUNNER_VERSION}, dry_run={args.dry_run})'
    )

    if not args.dry_run:
        _disk_audit_gate(env, 'pre-run')
        _ensure_source_row(env)

    print('# reading + deduping CSV...')
    dedupe, filtered_count, dedup_collapsed_count, csv_row_count = (
        _load_csv_into_dedupe_dict(csv_path)
    )
    canonical_stations = len(dedupe)
    print(f'# rows_seen={csv_row_count} (total CSV rows)')
    print(f'# filtered={filtered_count} (empty/null tarif + ID format-gate)')
    print(
        f'# dedup_collapsed={dedup_collapsed_count} '
        f'(PDC-grain rows merging to same station)'
    )
    print(
        f'# canonical_stations={canonical_stations} '
        f'(post-dedupe station-grain — pre-DB-existence)'
    )

    if args.dry_run:
        print('# DRY-RUN: skipped DB open + chunk UPDATE + run close.')
        return 0

    run_id = _open_run(env)
    print(f'# opened ingestion_runs.id={run_id}, status=running')

    items: List[Tuple[str, Tuple[str, Optional[str]]]] = list(dedupe.items())
    cumulative_affected = 0
    chunks_done = 0
    counters = {
        'rows_seen': csv_row_count,
        'rows_updated': 0,
        'rows_skipped': filtered_count + dedup_collapsed_count,
    }

    try:
        for i in range(0, len(items), CHUNK_SIZE):
            chunk_items = items[i : i + CHUNK_SIZE]
            chunk = [(sid, tarif) for sid, (tarif, _) in chunk_items]
            sql = _build_chunk_sql(chunk)
            count_str = _psql(sql, env=env)
            chunk_affected = int(count_str.strip())
            cumulative_affected += chunk_affected
            chunks_done += 1
            counters['rows_updated'] = cumulative_affected
            print(
                f'# chunk {chunks_done}: '
                f'attempted={len(chunk)} affected={chunk_affected} '
                f'cumulative={cumulative_affected}'
            )
            if chunks_done % DISK_GATE_INTERVAL_CHUNKS == 0:
                _disk_audit_gate(env, f'post-chunk-{chunks_done}')

        _disk_audit_gate(env, 'post-run')

        _close_run(env, run_id, 'success', counters)
        print(
            f'# rows_updated={cumulative_affected} '
            f"(UPDATEs that touched a live.stations row)"
        )
        print(f"# rows_skipped={counters['rows_skipped']}")
        print(
            f'# canonical_minus_updated={canonical_stations - cumulative_affected} '
            f'(canonical CSV stations not present in live.stations)'
        )
        print(f'# ingestion_runs.id={run_id} closed status=success')
        return 0

    except Exception as exc:
        try:
            _close_run(env, run_id, 'failed', counters, error_message=str(exc))
            print(
                f'# ingestion_runs.id={run_id} closed status=failed',
                file=sys.stderr,
            )
        except Exception as close_exc:
            print(
                f'# WARN: failed to close ingestion_runs row: {close_exc}',
                file=sys.stderr,
            )
        print(f'FATAL: {exc}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
