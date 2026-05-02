-- Migration 0001 — Extensions and schemas
--
-- T04, M1 W2. First migration in the chain.
--
-- WHY HAND-ROLLED SQL (not Drizzle-Kit generated):
--   Drizzle has no first-class DSL for CREATE EXTENSION or CREATE SCHEMA.
--   These are PostgreSQL infrastructure DDL that lives outside ORM scope.
--   Drizzle TS schema files mirror the tables created by 0002+ but never
--   try to manage extensions or schemas themselves.
--
-- IDEMPOTENCY:
--   This migration must apply clean against (a) an empty Postgres database
--   AND (b) the prix-bornes Supabase project where W1 already enabled both
--   extensions and created the three schemas. IF NOT EXISTS guards make
--   both paths a no-op when the object already exists.
--
-- SCHEMA PURPOSE (per docs/02-architecture.md §2.5 + AGENTS.md hard rule #6):
--   live    — canonical user-facing data. ALL application tables live here.
--             This supersedes the plan's stale "live = public" comment.
--   staging — per-run scratch space for the IRVE diff-and-swap pipeline (T06).
--   archive — cold storage / Parquet exports for ≥12-month-old rows. The
--             active partitioned tariff_history (T05 / migration 0006) stays
--             on `live` because the read API hits it; only aged-out rows
--             are moved to `archive` later.
--   public  — RESERVED for PostGIS system tables (spatial_ref_sys,
--             geometry_columns, etc.) and Supabase-managed objects.
--             NEVER write application data here.

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS live;
CREATE SCHEMA IF NOT EXISTS staging;
CREATE SCHEMA IF NOT EXISTS archive;
