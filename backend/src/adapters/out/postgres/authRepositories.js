// Repositorios de autenticación: usuarios y sesiones.
import { randomBytes } from 'node:crypto';

const toUser = (r) => ({
  id: r.id,
  email: r.email,
  passwordHash: r.password_hash,
  name: r.name,
  role: r.role,
  active: r.active,
  createdAt: r.created_at,
});

export const makeUserRepository = (db) => ({
  async findAll() {
    const { rows } = await db.query('SELECT * FROM users ORDER BY name');
    return rows.map(toUser);
  },
  async findByEmail(email) {
    const { rows } = await db.query('SELECT * FROM users WHERE email = $1', [email]);
    return rows[0] ? toUser(rows[0]) : null;
  },
  async findById(id) {
    const { rows } = await db.query('SELECT * FROM users WHERE id = $1', [id]);
    return rows[0] ? toUser(rows[0]) : null;
  },
  async save(u) {
    const { rows } = await db.query(
      'INSERT INTO users (email, password_hash, name, role, active) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [u.email, u.passwordHash, u.name, u.role, u.active]);
    return toUser(rows[0]);
  },
  async update(u) {
    const { rows } = await db.query(
      'UPDATE users SET password_hash = $2, active = $3 WHERE id = $1 RETURNING *',
      [u.id, u.passwordHash, u.active]);
    return toUser(rows[0]);
  },
});

export const makeSessionRepository = (db) => ({
  /** Crea la sesión y devuelve el token opaco (43 caracteres, 256 bits). */
  async create(userId, ttlDays) {
    const token = randomBytes(32).toString('base64url');
    await db.query(
      'INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))',
      [token, userId, ttlDays]);
    return token;
  },
  /** Devuelve el usuario dueño de la sesión válida, o null si no existe/expiró. */
  async findByToken(token) {
    const { rows } = await db.query(
      `SELECT u.* FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.token = $1 AND s.expires_at > now()`,
      [token ?? '']);
    return rows[0] ? toUser(rows[0]) : null;
  },
  async delete(token) {
    await db.query('DELETE FROM sessions WHERE token = $1', [token ?? '']);
  },
  async deleteExpired() {
    await db.query('DELETE FROM sessions WHERE expires_at <= now()');
  },
});
