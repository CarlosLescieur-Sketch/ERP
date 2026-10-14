// `db` puede ser el Pool (consultas sueltas) o un Client dentro de una transacción.
const toProduct = (r) => ({ id: r.id, sku: r.sku, name: r.name, price: Number(r.price), cost: Number(r.cost), stock: r.stock });

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
      `SELECT o.id, o.kind, o.total, o.created_at, p.name AS partner,
              COALESCE(SUM(i.quantity), 0)::int AS units
         FROM orders o
         JOIN partners p ON p.id = o.partner_id
         LEFT JOIN order_items i ON i.order_id = o.id
        WHERE ($1::text IS NULL OR o.kind = $1)
        GROUP BY o.id, p.name
        ORDER BY o.created_at DESC LIMIT 100`, [kind ?? null]);
    return rows.map((r) => ({ ...r, total: Number(r.total) }));
  },
  async save(order) {
    const { rows } = await db.query(
      'INSERT INTO orders (kind, partner_id, total) VALUES ($1,$2,$3) RETURNING id, created_at',
      [order.kind, order.partnerId, order.total]);
    const id = rows[0].id;
    for (const l of order.items) {
      await db.query(
        'INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES ($1,$2,$3,$4)',
        [id, l.productId, l.quantity, l.unitPrice]);
    }
    return { id, ...order, createdAt: rows[0].created_at };
  },
});

export const makeReportReader = (db) => ({
  async summary() {
    const { rows } = await db.query(`
      SELECT
        COALESCE((SELECT SUM(total) FROM orders WHERE kind = 'sale'), 0)     AS sales,
        COALESCE((SELECT SUM(total) FROM orders WHERE kind = 'purchase'), 0) AS purchases,
        COALESCE((SELECT SUM(stock * cost) FROM products), 0)                AS inventory_value,
        (SELECT COUNT(*) FROM products WHERE stock <= 5)::int                AS low_stock`);
    const r = rows[0];
    const sales = Number(r.sales), purchases = Number(r.purchases);
    return { sales, purchases, balance: sales - purchases, inventoryValue: Number(r.inventory_value), lowStock: r.low_stock };
  },
});

export const buildRepositories = (db) => ({
  products: makeProductRepository(db),
  partners: makePartnerRepository(db),
  orders: makeOrderRepository(db),
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
