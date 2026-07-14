-- 007_globals_table.sql
-- Classification: REVERSIBLE (additive table only; drop-safe rollback of new object)
-- Fixes a schema/DR gap discovered via real-MySQL test proof (2026-07-14): readGlobal()/
-- readConventions() in src/server/db.ts and src/server/board-store.ts unconditionally query
-- `globals` (key-value JSON store keyed by k, e.g. k='conventions'), but no prior migration
-- created this table. Existing staging/production databases already have it (created outside
-- the migration system), so IF NOT EXISTS makes this a no-op there; a fresh/greenfield
-- database was missing it entirely, breaking any board read path that calls readConventions()
-- (e.g. add_comment, readBoard). No FOREIGN KEY; no data seeded — reads already fall back to
-- caller-supplied defaults when a key row is absent.

CREATE TABLE IF NOT EXISTS globals (
  k VARCHAR(64) NOT NULL,
  data JSON NOT NULL,
  PRIMARY KEY (k)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
