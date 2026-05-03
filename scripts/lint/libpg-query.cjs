#!/usr/bin/env node
// Pre-commit / CI gate that parses each given .sql file with libpg_query
// (via the pure-WASM pg-query-emscripten binding) and fails on any parse
// error. Catches the class of mistake sqlfluff misses — most notably the
// orphan IF/THEN/END IF outside DO $$ … $$ that twice surfaced as a chat-
// paste artifact in T04/T05 (see docs/migrations-errata.md E6).
//
// Usage: node scripts/lint/libpg-query.cjs <file1.sql> [file2.sql ...]
// Exit:  0 = all files parse; 1 = at least one parse error.

"use strict";

const fs = require("node:fs");
const path = require("node:path");

async function main() {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    process.stdout.write("libpg_query: no files passed, nothing to do\n");
    process.exit(0);
  }

  const factory = require("pg-query-emscripten");

  let failed = 0;
  for (const file of files) {
    // Re-instantiate the WASM module per file. The emscripten heap
    // accumulates internal state across parses and corrupts past a few
    // large migrations; a fresh module is the simplest correctness fix.
    const pg = await factory.default();
    const sql = fs.readFileSync(file, "utf8");
    const result = pg.parse(sql);

    if (result.error) {
      const cursor = result.error.cursorpos || 0;
      const { line, col } = locateCursor(sql, cursor);
      const rel = path.relative(process.cwd(), file);
      process.stderr.write(
        `✗ ${rel}:${line}:${col} ${result.error.message}\n`
      );
      const snippet = previewAt(sql, cursor);
      if (snippet) process.stderr.write(`  ${snippet}\n`);
      failed += 1;
    }
  }

  if (failed > 0) {
    process.stderr.write(
      `\nlibpg_query: ${failed} file(s) failed to parse.\n`
    );
    process.exit(1);
  }
  process.stdout.write(`libpg_query: ${files.length} file(s) parsed clean\n`);
}

function locateCursor(sql, cursor) {
  let line = 1;
  let col = 1;
  for (let i = 0; i < cursor && i < sql.length; i += 1) {
    if (sql.charCodeAt(i) === 10) {
      line += 1;
      col = 1;
    } else {
      col += 1;
    }
  }
  return { line, col };
}

function previewAt(sql, cursor) {
  const start = Math.max(0, cursor - 20);
  const end = Math.min(sql.length, cursor + 40);
  const slice = sql.slice(start, end).replace(/\s+/g, " ").trim();
  return slice ? `near: …${slice}…` : null;
}

main().catch((err) => {
  process.stderr.write(`libpg_query: internal error — ${err.message}\n`);
  process.exit(2);
});
