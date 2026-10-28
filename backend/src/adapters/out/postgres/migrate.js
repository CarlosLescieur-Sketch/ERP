// Migraciones versionadas.
//
// Archivos en backend/migrations/ con nombre NNN_descripcion.sql, aplicados en
// orden y registrados en la tabla `schema_migrations` (uno por transacción).
// Una migración aplicada nunca se vuelve a ejecutar ni se modifica.
//
// Baselining: si la base ya tiene el esquema anterior (tabla `products` pero sin
// `schema_migrations`), la primera migración se marca como aplicada sin
// ejecutarla, para no chocar con tablas que ya existen.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { pool } from './pool.js';

const MIGRATIONS_DIR = new URL('../../../../migrations/', import.meta.url);
// El "version" registrado es el nombre completo del archivo (p. ej. `001_init.sql`).
const FIRST_MIGRATION = '001_init.sql';

const tableExists = async (db, name) => {
  const { rows } = await db.query('SELECT to_regclass($1) IS NOT NULL AS ok', [name]);
  return rows[0].ok;
};

/**
 * Aplica las migraciones pendientes de `dir`.
 * @param {import('pg').Pool} pool instancia con la que se trabaja (la de pruebas
 *   o la real); cada migración corre en su propia transacción.
 * @param {{dir?: URL, log?: (msg:string)=>void}} [opts]
 */
export async function runMigrations(pool, { dir = MIGRATIONS_DIR, log = () => {} } = {}) {
  const files = readdirSync(dir)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort();
  if (files.length === 0) throw new Error(`No hay migraciones en ${dir.pathname}`);

  const client = await pool.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const { rows } = await client.query('SELECT version FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.version));

    // Baselining: esquema previo al sistema de migraciones (tabla `products` ya
    // existe pero nunca se registró ninguna migración).
    if (!applied.has(FIRST_MIGRATION) && files.includes(FIRST_MIGRATION)
        && (await tableExists(client, 'products'))) {
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [FIRST_MIGRATION]);
      applied.add(FIRST_MIGRATION);
      log(`Base existente detectada: ${FIRST_MIGRATION} marcada como aplicada (baselining)`);
    }

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = readFileSync(new URL(file, dir), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        await client.query('COMMIT');
        log(`Migración aplicada: ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Falló la migración ${file}: ${err.message}`);
      }
    }
    log('Base de datos al día');
  } finally {
    client.release();
  }
}

// Ejecutable directo: `npm run migrate` (NO se ejecuta al importarlo en tests).
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    await runMigrations(pool, { log: console.log });
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
