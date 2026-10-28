// Base de datos de pruebas aislada en un esquema propio dentro de la misma
// base. Así no se necesita privilegio CREATEDB y las tablas reales (esquema
// public) quedan intactas.
//
// El nombre incluye el PID: `node --test` ejecuta archivos en paralelo y cada
// proceso (un archivo de test) usa su esquema, evitándose entre sí.
//
// Si PostgreSQL no está disponible, `setupTestDb()` devuelve `reason` y los
// tests de integración se saltan en lugar de fallar.
import pg from 'pg';
import { runMigrations } from '../../src/adapters/out/postgres/migrate.js';

const SCHEMA = `erp_test_${process.pid}`;

export async function setupTestDb() {
  const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) return { pool: null, reason: 'Sin DATABASE_URL ni TEST_DATABASE_URL' };

  const pool = new pg.Pool({
    connectionString: url,
    // search_path en cada conexión: todo lo no calificado cae en el esquema de pruebas.
    options: `-c search_path=${SCHEMA}`,
    connectionTimeoutMillis: 3000,
  });

  try {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.query(`CREATE SCHEMA ${SCHEMA}`);
    await runMigrations(pool);
  } catch (err) {
    await pool.end().catch(() => {});
    return { pool: null, reason: `PostgreSQL no disponible para pruebas: ${err.message}` };
  }

  return {
    pool,
    async teardown() {
      await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
      await pool.end().catch(() => {});
    },
  };
}
