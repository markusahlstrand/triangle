/**
 * The model and the migration journal describe ONE schema.
 *
 * `spec/model.ts` declares each entity's fields; `src/migrations.ts` is the
 * hand-written, append-only SQL the kernel applies. Nothing else holds the two
 * together, so this does: apply the journal to a scratch SQLite database and
 * compare every declared entity's field names with the real columns, in order.
 * A column added to one side and not the other fails here, not in a handler
 * that reads `undefined` off a row.
 */
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { gardenEntities } from '../spec/model.js';
import { gardenMigrations } from '../src/migrations.js';

describe('the model matches the journal', () => {
  const db = new Database(':memory:');
  for (const m of gardenMigrations) db.exec(m.sql);

  for (const [name, entity] of Object.entries(gardenEntities)) {
    it(`${name} → ${entity.table}`, () => {
      const columns = (db.prepare(`PRAGMA table_info(${entity.table})`).all() as { name: string; pk: number }[]);
      expect(columns.map((c) => c.name)).toEqual(Object.keys(entity.fields.shape));
      const declaredKey = (entity as { primaryKey?: readonly string[] }).primaryKey ?? ['id'];
      const actualKey = columns.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
      expect(actualKey).toEqual(declaredKey);
    });
  }
});
