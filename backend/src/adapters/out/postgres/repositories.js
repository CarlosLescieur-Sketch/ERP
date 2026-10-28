import { makeQuoteRepository } from './quoteRepository.js';

// `db` puede ser el Pool (consultas sueltas) o un Client dentro de una transacción.
const toProduct = (r) => ({ id: r.id, sku: r.sku, name: r.name, price: Number(r.price), cost: Number(r.cost), stock: r.stock });
const round2 = (n) => Math.round(n * 100) / 100;

export const makeProductRepository = (db) => ({
  async findAll() {
    const { rows } = await db.query('SELECT * FROM products ORDER BY name');
    return rows.map(toProduct);
  },
  async findById(id, { lock = false } = {}) {
    const { rows } = await db.query(`SELECT * FROM products WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`, [id]);
    return rows[0] ? toProduct(rows[0]) : null;
  },
  async save(p) {
    const { rows } = await db.query(
      'INSERT INTO products (sku, name, price, cost, stock) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [p.sku, p.name, p.price, p.cost, p.stock]);
    return toProduct(rows[0]);
  },
  async adjustStock(id, delta) {
    await db.query('UPDATE products SET stock = stock + $2 WHERE id = $1', [id, delta]);
  },
});

export const makePartnerRepository = (db) => ({
  async findAll(kind) {
    const { rows } = await db.query(
      `SELECT * FROM partners ${kind ? 'WHERE kind = $1' : ''} ORDER BY name`, kind ? [kind] : []);
    return rows;
  },
  async findById(id) {
    const { rows } = await db.query('SELECT * FROM partners WHERE id = $1', [id]);
    return rows[0] ?? null;
  },
  async save(p) {
    const { rows } = await db.query(
      'INSERT INTO partners (kind, name, email, phone) VALUES ($1,$2,$3,$4) RETURNING *',
      [p.kind, p.name, p.email, p.phone]);
    return rows[0];
  },
});

export const makeOrderRepository = (db) => ({
  async findAll(kind) {
    const { rows } = await db.query(
      `SELECT o.id, o.kind, o.total, o.subtotal, o.tax, o.created_at, p.name AS partner,
              COALESCE(SUM(i.quantity), 0)::int AS units,
              COALESCE((SELECT SUM(pay.amount) FROM payments pay WHERE pay.order_id = o.id), 0) AS paid
         FROM orders o
         JOIN partners p ON p.id = o.partner_id
         LEFT JOIN order_items i ON i.order_id = o.id
        WHERE ($1::text IS NULL OR o.kind = $1)
        GROUP BY o.id, p.name
        ORDER BY o.created_at DESC LIMIT 100`, [kind ?? null]);
    return rows.map((r) => ({
      ...r,
      total: Number(r.total),
      subtotal: Number(r.subtotal),
      tax: Number(r.tax),
      paid: Number(r.paid),
      // Saldo siempre calculado (total − pagado), nunca almacenado.
      balance: round2(Number(r.total) - Number(r.paid)),
    }));
  },

  /** Orden básica para transacciones. `{lock: true}` añade FOR UPDATE. */
  async findById(id, { lock = false } = {}) {
    const { rows } = await db.query(
      `SELECT id, kind, partner_id, total FROM orders WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`, [id]);
    if (!rows[0]) return null;
    return {
      id: rows[0].id,
      kind: rows[0].kind,
      partnerId: rows[0].partner_id,
      total: Number(rows[0].total),
    };
  },

  /** Suma pagada de una orden (la fuente del saldo). */
  async paidByOrder(orderId) {
    const { rows } = await db.query(
      'SELECT COALESCE(SUM(amount), 0) AS paid FROM payments WHERE order_id = $1', [orderId]);
    return round2(Number(rows[0].paid));
  },

  /** Detalle completo: cabecera + líneas + pagos. Null si no existe. */
  async findDetail(id) {
    const { rows } = await db.query(
      `SELECT o.*, p.name AS partner, p.kind AS partner_kind
         FROM orders o JOIN partners p ON p.id = o.partner_id
        WHERE o.id = $1`, [id]);
    if (!rows[0]) return null;
    const order = rows[0];
    const items = await db.query(
      `SELECT i.id, i.product_id, i.quantity, i.unit_price, i.tax_rate, pr.sku, pr.name
         FROM order_items i JOIN products pr ON pr.id = i.product_id
        WHERE i.order_id = $1 ORDER BY i.id`, [id]);
    const payments = await db.query(
      `SELECT pay.id, pay.amount, pay.method, pay.note, pay.paid_at, u.name AS created_by_name
         FROM payments pay LEFT JOIN users u ON u.id = pay.created_by
        WHERE pay.order_id = $1 ORDER BY pay.paid_at DESC, pay.id DESC`, [id]);
    const paid = payments.rows.reduce((s, p) => s + Number(p.amount), 0);
    return {
      id: order.id,
      kind: order.kind,
      partnerId: order.partner_id,
      partner: order.partner,
      partnerKind: order.partner_kind,
      subtotal: Number(order.subtotal),
      tax: Number(order.tax),
      total: Number(order.total),
      createdAt: order.created_at,
      items: items.rows.map((i) => ({
        productId: i.product_id,
        sku: i.sku,
        name: i.name,
        quantity: i.quantity,
        unitPrice: Number(i.unit_price),
        taxRate: Number(i.tax_rate),
      })),
      payments: payments.rows.map((p) => ({
        id: p.id,
        amount: Number(p.amount),
        method: p.method,
        note: p.note,
        paidAt: p.paid_at,
        createdBy: p.created_by_name,
      })),
      paid: round2(paid),
      balance: round2(Number(order.total) - paid),
    };
  },

  async save(order) {
    const { rows } = await db.query(
      `INSERT INTO orders (kind, partner_id, subtotal, tax, total)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at`,
      [order.kind, order.partnerId, order.subtotal, order.tax, order.total]);
    const id = rows[0].id;
    for (const l of order.items) {
      await db.query(
        `INSERT INTO order_items (order_id, product_id, quantity, unit_price, tax_rate)
         VALUES ($1,$2,$3,$4,$5)`,
        [id, l.productId, l.quantity, l.unitPrice, l.taxRate]);
    }
    return { id, ...order, createdAt: rows[0].created_at };
  },

  /** Registra un pago (ya validado el saldo por el caso de uso). */
  async savePayment(orderId, payment, createdById) {
    const { rows } = await db.query(
      `INSERT INTO payments (order_id, amount, method, note, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, paid_at`,
      [orderId, payment.amount, payment.method, payment.note, createdById ?? null]);
    return { id: rows[0].id, orderId, ...payment, paidAt: rows[0].paid_at };
  },
});

// Resumen financiero global (lo comparten GET /api/summary y el dashboard).
const readSummary = async (db) => {
  const { rows } = await db.query(`
    SELECT
      COALESCE((SELECT SUM(total) FROM orders WHERE kind = 'sale'), 0)     AS sales,
      COALESCE((SELECT SUM(total) FROM orders WHERE kind = 'purchase'), 0) AS purchases,
      COALESCE((SELECT SUM(stock * cost) FROM products), 0)                AS inventory_value,
      (SELECT COUNT(*) FROM products WHERE stock <= 5)::int                AS low_stock,
      -- Saldos: total − pagado, por cada orden viva (todo lo que no está saldado).
      COALESCE((SELECT SUM(o.total - COALESCE(p.paid, 0)) FROM orders o
                  LEFT JOIN (SELECT order_id, SUM(amount) AS paid FROM payments GROUP BY order_id) p
                    ON p.order_id = o.id
                 WHERE o.kind = 'sale'), 0)                                AS receivable,
      COALESCE((SELECT SUM(o.total - COALESCE(p.paid, 0)) FROM orders o
                  LEFT JOIN (SELECT order_id, SUM(amount) AS paid FROM payments GROUP BY order_id) p
                    ON p.order_id = o.id
                 WHERE o.kind = 'purchase'), 0)                            AS payable`);
  const r = rows[0];
  const sales = Number(r.sales), purchases = Number(r.purchases);
  return {
    sales,
    purchases,
    balance: sales - purchases,
    inventoryValue: Number(r.inventory_value),
    lowStock: r.low_stock,
    receivable: round2(Number(r.receivable)), // por cobrar (ventas sin saldar)
    payable: round2(Number(r.payable)),       // por pagar (compras sin saldar)
  };
};

export const makeReportReader = (db) => ({
  summary: () => readSummary(db),

  /**
   * Datos del dashboard de Resumen, todo en una sola petición:
   *  - summary: los KPI globales (mismo contenido que GET /api/summary)
   *  - monthly: serie continua de los últimos `months` meses (meses sin
   *    movimientos se rellenan con 0 para que las gráficas no "salten")
   *  - topProducts / topCustomers: rankings dentro de la ventana elegida
   *  - paymentMethods: cobros agrupados por método en la ventana
   *  - quoteStatuses: cotizaciones agrupadas por estado (estado actual)
   */
  async dashboard(months = 12) {
    const windowStart =
      `date_trunc('month', now()) - ($1::int - 1)::double precision * interval '1 month'`;

    const [summary, monthly, topProducts, topCustomers, paymentMethods, quoteStatuses] =
      await Promise.all([
        readSummary(db),
        db.query(`
          SELECT to_char(m, 'YYYY-MM')              AS month,
                 COALESCE(s.sales, 0)               AS sales,
                 COALESCE(s.purchases, 0)           AS purchases,
                 COALESCE(s.sales_count, 0)::int    AS sales_count,
                 COALESCE(c.collected, 0)           AS collected
            FROM generate_series(date_trunc('month', now()),
                                 ${windowStart},
                                 -interval '1 month') AS m
            LEFT JOIN (
                  SELECT date_trunc('month', created_at) AS mon,
                         SUM(total) FILTER (WHERE kind = 'sale')     AS sales,
                         SUM(total) FILTER (WHERE kind = 'purchase') AS purchases,
                         COUNT(*)     FILTER (WHERE kind = 'sale')     AS sales_count
                    FROM orders WHERE created_at >= ${windowStart}
                   GROUP BY 1) s ON s.mon = m
            LEFT JOIN (
                  SELECT date_trunc('month', paid_at) AS mon, SUM(amount) AS collected
                    FROM payments WHERE paid_at >= ${windowStart}
                   GROUP BY 1) c ON c.mon = m
           ORDER BY m`, [months]),
        db.query(`
          SELECT p.name, p.sku, SUM(i.quantity)::int AS units,
                 SUM(i.quantity * i.unit_price)      AS revenue
            FROM order_items i
            JOIN orders o    ON o.id = i.order_id
            JOIN products p  ON p.id = i.product_id
           WHERE o.kind = 'sale' AND o.created_at >= ${windowStart}
           GROUP BY p.id, p.name, p.sku
           ORDER BY revenue DESC, units DESC
           LIMIT 5`, [months]),
        db.query(`
          SELECT pt.name, SUM(o.total) AS total, COUNT(*)::int AS orders
            FROM orders o JOIN partners pt ON pt.id = o.partner_id
           WHERE o.kind = 'sale' AND o.created_at >= ${windowStart}
           GROUP BY pt.id, pt.name
           ORDER BY total DESC
           LIMIT 5`, [months]),
        db.query(`
          SELECT method, SUM(amount) AS total, COUNT(*)::int AS count
            FROM payments WHERE paid_at >= ${windowStart}
           GROUP BY method
           ORDER BY total DESC`, [months]),
        db.query(`
          SELECT status, COUNT(*)::int AS count
            FROM quotes GROUP BY status ORDER BY count DESC, status`),
      ]);

    return {
      months,
      summary,
      monthly: monthly.rows.map((r) => ({
        month: r.month, // 'YYYY-MM'
        sales: round2(Number(r.sales)),
        purchases: round2(Number(r.purchases)),
        collected: round2(Number(r.collected)),
        salesCount: r.sales_count,
      })),
      topProducts: topProducts.rows.map((r) => ({
        name: r.name, sku: r.sku, units: r.units, revenue: round2(Number(r.revenue)),
      })),
      topCustomers: topCustomers.rows.map((r) => ({
        name: r.name, total: round2(Number(r.total)), orders: r.orders,
      })),
      paymentMethods: paymentMethods.rows.map((r) => ({
        method: r.method, total: round2(Number(r.total)), count: r.count,
      })),
      quoteStatuses: quoteStatuses.rows.map((r) => ({ status: r.status, count: r.count })),
    };
  },
});

export const buildRepositories = (db) => ({
  products: makeProductRepository(db),
  partners: makePartnerRepository(db),
  orders: makeOrderRepository(db),
  quotes: makeQuoteRepository(db),
});

export const makeTransactionManager = (pool) => ({
  async run(work) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(buildRepositories(client));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },
});
