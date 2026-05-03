import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  check,
  date,
  foreignKey,
  index,
  numeric,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { live } from './_schemas';
import { geographyPoint } from './postgis';

/**
 * Canonical brand resolving the dataset's enseigne duplicates ("LIDL" vs
 * "Lidl France", "Tesla" vs "TESLA SUPERCHARGER"). Source migration:
 * supabase/migrations/0002_identity.sql.
 */
export const operators = live.table(
  'operators',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    slug: text().notNull(),
    displayName: text('display_name').notNull(),
    country: char({ length: 2 }).default('FR').notNull(),
    websiteUrl: text('website_url'),
    logoUrl: text('logo_url'),
    // ARRAY[]::text[] in DB. Drizzle introspect mis-emitted this as
    // ["RAY"] (character-level misparse of "ARRAY"); use raw SQL default.
    defaultPaymentMethods: text('default_payment_methods')
      .array()
      .default(sql`ARRAY[]::text[]`)
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    unique('operators_slug_key').on(t.slug),
    check('operators_country_iso3166', sql`(country)::text = upper((country)::text)`),
    check(
      'operators_slug_lowercase',
      sql`(slug = lower(slug)) AND (slug !~ '\s'::text)`,
    ),
  ],
);

/**
 * Sub-network within an operator (e.g. "TotalEnergies Charge Rapide").
 * Source: 0002_identity.sql.
 */
export const networks = live.table(
  'networks',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    operatorId: uuid('operator_id').notNull(),
    slug: text().notNull(),
    displayName: text('display_name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.operatorId],
      foreignColumns: [operators.id],
      name: 'networks_operator_id_fkey',
    }).onDelete('cascade'),
    unique('networks_operator_slug_unique').on(t.operatorId, t.slug),
    check(
      'networks_slug_lowercase',
      sql`(slug = lower(slug)) AND (slug !~ '\s'::text)`,
    ),
  ],
);

/**
 * Physical charging site. PK is `id_station_itinerance` (national ID per
 * decree). Geometry is PostGIS `geography(Point, 4326)`. Source:
 * 0002_identity.sql. Loaded by T06b from staging.
 */
export const stations = live.table(
  'stations',
  {
    idStationItinerance: text('id_station_itinerance').primaryKey().notNull(),
    operatorId: uuid('operator_id'),
    networkId: uuid('network_id'),
    idStationLocal: text('id_station_local'),
    nomStation: text('nom_station').notNull(),
    nomEnseigne: text('nom_enseigne'),
    adresseStation: text('adresse_station'),
    codeInseeCommune: text('code_insee_commune'),
    consolidatedCodePostal: text('consolidated_code_postal'),
    consolidatedCommune: text('consolidated_commune'),
    geom: geographyPoint('geom').notNull(),
    implantationStation: text('implantation_station'),
    conditionAcces: text('condition_acces'),
    horaires: text(),
    reservation: boolean(),
    accessibilitePmr: text('accessibilite_pmr'),
    restrictionGabarit: text('restriction_gabarit'),
    stationDeuxRoues: boolean('station_deux_roues'),
    raccordement: text(),
    numPdl: text('num_pdl'),
    dateMiseEnService: date('date_mise_en_service'),
    observations: text(),
    tariffUrl: text('tariff_url'),
    dateMaj: date('date_maj'),
    lastSeenInIrveAt: timestamp('last_seen_in_irve_at', {
      withTimezone: true,
      mode: 'string',
    }),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index('stations_geom_gist').using(
      'gist',
      t.geom.asc().nullsLast().op('gist_geography_ops'),
    ),
    foreignKey({
      columns: [t.networkId],
      foreignColumns: [networks.id],
      name: 'stations_network_id_fkey',
    }).onDelete('set null'),
    foreignKey({
      columns: [t.operatorId],
      foreignColumns: [operators.id],
      name: 'stations_operator_id_fkey',
    }).onDelete('set null'),
    check(
      'stations_postal_code_format',
      sql`(consolidated_code_postal IS NULL) OR (consolidated_code_postal ~ '^[0-9]{5}$'::text)`,
    ),
  ],
);

/**
 * One connector. PK is `id_pdc_itinerance`. Source: 0002_identity.sql.
 * Loaded by T06b from staging.
 */
export const chargePoints = live.table(
  'charge_points',
  {
    idPdcItinerance: text('id_pdc_itinerance').primaryKey().notNull(),
    stationId: text('station_id').notNull(),
    idPdcLocal: text('id_pdc_local'),
    powerKw: numeric('power_kw', { precision: 7, scale: 2 }).notNull(),
    cableT2Attache: boolean('cable_t2_attache'),
    priseTypeEf: boolean('prise_type_ef'),
    priseType2: boolean('prise_type_2'),
    priseTypeComboCcs: boolean('prise_type_combo_ccs'),
    priseTypeChademo: boolean('prise_type_chademo'),
    priseTypeAutre: boolean('prise_type_autre'),
    paiementActe: boolean('paiement_acte'),
    paiementCb: boolean('paiement_cb'),
    paiementAutre: boolean('paiement_autre'),
    gratuit: boolean(),
    observations: text(),
    lastSeenInIrveAt: timestamp('last_seen_in_irve_at', {
      withTimezone: true,
      mode: 'string',
    }),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index('charge_points_station_idx').using(
      'btree',
      t.stationId.asc().nullsLast().op('text_ops'),
    ),
    foreignKey({
      columns: [t.stationId],
      foreignColumns: [stations.idStationItinerance],
      name: 'charge_points_station_id_fkey',
    }).onDelete('cascade'),
    check('charge_points_power_positive', sql`power_kw > (0)::numeric`),
  ],
);

export type Operator = typeof operators.$inferSelect;
export type OperatorInsert = typeof operators.$inferInsert;
export type Network = typeof networks.$inferSelect;
export type NetworkInsert = typeof networks.$inferInsert;
export type Station = typeof stations.$inferSelect;
export type StationInsert = typeof stations.$inferInsert;
export type ChargePoint = typeof chargePoints.$inferSelect;
export type ChargePointInsert = typeof chargePoints.$inferInsert;
