# Contributing to Prix-Bornes

Thanks for the interest. The project is in early M1 — there's no public UI yet, but the data pipeline is being built up. Here's how to help.

## Quick orientation

Read these in order before touching code:
1. [`docs/01-discovery.md`](docs/01-discovery.md) — data landscape (IRVE schema, OCPI reference, the 76 % empty-tariff reality)
2. [`docs/02-architecture.md`](docs/02-architecture.md) — system design (4 layers, confidence tiers, M1/M1.5/M2/M3 roadmap)
3. [`docs/03-implementation-plan.md`](docs/03-implementation-plan.md) — concrete W1–W5 task list

## Things we'd love help with

### Parser fixtures (high impact, low barrier)

The IRVE `tarification` field is free text from many operators. We have parsers for DRIVECO's JSON-in-a-text-field format, the CITEOS templated format, and a generic €/kWh regex (see [`docs/03-implementation-plan.md` §5](docs/03-implementation-plan.md)). The long tail breaks them.

If you spot a `tarification` value that should parse but doesn't (or worse, parses wrong), open an issue with:
- The verbatim raw value
- The `id_pdc_itinerance` it came from (so we can reproduce)
- What you'd expect the parsed output to be

We turn good submissions into permanent test fixtures under `tests/fixtures/parsers/`.

### Operator data corrections

If you're a network operator and a price we display is wrong → comment on issue #1 (a dedicated `corrections@` mailbox lands pre-launch). We've designed a `corrections` table that records operator-supplied overrides as `source='operator_correction'`, `confidence='verified'` — your input wins over our scrape.

### Bug reports

Open an issue. Helpful template:
- What URL / API call / search did you do?
- What did you see?
- What did you expect?
- Any console errors / network errors?
- Browser + OS (for UI bugs)

### Code

Best path is to comment on an existing issue first, especially during M1 where the implementation order is fairly tight (see [`docs/03-implementation-plan.md` §3](docs/03-implementation-plan.md)). Spec drift is more painful than missing code right now.

## Code conventions

- TypeScript strict mode. No `any` without a `// reason:` comment.
- Drizzle for typed reads/writes; raw SQL only for batch operations explicitly called out in the architecture doc (notably the IRVE diff-and-swap, T06b).
- One task per commit on `main`. Conventional-commit subject lines (`feat(T0X):`, `chore(T0X):`, etc.).
- No production code without a passing acceptance criterion from the implementation plan. "It compiles" is not "done."

## Local development

You'll need:
- Node ≥ 20 (use `mise` or `nvm`; we run on 25 in CI but 20 LTS is the floor)
- pnpm 10+
- A Supabase project (free tier, PostGIS + pgcrypto enabled)
- [sqlfluff](https://sqlfluff.com/) for the migration pre-commit hook: `brew install sqlfluff` (or `pip install 'sqlfluff>=4,<5'`). The hook degrades gracefully if sqlfluff isn't installed — CI will still validate migrations on PR — but you'll lose the immediate paste/save-error gate locally.

```bash
pnpm install                         # also installs Husky pre-commit
cp .env.example .env.local           # then fill the empty values
pnpm drizzle-kit introspect          # smoke test: connects to your DB
pnpm dev                             # http://localhost:3000
```

### Authoring migrations

Migrations live under `supabase/migrations/NNNN_<name>.sql`, numbered in dependency order, applied via the Supabase CLI (`supabase db push`) or the Supabase MCP `apply_migration`. Migration history is **append-only** — never edit a committed migration; always add a new one.

Every migration must:
- Be idempotent (`CREATE … IF NOT EXISTS`, `DROP TRIGGER IF EXISTS` + `CREATE`, `CREATE OR REPLACE FUNCTION`, `INSERT … ON CONFLICT … DO NOTHING`).
- Apply clean against a fresh empty database (CI proves this on every PR).
- Apply clean a second time without errors or extra rows (CI also asserts this).
- Target the `live` / `staging` / `archive` schemas, never `public` (PostGIS-reserved).
- Carry a header comment documenting why it's hand-rolled SQL vs Drizzle-Kit-generated.

The pre-commit hook runs `sqlfluff lint` on staged migration files; CI re-lints and then applies every migration in order against a Postgres + PostGIS container.

The IRVE CSV cache lives under `.cache/` (gitignored). For the full pipeline locally, see [`docs/03-implementation-plan.md` §3](docs/03-implementation-plan.md) for the W2+ task instructions.

## Code of conduct

Be decent. Disagree on the merits, not the person. We're building a public-interest tool for drivers, journalists, and researchers — keep that in mind.

## Licensing

By contributing you agree your code is licensed under [AGPL-3.0](LICENSE) and any data you contribute is licensed [CC-BY-4.0](LICENSE-DATA).
