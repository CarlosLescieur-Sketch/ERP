// Carga backend/.env si existe, sin pisar variables ya definidas (la misma
// semántica que `node --env-file`, pero compatible con Node 20.6+).
// Se inyecta con `node --import ./test/loadEnv.js --test`.
import { existsSync, readFileSync } from 'node:fs';

const envFile = new URL('../.env', import.meta.url);
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}
