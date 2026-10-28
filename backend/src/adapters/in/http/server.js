import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { DomainError, NotFoundError, UnauthorizedError, ForbiddenError } from '../../../domain/errors.js';
import { can, permissionsFor } from '../../../domain/user.js';
import { sessionTokenFrom, sessionCookie, clearSessionCookie } from './cookies.js';
import { loginRateLimit } from './rateLimit.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((data) => res.json(data)).catch(next);

// findDetail devuelve null si no existe: lo traduce al 404 del dominio.
const mustOrder = (orderPromise, label) =>
  orderPromise.then((o) => { if (!o) throw new NotFoundError(`${label} inexistente`); return o; });

export function createServer(uc, { sessionTtlDays = 7 } = {}) {
  const app = express();
  // Headers de seguridad (CSP, X-Frame-Options, etc.). La API no sirve HTML,
  // pero no cuesta nada tenerlos.
  app.use(helmet());
  // Credenciales (cookies de sesión) solo para los orígenes declarados.
  const origins = (process.env.CORS_ORIGIN ?? 'http://localhost:5173').split(',').map((s) => s.trim());
  app.use(cors({ origin: origins, credentials: true }));
  app.use(express.json({ limit: '100kb' }));

  const ttlSeconds = sessionTtlDays * 86_400;

  // Resuelve la sesión de la cookie (si la hay) en req.user. No rechaza: eso
  // lo decide requireAuth en cada ruta.
  app.use(async (req, _res, next) => {
    try {
      req.user = await uc.sessionUser(sessionTokenFrom(req));
      next();
    } catch (err) { next(err); }
  });

  const requireAuth = (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Sesión requerida' });
    next();
  };
  // Misma idea que requireAuth, pero con el rol del usuario (domain/user.js `can`).
  const requirePermission = (permission) => (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Sesión requerida' });
    if (!can(req.user.role, permission)) return res.status(403).json({ error: 'No tienes permiso para esta acción' });
    next();
  };

  /* ---------- Públicas ---------- */
  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  app.post('/api/auth/login', loginRateLimit, wrap(async (req, res) => {
    const { token, user } = await uc.login(req.body);
    res.set('Set-Cookie', sessionCookie(token, { maxAgeSeconds: ttlSeconds, secure: req.secure }));
    return { user: { ...user, permissions: permissionsFor(user.role) } };
  }));

  app.post('/api/auth/logout', wrap(async (req, res) => {
    await uc.logout(sessionTokenFrom(req));
    res.set('Set-Cookie', clearSessionCookie({ secure: req.secure }));
    return { ok: true };
  }));

  /* ---------- Sesión actual ---------- */
  app.get('/api/auth/me', requireAuth, (req, res) =>
    res.json({ user: { ...req.user, permissions: permissionsFor(req.user.role) } }));

  app.post('/api/auth/change-password', requireAuth, wrap((req) =>
    uc.changePassword(req.body, req.user)));

  /* ---------- Usuarios (admin) ---------- */
  app.get('/api/users', requirePermission('users:manage'), wrap(() => uc.listUsers()));
  app.post('/api/users', requirePermission('users:manage'), wrap((req) => uc.createUser(req.body, req.user)));

  /* ---------- Negocio (sesión requerida; escritura según rol) ---------- */
  app.get('/api/summary', requireAuth, wrap(() => uc.getSummary()));
  app.get('/api/reports/dashboard', requireAuth,
    wrap((req) => uc.getDashboard({ months: req.query.months })));

  app.get('/api/products', requireAuth, wrap(() => uc.listProducts()));
  app.post('/api/products', requirePermission('products:write'), wrap((req) => uc.createProduct(req.body)));

  app.get('/api/partners', requireAuth, wrap((req) => uc.listPartners(req.query.kind)));
  app.post('/api/partners', requirePermission('partners:write'), wrap((req) => uc.createPartner(req.body)));

  app.get('/api/purchases', requireAuth, wrap(() => uc.listPurchases()));
  app.post('/api/purchases', requirePermission('purchases:write'), wrap((req) => uc.registerPurchase(req.body)));
  app.get('/api/purchases/:id', requireAuth, wrap((req) => mustOrder(uc.getOrder(req.params.id), 'Compra')));
  app.post('/api/purchases/:id/payments', requirePermission('payments:write'),
    wrap((req) => uc.registerPurchasePayment(req.params.id, req.body, req.user)));

  app.get('/api/sales', requireAuth, wrap(() => uc.listSales()));
  app.post('/api/sales', requirePermission('sales:write'), wrap((req) => uc.registerSale(req.body)));
  app.get('/api/sales/:id', requireAuth, wrap((req) => mustOrder(uc.getOrder(req.params.id), 'Venta')));
  app.post('/api/sales/:id/payments', requirePermission('payments:write'),
    wrap((req) => uc.registerSalePayment(req.params.id, req.body, req.user)));

  // --- Cotizaciones: lectura para todos; estados y conversión con permiso ---
  app.get('/api/quotes', requireAuth, wrap((req) => uc.listQuotes(req.query.status ?? null)));
  app.post('/api/quotes', requirePermission('quotes:write'), wrap((req) => uc.createQuote(req.body, req.user)));
  app.get('/api/quotes/:id', requireAuth, wrap(async (req) => {
    const q = await uc.getQuote(req.params.id);
    if (!q) throw new NotFoundError('La cotización inexistente');
    return q;
  }));
  app.patch('/api/quotes/:id/status', requirePermission('quotes:write'),
    wrap((req) => uc.transitionQuote(req.params.id, req.body?.status)));
  app.post('/api/quotes/:id/convert', requirePermission('quotes:write'),
    wrap((req) => uc.convertQuoteToSale(req.params.id, req.user)));

  // Traducción de errores del dominio a HTTP
  app.use((err, _req, res, _next) => {
    if (err instanceof DomainError) return res.status(400).json({ error: err.message });
    if (err instanceof UnauthorizedError) return res.status(401).json({ error: err.message });
    if (err instanceof ForbiddenError) return res.status(403).json({ error: err.message });
    if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
    if (err.code === '23505') return res.status(409).json({ error: 'Ya existe un registro con ese valor único (¿SKU o correo repetido?)' });
    console.error(err);
    res.status(500).json({ error: 'Error interno del servidor' });
  });
  return app;
}
