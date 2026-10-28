// Puertos falsos en memoria: permiten testear los casos de uso sin Postgres.
// Replican el contrato de adapters/out/postgres/repositories.js.

const clone = (v) => structuredClone(v);
const nextId = (rows) => rows.reduce((m, r) => Math.max(m, r.id), 0) + 1;
const notFound = (msg) => Object.assign(new Error(msg), { name: 'NotFoundError' });

/**
 * Crea un mundo falso con datos sembrados opcionalmente.
 * `summary` es el valor que devolverá el ReportReader falso.
 */
export function makeFakeWorld(seed = {}) {
  const db = {
    products: clone(seed.products ?? []),
    partners: clone(seed.partners ?? []),
    orders: clone(seed.orders ?? []),
    // Cotizaciones: { id, status, partnerId, items, expiresAt, ... }.
    quotes: clone(seed.quotes ?? []),
    users: clone(seed.users ?? []),
    // Sesiones: token → { userId, expiresAt }.
    sessions: clone(seed.sessions ?? []),
    // Pagos: { id, orderId, amount, method, note, paidAt, createdById }.
    payments: clone(seed.payments ?? []),
    summary: clone(seed.summary ?? {
      sales: 0, purchases: 0, balance: 0, inventoryValue: 0, lowStock: 0,
      receivable: 0, payable: 0,
    }),
  };

  const round2 = (n) => Math.round(n * 100) / 100;

  const products = {
    findAll: async () => clone(db.products),
    findById: async (id) => clone(db.products.find((p) => p.id === Number(id)) ?? null),
    save: async (p) => {
      if (db.products.some((x) => x.sku === p.sku)) {
        throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
      }
      const row = { id: nextId(db.products), ...clone(p) };
      db.products.push(row);
      return clone(row);
    },
    adjustStock: async (id, delta) => {
      const p = db.products.find((x) => x.id === Number(id));
      if (!p) throw notFound(`Producto ${id} no existe`);
      p.stock += delta;
    },
  };

  const partners = {
    findAll: async (kind) => clone(db.partners.filter((p) => !kind || p.kind === kind)),
    findById: async (id) => clone(db.partners.find((p) => p.id === Number(id)) ?? null),
    save: async (p) => {
      const row = { id: nextId(db.partners), ...clone(p) };
      db.partners.push(row);
      return clone(row);
    },
  };

  const orders = {
    findAll: async (kind) => clone(db.orders.filter((o) => !kind || o.kind === kind)),
    findById: async (id, { lock = false } = {}) => {
      const o = db.orders.find((x) => x.id === Number(id));
      if (!o) return null;
      // `lock` se ignora en memoria: no hay concurrencia real en el fake.
      return { id: o.id, kind: o.kind, partnerId: o.partnerId, total: o.total };
    },
    paidByOrder: async (orderId) =>
      round2(db.payments.filter((p) => p.orderId === Number(orderId))
        .reduce((s, p) => s + p.amount, 0)),
    savePayment: async (orderId, payment, createdById) => {
      const row = {
        id: db.payments.reduce((m, p) => Math.max(m, p.id), 0) + 1,
        orderId: Number(orderId),
        createdById: createdById ?? null,
        paidAt: new Date().toISOString(),
        ...clone(payment),
      };
      db.payments.push(row);
      return clone(row);
    },
    save: async (order) => {
      const id = nextId(db.orders);
      const row = { id, ...clone(order), createdAt: new Date().toISOString() };
      db.orders.push(row);
      return clone(row);
    },
    // Detalle con el mismo shape que el repositorio Postgres real.
    findDetail: async (id) => {
      const o = db.orders.find((x) => x.id === Number(id));
      if (!o) return null;
      const partner = db.partners.find((p) => p.id === o.partnerId);
      const payments = db.payments.filter((p) => p.orderId === o.id);
      const paid = round2(payments.reduce((s, p) => s + p.amount, 0));
      return {
        id: o.id,
        kind: o.kind,
        partnerId: o.partnerId,
        partner: partner?.name ?? null,
        partnerKind: partner?.kind ?? null,
        subtotal: o.subtotal ?? o.total,
        tax: o.tax ?? 0,
        total: o.total,
        createdAt: o.createdAt,
        items: (o.items ?? []).map((i) => {
          const prod = db.products.find((p) => p.id === i.productId);
          return {
            productId: i.productId,
            sku: prod?.sku ?? null,
            name: prod?.name ?? null,
            quantity: i.quantity,
            unitPrice: i.unitPrice,
            taxRate: i.taxRate ?? 16,
          };
        }),
        payments: clone(payments),
        paid,
        balance: round2(o.total - paid),
      };
    },
  };

  // Dashboard agregado en memoria: misma forma que la implementación Postgres.
  // (La serie mensual se deja vacía: generarla requiere fechas relativas y la
  // cubre el test de integración contra la BD real.)
  const reports = {
    summary: async () => clone(db.summary),
    dashboard: async (months = 12) => {
      const byMethod = {};
      for (const p of db.payments) {
        byMethod[p.method] ??= { method: p.method, total: 0, count: 0 };
        byMethod[p.method].total = round2(byMethod[p.method].total + p.amount);
        byMethod[p.method].count += 1;
      }
      const byStatus = {};
      for (const q of db.quotes) byStatus[q.status] = (byStatus[q.status] ?? 0) + 1;

      const byProduct = {};
      const byPartner = {};
      for (const o of db.orders.filter((x) => x.kind === 'sale')) {
        const pt = db.partners.find((p) => p.id === o.partnerId);
        byPartner[o.partnerId] ??= { name: pt?.name ?? `#${o.partnerId}`, total: 0, orders: 0 };
        byPartner[o.partnerId].total = round2(byPartner[o.partnerId].total + o.total);
        byPartner[o.partnerId].orders += 1;
        for (const l of o.items ?? []) {
          const prod = db.products.find((p) => p.id === l.productId);
          byProduct[l.productId] ??= { name: prod?.name ?? `#${l.productId}`, sku: prod?.sku ?? null, units: 0, revenue: 0 };
          byProduct[l.productId].units += l.quantity;
          byProduct[l.productId].revenue = round2(byProduct[l.productId].revenue + l.quantity * l.unitPrice);
        }
      }
      const top = (rows) => rows.sort((a, b) => (b.revenue ?? b.total) - (a.revenue ?? a.total)).slice(0, 5);

      return {
        months,
        summary: clone(db.summary),
        monthly: [],
        topProducts: top(Object.values(byProduct)),
        topCustomers: top(Object.values(byPartner)),
        paymentMethods: Object.values(byMethod).sort((a, b) => b.total - a.total),
        quoteStatuses: Object.entries(byStatus)
          .map(([status, count]) => ({ status, count }))
          .sort((a, b) => b.count - a.count),
      };
    },
  };

  // Usuarios y sesiones (contrato idéntico a adapters/out/postgres/authRepositories.js).
  const users = {
    findAll: async () => clone(db.users),
    findByEmail: async (email) => clone(db.users.find((u) => u.email === email) ?? null),
    findById: async (id) => clone(db.users.find((u) => u.id === Number(id)) ?? null),
    save: async (u) => {
      if (db.users.some((x) => x.email === u.email)) {
        throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
      }
      const row = { id: nextId(db.users), createdAt: new Date().toISOString(), ...clone(u) };
      db.users.push(row);
      return clone(row);
    },
    update: async (u) => {
      const i = db.users.findIndex((x) => x.id === Number(u.id));
      if (i === -1) throw notFound(`Usuario ${u.id} no existe`);
      db.users[i] = { ...db.users[i], ...clone(u) };
      return clone(db.users[i]);
    },
  };

  let tokenSeq = 0;
  const sessions = {
    create: async (userId, ttlDays) => {
      const token = `fake-token-${++tokenSeq}`;
      db.sessions.push({ token, userId, expiresAt: Date.now() + ttlDays * 86_400_000 });
      return token;
    },
    findByToken: async (token) => {
      const s = db.sessions.find((x) => x.token === token);
      if (!s || s.expiresAt <= Date.now()) return null;
      return clone(db.users.find((u) => u.id === s.userId) ?? null);
    },
    delete: async (token) => {
      db.sessions = db.sessions.filter((x) => x.token !== token);
    },
    deleteExpired: async () => {
      db.sessions = db.sessions.filter((x) => x.expiresAt > Date.now());
    },
  };

  // Hash trivial (predecible) para tests: NO usar en producción.
  const passwords = {
    hash: async (plain) => `fake:${plain}`,
    verify: async (plain, stored) => stored === `fake:${plain}`,
  };

  // Cotizaciones (contrato de adapters/out/postgres/quoteRepository.js).
  const quotes = {
    findAll: async (status) => clone(db.quotes.filter((q) => !status || q.status === status)),
    findById: async (id, { lock = false } = {}) => {
      const q = db.quotes.find((x) => x.id === Number(id));
      if (!q) return null;
      void lock; // sin concurrencia real en el fake
      const partner = db.partners.find((p) => p.id === q.partnerId);
      return {
        ...clone(q),
        partner: partner?.name ?? null,
        partnerKind: partner?.kind ?? null,
        items: (q.items ?? []).map((i) => {
          const prod = db.products.find((p) => p.id === i.productId);
          return {
            ...clone(i),
            sku: prod?.sku ?? null,
            name: prod?.name ?? null,
          };
        }),
      };
    },
    save: async (quote) => {
      const id = nextId(db.quotes);
      const row = {
        id,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...clone(quote),
      };
      db.quotes.push(row);
      return clone(row);
    },
    transition: async (id, status, { convertedOrderId = null } = {}) => {
      const q = db.quotes.find((x) => x.id === Number(id));
      if (!q) return null;
      q.status = status;
      if (convertedOrderId) q.convertedOrderId = convertedOrderId;
      q.updatedAt = new Date().toISOString();
      return clone(q);
    },
  };

  // Transacciones con "todo o nada": snapshot al entrar, restauración si el
  // trabajo lanza excepción (mismo contrato que makeTransactionManager real).
  const repos = { products, partners, orders, quotes };
  const transactions = {
    async run(work) {
      const snapshot = clone(db);
      try {
        return await work(repos);
      } catch (err) {
        Object.assign(db, snapshot);
        throw err;
      }
    },
  };

  return { db, products, partners, orders, quotes, users, sessions, passwords, reports, transactions };
}
