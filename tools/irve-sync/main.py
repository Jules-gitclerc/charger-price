#!/usr/bin/env python3
"""IRVE consolidated-CSV ingestion runner (T06a → T06b).

Two modes:

* ``--validate-fixture-only`` — offline. Reads
  ``tools/irve-sync/test/fixture-10rows.csv``, runs header validation +
  per-row pre-processor, prints a decision log, exits non-zero on a logic
  regression. NO network. NO DB.

* full run (default) — downloads the IRVE consolidated CSV from
  data.gouv.fr, SHA-aborts on no-change, opens a ``live.ingestion_runs``
  row, COPYs the transformed stream into ``staging.irve_raw`` via
  ``psql``, then calls ``live.run_irve_swap()`` to upsert into
  ``live.stations`` / ``live.charge_points``. The SQL function closes the
  run row internally on the success / partial path; on swap failure the
  runner issues a separate ``live.close_ingestion_run(..., 'failed', …)``
  call per the E15 post-rollback contract.

Env vars (full run only):

* ``SUPABASE_DB_URL``  Postgres URI for the prix-bornes project (direct,
  not the transaction pooler — COPY needs it).
* ``GIT_SHA``  workflow commit SHA (``${{ github.sha }}``); fail loud if
  missing.
* ``IRVE_RESOURCE_ID``  data.gouv.fr resource UUID. Defaults to the pin
  in ``DEFAULT_RESOURCE_ID`` below.
* ``DRY_RUN``  ``true``/``1``/``yes`` → telemetry-only invocation;
  download but skip TRUNCATE/COPY/swap/meta. Writes a short-lived
  ``success`` row and exits 0.

Operator-only CLI flag (full run only): ``--force-refresh`` clears
``staging.ingestion_run_meta`` for the IRVE slug before the SHA check,
forcing the runner to re-process. See ``full_run()``'s mode matrix for
interaction with ``DRY_RUN``.

The runner never logs ``SUPABASE_DB_URL``; subprocess errors strip it.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Iterable

# Postgres command tags that the supavisor session pooler returns on stdout
# alongside the actual result tuples (the direct connection suppresses these
# in -tA mode; the pooler does not). Surfaced in T06a step 3 first real run.
_PSQL_TAG_RE = re.compile(
    r"^(?:INSERT \d+ \d+|UPDATE \d+|DELETE \d+|SELECT \d+|MERGE \d+|"
    r"COPY \d+|TRUNCATE TABLE|BEGIN|COMMIT|ROLLBACK)$"
)

# ---------------------------------------------------------------------------
# Constants — must stay in sync with supabase/migrations/0011_staging_irve_raw.sql
# ---------------------------------------------------------------------------

DEFAULT_RESOURCE_ID = "eb76d20a-8501-400e-b336-d85724de5435"
DATA_GOUV_RESOURCE_URL = (
    "https://www.data.gouv.fr/api/1/datasets/r/{resource_id}"
)
SOURCE_SLUG = "irve_consolidated"
ORPHAN_TIMEOUT_SECONDS = 2 * 3600  # 2 hours, per T06a brief design call #5

# IRVE v2.3.0 spec columns (40) + data.gouv consolidation extras (12), in
# CSV header order. Authoritative copy lives in 0011_staging_irve_raw.sql.
SPEC_COLS: tuple[str, ...] = (
    "nom_amenageur", "siren_amenageur", "contact_amenageur", "nom_operateur",
    "contact_operateur", "telephone_operateur", "nom_enseigne",
    "id_station_itinerance", "id_station_local", "nom_station",
    "implantation_station", "adresse_station", "code_insee_commune",
    "coordonneesXY", "nbre_pdc", "id_pdc_itinerance", "id_pdc_local",
    "puissance_nominale", "prise_type_ef", "prise_type_2",
    "prise_type_combo_ccs", "prise_type_chademo", "prise_type_autre",
    "gratuit", "paiement_acte", "paiement_cb", "paiement_autre",
    "tarification", "condition_acces", "reservation", "horaires",
    "accessibilite_pmr", "restriction_gabarit", "station_deux_roues",
    "raccordement", "num_pdl", "date_mise_en_service", "observations",
    "date_maj", "cable_t2_attache",
)
CONSOLIDATION_COLS: tuple[str, ...] = (
    "last_modified", "datagouv_dataset_id", "datagouv_resource_id",
    "datagouv_organization_or_owner", "created_at", "consolidated_longitude",
    "consolidated_latitude", "consolidated_code_postal",
    "consolidated_commune", "consolidated_is_lon_lat_correct",
    "consolidated_is_code_insee_verified",
    "consolidated_is_code_insee_modified",
)
KNOWN_COLS: frozenset[str] = frozenset(SPEC_COLS) | frozenset(CONSOLIDATION_COLS)

# 7 IRVE-mandated keys per the spec. Header missing any = run fails.
REQUIRED_KEYS: tuple[str, ...] = (
    "id_station_itinerance", "id_pdc_itinerance", "coordonneesXY",
    "nom_enseigne", "nom_station", "nbre_pdc", "puissance_nominale",
)

FIXTURE_PATH = Path(__file__).resolve().parent / "test" / "fixture-10rows.csv"


# ---------------------------------------------------------------------------
# Header + row processing (shared by both modes)
# ---------------------------------------------------------------------------


def validate_header(actual: list[str]) -> dict:
    """Compare CSV header against the known-column set.

    Returns a dict with:
      missing_required:        list of REQUIRED_KEYS absent from the header
      missing_optional_spec:   list of SPEC_COLS - REQUIRED_KEYS absent from
                               the header (acceptable; COPY just omits them)
      missing_consolidation:   list of CONSOLIDATION_COLS absent from the
                               header (acceptable)
      unknown_columns:         list of header columns not in KNOWN_COLS
                               (drift bucket — captured into _extra_columns)
      fail:                    True iff missing_required is non-empty.
    """
    header_set = set(actual)
    missing_required = [c for c in REQUIRED_KEYS if c not in header_set]
    optional_spec = [c for c in SPEC_COLS if c not in REQUIRED_KEYS]
    missing_optional_spec = [c for c in optional_spec if c not in header_set]
    missing_consolidation = [
        c for c in CONSOLIDATION_COLS if c not in header_set
    ]
    unknown_columns = [c for c in actual if c not in KNOWN_COLS]
    return {
        "missing_required": missing_required,
        "missing_optional_spec": missing_optional_spec,
        "missing_consolidation": missing_consolidation,
        "unknown_columns": unknown_columns,
        "fail": bool(missing_required),
    }


def process_row(
    row: dict[str, str],
    unknown_columns: list[str],
) -> tuple[dict[str, str | None] | None, str]:
    """Pre-process one CSV row.

    Returns (transformed, decision):
      transformed: dict keyed by KNOWN_COLS plus '_extra_columns' (JSON-
                   stringified). None if the row is skipped.
      decision:    one-line human-readable reason for the log.
    """
    for key in REQUIRED_KEYS:
        value = (row.get(key) or "").strip()
        if not value:
            return None, (
                f"skip: required key {key!r} empty "
                f"(id_station_itinerance={row.get('id_station_itinerance')!r}, "
                f"id_pdc_itinerance={row.get('id_pdc_itinerance')!r})"
            )

    transformed: dict[str, str | None] = {}
    for col in SPEC_COLS:
        transformed[col] = row.get(col)
    for col in CONSOLIDATION_COLS:
        transformed[col] = row.get(col)

    extra: dict[str, str] = {}
    for col in unknown_columns:
        value = row.get(col)
        if value is not None and value != "":
            extra[col] = value
    transformed["_extra_columns"] = json.dumps(extra, ensure_ascii=False)

    note_parts: list[str] = []
    optional_empty = [
        c
        for c in (set(SPEC_COLS) - set(REQUIRED_KEYS))
        if (row.get(c) or "") == ""
    ]
    if optional_empty:
        note_parts.append(
            f"optional empty: {sorted(optional_empty)[:3]}"
            + ("…" if len(optional_empty) > 3 else "")
        )
    if extra:
        note_parts.append(f"_extra_columns={extra}")
    note = "; ".join(note_parts) if note_parts else "all known cols populated"
    return transformed, f"ok: {note}"


# ---------------------------------------------------------------------------
# Fixture mode
# ---------------------------------------------------------------------------


def validate_fixture(path: Path = FIXTURE_PATH) -> int:
    """Offline pre-processor smoke. NO network. NO DB.

    Returns process exit code.
    """
    if not path.exists():
        print(f"fixture not found: {path}", file=sys.stderr)
        return 1

    with path.open("r", encoding="utf-8", newline="") as fh:
        reader = csv.DictReader(fh)
        actual_header = list(reader.fieldnames or [])
        verdict = validate_header(actual_header)

        print(f"# fixture: {path.relative_to(Path.cwd())}")
        print(f"# header columns: {len(actual_header)}")
        if verdict["missing_required"]:
            print(
                f"# FAIL: missing required keys: {verdict['missing_required']}"
            )
            return 1
        if verdict["missing_optional_spec"]:
            print(
                "# warn: missing optional spec columns: "
                f"{verdict['missing_optional_spec']}"
            )
        if verdict["missing_consolidation"]:
            print(
                "# warn: missing consolidation columns: "
                f"{verdict['missing_consolidation']}"
            )
        if verdict["unknown_columns"]:
            print(
                f"# drift: unknown header columns: {verdict['unknown_columns']}"
            )

        rows_seen = 0
        rows_clean = 0
        rows_skipped = 0
        for idx, row in enumerate(reader, start=1):
            rows_seen += 1
            transformed, decision = process_row(row, verdict["unknown_columns"])
            if transformed is None:
                rows_skipped += 1
            else:
                rows_clean += 1
            print(f"row {idx:>2}: {decision}")

    print(
        f"\nrows_seen={rows_seen}, rows_clean={rows_clean}, "
        f"rows_skipped={rows_skipped}, "
        f"drift_columns_detected={verdict['unknown_columns']}"
    )

    if rows_seen == 0:
        print("FAIL: fixture has no data rows", file=sys.stderr)
        return 1
    return 0


# ---------------------------------------------------------------------------
# Full-run mode (NOT exercised in step 2; wired for step 3)
# ---------------------------------------------------------------------------


def _psql(sql: str, *, env: dict[str, str], capture: bool = True) -> str:
    """Run psql with the URL from the env. Never log the URL.

    Fails loud on non-zero exit (raises SystemExit). Default helper for
    every shellout that should abort the runner on SQL error.
    """
    db_url = env.get("SUPABASE_DB_URL")
    if not db_url:
        raise SystemExit("SUPABASE_DB_URL not set")
    cmd = [
        "psql", db_url,
        "-v", "ON_ERROR_STOP=1",
        "-tAc", sql,
    ]
    try:
        result = subprocess.run(
            cmd, check=True, capture_output=capture, text=True,
        )
    except subprocess.CalledProcessError as exc:
        # Strip the URL from any error message before re-raising.
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
    """Variant of `_psql` that returns the exit status instead of raising.

    Returned tuple is ``(returncode, stdout_stripped, stderr_redacted)``:

    * ``returncode``       — psql's exit code (0 on success).
    * ``stdout_stripped``  — stdout with empty lines and ``_PSQL_TAG_RE``
                             matches removed; same shape `_psql` produces
                             on success.
    * ``stderr_redacted``  — stderr with the SUPABASE_DB_URL replaced by a
                             placeholder, so callers can include it in
                             error messages safely.

    Use this **only** on paths that need to handle non-zero exit
    gracefully — primarily the `live.run_irve_swap` call, where a SQL
    failure must NOT abort the runner: per E15, the runner has to issue
    a separate post-rollback `live.close_ingestion_run(..., 'failed', …)`
    statement after the swap txn rolls back. Every other psql shellout
    in this file uses `_psql`, which fails loud.
    """
    db_url = env.get("SUPABASE_DB_URL")
    if not db_url:
        raise SystemExit("SUPABASE_DB_URL not set")
    cmd = [
        "psql", db_url,
        "-v", "ON_ERROR_STOP=1",
        "-tAc", sql,
    ]
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


def _status_from_swap_jsonb(payload: dict) -> str:
    """Compute the terminal status from a `live.run_irve_swap` jsonb return.

    Single source of truth for the success / partial trichotomy:

    * ``rows_skipped == 0`` → ``'success'``
    * ``rows_skipped > 0``  → ``'partial'``

    The third terminal value, ``'failed'``, is **never** returned by this
    helper. Failure means the swap raised before any jsonb existed; the
    failure path in `full_run()` writes the literal ``'failed'`` directly
    when issuing the post-rollback `close_ingestion_run` call (E15).

    Raises ``KeyError`` if ``rows_skipped`` is absent: the jsonb shape is
    a documented SQL contract (see `live.run_irve_swap`'s comment in
    0012_irve_swap_functions.sql) and a missing key signals a contract
    violation worth surfacing loudly, not silently defaulting.
    """
    rows_skipped = payload["rows_skipped"]
    return "partial" if rows_skipped > 0 else "success"


def _read_required_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise SystemExit(
            f"{name} not set. Required in full-run mode "
            f"(use --validate-fixture-only for offline checks)."
        )
    return value


def _stream_download_with_sha(url: str) -> tuple[bytes, str]:
    """Download via requests (streaming) and compute SHA256 in-stream."""
    import requests  # imported lazily so fixture mode doesn't need it

    digest = hashlib.sha256()
    chunks: list[bytes] = []
    with requests.get(url, stream=True, timeout=300) as response:
        response.raise_for_status()
        for chunk in response.iter_content(chunk_size=1024 * 1024):
            if chunk:
                digest.update(chunk)
                chunks.append(chunk)
    return b"".join(chunks), digest.hexdigest()


def _orphan_sweep(env: dict[str, str]) -> int:
    """Mark stuck status='running' rows older than ORPHAN_TIMEOUT_SECONDS as
    failed. Returns the number of rows transitioned."""
    sql = (
        "UPDATE live.ingestion_runs "
        "SET status='failed', "
        "    finished_at=now(), "
        "    error_message=COALESCE(error_message,'') || "
        "      ' superseded by newer run; runner timed out' "
        "WHERE source_id = (SELECT id FROM live.sources WHERE slug = "
        f"'{SOURCE_SLUG}') "
        "  AND status='running' "
        f"  AND started_at < now() - interval '{ORPHAN_TIMEOUT_SECONDS} seconds' "
        "RETURNING id"
    )
    result = _psql(sql, env=env)
    return len([line for line in result.splitlines() if line.strip()])


def _last_sha(env: dict[str, str]) -> str | None:
    sql = (
        "SELECT last_sha FROM staging.ingestion_run_meta "
        f"WHERE slug = '{SOURCE_SLUG}'"
    )
    result = _psql(sql, env=env)
    return result or None


def _open_run_row(env: dict[str, str], git_sha: str) -> str:
    """INSERT a new ingestion_runs row in status='running'. Returns its uuid."""
    sql = (
        "INSERT INTO live.ingestion_runs (source_id, status, git_sha) "
        "SELECT id, 'running', "
        + _quote_sql_literal(git_sha)
        + " FROM live.sources WHERE slug = '"
        + SOURCE_SLUG
        + "' RETURNING id"
    )
    return _psql(sql, env=env)


def _short_lived_success_row(
    env: dict[str, str],
    git_sha: str,
    error_message: str,
) -> str:
    """SHA-abort path: insert a status='success' run row in one shot."""
    sql = (
        "INSERT INTO live.ingestion_runs "
        "(source_id, status, started_at, finished_at, git_sha, error_message) "
        "SELECT id, 'success', now(), now(), "
        + _quote_sql_literal(git_sha)
        + ", "
        + _quote_sql_literal(error_message)
        + " FROM live.sources WHERE slug = '"
        + SOURCE_SLUG
        + "' RETURNING id"
    )
    return _psql(sql, env=env)


def _quote_sql_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def _truncate_staging(env: dict[str, str]) -> None:
    _psql("TRUNCATE staging.irve_raw", env=env)


def _copy_into_staging(
    csv_bytes: bytes,
    *,
    env: dict[str, str],
    run_id: str,
) -> tuple[int, int, list[str]]:
    """Pre-process the CSV and pipe a transformed stream to psql \\copy.

    Returns (rows_seen, rows_skipped, unknown_columns).
    """
    db_url = env["SUPABASE_DB_URL"]
    text = csv_bytes.decode("utf-8", errors="replace")
    reader = csv.DictReader(io.StringIO(text))
    actual_header = list(reader.fieldnames or [])
    verdict = validate_header(actual_header)
    if verdict["fail"]:
        raise SystemExit(
            f"required keys missing from upstream header: "
            f"{verdict['missing_required']}"
        )

    # Build the transformed CSV stream. Column order mirrors staging.irve_raw.
    output_cols = list(SPEC_COLS) + list(CONSOLIDATION_COLS) + [
        "_extra_columns", "_raw_line", "_ingestion_run_id",
    ]
    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=output_cols)
    writer.writeheader()

    rows_seen = 0
    rows_skipped = 0
    raw_lines = text.splitlines()[1:]  # skip header for forensics alignment
    for idx, row in enumerate(reader):
        rows_seen += 1
        try:
            transformed, _ = process_row(row, verdict["unknown_columns"])
            if transformed is None:
                rows_skipped += 1
                continue
            transformed["_raw_line"] = (
                raw_lines[idx] if idx < len(raw_lines) else ""
            )
            transformed["_ingestion_run_id"] = run_id
            writer.writerow(transformed)
        except (csv.Error, UnicodeDecodeError, ValueError) as exc:
            # Per-row safety net: never let one bad row abort the COPY.
            rows_skipped += 1
            print(
                f"warn: row {idx + 1} skipped at runtime: {exc}",
                file=sys.stderr,
            )

    copy_sql = (
        "\\copy staging.irve_raw ("
        + ", ".join(f'"{c}"' if c == "coordonneesXY" else c for c in output_cols)
        + ") FROM STDIN WITH (FORMAT csv, HEADER true, NULL '')"
    )
    proc = subprocess.run(
        ["psql", db_url, "-v", "ON_ERROR_STOP=1", "-c", copy_sql],
        input=buffer.getvalue(),
        text=True,
        capture_output=True,
    )
    if proc.returncode != 0:
        stderr = (proc.stderr or "").replace(db_url, "[SUPABASE_DB_URL]")
        raise SystemExit(f"\\copy failed: {stderr}")

    return rows_seen, rows_skipped, verdict["unknown_columns"]


def _upsert_meta(env: dict[str, str], sha: str) -> None:
    sql = (
        "INSERT INTO staging.ingestion_run_meta (slug, last_sha, last_run_at) "
        f"VALUES ('{SOURCE_SLUG}', "
        + _quote_sql_literal(sha)
        + ", now()) "
        "ON CONFLICT (slug) DO UPDATE SET "
        "last_sha = EXCLUDED.last_sha, last_run_at = EXCLUDED.last_run_at"
    )
    _psql(sql, env=env)


def full_run(force_refresh: bool = False) -> int:
    """Download → SHA-abort or stage → swap into live → terminal status.

    On the load path: open ingestion_runs row at status='running',
    TRUNCATE+COPY into staging.irve_raw, call live.run_irve_swap which
    upserts into live.stations / live.charge_points and closes the run
    row internally to 'success' or 'partial' per
    `_status_from_swap_jsonb`. On swap failure the txn rolls back and
    the runner issues a separate close_ingestion_run(..., 'failed', …)
    per E15.

    The SHA-abort path inserts a fully-closed status='success' row in
    one shot.

    `staging.ingestion_run_meta` is only advanced after a successful
    swap+close, so a failed run leaves the SHA cache untouched and the
    next workflow run retries naturally without --force-refresh.

    Mode matrix (force_refresh, DRY_RUN env):

    * (F, F) — vanilla. SHA-abort if cache matches; else swap+close.
    * (T, F) — force-refresh. DELETE staging.ingestion_run_meta cache
              before SHA check, so the run always proceeds to swap.
              Used to re-test the pipeline against staging that's
              already up-to-date.
    * (F, T) — dry-run. orphan sweep + download + telemetry-only
              `success` row. No staging write, no SHA check, no swap.
    * (T, T) — contradictory. dry-run early-exits before the
              force-refresh DELETE, so the cache is **NOT** cleared.
              Operators wanting "clear then telemetry" should run two
              invocations: --force-refresh once non-dry to clear+
              process, then DRY_RUN once non-force-refresh.
    """
    env = {k: v for k, v in os.environ.items() if v is not None}
    git_sha = _read_required_env("GIT_SHA")
    _read_required_env("SUPABASE_DB_URL")
    resource_id = os.environ.get("IRVE_RESOURCE_ID") or DEFAULT_RESOURCE_ID
    url = DATA_GOUV_RESOURCE_URL.format(resource_id=resource_id)
    dry_run = os.environ.get("DRY_RUN", "").lower() in ("true", "1", "yes")

    print(
        f"# IRVE sync starting (resource={resource_id}, "
        f"git_sha={git_sha[:12]}…, dry_run={dry_run})"
    )

    swept = _orphan_sweep(env)
    if swept:
        print(f"# orphan sweep: {swept} stuck row(s) transitioned to failed")

    t0 = time.monotonic()
    csv_bytes, sha = _stream_download_with_sha(url)
    t_download = time.monotonic() - t0
    print(
        f"# download: {len(csv_bytes) / (1024 * 1024):.1f} MiB, "
        f"sha={sha[:12]}…, took {t_download:.1f}s"
    )

    if dry_run:
        run_id = _short_lived_success_row(
            env, git_sha,
            f"dry_run: telemetry-only invocation; downloaded "
            f"{len(csv_bytes) / (1024 * 1024):.1f} MiB, sha={sha[:12]}…; "
            f"no staging write",
        )
        print(
            f"# DRY-RUN: skipped TRUNCATE/COPY/meta-upsert; "
            f"ingestion_runs.id={run_id}, status=success"
        )
        return 0

    if force_refresh:
        print(
            f"# --force-refresh: clearing SHA cache for slug "
            f"{SOURCE_SLUG}"
        )
        _psql(
            "DELETE FROM staging.ingestion_run_meta WHERE slug = "
            + _quote_sql_literal(SOURCE_SLUG),
            env=env,
        )

    previous_sha = _last_sha(env)
    if previous_sha == sha:
        run_id = _short_lived_success_row(
            env, git_sha,
            "no-change abort: SHA matches previous run",
        )
        print(
            f"# SHA-abort: identical to previous run; "
            f"ingestion_runs.id={run_id}, status=success"
        )
        return 0

    t1 = time.monotonic()
    run_id = _open_run_row(env, git_sha)
    print(f"# opened ingestion_runs.id={run_id}, status=running")

    _truncate_staging(env)
    t_truncate = time.monotonic() - t1

    t2 = time.monotonic()
    rows_seen, rows_skipped, unknown_cols = _copy_into_staging(
        csv_bytes, env=env, run_id=run_id,
    )
    t_copy = time.monotonic() - t2
    print(
        f"# copy: rows_seen={rows_seen}, rows_skipped={rows_skipped}, "
        f"unknown_columns={unknown_cols}, took {t_copy:.1f}s"
    )

    # ─── swap into live ──────────────────────────────────────────────
    # live.run_irve_swap closes the ingestion_runs row internally on
    # success/partial via PERFORM live.close_ingestion_run(...). Do NOT
    # issue a redundant close from here on the success path — would
    # double-write finished_at and contradict the SQL design (see
    # 0012_irve_swap_functions.sql:449 and the close_ingestion_run
    # COMMENT on lines 144-145). On failure (psql returncode != 0) the
    # swap txn has already rolled back, so the runner MUST issue a
    # separate close_ingestion_run with status='failed' as a
    # post-rollback statement (E15 forward practice).
    # _upsert_meta runs only after a successful swap+close, so a failed
    # swap leaves the SHA cache at the previous value and the next
    # workflow run retries naturally.
    t3 = time.monotonic()
    swap_rc, swap_stdout, swap_stderr = _psql_no_raise(
        f"SELECT live.run_irve_swap('{run_id}'::uuid)",
        env=env,
    )
    t_swap = time.monotonic() - t3

    if swap_rc != 0:
        error_message = (
            swap_stderr.strip() or f"run_irve_swap exited {swap_rc}"
        )[:500]
        # E15: separate post-rollback statement; NOT in the swap's txn.
        _psql(
            "SELECT live.close_ingestion_run("
            f"'{run_id}'::uuid, 'failed', '{{}}'::jsonb, "
            + _quote_sql_literal(error_message)
            + ")",
            env=env,
        )
        print(
            f"# swap FAILED: ingestion_runs.id={run_id} closed to "
            f"status=failed; took {t_swap:.1f}s; "
            f"error={error_message}",
            file=sys.stderr,
        )
        raise SystemExit(1)

    swap_payload = json.loads(swap_stdout)
    expected_status = _status_from_swap_jsonb(swap_payload)
    sql_status = swap_payload.get("status")
    if sql_status != expected_status:
        # SQL is authoritative (it did the actual close); local helper is
        # a sanity check. Disagreement is a contract violation worth
        # flagging without failing the run.
        print(
            f"# WARN: status drift — sql={sql_status!r} "
            f"local={expected_status!r}. SQL is authoritative; flagging "
            f"for future investigation.",
            file=sys.stderr,
        )

    _upsert_meta(env, sha)

    print(
        f"# swap: status={sql_status} "
        f"rows_seen={swap_payload['rows_seen']} "
        f"rows_inserted={swap_payload['rows_inserted']} "
        f"rows_updated={swap_payload['rows_updated']} "
        f"rows_skipped={swap_payload['rows_skipped']}"
    )
    print(
        f"# stations: inserted={swap_payload['stations_inserted']} "
        f"updated={swap_payload['stations_updated']} "
        f"skipped={swap_payload['stations_skipped']}"
    )
    print(
        f"# meta: staging.ingestion_run_meta upserted with sha={sha[:12]}…"
    )
    print(
        f"# T06b complete; ingestion_runs.id={run_id} closed by SQL "
        f"to status={sql_status}."
    )
    print(
        f"# wall-clock: download={t_download:.1f}s, "
        f"truncate={t_truncate:.1f}s, copy={t_copy:.1f}s, "
        f"swap+close={t_swap:.1f}s "
        f"(sql_internal_duration_ms={swap_payload['duration_ms']})"
    )
    return 0


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "T06a/T06b IRVE consolidated-CSV runner. "
            "Use --validate-fixture-only for offline CI smoke."
        ),
    )
    parser.add_argument(
        "--validate-fixture-only",
        action="store_true",
        help="Run header validation + per-row pre-processor against the "
             "checked-in fixture. NO network, NO DB. Exit non-zero on "
             "logic regressions.",
    )
    parser.add_argument(
        "--force-refresh",
        action="store_true",
        help="Clear staging.ingestion_run_meta for the IRVE slug before "
             "the SHA check, forcing the runner to re-process even when "
             "the upstream blob is unchanged. Operator-only escape hatch "
             "for re-testing the pipeline against already-current "
             "staging. No-op when combined with DRY_RUN env var (dry-run "
             "early-exits before the cache DELETE — see full_run() "
             "docstring's mode matrix).",
    )
    args = parser.parse_args(argv)

    if args.validate_fixture_only:
        return validate_fixture()
    return full_run(force_refresh=args.force_refresh)


if __name__ == "__main__":
    raise SystemExit(main())
