import { pool } from './adapters/out/postgres/pool.js';
import {
  buildRepositories, makeReportReader, makeTransactionManager,
} from './adapters/out/postgres/repositories.js';
import { makeUseCases } from './application/useCases.js';
import { createServer } from './adapters/in/http/server.js';

// Aquí (y solo aquí) se conectan adaptadores con puertos.
const repos = buildRepositories(pool);
const useCases = makeUseCases({
  ...repos,
  reports: makeReportReader(pool),
  transactions: makeTransactionManager(pool),
});

const port = process.env.PORT || 3000;
createServer(useCases).listen(port, () => console.log(`API lista en http://localhost:${port}`));
