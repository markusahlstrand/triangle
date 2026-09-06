import type { SqlMigration } from '@substrat-run/kernel';

// ============================================================================
// The garden module's OWN tables (concept §7), prefixed `garden_` so they can
// never collide with anything. Ids are TEXT (ULIDs), timestamps ISO-8601 TEXT,
// all lengths/coordinates REAL meters. Migrations are append-only and ordered:
// once a version has shipped, you add a new one, you never edit it.
// ============================================================================

export const gardenMigrations: SqlMigration[] = [
  {
    version: '0001-init',
    sql: `
      CREATE TABLE garden_sites (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        datum_note  TEXT,                 -- "terrace floor = 0.00"
        created_at  TEXT NOT NULL
      );

      -- Survey points. seq is the creation order the solver's frame depends on:
      -- the lowest-seq point is the origin, the second the baseline (concept §2).
      -- x/y are SOLVER OUTPUT (meters), never hand-edited; status mirrors the
      -- lifecycle named/measured/placed. side records the mirror choice as the
      -- sign of the cross product against the point's first two anchors.
      CREATE TABLE garden_points (
        id          TEXT PRIMARY KEY,
        site_id     TEXT NOT NULL REFERENCES garden_sites(id),
        seq         INTEGER NOT NULL,
        name        TEXT NOT NULL,
        elevation_m REAL,
        x           REAL,
        y           REAL,
        status      TEXT NOT NULL DEFAULT 'named',  -- named | measured | placed
        side        INTEGER,                        -- -1 | 1 | NULL
        locked      INTEGER NOT NULL DEFAULT 0,
        note        TEXT,
        created_at  TEXT NOT NULL
      );
      CREATE INDEX garden_points_site ON garden_points(site_id, seq);

      -- Tape pulls, in meters. Corrections are new rows / audited deletes.
      CREATE TABLE garden_measurements (
        id          TEXT PRIMARY KEY,
        site_id     TEXT NOT NULL REFERENCES garden_sites(id),
        point_a     TEXT NOT NULL REFERENCES garden_points(id),
        point_b     TEXT NOT NULL REFERENCES garden_points(id),
        distance_m  REAL NOT NULL,
        note        TEXT,
        created_at  TEXT NOT NULL
      );
      CREATE INDEX garden_measurements_site ON garden_measurements(site_id);

      -- Solver assumptions (concept §2/§7): right-angle | parallel |
      -- equal-length | colinear. points_json is the ordered id list whose
      -- meaning depends on kind ([at, from, to] for right-angle; [a1,a2,b1,b2]
      -- for parallel/equal-length; [p1..pn] for colinear).
      CREATE TABLE garden_constraints (
        id          TEXT PRIMARY KEY,
        site_id     TEXT NOT NULL REFERENCES garden_sites(id),
        kind        TEXT NOT NULL,
        points_json TEXT NOT NULL,
        created_at  TEXT NOT NULL
      );
      CREATE INDEX garden_constraints_site ON garden_constraints(site_id);

      -- Built fabric drawn through points: retention-wall | pool | terrace |
      -- stairs | house | fence | bed | path. props_json carries per-type extras
      -- (wall height, step count …).
      CREATE TABLE garden_features (
        id          TEXT PRIMARY KEY,
        site_id     TEXT NOT NULL REFERENCES garden_sites(id),
        type        TEXT NOT NULL,
        name        TEXT NOT NULL,
        closed      INTEGER NOT NULL DEFAULT 0,
        props_json  TEXT NOT NULL DEFAULT '{}',
        created_at  TEXT NOT NULL
      );
      CREATE INDEX garden_features_site ON garden_features(site_id);

      -- The ordered point-run that gives a feature its shape; curved_to_next
      -- marks a smooth segment (concept §2). Features never store coordinates.
      CREATE TABLE garden_feature_vertices (
        feature_id     TEXT NOT NULL REFERENCES garden_features(id),
        seq            INTEGER NOT NULL,
        point_id       TEXT NOT NULL REFERENCES garden_points(id),
        curved_to_next INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (feature_id, seq)
      );

      -- The species library (per tenant): names that appear on DXF labels, and
      -- the growth numbers the future growth view will animate.
      CREATE TABLE garden_species (
        id                TEXT PRIMARY KEY,
        common_name       TEXT NOT NULL,
        latin_name        TEXT,
        category          TEXT NOT NULL DEFAULT 'tree', -- tree | shrub | hedge | perennial | climber
        mature_canopy_m   REAL,
        mature_height_m   REAL,
        years_to_mature   REAL,
        created_at        TEXT NOT NULL
      );

      CREATE TABLE garden_plants (
        id          TEXT PRIMARY KEY,
        site_id     TEXT NOT NULL REFERENCES garden_sites(id),
        point_id    TEXT NOT NULL REFERENCES garden_points(id),
        species_id  TEXT NOT NULL REFERENCES garden_species(id),
        label       TEXT,                 -- falls back to the species common name
        planted_on  TEXT,                 -- ISO date
        note        TEXT,
        created_at  TEXT NOT NULL
      );
      CREATE INDEX garden_plants_site ON garden_plants(site_id);
    `,
  },
];
