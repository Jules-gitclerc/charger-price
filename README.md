# charger-price

Repo `charger-price` hosts the **Prix-Bornes** project — a public, neutral comparator for EV charging tariffs in France.

The mental model is [prix-carburants.gouv.fr](https://www.prix-carburants.gouv.fr/), but for EV charging stations: a sortable table, an open API, zero commercial bias. We aggregate the official IRVE national dataset, parse what we can, scrape what we must, and show our work — including where the data is incomplete.

> **Status: M1 in progress.** No public-facing UI yet. See [`docs/03-implementation-plan.md`](docs/03-implementation-plan.md) for the roadmap.

## What's distinctive

- **Honesty about what we know.** Each tariff is tagged with one of four confidence tiers: `verified` (direct operator scrape, < 7 days old), `parsed` (extracted from the IRVE dataset's free-text field), `estimated` (network-level fallback), or `unknown` (we genuinely don't have it — here's the operator link). Roughly **76 % of IRVE rows have no usable tariff text** — see [`docs/01-discovery.md` §D.1](docs/01-discovery.md). We say so, instead of inventing numbers.
- **Open, free, public API.** Read endpoints under `/api/v1/*` will be documented and rate-limited (M2). No paid tier.
- **Open data.** The normalized dataset we publish back is licensed [CC-BY-4.0](LICENSE-DATA) — same spirit as the IRVE upstream.
- **Open code.** This repository is licensed [AGPL-3.0](LICENSE) — any hosted fork must remain open.

## Data sources & attribution

- **IRVE consolidated dataset** — © Etalab, [Licence Ouverte / Open Licence 2.0](https://www.etalab.gouv.fr/licence-ouverte-open-licence/). Fetched daily from <https://www.data.gouv.fr/fr/datasets/fichier-consolide-des-bornes-de-recharge-pour-vehicules-electriques/>.
- **IRVE static schema** v2.3.0 — © Etalab, <https://schema.data.gouv.fr/etalab/schema-irve-statique/>.
- **Base Adresse Nationale (BAN)** — © Etalab, used for reverse-geocoding the ~42 % of IRVE rows missing a postal code. <https://api-adresse.data.gouv.fr/>.
- **OCPI 2.2.1** — internal tariff data model reference. Not a live integration. <https://github.com/ocpi/ocpi>.
- **Per-operator scrapers** — public-facing CGV / pricing pages of each French CPO; full source list and refresh cadence in [`docs/01-discovery.md`](docs/01-discovery.md). We honor robots.txt, throttle to weekly, identify with the `Prix-Bornes/1.0 (+https://github.com/Jules-gitclerc/charger-price)` user agent.

If you operate a charging network and a tariff we display is wrong, see "Operator corrections" below.

## Tech stack

- **Web** — Next.js 16 (App Router) on [Vercel](https://vercel.com/), region `cdg1` (Paris).
- **Database** — Postgres 17 + PostGIS on [Supabase](https://supabase.com/), region `eu-west-3` (Paris).
- **ORM** — Drizzle for typed access; raw SQL for the IRVE diff-and-swap.
- **Daily IRVE ingestion** — GitHub Actions cron (the 151 MB CSV doesn't fit a serverless function ceiling). Per-operator scrapers run on Vercel Cron.
- See [`docs/02-architecture.md`](docs/02-architecture.md) for the full design.

## Repo layout

```
docs/                  Phase 1–3 design documents (read in order)
src/app/               Next.js App Router pages + API routes
src/lib/db/            Drizzle client + (W2+) schema definitions
src/lib/supabase/      @supabase/supabase-js server client
supabase/migrations/   Hand-written SQL migrations (W2+)
tools/                 IRVE sync, geocoding backfill (W2/W3, Python)
.github/workflows/     IRVE cron + partition rollover (W2+)
```

## Operator corrections

If you are a network operator and a price we display for one of your stations is wrong:

> **Contact channel TBD pre-launch — please open or comment on [issue #1](https://github.com/Jules-gitclerc/charger-price/issues/1).**

A dedicated `corrections@` mailbox + a structured intake table (see [`docs/02-architecture.md` §A3](docs/02-architecture.md)) will land before public launch. Until then, GitHub issues are the channel.

## Out of scope (deliberately)

- Real-time availability (occupied / free) — focus is **price**, not status. See [ABRP](https://abetterrouteplanner.com/) for routing.
- Native mobile app — responsive web is enough for v1.
- Integrated payment or our own roaming pass — we are not becoming an operator.
- Operator partnerships that would bias display ranking.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Bug reports, parser fixture submissions, and per-operator data corrections are all welcome.

## Licenses

- **Code** — [GNU AGPL-3.0](LICENSE)
- **Published normalized dataset** — [CC-BY-4.0](LICENSE-DATA)
- **Upstream IRVE data** — Etalab Open Licence 2.0 (see attribution above)
