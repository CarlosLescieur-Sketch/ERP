import { buildProduct } from '../domain/product.js';
import { buildPartner } from '../domain/partner.js';
import { buildOrder, PARTNER_FOR, ORDER_KINDS } from '../domain/order.js';
import { buildPayment } from '../domain/payment.js';
import { buildQuote, assertTransition, effectiveStatus, allowedTransitions, quoteToOrderInput, QUOTE_STATUS_LABELS } from '../domain/quote.js';
import { buildUser, assertPasswordStrength, publicUser } from '../domain/user.js';
import { DomainError, NotFoundError, UnauthorizedError } from '../domain/errors.js';

const round2 = (n) => Math.round(n * 100) / 100;

// Cada caso de uso recibe sus puertos por inyección (ver main.js).
export function makeUseCases({ products, partners, orders, quotes, reports, transactions, users, sessions, passwords, sessionTtlDays = 7 }) {
  const registerOrder = (kind) => (input) => {
    const order = buildOrder({ ...input, kind });
    // Todo o nada: la orden y el movimiento de inventario van en una sola transacción.
    return transactions.run(async (tx) => {
      const partner = await tx.partners.findById(order.partnerId);
      if (!partner) throw new NotFoundError('El cliente/proveedor no existe');
      if (partner.kind !== PARTNER_FOR[kind])
        throw new DomainError(`Esta operación requiere un ${PARTNER_FOR[kind] === 'customer' ? 'cliente' : 'proveedor'}`);

      for (const line of order.items) {
        const product = await tx.products.findById(line.productId, { lock: true });
        if (!product) throw new NotFoundError(`Producto ${line.productId} no existe`);
        if (kind === 'sale' && product.stock < line.quantity)
          throw new DomainError(`Stock insuficiente de "${product.name}" (disponible: ${product.stock})`);
        await tx.products.adjustStock(line.productId, kind === 'sale' ? -line.quantity : line.quantity);
      }
      return tx.orders.save(order);
    });
  };

  /* ---------- Autenticación ---------- */

  const login = async ({ email, password }) => {
    const e = String(email ?? '').trim().toLowerCase();
    if (!e || !password) throw new DomainError('Correo y contraseña son obligatorios');

    const user = await users.findByEmail(e);
    // Mismo mensaje si el correo no existe o la contraseña falla: no se revela
    // cuál de los dos estaba mal.
    const ok = user && user.active && await passwords.verify(password, user.passwordHash);
    if (!ok) throw new UnauthorizedError('Credenciales inválidas');

    const token = await sessions.create(user.id, sessionTtlDays);
    return { token, user: publicUser(user) };
  };

  /* ---------- Pagos (cuentas por cobrar/pagar) ---------- */

  /**
   * Registra un pago sobre una orden. Dentro de la transacción se bloquea la
   * orden (FOR UPDATE) para que dos pagos simultáneos no puedan sobrepasar el
   * saldo: el segundo espera a que el primero confirme y relee el saldo.
   */
  const registerPayment = (kind) => (orderId, input, actor) => {
    const payment = buildPayment(input);
    const id = Number(orderId);
    if (!Number.isInteger(id) || id <= 0) throw new NotFoundError('La orden no existe');

    return transactions.run(async (tx) => {
      const order = await tx.orders.findById(id, { lock: true });
      if (!order) throw new NotFoundError('La orden no existe');
      if (order.kind !== kind) throw new DomainError(`El pago corresponde a ${kind === 'sale' ? 'una venta' : 'una compra'}`);

      const paid = await tx.orders.paidByOrder(id);
      const balance = round2(order.total - paid);
      if (payment.amount > balance)
        throw new DomainError(`El pago excede el saldo pendiente (${balance.toFixed(2)}); no se admite sobrepago`);

      const saved = await tx.orders.savePayment(id, payment, actor?.id ?? null);
      return { ...saved, balance: round2(balance - payment.amount) };
    });
  };

  /* ---------- Cotizaciones (máquina de estados) ---------- */

  /** Añade el estado efectivo (caducidad perezosa) y las transiciones permitidas. */
  const decorate = (q, now = Date.now()) => {
    const status = effectiveStatus(q, now);
    return { ...q, status, statusLabel: QUOTE_STATUS_LABELS[status], allowed: allowedTransitions(status) };
  };

  const listQuotes = async (status) => (await quotes.findAll(status)).map((q) => decorate(q));
  const getQuote = async (id) => {
    const q = await quotes.findById(Number(id));
    return q ? decorate(q) : null;
  };

  const createQuote = async (input, actor) => {
    const quote = buildQuote({ ...input, createdBy: actor?.id ?? null });
    // El cliente debe existir y ser cliente (misma regla que las ventas).
    const partner = await partners.findById(quote.partnerId);
    if (!partner) throw new NotFoundError('El cliente no existe');
    if (partner.kind !== 'customer') throw new DomainError('Las cotizaciones son solo para clientes');
    // Los productos deben existir (aunque no se mueva stock: cotizar no reserva).
    for (const line of quote.items) {
      if (!await products.findById(line.productId))
        throw new NotFoundError(`Producto ${line.productId} no existe`);
    }
    return decorate(await quotes.save(quote));
  };

  /**
   * Aplica una transición de estado. Se bloquea la cotización (FOR UPDATE) para
   * que dos acciones simultáneas (p. ej. aceptar y rechazar) no pasen a la vez.
   */
  const transitionQuote = (id, to) => transactions.run(async (tx) => {
    const q = await tx.quotes.findById(Number(id), { lock: true });
    if (!q) throw new NotFoundError('La cotización no existe');
    assertTransition(q, to);
    const saved = await tx.quotes.transition(q.id, to);
    return decorate({ ...q, ...saved, items: q.items });
  });

  /**
   * Convierte una cotización ACEPTADA en una venta real: crea la orden (moviendo
   * stock con las mismas reglas que cualquier venta) y marca la cotización como
   * `convertida` enlazando a la orden creada. Todo en UNA transacción.
   * Si al convertir ya no hay stock, falla y no se marca nada (la cotización
   * sigue aceptada para que se pueda reintentar).
   */
  const convertQuoteToSale = (id) => transactions.run(async (tx) => {
    const q = await tx.quotes.findById(Number(id), { lock: true });
    if (!q) throw new NotFoundError('La cotización no existe');
    assertTransition(q, 'converted');

    // Reutiliza la lógica de venta: valida cliente, stock y descuenta inventario.
    const order = buildOrder({ ...quoteToOrderInput(q), kind: 'sale' });
    const partner = await tx.partners.findById(order.partnerId);
    if (!partner) throw new NotFoundError('El cliente no existe');
    if (partner.kind !== PARTNER_FOR.sale) throw new DomainError('Esta operación requiere un cliente');

    for (const line of order.items) {
      const product = await tx.products.findById(line.productId, { lock: true });
      if (!product) throw new NotFoundError(`Producto ${line.productId} no existe`);
      if (product.stock < line.quantity)
        throw new DomainError(`Stock insuficiente de "${product.name}" (disponible: ${product.stock})`);
      await tx.products.adjustStock(line.productId, -line.quantity);
    }
    const saved = await tx.orders.save(order);
    const updated = await tx.quotes.transition(q.id, 'converted', { convertedOrderId: saved.id });
    return { order: saved, quote: decorate({ ...q, ...updated, items: q.items }) };
  });

  return {
    // --- Sesiones (las usa el middleware HTTP) ---
    login,
    logout: (token) => sessions.delete(token),
    sessionUser: async (token) => {
      if (!token) return null;
      const user = await sessions.findByToken(token);
      return user && user.active ? publicUser(user) : null;
    },

    // --- Usuarios (solo admin, filtrado por permisos en HTTP) ---
    listUsers: async () => (await users.findAll()).map(publicUser),
    createUser: async (input, actor) => {
      const u = buildUser(input);
      assertPasswordStrength(input.password);
      if (await users.findByEmail(u.email)) throw new DomainError('Ya existe un usuario con ese correo');
      const saved = await users.save({ ...u, passwordHash: await passwords.hash(input.password) });
      return { ...publicUser(saved), createdBy: actor?.email ?? null };
    },
    changePassword: async ({ currentPassword, newPassword }, actor) => {
      const user = await users.findById(actor.id);
      if (!user) throw new UnauthorizedError('Sesión inválida');
      if (!await passwords.verify(currentPassword, user.passwordHash))
        throw new UnauthorizedError('La contraseña actual no coincide');
      assertPasswordStrength(newPassword);
      await users.update({ ...user, passwordHash: await passwords.hash(newPassword) });
      return { ok: true };
    },

    // --- Negocio (sin cambios respecto a la Fase 0) ---
    listProducts: () => products.findAll(),
    createProduct: (input) => products.save(buildProduct(input)),
    listPartners: (kind) => partners.findAll(kind),
    createPartner: (input) => partners.save(buildPartner(input)),
    listPurchases: () => orders.findAll('purchase'),
    listSales: () => orders.findAll('sale'),
    registerPurchase: registerOrder('purchase'),
    registerSale: registerOrder('sale'),
    getOrder: (id) => orders.findDetail(Number(id)),
    registerSalePayment: registerPayment('sale'),
    registerPurchasePayment: registerPayment('purchase'),
    getSummary: () => reports.summary(),
    // Dashboard de Resumen: un solo viaje con todo lo que pinta la vista.
    // El periodo se sanea aquí (la BD solo necesita un entero razonable).
    getDashboard: (input) => {
      const raw = Number(input?.months ?? 12);
      const months = Number.isFinite(raw) ? Math.min(24, Math.max(3, Math.trunc(raw))) : 12;
      return reports.dashboard(months);
    },

    // --- Cotizaciones ---
    listQuotes,
    getQuote,
    createQuote,
    transitionQuote,
    convertQuoteToSale,
  };
}
