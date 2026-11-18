import { buildProduct } from '../domain/product.js';
import { buildPartner } from '../domain/partner.js';
import { buildOrder, PARTNER_FOR, ORDER_KINDS } from '../domain/order.js';
import { buildPayment } from '../domain/payment.js';
import { buildQuote, assertTransition, effectiveStatus, allowedTransitions, quoteToOrderInput, QUOTE_STATUS_LABELS, parseExpiresAt } from '../domain/quote.js';
import { buildUser, assertPasswordStrength, publicUser } from '../domain/user.js';
import { DomainError, NotFoundError, UnauthorizedError } from '../domain/errors.js';

const round2 = (n) => Math.round(n * 100) / 100;

// Cada caso de uso recibe sus puertos por inyección (ver main.js).
export function makeUseCases({ products, partners, orders, quotes, reports, transactions, users, sessions, passwords, sessionTtlDays = 7 }) {
  /** Nombre del tercero que exige cada tipo de orden (para mensajes). */
  const partnerLabel = (kind) => (PARTNER_FOR[kind] === 'customer' ? 'cliente' : 'proveedor');

  /**
   * Aplica el movimiento de stock de las líneas de una orden que se registra
   * (venta resta, compra suma), bloqueando cada producto con FOR UPDATE.
   * Lo comparten registro de órdenes, edición y borrado.
   */
  const applyStock = async (tx, kind, items) => {
    for (const line of items) {
      const product = await tx.products.findById(line.productId, { lock: true });
      if (!product) throw new NotFoundError(`Producto ${line.productId} no existe`);
      if (kind === 'sale' && product.stock < line.quantity)
        throw new DomainError(`Stock insuficiente de "${product.name}" (disponible: ${product.stock})`);
      await tx.products.adjustStock(line.productId, kind === 'sale' ? -line.quantity : line.quantity);
    }
  };

  /**
   * Invierte el stock que una orden YA movió: una venta devuelve unidades y
   * una compra las retira de vuelta. `action` nombra la operación en errores.
   */
  const reverseStock = async (tx, kind, items, action) => {
    for (const line of items) {
      const product = await tx.products.findById(line.productId, { lock: true });
      if (!product) throw new NotFoundError(`Producto ${line.productId} no existe`);
      if (kind === 'purchase' && product.stock < line.quantity)
        throw new DomainError(
          `No se puede ${action}: el stock de "${product.name}" ya fue consumido ` +
          `(disponible: ${product.stock}, hay que devolver ${line.quantity} unidades)`);
      await tx.products.adjustStock(line.productId, kind === 'sale' ? line.quantity : -line.quantity);
    }
  };

  /**
   * Valida el tercero de una orden dentro de una transacción: existe, es del
   * tipo correcto y (salvo que se autorice) no está archivado.
   */
  const assertPartnerFor = async (tx, partnerId, kind, { allowArchived = false } = {}) => {
    const partner = await tx.partners.findById(partnerId);
    if (!partner) throw new NotFoundError('El cliente/proveedor no existe');
    if (partner.kind !== PARTNER_FOR[kind])
      throw new DomainError(`Esta operación requiere un ${partnerLabel(kind)}`);
    if (partner.archived && !allowArchived)
      throw new DomainError(`El ${partnerLabel(kind)} está archivado; revélolo antes de usarlo`);
    return partner;
  };

  const registerOrder = (kind) => (input) => {
    const order = buildOrder({ ...input, kind });
    // Todo o nada: la orden y el movimiento de inventario van en una sola transacción.
    return transactions.run(async (tx) => {
      await assertPartnerFor(tx, order.partnerId, kind);
      await applyStock(tx, kind, order.items);
      return tx.orders.save(order);
    });
  };

  /* ---------- Edición y borrado de órdenes ---------- */

  const orderIdOr404 = (id) => {
    const n = Number(id);
    if (!Number.isInteger(n) || n <= 0) throw new NotFoundError('La orden no existe');
    return n;
  };

  const assertOrderKind = (existing, orderId, kind) => {
    if (existing.kind !== kind)
      throw new DomainError(
        `La orden #${orderId} no es ${kind === 'sale' ? 'una venta' : 'una compra'}`);
  };

  /**
   * Edita una orden: recalcula totales con el input nuevo y acomoda el stock
   * por DIFERENCIA (revierte lo que la orden ya movió y aplica lo nuevo) en
   * UNA sola transacción. Si tiene pagos, el total nuevo no puede bajar por
   * debajo de lo ya cobrado/pagado.
   */
  const updateOrder = (kind) => (id, input) => {
    const orderId = orderIdOr404(id);
    const order = buildOrder({ ...input, kind });

    return transactions.run(async (tx) => {
      const existing = await tx.orders.findById(orderId, { lock: true });
      if (!existing) throw new NotFoundError('La orden no existe');
      assertOrderKind(existing, orderId, kind);

      // Cambiar de tercero solo si el nuevo no está archivado; conservar el
      // actual (aunque esté archivado) permite seguir editando la orden.
      await assertPartnerFor(tx, order.partnerId, kind,
        { allowArchived: order.partnerId === existing.partnerId });

      const paid = await tx.orders.paidByOrder(orderId);
      if (paid > order.total)
        throw new DomainError(
          `El nuevo total (${order.total.toFixed(2)}) no puede ser menor que lo ya pagado (${paid.toFixed(2)})`);

      const action = `editar ${kind === 'sale' ? 'la venta' : 'la compra'}`;
      await reverseStock(tx, kind, await tx.orders.findItems(orderId), action);
      await applyStock(tx, kind, order.items);

      await tx.orders.update({
        id: orderId, partnerId: order.partnerId,
        subtotal: order.subtotal, tax: order.tax, total: order.total,
      });
      await tx.orders.replaceItems(orderId, order.items);
      return tx.orders.findDetail(orderId);
    });
  };

  /**
   * Borra una orden: devuelve el stock que movió y, en cascada, desaparecen
   * sus líneas y pagos (ON DELETE CASCADE en la BD).
   */
  const deleteOrder = (kind) => (id) => {
    const orderId = orderIdOr404(id);
    return transactions.run(async (tx) => {
      const existing = await tx.orders.findById(orderId, { lock: true });
      if (!existing) throw new NotFoundError('La orden no existe');
      assertOrderKind(existing, orderId, kind);

      const action = `eliminar ${kind === 'sale' ? 'la venta' : 'la compra'}`;
      await reverseStock(tx, kind, await tx.orders.findItems(orderId), action);
      await tx.orders.remove(orderId);
      return { deleted: true, id: orderId };
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

  /**
   * Edita el monto, método o nota de un pago. Se bloquea la orden y se resta
   * el pago actual del total pagado: el nuevo monto no puede exceder el saldo
   * que quedaría (es como registrarlo de cero otra vez).
   */
  const updatePayment = (kind) => (orderId, paymentId, input) => {
    const id = orderIdOr404(orderId);
    const pid = Number(paymentId);
    if (!Number.isInteger(pid) || pid <= 0) throw new NotFoundError('El pago no existe');
    const payment = buildPayment(input);

    return transactions.run(async (tx) => {
      const order = await tx.orders.findById(id, { lock: true });
      if (!order) throw new NotFoundError('La orden no existe');
      assertOrderKind(order, id, kind);

      const current = await tx.orders.findPayment(pid);
      if (!current || current.orderId !== id) throw new NotFoundError('El pago no existe');

      const others = round2((await tx.orders.paidByOrder(id)) - current.amount);
      const available = round2(order.total - others);
      if (payment.amount > available)
        throw new DomainError(
          `El pago excede el saldo pendiente (${available.toFixed(2)}); no se admite sobrepago`);

      await tx.orders.updatePayment(pid, payment);
      return { ...current, ...payment, balance: round2(available - payment.amount) };
    });
  };

  /**
   * Borra un pago. El saldo no se almacena: al quitar el pago, la orden
   * vuelve a mostrar total − SUM(resto de pagos) automáticamente.
   */
  const deletePayment = (kind) => (orderId, paymentId) => {
    const id = orderIdOr404(orderId);
    const pid = Number(paymentId);
    if (!Number.isInteger(pid) || pid <= 0) throw new NotFoundError('El pago no existe');

    return transactions.run(async (tx) => {
      const order = await tx.orders.findById(id, { lock: true });
      if (!order) throw new NotFoundError('La orden no existe');
      assertOrderKind(order, id, kind);

      const current = await tx.orders.findPayment(pid);
      if (!current || current.orderId !== id) throw new NotFoundError('El pago no existe');

      await tx.orders.removePayment(pid);
      const paid = await tx.orders.paidByOrder(id);
      return { deleted: true, id: pid, balance: round2(order.total - paid) };
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
    if (partner.archived) throw new DomainError('El cliente está archivado; revélolo antes de cotizarle');
    // Los productos deben existir (aunque no se mueva stock: cotizar no reserva).
    for (const line of quote.items) {
      if (!await products.findById(line.productId))
        throw new NotFoundError(`Producto ${line.productId} no existe`);
    }
    return decorate(await quotes.save(quote));
  };

  /**
   * Edita una cotización en BORRADOR: una vez enviada ya no cambia su
   * contenido (para no romper la máquina de estados). Se conservan creador,
   * estado y vínculo de conversión; nota y caducidad solo cambian si el
   * input las trae explícitamente.
   */
  const updateQuote = (id, input) => transactions.run(async (tx) => {
    const q = await tx.quotes.findById(Number(id), { lock: true });
    if (!q) throw new NotFoundError('La cotización no existe');
    if (q.status !== 'draft') throw new DomainError('Solo se pueden editar cotizaciones en borrador');

    const quote = buildQuote({
      ...input,
      expiresAt: null, // la caducidad se resuelve abajo (sin re-validar la guardada)
      note: input?.note === undefined ? q.note : input.note,
      createdBy: q.createdBy,
    });
    // Caducidad: solo se valida si viene en el input; si no, se conserva.
    const expiresAt = input?.expiresAt === undefined ? q.expiresAt : parseExpiresAt(input.expiresAt);

    const partner = await tx.partners.findById(quote.partnerId);
    if (!partner) throw new NotFoundError('El cliente no existe');
    if (partner.kind !== 'customer') throw new DomainError('Las cotizaciones son solo para clientes');
    if (partner.archived && partner.id !== q.partnerId)
      throw new DomainError('No puedes cambiar a un cliente archivado; revélolo primero');
    for (const line of quote.items) {
      if (!await tx.products.findById(line.productId))
        throw new NotFoundError(`Producto ${line.productId} no existe`);
    }

    await tx.quotes.update({ id: q.id, ...quote, expiresAt });
    return decorate(await tx.quotes.findById(q.id));
  });

  /**
   * Borra una cotización (sus líneas caen en cascada). La convertida en venta
   * no se borra: enlaza con una orden real que ya movió stock y dinero.
   */
  const deleteQuote = (id) => transactions.run(async (tx) => {
    const q = await tx.quotes.findById(Number(id), { lock: true });
    if (!q) throw new NotFoundError('La cotización no existe');
    if (q.status === 'converted')
      throw new DomainError(
        'No se puede borrar una cotización convertida en venta (borra la venta si hace falta)');
    await tx.quotes.remove(q.id);
    return { deleted: true, id: q.id };
  });

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

  /* ---------- Productos y terceros: editar, borrar y archivar ---------- */

  const updateProduct = async (id, input) => {
    const saved = await products.update({ id: Number(id), ...buildProduct(input) });
    if (!saved) throw new NotFoundError('Producto inexistente');
    return saved;
  };

  /**
   * Borrado «si libre, si en uso archivar»: un producto que ya está en alguna
   * orden o cotización no puede salir de la BD (llave foránea), así que se
   * archiva: desaparece de los listados y formularios pero el historial lo
   * conserva. Se puede restaurar (o borrar de verdad) más adelante.
   */
  const deleteProduct = async (id) => {
    const pid = Number(id);
    const p = await products.findById(pid);
    if (!p) throw new NotFoundError('Producto inexistente');
    if (await products.inUse(pid)) {
      if (p.archived)
        throw new DomainError('No se puede borrar: sigue en uso por ventas, compras o cotizaciones');
      await products.setArchived(pid, true);
      return { archived: true, id: pid };
    }
    await products.remove(pid);
    return { deleted: true, id: pid };
  };

  const setProductArchived = async (id, archived) => {
    const saved = await products.setArchived(Number(id), archived === true);
    if (!saved) throw new NotFoundError('Producto inexistente');
    return saved;
  };

  const updatePartner = async (id, input) => {
    const pid = Number(id);
    const existing = await partners.findById(pid);
    if (!existing) throw new NotFoundError('El cliente/proveedor no existe');
    const p = buildPartner(input);
    // Cambiar cliente ↔ proveedor rompería el sentido de las órdenes viejas.
    if (p.kind !== existing.kind && await partners.inUse(pid))
      throw new DomainError('No se puede cambiar el tipo de un tercero que ya tiene ventas, compras o cotizaciones');
    const saved = await partners.update({ id: pid, ...p });
    if (!saved) throw new NotFoundError('El cliente/proveedor no existe');
    return saved;
  };

  /** Mismo criterio que los productos: borrar si está libre, archivar si no. */
  const deletePartner = async (id) => {
    const pid = Number(id);
    const p = await partners.findById(pid);
    if (!p) throw new NotFoundError('El cliente/proveedor no existe');
    if (await partners.inUse(pid)) {
      if (p.archived)
        throw new DomainError('No se puede borrar: sigue en uso por ventas, compras o cotizaciones');
      await partners.setArchived(pid, true);
      return { archived: true, id: pid };
    }
    await partners.remove(pid);
    return { deleted: true, id: pid };
  };

  const setPartnerArchived = async (id, archived) => {
    const saved = await partners.setArchived(Number(id), archived === true);
    if (!saved) throw new NotFoundError('El cliente/proveedor no existe');
    return saved;
  };

  /* ---------- Usuarios: editar y borrar (solo admin) ---------- */

  /** ¿Queda algún administrador activo distinto de `id`? */
  const otherActiveAdmin = async (id) =>
    (await users.findAll()).some((u) => u.id !== id && u.active && u.role === 'admin');

  const updateUser = async (id, input, actor) => {
    const uid = Number(id);
    const existing = await users.findById(uid);
    if (!existing) throw new NotFoundError('Usuario inexistente');
    const u = buildUser(input);

    if (actor?.id === uid && !u.active) throw new DomainError('No puedes desactivar tu propia cuenta');
    const demotesAdmin = existing.role === 'admin' && existing.active && (u.role !== 'admin' || !u.active);
    if (demotesAdmin && !(await otherActiveAdmin(uid)))
      throw new DomainError('No se puede quitar el último administrador activo');

    const taken = await users.findByEmail(u.email);
    if (taken && taken.id !== uid) throw new DomainError('Ya existe un usuario con ese correo');

    // Contraseña opcional: si no viene, se conserva la actual.
    let passwordHash = existing.passwordHash;
    if (input.password) {
      assertPasswordStrength(input.password);
      passwordHash = await passwords.hash(input.password);
    }
    return publicUser(await users.update({ ...existing, ...u, passwordHash }));
  };

  const deleteUser = async (id, actor) => {
    const uid = Number(id);
    const existing = await users.findById(uid);
    if (!existing) throw new NotFoundError('Usuario inexistente');
    if (actor?.id === uid) throw new DomainError('No puedes eliminar tu propia cuenta');
    if (existing.active && existing.role === 'admin' && !(await otherActiveAdmin(uid)))
      throw new DomainError('No se puede eliminar el último administrador activo');
    await users.remove(uid); // las sesiones del usuario caen en cascada
    return { deleted: true, id: uid };
  };

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
    updateUser,
    deleteUser,
    changePassword: async ({ currentPassword, newPassword }, actor) => {
      const user = await users.findById(actor.id);
      if (!user) throw new UnauthorizedError('Sesión inválida');
      if (!await passwords.verify(currentPassword, user.passwordHash))
        throw new UnauthorizedError('La contraseña actual no coincide');
      assertPasswordStrength(newPassword);
      await users.update({ ...user, passwordHash: await passwords.hash(newPassword) });
      return { ok: true };
    },

    // --- Negocio (CRUD completo: crear, listar, editar y borrar) ---
    listProducts: (opts) => products.findAll(opts),
    createProduct: (input) => products.save(buildProduct(input)),
    updateProduct,
    deleteProduct,
    setProductArchived,
    listPartners: (kind, opts) => partners.findAll(kind, opts),
    createPartner: (input) => partners.save(buildPartner(input)),
    updatePartner,
    deletePartner,
    setPartnerArchived,
    listPurchases: () => orders.findAll('purchase'),
    listSales: () => orders.findAll('sale'),
    registerPurchase: registerOrder('purchase'),
    registerSale: registerOrder('sale'),
    updatePurchase: updateOrder('purchase'),
    updateSale: updateOrder('sale'),
    deletePurchase: deleteOrder('purchase'),
    deleteSale: deleteOrder('sale'),
    getOrder: (id) => orders.findDetail(Number(id)),
    registerSalePayment: registerPayment('sale'),
    registerPurchasePayment: registerPayment('purchase'),
    updateSalePayment: updatePayment('sale'),
    updatePurchasePayment: updatePayment('purchase'),
    deleteSalePayment: deletePayment('sale'),
    deletePurchasePayment: deletePayment('purchase'),
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
    updateQuote,
    deleteQuote,
    transitionQuote,
    convertQuoteToSale,
  };
}
