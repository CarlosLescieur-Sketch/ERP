import express from 'express';
import cors from 'cors';
import { DomainError, NotFoundError } from '../../../domain/errors.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((data) => res.json(data)).catch(next);

export function createServer(uc) {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.get('/api/summary', wrap(() => uc.getSummary()));

  app.get('/api/products', wrap(() => uc.listProducts()));
  app.post('/api/products', wrap((req) => uc.createProduct(req.body)));

  app.get('/api/partners', wrap((req) => uc.listPartners(req.query.kind)));
  app.post('/api/partners', wrap((req) => uc.createPartner(req.body)));

  app.get('/api/purchases', wrap(() => uc.listPurchases()));
  app.post('/api/purchases', wrap((req) => uc.registerPurchase(req.body)));

  app.get('/api/sales', wrap(() => uc.listSales()));
  app.post('/api/sales', wrap((req) => uc.registerSale(req.body)));

  // Traducción de errores del dominio a HTTP
  app.use((err, _req, res, _next) => {
    if (err instanceof DomainError) return res.status(400).json({ error: err.message });
    if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
    if (err.code === '23505') return res.status(409).json({ error: 'Ya existe un registro con ese valor único (¿SKU repetido?)' });
    console.error(err);
    res.status(500).json({ error: 'Error interno del servidor' });
  });
  return app;
}
