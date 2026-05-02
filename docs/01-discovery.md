# Phase 1 — Discovery

> Read-only audit of the data landscape for **Prix-Bornes**. No design decisions yet.
> Date of audit: 2026-05-02.
> Geographic scope considered: France métropolitaine + DOM-TOM (per user direction). Empirical finding: DOM-TOM is **0.03% of the IRVE dataset** (74 of 224,467 rows have postal code 97xxx) — see Section A.
> Method: web fetches + targeted searches against canonical sources, plus one-time local download of the 150 MB IRVE CSV to ground Section D in real samples. Where a publisher's page returned 403/404 to the headless fetcher, the document falls back on search-result snippets that quote those pages, and labels the claim accordingly.

---

## Section A — Data sources inventory

| # | Source | URL | Format | Refresh cadence | License / legal | Reliability | Gap to fill |
|---|--------|-----|--------|-----------------|-----------------|-------------|-------------|
| 1 | **IRVE consolidated dataset** (Base nationale) | https://www.data.gouv.fr/fr/datasets/fichier-consolide-des-bornes-de-recharge-pour-vehicules-electriques/ — CSV: https://www.data.gouv.fr/api/1/datasets/r/eb76d20a-8501-400e-b336-d85724de5435 | CSV (~150 MB) + GeoJSON (~545 MB) + doc CSV | Page reports "Mis à jour aujourd'hui" — effectively daily | Licence Ouverte / Etalab Open Licence (https://www.etalab.gouv.fr/wp-content/uploads/2014/05/Licence_Ouverte.pdf) | **High** for geometry, IDs, sockets. **Low** for `tarification` (free text). | Tariffs structured; freshness of operator commercial data. |
| 2 | **IRVE static schema spec** | https://schema.data.gouv.fr/etalab/schema-irve-statique/ + https://schema.data.gouv.fr/etalab/schema-irve-statique/latest/documentation.html + https://github.com/etalab/schema-irve | HTML doc + JSON Table Schema in repo | Schema spec last released v2.3.0; dataset page advertises v2.1.0 (Oct 2022) — **version drift to confirm** | Etalab | **High** as reference contract | None — this is the contract. |
| 3 | **OCPI 2.2.1 spec** (Tariffs / Locations / CDRs) | https://evroaming.org/app/uploads/2021/11/OCPI-2.2.1.pdf and https://github.com/ocpi/ocpi (Tariffs at `mod_tariffs.asciidoc`) | PDF + AsciiDoc on GitHub | Versioned (2.2.1 stable; 3.x in flight at evroaming.org) | EVRA copyright; spec is freely readable | **High** | Reference data model only — we're not connecting OCPI live (yet). |
| 4 | **Electra** | https://www.go-electra.com/en/price/ ; https://www.go-electra.com/en/electra-plus/ | HTML page + in-app dynamic pricing | Tariffs revised on operator timeline (last visible: Mar 2025 launch of Electra+ tiers) | Public commercial communication | **Medium** — site published price floor (€0.29/kWh app), but stations apply *dynamic* per-occupancy pricing visible only in-app pre-session (per source). | Per-station/time tariff snapshots. |
| 5 | **Ionity** | https://www.ionity.eu/network/access-and-payments ; https://www.ionity.eu/subscriptions ; https://support.ionity.eu/faqs/how-much-does-it-cost-to-charge-at-ionity | HTML + FAQ | Annual plan changes (e.g. Power 365 / Motion 365 introduced; ad-hoc cuts in 12 countries May 2024) | Public | **Medium-High** for ad-hoc & subscription headline; **Medium** for per-country floor variation. | Per-country tariff matrix; Passport vs ad-hoc deltas in France. |
| 6 | **TotalEnergies / Charge+** | https://www.totalenergies.fr/particuliers/recharge-voiture-electrique/borne-a-domicile/prix ; https://chargeplus.totalenergies.com/fr/conseils-recharge-electrique/cout-recharge-voiture-electrique/ ; https://services.totalenergies.fr/particuliers/energies-vehicules/electrique-rechargeable/pourquoi-choisir-electrique-totalenergies | HTML | Last public price reset: 5 Mar 2025 — €0.52/kWh ≤50 kW, €0.62/kWh >50 kW (per search snippet quoting Charge+) | Public | **Medium** | Subscription / app vs CB delta; rural vs HPC variation. |
| 7 | **Tesla Supercharger** | https://www.tesla.com/fr_fr/support/charging/supercharger ; https://www.tesla.com/fr_fr/support/charging/non-tesla | In-app + brief static page | **Dynamic per-station, per-time-slot.** Public list does not exist; only the app or per-station page exposes the live price. | Public-facing but commercial | **Low (machine-readable)** — Tesla deliberately hides a full price list. | This is a *known hard case*: per-station, time-of-day price + Membership delta. |
| 8 | **Allego** | https://www.allego.eu/pricing/ ; https://chargemap.com/en-us/networks/allego | HTML | Tariff revisions; July 2024 introduced added taxe per automobile-propre.com | Public | **Medium** | Per-country, per-power-class table. |
| 9 | **Fastned** | https://www.fastnedcharging.com/en/charging/tariffs ; https://www.fastnedcharging.com/hq/en/charge-price-changes | HTML — *publishes a dedicated price-changes page* | Frequent (last hike 1 Apr 2026 per automobile-propre.com snippet) | Public | **High** — Fastned is the most transparent operator on this list. | None of substance; just scrape. |
| 10 | **Izivia (EDF)** | https://izivia.com/ ; https://izivia.com/blog/combien-coute-une-recharge-en-voiture-electrique | HTML / blog | Per-station; mix of €/kWh + time component on Izivia Express | Public | **Low-Medium** — published ranges (~€0.38–0.55/kWh) but per-station detail in app/map only. | Per-station tariff snapshots. |
| 11 | **Freshmile** | https://www.freshmile.com/en/our-solutions/recharge-cards/private-recharge-card/ | HTML | Tariffs vary by underlying CPO — Freshmile aggregates | Public | **Low** — by design, "no single Freshmile rate" | Reverse-mapping of which CPO sets the price. |
| 12 | **Chargemap Pass** | https://chargemap.com/en-us/pass ; https://chargemap.com/en-us/price ; https://support.chargemap.com/l/en/article/amoapmndfg-how-much-does-charging-cost-with-the-chargemap-pass | HTML + per-station price visible in app | Continuous; markup = 5–15% by network (per tesla-mag.com snippet) | Public | **Medium** | Network-by-network commission table. |
| 13 | **Shell Recharge** | https://shellrecharge.com/fr-fr/en-deplacement/tarifs-de-la-recharge-publique ; https://www.shell.fr/recharge-electrique/tarifs-de-shell-recharge.html | HTML | Continuous | Public | **Medium** | Per-CPO markup rules. |
| 14 | **Plugsurfing** | https://www.plugsurfing.com/drivers/pricing?lang=fr | HTML | Continuous; ~10% service fee per session per snippets | Public | **Medium** | Per-CPO commission. |
| 15 | **KiWhi Pass / Fulli** | https://www.fulli.com/en/news/electric-charging-easy ; https://activercarte.com/activer-la-carte-kiwhi-pass/ | HTML | Per-CPO; KiWhi resells | Public | **Low** | Subscription tiers + per-CPO behavior. |
| 16 | **Chargeprice** (competitor) | https://www.chargeprice.app/ ; https://github.com/chargeprice/chargeprice-api-docs | Map UI + paid API (free demo) | Continuous | Commercial; API "commercial use prohibited" on demo tier | **Medium** as data source, **High** as design reference | n/a — adversary/inspiration. |

**Cross-source notes**
- **Schema version drift** — the dataset landing page advertises schema **v2.1.0** while the schema portal serves **v2.3.0**. Either the dataset is lagging, or the page metadata is stale. Must be confirmed before designing any ingestion. (sources: rows 1 and 2)
- **Direct vs intermediated price discovery.** Operators 4, 5, 7, 10 publish *headlines* but the real per-station price is only inside their app. Pass providers 12–15 deliberately publish *commission rules*, not absolute prices. **Implication:** for many stations, the "honest" price for our table will need a confidence/freshness flag, not a number we pretend is canonical.

### A.1 — IRVE dataset, measured (one-time local download, 2026-05-02)

Downloaded the consolidated CSV (151 MB, 224,467 data rows + 1 header) and ran a Python pass to ground the next sections in real data rather than guesswork.

**Schema-vs-actual columns.** The actual CSV contains **51 columns**, vs the schema's documented 41. The 10 extras are all consolidation metadata appended by the data.gouv pipeline (no new tariff information): `last_modified, datagouv_dataset_id, datagouv_resource_id, datagouv_organization_or_owner, created_at, consolidated_longitude, consolidated_latitude, consolidated_code_postal, consolidated_commune, consolidated_is_lon_lat_correct, consolidated_is_code_insee_verified, consolidated_is_code_insee_modified`. None affects pricing; some (`consolidated_*`) are useful for ingestion (pre-deduped geocode and INSEE).

**Geographic distribution by `consolidated_code_postal`.**

| Region | Rows | % |
|---|---:|---:|
| Métropole (postal `[01–95]xxx`) | 129,618 | 57.7% |
| DOM-TOM (postal `97xxx`) | **74** | **0.03%** |
| Unknown / no postal code | 94,775 | 42.2% |

**Implication for scope:** including DOM-TOM costs nothing in v1 (74 rows, model-equivalent), but **42% missing postal code is a much bigger problem** than DOM-TOM coverage. Reverse-geocoding from `coordonneesXY` will be a v1 ingestion task.

**Top 15 enseignes by row count.**

| # | Enseigne | Rows |
|---|---|---:|
| 1 | Power Dot France | 13,896 |
| 2 | Freshmile France | 9,274 |
| 3 | Réseau de recharge du groupe Indigo | 7,365 |
| 4 | ENGIE Vianeo | 6,241 |
| 5 | LIDL | 5,562 |
| 6 | DRIVECO | 5,230 |
| 7 | CPO CITEOS Mobive | 4,940 |
| 8 | Lidl France *(distinct from #5 — duplicate enseigne)* | 4,851 |
| 9 | Tesla | 4,533 |
| 10 | TESLA SUPERCHARGER *(distinct from #9 — duplicate enseigne)* | 4,509 |
| 11 | Belib' | 4,282 |
| 12 | TotalEnergies Charge Rapide | 3,847 |
| 13 | Réseau eborn | 3,635 |
| 14 | QOVOLTIS | 3,612 |
| 15 | QPARK | 3,612 |

**Three immediate findings:**
1. **Power Dot is the largest enseigne in France** — they operate the LIDL fast-charging stations. The brief's priority list omits them; should be added to operator coverage planning.
2. **Enseigne deduplication is a v1 task.** "LIDL" / "Lidl France" and "Tesla" / "TESLA SUPERCHARGER" are split entries for the same brand. We need a canonical-brand mapping table.
3. **The brief's 16-operator priority list is reasonable but incomplete.** Power Dot, Indigo, ENGIE Vianeo, DRIVECO, CITEOS Mobive, Belib', eborn, QOVOLTIS, QPARK each individually exceed Ionity (~700 stations in France) by orders of magnitude — coverage of the *top 15 by station count* would dominate user value.

### A.2 — Robots.txt scan (verified 2026-05-02)

Headless fetch of `/robots.txt` for each operator/pass with a published web presence.

| Source | robots.txt verdict | Notes |
|---|---|---|
| Electra (`go-electra.com`) | **Open** — `User-agent: * / Allow: /` (only `/en/storyblok-preview/` blocked) | Sitemap published. Tariff page in scope. |
| Ionity (`ionity.eu`) | **Inconclusive** — fetcher returned an unhelpful response; needs a real browser to confirm | Re-verify before scraping. |
| TotalEnergies (`totalenergies.fr`) | **Inconclusive** — fetcher returned a socket error (likely WAF / bot block at the edge, not robots.txt itself) | Suggests aggressive bot detection at the network layer regardless of robots.txt. |
| Tesla (`tesla.com`) | **Likely hostile** — fetcher returned 403 on `/robots.txt`. Tesla's edge blocks unauthenticated automated requests broadly. | Treat as effectively inaccessible to a server-side scraper. |
| Allego (`allego.eu`) | **Open** — `User-agent: * / Disallow: /wp-admin/` only | WordPress site; pricing page in scope. |
| Fastned (`fastnedcharging.com`) | **Open** — `User-agent: * / Allow: /` | Plus dedicated price-changes page; ideal scrape target. |
| Izivia (`izivia.com`) | **Open** — `User-agent: * / Disallow: /wp-admin/` | WordPress; OK. |
| Freshmile (`freshmile.com`) | **Open with politeness** — same as above + `Crawl-delay: 10` | Honor the 10-second delay. |
| Chargemap (`chargemap.com`) | **Restrictive and asymmetric** — explicitly **allows SemrushBot and Oncrawl**, **blocks Googlebot, Bingbot, DuckDuckBot, Applebot** with selective `Disallow`s; **catch-all `Disallow: /` for unlisted UAs** | Our scraper would fall under the catch-all; a polite scrape is technically blocked by robots. Re-evaluate scope of Chargemap data needs (we may only need their *pass markup grid*, not their station data). |
| Shell Recharge (`shellrecharge.com`) | **Inconclusive** — `/robots.txt` 301-redirects to `shell.com/` (i.e. there is no robots.txt at the recharge subdomain; the parent corporate site is what's served) | Effectively no robots-level guidance. ToS review required. |
| Plugsurfing (`plugsurfing.com`) | **Open** — `User-agent: * / Disallow:` (empty) | Sitemap published. |
| Fulli / KiWhi (`fulli.com`) | **Open** — Drupal-style allow/deny: blocks admin/checkout, allows content | Sitemap published. |

**Headline:** Tesla and TotalEnergies appear to actively block server-side automated traffic at the edge. Chargemap's robots.txt explicitly excludes generic UAs. Everyone else is permissive at the robots layer. This is a **first-pass** signal only — robots.txt is not legally binding (only an instruction to compliant crawlers), and ToS / commercial-use terms still need review per Section F open question 3.

---

## Section B — IRVE schema deep-dive

Source: https://schema.data.gouv.fr/etalab/schema-irve-statique/latest/documentation.html (schema **v2.3.0**, originally created 2018-06-29).

### Full field list

| Field | Type | Required | Notes |
|---|---|---|---|
| `nom_amenageur` | String | No | Owner business name |
| `siren_amenageur` | String | No | Owner SIREN |
| `contact_amenageur` | Email | No | |
| `nom_operateur` | String | No | Operator business name |
| `contact_operateur` | Email | **Yes** | Generic email preferred |
| `telephone_operateur` | String | No | |
| `nom_enseigne` | String | **Yes** | Commercial network name (e.g. "Electra", "Ionity") |
| `id_station_itinerance` | String | **Yes** | National station ID per decree |
| `id_station_local` | String | No | |
| `nom_station` | String | **Yes** | |
| `implantation_station` | String | **Yes** | Roadside / parking pub / parking priv / station rapide |
| `adresse_station` | String | **Yes** | Full address |
| `code_insee_commune` | String | No | INSEE commune code |
| `coordonneesXY` | Geographic Point | **Yes** | Lon/lat WGS84 |
| `nbre_pdc` | Integer | **Yes** | Number of charge points |
| `id_pdc_itinerance` | String | **Yes** | National charge point ID |
| `id_pdc_local` | String | No | |
| `puissance_nominale` | Float | **Yes** | kW max |
| `prise_type_ef` | Boolean | **Yes** | E/F socket |
| `prise_type_2` | Boolean | **Yes** | Type 2 |
| `prise_type_combo_ccs` | Boolean | **Yes** | CCS |
| `prise_type_chademo` | Boolean | **Yes** | CHAdeMO |
| `prise_type_autre` | Boolean | **Yes** | Other |
| `gratuit` | Boolean | No | Free? |
| `paiement_acte` | Boolean | **Yes** | Pay-per-use without ID/subscription |
| `paiement_cb` | Boolean | No | CB terminal at station |
| `paiement_autre` | Boolean | No | Other payment, may be detailed in `observations` |
| `tarification` | String | No | **Free-text — see verbatim quote below** |
| `condition_acces` | String | **Yes** | "Accès libre" / "Accès réservé" |
| `reservation` | Boolean | **Yes** | |
| `horaires` | String | **Yes** | 24/7 or specified |
| `accessibilite_pmr` | String | **Yes** | Accessibility status |
| `restriction_gabarit` | String | **Yes** | Vehicle size restrictions |
| `station_deux_roues` | Boolean | **Yes** | 2-wheelers only |
| `raccordement` | String | No | Direct / Indirect grid connection |
| `num_pdl` | String | No | Electricity delivery point number |
| `date_mise_en_service` | Date | No | |
| `observations` | String | No | Free-text catch-all |
| `date_maj` | Date | **Yes** | Last update date — **critical for our freshness logic** |
| `cable_t2_attache` | Boolean | No | Captive T2 cable? |

### Tariff- and payment-related fields, verbatim

- `paiement_acte` — `"Possibilité de paiement à l'acte (sans identification ni abonnement)."`
- `paiement_cb` — `"Possibilité de paiement par carte bancaire (présence d'un terminal de paiement avec une CB)."`
- `paiement_autre` — `"Possibilité de paiement par un autre moyen (qui peut être précisé dans le champ « observation »)."`
- `tarification` — `"Toutes informations pouvant être apportées concernant les tarification(s) pratiquée(s)."`
- `condition_acces` — `"Éventuelles conditions d'accès à la station, hors gabarit ... indiquer 'Accès libre' ou 'Accès réservé'."`
- `gratuit` — boolean only; no description text observed.

### Honest assessment of what the schema gives us

The schema cleanly normalizes **identity, geometry, sockets, payment-method availability (booleans), accessibility**. But on **price** it gives one free-text field plus three booleans and a free-text `observations`. That is the entire IRVE tariff surface area — and it's the gap our project exists to close.

---

## Section C — OCPI 2.2.1 Tariffs reference model (condensed)

Source: https://github.com/ocpi/ocpi (`mod_tariffs.asciidoc`).

We adopt OCPI as our **internal canonical model** even without live OCPI feeds, because (a) it's the European reference; (b) any future direct-CPO integration will speak it; (c) it's well-typed enough to express the messy real world.

```
Tariff
├── country_code, party_id, id              -- (CPO, country, tariff id)
├── currency (ISO 4217)                     -- e.g. "EUR"
├── type                                    -- AD_HOC_PAYMENT | PROFILE_CHEAP |
│                                              PROFILE_FAST | PROFILE_GREEN | REGULAR
├── tax_included                            -- YES | NO | N/A
├── min_price, max_price                    -- session floor/cap
├── start_date_time, end_date_time          -- validity window
├── last_updated
└── elements: [ TariffElement ]
        ├── price_components: [ PriceComponent ]
        │   ├── type        -- ENERGY (kWh) | FLAT | TIME (hr) | PARKING_TIME (hr)
        │   ├── price       -- per unit
        │   ├── vat         -- % (optional)
        │   └── step_size   -- billed in multiples of (1 Wh for ENERGY, 1 s for TIME)
        └── restrictions: TariffRestrictions
            ├── start_time, end_time              -- "HH:MM" local
            ├── start_date, end_date              -- "YYYY-MM-DD" local
            ├── min_kwh, max_kwh
            ├── min_current, max_current          -- A
            ├── min_power, max_power              -- kW
            ├── min_duration, max_duration        -- s
            ├── day_of_week: [ DayOfWeek ]
            └── reservation
```

**Why this is enough to model the messy real world:**
- Time-of-use (Tesla "Super Creuses", Izivia time fee on tail of session) → `TariffRestrictions.start_time/end_time` + a TIME `PriceComponent`.
- Power-tier pricing (TotalEnergies €0.52 ≤50 kW vs €0.62 >50 kW) → two `TariffElement`s with `min_power`/`max_power` restrictions.
- Idle/blocking fees → `PARKING_TIME` `PriceComponent` with `min_duration` restriction.
- Subscription delta (Fastned Gold €0.41 vs ad-hoc €0.61) → two distinct `Tariff` records, `type=REGULAR` vs `type=AD_HOC_PAYMENT`, plus a separate "subscription cost" record outside OCPI (membership €/month is **not** in OCPI Tariffs — it's customer-side, see Section F open question 5).
- Pass markup → modeled as a *derived* tariff that references a base tariff + a multiplier, **outside OCPI** (OCPI assumes one CPO publishing absolute prices).

---

## Section D — Normalization challenge (grounded in real CSV samples)

Source: full one-time scan of the IRVE consolidated CSV (224,467 rows) on 2026-05-02.

### D.1 — Empirical distribution of the `tarification` field

| Pattern class | Rows | % of dataset | Parser cost |
|---|---:|---:|---|
| **Empty / sentinel** (`""`, `"-"`, `"TRUE"`, `"false"`, `"Inconnu"`, `"N/A"`, `"FIXE"`) | 171,618 | **76.5%** | nothing to parse — must be modeled as **"price unknown"**, not as missing |
| `PROSE_NO_NUMBER` (e.g. `"Au kWh"`, `"/"`, `"FIXE"`) | 16,925 | 7.5% | useless prose; treat as sentinel |
| `NUMERIC_OTHER` (numbers present but no €/kWh; e.g. `"2 € / heure pour les abonnés"`, malformed CITEOS-style) | 8,980 | 4.0% | template grammar, partial recovery |
| `TIME_WINDOWED_NL` (CITEOS-style: `"entre 07:00 et 22:00 : 0.3333€ par kwh ..."`) | 8,656 | 3.9% | **highly tractable** — clearly machine-generated, single grammar fits all |
| `URL_ONLY` (e.g. `"https://belib.paris"`, operator CGV link) | 8,384 | 3.7% | enqueue URL for downstream scrape; no price recovery from this field |
| `PRICE_KWH_NL` (`"0,29€ / kWh"`, `"AC 36cts/KWh"`, `"HPC 49cts/Kwh"`) | 8,351 | 3.7% | regex; ~181 distinct values — small enough to manually QA |
| `JSON_LIKE` (DRIVECO emits JSON: `{"fixedPrice":0,"energyPrice":0.49,...}`) | 1,553 | 0.7% | **trivially parseable** — operator stuffed structured data into a free-text field; only 5 distinct schemas observed |

**Headline:** 76.5% of rows have **no usable tariff text at all**, and another 7.5% is non-numeric prose. Across the entire IRVE dataset, only ~**12.3%** of rows (TIME_WINDOWED_NL + PRICE_KWH_NL + JSON_LIKE + URL_ONLY) carry information that could feed a price into our table — and URL_ONLY only points elsewhere. The brief's "free text, unstructured, often outdated" assessment was if anything *generous*.

### D.2 — Real samples per pattern class

All examples below are verbatim values from the dataset, copied from a random sample seeded with `random.seed(42)`.

**PRICE_KWH_NL** — 181 distinct values, regex-friendly.
```
[Mobilygreen CPO]                       "0.33€/kWh"
[Mobilygreen CPO]                       "0.49€/kWh"
[EVBOX]                                 "0,30cts/KWh"           ← unit ambiguity (cts vs €)
[Edenauto Toulouse Etats-Unis]          "lorsque la voitutre est branché:on applique
                                         0.32€/Kwh + 0.1€ /min ( App Tarif) lorsque la
                                         voiture est chargée mais toujours branché: on
                                         applique 0.1€/min (App tarif)"   ← typo + multi-clause
```

**TIME_WINDOWED_NL** — 65 distinct values, all from "CPO CITEOS" variants. Single grammar fits all; this is auto-generated from an upstream OCPI-like exporter.
```
[CPO CITEOS Mobive]
"entre 07:00 et 23:00 : 0.45833€ par kwh de charge,
 entre 07:00 et 23:00 : 4.5€ par heure d'occupation hors charge,
 0.45833€ par kwh de charge,
 4.5€ par heure de charge,
 entre 23:00 et 07:00 : 0.45833€ par kwh de charge,
 par défaut : 0.45833€ par kwh de charge,
 entre 07:00 et 22:0..."  ← truncated example; real values run 200–500 chars
```
Note one observed bug: a single CITEOS row contained `"par heure ,'occupation hors charge"` (misplaced comma). The upstream exporter has a stringification glitch. Robust parser must tolerate both forms.

**JSON_LIKE** — 5 distinct schemas, all from DRIVECO. Trivial to parse.
```
[DRIVECO] {"fixedPrice":0,"energyPrice":0.49,"minimumBilling":0,
           "matrix":[],
           "matrixOSF":[
             {"duration":0,"interval":1,"price":0.2,"gracePeriodBeforeOSF":900},
             {"duration":15,"interval":1,"price":0,"gracePeriodBeforeOSF":0}
           ],
           "hasDynamicTarif":false,"ecoHour":false}
```
Field decode: `energyPrice` = €/kWh; `matrixOSF` = "occupation supplémentaire facturée" — idle fee starting at duration=0 then waived after 15 min (graceful idle window). This is essentially a private tariff DSL; **DRIVECO is silently giving us machine-readable data through the wrong field**.

**URL_ONLY** — 11 distinct values, all stable operator landing pages.
```
"https://belib.paris"
"https://apps.total-ev-charge.com/charge-points"
"https://www.ouestcharge-paysdelaloire-moncompte.fr/fr/tarifs"
"https://www.metropolis-recharge.fr/"
"https://www.e-vadea.fr/fr/tarifs"
"https://www.go-fuzed.com/cgv"
```
**Implication:** the field is being used as a **hyperlink dispatcher** by several public-tender operators. Our ingestion must dereference these URLs as a second-stage scrape.

**NUMERIC_OTHER** — 250 distinct values; long-tail malformed.
```
[CPO CITEOS Vaucluse]   broken CITEOS template: "par défaut : 0.33334€ par kwh de
                        charge, 2.5€ par heure ,'occupation hors charge ..."
[ZEENCO]                "0,50€KWHHT"            ← no separators, "HT" tax marker
[FR*S28]                "2 € / heure pour les abonnés"  ← per-hour, subscriber-only
```

**PROSE_NO_NUMBER** — 20 distinct values.
```
[Réseau MOBIVE]               "Au kWh"        ← states a unit but no number
[CEGELEC Clermont-Montluçon]  "/"             ← null marker
[LABORATOIRE ESTRADE HUART]   "false"         ← boolean leaked from another field
[Bornes CIVP]                 "FIXE"          ← unclear
```

### D.3 — Single most common value (12,890 rows)

The single most frequent non-empty `tarification` value is a 12,890-row meta-disclaimer:

> *"Les tarifs de recharge peuvent varier en fonction de plusieurs facteurs, y compris le fournisseur de services, l'emplacement de la borne, la puissance de charge, et les éventuelles promotions en cours..."*

It is, deliberately or not, **content-free**. Likely all from one large operator (probably Power Dot — coincides with their station count). 5.7% of all rows in the entire IRVE dataset, and **23% of all non-empty `tarification` values**, contain literally no pricing information. Sentinel candidate.

### D.4 — Practical parsing budget

Given the empirical distribution:

| Strategy | Rows it handles | % of dataset |
|---|---:|---:|
| Constant: emit "price unknown" with pointer to source | 171,618 + 16,925 sentinels | 84.0% |
| JSON parser (DRIVECO) | 1,553 | 0.7% |
| CITEOS template parser | 8,656 | 3.9% |
| Regex `(\d+[.,]\d+)\s*(€|cts)\s*/?\s*kWh` family | most of `PRICE_KWH_NL` (8,351) + maybe 30% of `NUMERIC_OTHER` (~2,700) | ~5% |
| URL fetch + re-parse | 8,384 | 3.7% |
| LLM long-tail fallback | residual ~1–2% | ~1.5% |

**Realistic v1 outcome.** With 5 small parsers we can give a *number* to ~13–14% of rows, a *URL pointer* to another ~3.7%, and an honest "price unknown — last seen at \<date_maj\>" to the remaining ~82%. That is the truth, and the UI must show it. The differentiation against Chargeprice (Section E) is precisely this: where they hide low-confidence data behind a number, we surface uncertainty as a first-class field.

The architecture (Phase 2) must therefore treat **"no price"** and **"price with date_maj from N months ago"** and **"price from operator scrape, fresh"** as three distinct rendered states, not as edge cases.

---

## Section E — Competitive analysis: Chargeprice

**Sources.** https://www.chargeprice.app/, https://www.chargeprice.net/en/, https://github.com/chargeprice/chargeprice-api-docs, public app reviews surfaced via search.

**What they do**
- Map-centric mobile + web app for finding charging stations and comparing per-session price across many tariffs (operator subscription, CB, several roaming passes) for a given vehicle and battery state-of-charge.
- API exposes entities `charging_stations`, `charge_prices`, `tariffs`, `companies`, `vehicles`, `vehicle_brands` (sources cite `/api/v1/...` and `/api/v2/vehicles`).
- Pan-European coverage; >300k drivers per their marketing.
- API has a free demo tier ("commercial use prohibited") and a paid commercial tier — `sales@chargeprice.net`. No fully open free public API.

**What users complain about (search snippets, AlternativeTo / store reviews)**
- Data freshness — multiple users report stale prices, with at least one anecdote of being stranded twice. Chargeprice acknowledges and points to community reporting + 2024 work on operator interop and automated price-change alerts.
- Coverage of small French operators is uneven (general signal, not a quoted complaint).

**What they *don't* do (gap → our differentiation)**
1. **Map-first, not table-first.** A driver standing at a parking lot wants a *sortable list*, not a clustered map. Prix-Bornes can lead with the prix-carburants table metaphor.
2. **No public free API.** A documented, free, rate-limited API is one of our explicit deliverables and a clear contrast.
3. **No price history.** No timeline view of "how has this station's price changed in 6 months."
4. **No transparency about freshness per data point.** We can show a per-row `source` + `last_seen_at` + `confidence` triple as a first-class UI element.
5. **Closed data.** They don't republish their normalized dataset as open data; we can.
6. **Mobile-first UX.** Web responsive desktop is our primary surface (driver does the homework before leaving), per project brief.

**What we should learn from them, not compete with**
- The hard problem of **session cost simulation per vehicle** (battery capacity, taper curve, ambient temp). For v1 we should *not* attempt curve modeling — a flat kWh × duration estimate per power class is enough (see Phase-2 MVP scope).
- The data-quality hamster wheel — community reporting + per-source confidence is essential infrastructure, not a v2 nice-to-have.

---

## Section F — Open questions for the user

These are decisions or verifications I cannot make alone. Please answer before Phase 2.

1. **Schema version reality.** Page says v2.1.0; spec portal says v2.3.0. The CSV header carries the columns expected by v2.3.0 plus consolidation extras (Section A.1), suggesting v2.3.0 in practice — but I have not formally validated against either Table Schema. Worth a short Validata pass before Phase 2 if you want certainty.
2. **AFIR Article 20 transparency leverage.** EU AFIR (in force April 2024) imposes ad-hoc price publication on operators and arguably gives third-party aggregators an implicit defensive position when republishing publicly-published prices. Do you have a legal opinion on this, or do we need to source one?
3. **Operator ToS review (the harder half of "scraping legality").** Section A.2 confirms robots.txt is permissive almost everywhere except Chargemap (and edge-blocked at Tesla/TotalEnergies). robots.txt ≠ ToS; we still owe a per-operator ToS pass before any scraper goes live. Phase-2 task or earlier?
4. **Chargemap scraping — full skip or pass-only?** Chargemap's robots.txt explicitly excludes generic UAs. We may not need to scrape *station* data from them at all (we have IRVE for that); we may only need their *pass-markup grid*, which is a single small page. Confirm we can scope Chargemap-side to that minimum, OR commit to the political/legal exposure of broader scraping.
5. **Subscription-cost modeling.** OCPI Tariffs models *per-session* costs but not the customer-side recurring fee (Electra+ €1.99 or €9.99/mo, Fastned Gold €11.99/mo, Ionity Power 365 €119.99/yr). For the comparator to be honest about "real cost per kWh including amortized subscription," we need a separate model. Confirm in scope for v1, vs. "display per-session only and let the user reason about subscriptions elsewhere."
6. **Tesla and dynamic-pricing operators (Tesla, Electra).** Per-station, time-varying, app-only. Tesla's edge also blocks server-side fetches (Section A.2). Options: (a) display "see app" with no number; (b) reverse-engineer the app (legal risk); (c) crowdsource snapshots; (d) skip in v1. Which is the v1 default policy?
7. **Coverage cap for v1.** Section A.1 reveals the brief's priority list does not match station-count reality. **Power Dot operates the largest network in France** (~14k rows, includes LIDL stations); Indigo, ENGIE Vianeo, DRIVECO, CITEOS Mobive each exceed Ionity by an order of magnitude. Do you want to revise the M1 priority? My revised recommendation: **Power Dot + DRIVECO + Fastned + Chargemap Pass** (Power Dot for raw coverage, DRIVECO because they self-publish JSON tariffs in the IRVE field, Fastned because their site is the cleanest scrape target, Chargemap as the pass).
8. **The "76.5% empty + 7.5% prose" reality.** Per Section D.1, only ~12% of IRVE rows carry parseable price information. Should v1 scope explicitly accept that *most stations will display "price unknown" until we onboard their operator's own scraper*? If yes, the UX must lead with that honestly — and we should flag in Phase 2 which operators give us the largest tariff coverage gain per scraper built.
9. **Geographic ID strategy.** IRVE provides `id_station_itinerance` and `id_pdc_itinerance` (national IDs per decree). Do we make `id_station_itinerance` our primary key, or assign our own opaque ID and treat the national one as an external reference? The 42% of rows missing postal code (Section A.1) makes me lean toward "national ID as PK, geometry as the resolver."
10. **Enseigne canonicalization.** "LIDL"/"Lidl France" and "Tesla"/"TESLA SUPERCHARGER" are split entries for the same brand (Section A.1). Do we maintain our own brand-canonical table, or accept the upstream noise? Affects v1 UI grouping.
11. **Public-API access policy.** "Free" — but rate-limited how? API key required (with light email-only signup) or fully anonymous? Shapes the auth/edge story.
12. **Data republication license.** The brief says we re-emit normalized data as open data. ODbL? CC-BY 4.0? Etalab Open License (consistent with upstream IRVE)? Pick one before we start writing.

---

## Method note (transparency about this audit)

- **Verified directly via WebFetch:** IRVE dataset metadata page, IRVE schema documentation page, OCPI Tariffs module on GitHub, and `/robots.txt` for 12 operators/passes (results in Section A.2).
- **Verified directly via local file scan:** the IRVE consolidated CSV (151 MB, 224,467 rows) was downloaded once on 2026-05-02 to `.cache/irve.csv`, scanned with Python for the geographic, enseigne, schema-shape and `tarification` analyses in Sections A.1 and D.
- **Verified via WebSearch quoting the publisher's page** (publisher's URL returned 403/404/socket-close to the headless fetcher): Electra, Ionity, TotalEnergies, Tesla, Allego, Izivia, Freshmile, Shell Recharge, Plugsurfing, KiWhi, Fastned, Chargemap. Prices and dates in Section A reflect what those snippets quoted from the publishers. Treat as **accurate-pending-confirmation**; before any scraper goes live, the actual page must be re-fetched (e.g. via a real browser stack) and the parsing target re-validated.
- **Not done in this audit:** formal Table Schema validation of the CSV against v2.1.0/v2.3.0, per-operator Terms-of-Service review, OCPI 3.x review, federation with EVSE-ID registries (eMI3, IEC 63119).
