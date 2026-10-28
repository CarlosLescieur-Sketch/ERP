import { pool } from './adapters/out/postgres/pool.js';
import {
  buildRepositories, makeReportReader, makeTransactionManager,
} from './adapters/out/postgres/repositories.js';
import { makeUserRepository, makeSessionRepository } from './adapters/out/postgres/authRepositories.js';
import { passwords } from './adapters/out/crypto/passwords.js';
import { makeUseCases } from './application/useCases.js';
import { createServer } from './adapters/in/http/server.js';

// Aquí (y solo aquí) se conectan adaptadores con puertos.
const repos = buildRepositories(pool);
const useCases = makeUseCases({
  ...repos,
  reports: makeReportReader(pool),
  transactions: makeTransactionManager(pool),
  users: makeUserRepository(pool),
  sessions: makeSessionRepository(pool),
  passwords,
  sessionTtlDays: Number(process.env.SESSION_TTL_DAYS ?? 7),
});

const port = process.env.PORT || 3000;
createServer(useCases, { sessionTtlDays: Number(process.env.SESSION_TTL_DAYS ?? 7) })
  .listen(port, () => console.log(`API lista en http://localhost:${port}`));
