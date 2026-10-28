// Rate limiting en memoria para el login: ventana deslizante por IP+correo.
// Suficiente para una instancia única; si el sistema escala a varias
// instancias, se mueve a un almacén compartido (p. ej. Redis) tras este mismo
// contrato (req → next | 429).
const WINDOW_MS = 15 * 60_000; // 15 minutos
const MAX_ATTEMPTS = 10;

const attempts = new Map(); // clave → [timestamp, ...]

export function loginRateLimit(req, res, next) {
  const key = `${req.ip}|${String(req.body?.email ?? '').toLowerCase()}`;
  const now = Date.now();
  const hits = (attempts.get(key) ?? []).filter((t) => now - t < WINDOW_MS);

  if (hits.length >= MAX_ATTEMPTS) {
    res.set('Retry-After', String(Math.ceil(WINDOW_MS / 1000)));
    return res.status(429).json({ error: 'Demasiados intentos. Intenta de nuevo en unos minutos.' });
  }

  hits.push(now);
  attempts.set(key, hits);

  // Limpieza ocasional para que el mapa no crezca sin límite.
  if (attempts.size > 10_000) {
    for (const [k, v] of attempts) if (v.every((t) => now - t >= WINDOW_MS)) attempts.delete(k);
  }
  next();
}
