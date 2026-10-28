import './style.css';
import { api } from './api.js';
import Chart from 'chart.js/auto';

const view = document.querySelector('#view');
const $ = (s, r = document) => r.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => Number(n).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
const date = (d) => new Date(d).toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' });
const table = (heads, rows, empty) => rows.length
  ? `<table><thead><tr>${heads.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`
  : `<p class="empty">${empty}</p>`;

// Dinero compacto para ejes de gráficas ("$12.5 mil") vs money() completo.
const moneyCompact = (n) => Number(n).toLocaleString('es-MX', {
  style: 'currency', currency: 'MXN', notation: 'compact', maximumFractionDigits: 1 });

const PAY_METHOD_LABELS = { cash: 'Efectivo', transfer: 'Transferencia', card: 'Tarjeta' };

// Badge de saldo de una orden: "Pagada" o el saldo pendiente en dinero.
function balanceBadge(balance) {
  const b = Number(balance ?? 0);
  return b <= 0
    ? '<span class="badge paid">Pagada</span>'
    : `<span class="badge pending">Debe ${money(b)}</span>`;
}

let toastTimer;
function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `show ${bad ? 'bad' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ''), 3500);
}

// Envuelve un submit: ejecuta, muestra mensaje y vuelve a pintar la vista.
const onSubmit = (form, action, okMsg) => form.addEventListener('submit', async (e) => {
  e.preventDefault();
  try { await action(Object.fromEntries(new FormData(form))); toast(okMsg); render(); }
  catch (err) { toast(err.message, true); }
});

/* ---------- Sesión ---------- */
let session = null; // { id, email, name, role, permissions: string[], ... } | null

// La matriz de permisos vive en el backend (domain/user.js) y llega en login/me.
// Aquí solo decide qué botones mostrar: la autoridad real es la API.
const can = (perm) => Array.isArray(session?.permissions) && session.permissions.includes(perm);

function paintChrome() {
  $('#whoami').hidden = !session;
  $('#whoami-name').textContent = session?.name ?? '';
  $('#whoami-role').textContent = session ? { admin: 'Administrador', vendedor: 'Vendedor', bodeguero: 'Bodeguero' }[session.role] ?? session.role : '';
  document.querySelectorAll('#nav a[data-perm]').forEach((a) => { a.hidden = !can(a.dataset.perm); });
}

$('#logout').addEventListener('click', async () => {
  try { await api.logout(); } catch { /* la sesión ya no importa */ }
  session = null;
  paintChrome();
  location.hash = 'login';
  render();
});

/* ---------- Vistas ---------- */
const views = {
  login() {
    view.innerHTML = `<h2>Iniciar sesión</h2>
      <form id="f" class="login">
        <label>Correo
          <input name="email" type="email" autocomplete="username" required autofocus />
        </label>
        <label>Contraseña
          <input name="password" type="password" autocomplete="current-password" required />
        </label>
        <button>Entrar</button>
        <p class="empty">Pide tus credenciales al administrador del sistema.</p>
      </form>`;
    $('#f').addEventListener('submit', async (e) => {
      e.preventDefault();
      const { email, password } = Object.fromEntries(new FormData(e.target));
      try {
        const { user } = await api.login(email, password);
        session = user;
        paintChrome();
        toast(`Bienvenido, ${user.name}`);
        location.hash = 'resumen';
      } catch (err) { toast(err.message, true); }
    });
  },

  async resumen() {
    const d = await api.dashboard(dashMonths);
    const s = d.summary;
    const monthly = d.monthly ?? [];
    const last = monthly.at(-1);
    const prev = monthly.at(-2);

    // Tendencia del mes en curso contra el mes anterior (solo si hay base).
    const trend = (cur, antes) => {
      if (antes === undefined || cur === undefined || !antes) return '';
      const pct = ((cur - antes) / Math.abs(antes)) * 100;
      if (!Number.isFinite(pct)) return '';
      const up = pct >= 0;
      return `<span class="trend ${up ? 'up' : 'down'}" title="Mes en curso vs mes anterior">${up ? '▲' : '▼'} ${Math.abs(pct).toFixed(0)}% vs mes ant.</span>`;
    };
    const card = (label, value, extra = '') =>
      `<div class="stat"><span>${label}</span><strong>${value}</strong>${extra}</div>`;

    const hasMonthly = monthly.some((r) => r.sales || r.purchases || r.collected);
    const hasQuotes = (d.quoteStatuses ?? []).length > 0;
    const hasMethods = (d.paymentMethods ?? []).length > 0;
    const hasProducts = (d.topProducts ?? []).length > 0;
    const hasCustomers = (d.topCustomers ?? []).length > 0;
    const chartCard = (id, title, isEmpty, cls = '') => `
      <div class="chart-card ${cls}">
        <h3>${title}</h3>
        ${isEmpty ? '<p class="empty">Sin datos todavía</p>'
                  : `<div class="chart-box"><canvas id="${id}" aria-label="${esc(title)}" role="img"></canvas></div>`}
      </div>`;

    view.innerHTML = `
      <div class="dash-head">
        <h2>Resumen financiero</h2>
        <div class="period-toggle" role="group" aria-label="Periodo de las gráficas">
          ${[6, 12, 24].map((m) => `<button type="button" data-months="${m}"
              class="${dashMonths === m ? 'active' : ''}">${m === 6 ? '6 meses' : m === 12 ? '1 año' : '2 años'}</button>`).join('')}
        </div>
      </div>

      <div class="stats">
        ${card('Ventas (histórico)', money(s.sales))}
        ${card('Compras (histórico)', money(s.purchases))}
        ${card('Balance (ventas − compras)', money(s.balance))}
        ${card('Por cobrar', money(s.receivable ?? 0))}
        ${card('Por pagar', money(s.payable ?? 0))}
        ${card('Ventas del mes', money(last?.sales ?? 0), trend(last?.sales, prev?.sales))}
        ${card('Valor del inventario', money(s.inventoryValue))}
        ${card('Stock bajo (≤ 5)', s.lowStock)}
      </div>

      <div class="dash-grid">
        ${chartCard('c-monthly', `Ventas, compras y cobros · últimos ${dashMonths} meses`, !hasMonthly, 'wide')}
        ${chartCard('c-receivable', 'Cartera de clientes', !(s.sales > 0))}
        ${chartCard('c-payable', 'Cartera de proveedores', !(s.purchases > 0))}
        ${chartCard('c-methods', 'Cobros por método', !hasMethods)}
        ${chartCard('c-quotes', 'Cotizaciones por estado', !hasQuotes)}
        ${chartCard('c-products', 'Top productos por ingresos', !hasProducts)}
        ${chartCard('c-customers', 'Top clientes por facturación', !hasCustomers)}
      </div>`;

    view.querySelectorAll('.period-toggle button').forEach((b) => b.addEventListener('click', () => {
      dashMonths = Number(b.dataset.months);
      render();
    }));

    renderDashCharts(d);
  },

  async productos() {
    const items = await api.products();
    view.innerHTML = `<h2>Inventario</h2>
      ${can('products:write') ? `<form id="f" class="inline">
        <input name="sku" placeholder="SKU" required />
        <input name="name" placeholder="Nombre" required />
        <input name="cost" type="number" step="0.01" min="0" placeholder="Costo" required />
        <input name="price" type="number" step="0.01" min="0" placeholder="Precio venta" required />
        <input name="stock" type="number" min="0" step="1" placeholder="Stock inicial" value="0" />
        <button>Guardar producto</button>
      </form>` : ''}
      ${table(['SKU', 'Producto', 'Costo', 'Precio', 'Stock'], items.map((p) =>
        `<tr><td>${esc(p.sku)}</td><td>${esc(p.name)}</td><td>${money(p.cost)}</td><td>${money(p.price)}</td>
         <td class="${p.stock <= 5 ? 'low' : ''}">${p.stock}</td></tr>`), 'Aún no hay productos. Registra el primero arriba.')}`;
    if (can('products:write')) onSubmit($('#f'), api.createProduct, 'Producto guardado');
  },

  async terceros() {
    const items = await api.partners();
    const label = { customer: 'Cliente', supplier: 'Proveedor' };
    view.innerHTML = `<h2>Clientes y proveedores</h2>
      ${can('partners:write') ? `<form id="f" class="inline">
        <select name="kind"><option value="customer">Cliente</option><option value="supplier">Proveedor</option></select>
        <input name="name" placeholder="Nombre" required />
        <input name="email" type="email" placeholder="Correo" />
        <input name="phone" placeholder="Teléfono" />
        <button>Guardar</button>
      </form>` : ''}
      ${table(['Tipo', 'Nombre', 'Correo', 'Teléfono'], items.map((p) =>
        `<tr><td>${label[p.kind]}</td><td>${esc(p.name)}</td><td>${esc(p.email)}</td><td>${esc(p.phone)}</td></tr>`),
        'Aún no hay registros.')}`;
    if (can('partners:write')) onSubmit($('#f'), api.createPartner, 'Registro guardado');
  },

  async usuarios() {
    const items = await api.users();
    const roleLabel = { admin: 'Administrador', vendedor: 'Vendedor', bodeguero: 'Bodeguero' };
    view.innerHTML = `<h2>Usuarios del sistema</h2>
      <form id="f" class="inline">
        <input name="email" type="email" placeholder="Correo" required />
        <input name="name" placeholder="Nombre" required />
        <select name="role">
          <option value="admin">Administrador</option>
          <option value="vendedor">Vendedor</option>
          <option value="bodeguero">Bodeguero</option>
        </select>
        <input name="password" type="password" minlength="8" placeholder="Contraseña (mín. 8)" required />
        <button>Crear usuario</button>
      </form>
      ${table(['Nombre', 'Correo', 'Rol', 'Estado'], items.map((u) =>
        `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${roleLabel[u.role] ?? esc(u.role)}</td>
         <td>${u.active ? 'Activo' : 'Inactivo'}</td></tr>`), 'Aún no hay usuarios.')}`;
    onSubmit($('#f'), api.createUser, 'Usuario creado');
  },

  async perfil() {
    view.innerHTML = `<h2>Mi cuenta</h2>
      <form id="f" class="login">
        <label>Correo <input value="${esc(session?.email)}" disabled /></label>
        <label>Contraseña actual
          <input name="currentPassword" type="password" autocomplete="current-password" required />
        </label>
        <label>Nueva contraseña (mín. 8 caracteres)
          <input name="newPassword" type="password" autocomplete="new-password" minlength="8" required />
        </label>
        <button>Cambiar contraseña</button>
      </form>`;
    $('#f').addEventListener('submit', async (e) => {
      e.preventDefault();
      const { currentPassword, newPassword } = Object.fromEntries(new FormData(e.target));
      try {
        await api.changePassword(currentPassword, newPassword);
        toast('Contraseña actualizada');
        e.target.reset();
      } catch (err) { toast(err.message, true); }
    });
  },
};

// Compras y ventas comparten la misma pantalla: cambia el tipo de tercero y el precio sugerido.
function orderView(kind) {
  const isSale = kind === 'sale';
  const writePerm = isSale ? 'sales:write' : 'purchases:write';
  return async () => {
    const [partners, products, orders] = await Promise.all([
      api.partners(isSale ? 'customer' : 'supplier'), api.products(), api.orders(kind)]);
    const suggested = (p) => (isSale ? p.price : p.cost);
    const productOptions = products.map((p) =>
      `<option value="${p.id}" data-price="${suggested(p)}">${esc(p.name)} (stock ${p.stock})</option>`).join('');
    const line = () => `<div class="line">
        <select name="productId" required>${productOptions}</select>
        <input name="quantity" type="number" min="1" step="1" value="1" required />
        <input name="unitPrice" type="number" min="0" step="0.01" required />
        <button type="button" class="ghost rm" aria-label="Quitar línea">Quitar</button>
      </div>`;
    const canWrite = can(writePerm);

    view.innerHTML = `<h2>${isSale ? 'Ventas' : 'Compras'}</h2>
      ${!canWrite
        ? `<p class="empty">Tu rol no permite registrar ${isSale ? 'ventas' : 'compras'}.</p>`
        : !partners.length || !products.length
        ? `<p class="empty">Para registrar ${isSale ? 'una venta' : 'una compra'} necesitas al menos un ${isSale ? 'cliente' : 'proveedor'} y un producto.</p>`
        : `<form id="f" class="order">
            <select name="partnerId" required>${partners.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select>
            <div id="lines">${line()}</div>
            <div class="actions"><button type="button" class="ghost" id="add">Agregar producto</button>
            <button>${isSale ? 'Registrar venta' : 'Registrar compra'}</button></div>
          </form>`}
      ${table(['Folio', 'Fecha', isSale ? 'Cliente' : 'Proveedor', 'Unidades', 'Total', 'Saldo'], orders.map((o) =>
        `<tr><td><a href="#${isSale ? 'venta' : 'compra'}-${o.id}">#${o.id}</a></td><td>${date(o.created_at)}</td>
         <td>${esc(o.partner)}</td><td>${o.units}</td><td>${money(o.total)}</td>
         <td>${balanceBadge(o.balance)}</td></tr>`),
        'Sin movimientos todavía.')}`;

    const form = $('#f');
    if (!form) return;
    const fillPrice = (row) => { const o = $('select', row).selectedOptions[0]; $('[name=unitPrice]', row).value = o.dataset.price; };
    const lines = $('#lines');
    fillPrice(lines.firstElementChild);
    lines.addEventListener('change', (e) => { if (e.target.name === 'productId') fillPrice(e.target.closest('.line')); });
    lines.addEventListener('click', (e) => { if (e.target.classList.contains('rm') && lines.children.length > 1) e.target.closest('.line').remove(); });
    $('#add').addEventListener('click', () => { lines.insertAdjacentHTML('beforeend', line()); fillPrice(lines.lastElementChild); });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const items = [...lines.children].map((r) => ({
        productId: $('[name=productId]', r).value, quantity: $('[name=quantity]', r).value, unitPrice: $('[name=unitPrice]', r).value }));
      try {
        await api.createOrder(kind, { partnerId: form.partnerId.value, items });
        toast(isSale ? 'Venta registrada' : 'Compra registrada'); render();
      } catch (err) { toast(err.message, true); }
    });
  };
}
views.compras = orderView('purchase');
views.ventas = orderView('sale');

/* ---------- Cotizaciones ---------- */
const QUOTE_STATUS = {
  draft: ['Borrador', 'chip-draft'], sent: ['Enviada', 'chip-sent'],
  accepted: ['Aceptada', 'chip-accepted'], rejected: ['Rechazada', 'chip-rejected'],
  expired: ['Vencida', 'chip-expired'], converted: ['Convertida', 'chip-converted'],
};
const statusChip = (status) => {
  const [label, cls] = QUOTE_STATUS[status] ?? [status, 'chip-draft'];
  return `<span class="chip ${cls}">${label}</span>`;
};
// Qué botones mostrar para cada transición permitida (la autoridad es el backend).
const QUOTE_ACTIONS = {
  sent: ['sent:Enviar'], accepted: ['accepted:Aceptar', 'rejected:Rechazar', 'expired:Marcar vencida'],
  converted: ['convert:Convertir en venta'],
};

views.cotizaciones = async () => {
  const items = await api.quotes();
  const canWrite = can('quotes:write');
  const rows = items.map((q) =>
    `<tr><td><a href="#cotizacion-${q.id}">#${q.id}</a></td><td>${statusChip(q.status)}</td>
     <td>${esc(q.partner)}</td><td>${q.units}</td><td>${money(q.total)}</td>
     <td>${q.expiresAt ? date(q.expiresAt) : '—'}</td></tr>`);

  view.innerHTML = `<h2>Cotizaciones</h2>
    ${canWrite ? `<form id="f" class="order">
      <select name="partnerId" id="q-partners" required></select>
      <div id="lines"></div>
      <div class="actions">
        <button type="button" class="ghost" id="add">Agregar producto</button>
        <button>Crear borrador</button>
      </div>
    </form>` : ''}
    ${table(['Folio', 'Estado', 'Cliente', 'Unidades', 'Total', 'Caduca'], rows, 'Aún no hay cotizaciones.')}`;

  if (!canWrite) return;
  const [partners, products] = await Promise.all([api.partners('customer'), api.products()]);
  $('#q-partners').innerHTML = partners.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  const productOptions = products.map((p) =>
    `<option value="${p.id}" data-price="${p.price}">${esc(p.name)} (stock ${p.stock})</option>`).join('');
  const line = () => `<div class="line">
      <select name="productId" required>${productOptions}</select>
      <input name="quantity" type="number" min="1" step="1" value="1" required />
      <input name="unitPrice" type="number" min="0" step="0.01" required />
      <button type="button" class="ghost rm" aria-label="Quitar línea">Quitar</button>
    </div>`;
  const fillPrice = (row) => { const o = $('select', row).selectedOptions[0]; $('[name=unitPrice]', row).value = o.dataset.price; };
  const lines = $('#lines');
  lines.insertAdjacentHTML('beforeend', line());
  fillPrice(lines.firstElementChild);
  lines.addEventListener('change', (e) => { if (e.target.name === 'productId') fillPrice(e.target.closest('.line')); });
  lines.addEventListener('click', (e) => { if (e.target.classList.contains('rm') && lines.children.length > 1) e.target.closest('.line').remove(); });
  $('#add').addEventListener('click', () => { lines.insertAdjacentHTML('beforeend', line()); fillPrice(lines.lastElementChild); });

  $('#f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const items2 = [...lines.children].map((r) => ({
      productId: $('[name=productId]', r).value, quantity: $('[name=quantity]', r).value, unitPrice: $('[name=unitPrice]', r).value }));
    try {
      const q = await api.createQuote({ partnerId: $('#q-partners').value, items: items2 });
      toast(`Cotización #${q.id} creada como borrador`);
      location.hash = `cotizacion-${q.id}`;
    } catch (err) { toast(err.message, true); }
  });
};

async function quoteDetail(id) {
  const q = await api.quote(id);
  const items = q.items.map((i) =>
    `<tr><td>${esc(i.sku)}</td><td>${esc(i.name)}</td><td>${i.quantity}</td>
     <td>${money(i.unitPrice)}</td><td>${i.taxRate}%</td><td>${money(i.quantity * i.unitPrice * (1 + i.taxRate / 100))}</td></tr>`);

  const buttons = can('quotes:write')
    ? (q.allowed ?? []).map((t) => {
        const [action, label] = (QUOTE_ACTIONS[t] ?? [`${t}:${t}`])[0].split(':');
        return action === 'convert'
          ? `<button data-convert>${label}</button>`
          : `<button class="ghost" data-status="${action}">${label}</button>`;
      }).join('')
    : '';

  view.innerHTML = `<h2>Cotización #${q.id} ${statusChip(q.status)}</h2>
    <p class="detail-meta">
      <a href="#cotizaciones">← Volver a cotizaciones</a>
      · <strong>${esc(q.partner)}</strong> (cliente)
      · creada ${date(q.createdAt)}
      ${q.expiresAt ? `· caduca ${date(q.expiresAt)}` : ''}
      ${q.convertedOrderId ? `· <a href="#venta-${q.convertedOrderId}">venta #${q.convertedOrderId}</a>` : ''}
    </p>
    ${q.note ? `<p class="empty">“${esc(q.note)}”</p>` : ''}

    <div class="stats">
      <div class="stat"><span>Subtotal (neto)</span><strong>${money(q.subtotal)}</strong></div>
      <div class="stat"><span>IVA</span><strong>${money(q.tax)}</strong></div>
      <div class="stat"><span>Total</span><strong>${money(q.total)}</strong></div>
    </div>

    <h3>Productos cotizados</h3>
    ${table(['SKU', 'Producto', 'Cant.', 'Precio neto', 'IVA', 'Importe c/IVA'], items, 'Sin líneas.')}

    ${buttons ? `<div class="actions"><h3 style="margin:0;flex:1">Acciones</h3>${buttons}</div>` : ''}`;

  view.querySelectorAll('[data-status]').forEach((b) => b.addEventListener('click', async () => {
    try { await api.quoteStatus(q.id, b.dataset.status); toast('Estado actualizado'); render(); }
    catch (err) { toast(err.message, true); }
  }));
  view.querySelector('[data-convert]')?.addEventListener('click', async () => {
    try {
      const { order } = await api.convertQuote(q.id);
      toast(`Venta #${order.id} creada desde la cotización`);
      location.hash = `venta-${order.id}`;
    } catch (err) { toast(err.message, true); }
  });
}

/* ---------- Detalle de orden (con pagos) ---------- */
async function orderDetail(kind, id) {
  const isSale = kind === 'sale';
  const o = await api.order(kind, id);
  const rows = o.items.map((i) =>
    `<tr><td>${esc(i.sku)}</td><td>${esc(i.name)}</td><td>${i.quantity}</td>
     <td>${money(i.unitPrice)}</td><td>${i.taxRate}%</td>
     <td>${money(i.quantity * i.unitPrice * (1 + i.taxRate / 100))}</td></tr>`);

  const paidRows = o.payments.map((p) =>
    `<tr><td>${date(p.paidAt)}</td><td>${money(p.amount)}</td><td>${PAY_METHOD_LABELS[p.method] ?? esc(p.method)}</td>
     <td>${esc(p.note ?? '—')}</td><td>${esc(p.createdBy ?? '—')}</td></tr>`);

  const canPay = can('payments:write') && o.balance > 0;

  view.innerHTML = `<h2>${isSale ? 'Venta' : 'Compra'} #${o.id}</h2>
    <p class="detail-meta">
      <a href="#${isSale ? 'ventas' : 'compras'}">← Volver a ${isSale ? 'ventas' : 'compras'}</a>
      · <strong>${esc(o.partner)}</strong> (${isSale ? 'cliente' : 'proveedor'})
      · ${date(o.createdAt)}
    </p>

    <div class="stats">
      <div class="stat"><span>Subtotal (neto)</span><strong>${money(o.subtotal)}</strong></div>
      <div class="stat"><span>IVA</span><strong>${money(o.tax)}</strong></div>
      <div class="stat"><span>Total</span><strong>${money(o.total)}</strong></div>
      <div class="stat"><span>Pagado</span><strong>${money(o.paid)}</strong></div>
      <div class="stat"><span>Saldo</span><strong>${balanceBadge(o.balance)}</strong></div>
    </div>

    <h3>Productos</h3>
    ${table(['SKU', 'Producto', 'Cant.', 'Precio neto', 'IVA', 'Importe c/IVA'], rows, 'Sin líneas.')}

    ${canPay ? `<form id="pay" class="inline">
      <input name="amount" type="number" step="0.01" min="0.01" max="${o.balance}" placeholder="Monto (máx. ${o.balance.toFixed(2)})" required />
      <select name="method">
        <option value="cash">Efectivo</option>
        <option value="transfer">Transferencia</option>
        <option value="card">Tarjeta</option>
      </select>
      <input name="note" placeholder="Nota (opcional)" />
      <button>Registrar pago</button>
    </form>` : ''}

    <h3>Pagos</h3>
    ${table(['Fecha', 'Monto', 'Método', 'Nota', 'Registró'], paidRows, 'Aún no hay pagos.')}`;

  if (canPay) {
    $('#pay').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      try {
        await api.payOrder(kind, id, { amount: Number(f.amount), method: f.method, note: f.note || null });
        toast('Pago registrado');
        render();
      } catch (err) { toast(err.message, true); }
    });
  }
}

// Rutas dinámicas: #venta-3 / #compra-3 → detalle.
function resolveRoute(route) {
  const m = route.match(/^(venta|compra)-(\d+)$/);
  if (m) {
    const kind = m[1] === 'venta' ? 'sale' : 'purchase';
    return () => orderDetail(kind, m[2]);
  }
  const q = route.match(/^cotizacion-(\d+)$/);
  if (q) return () => quoteDetail(q[1]);
  return views[route] ?? views.resumen;
}

/* ---------- Dashboard: gráficas (Chart.js) ---------- */
let dashMonths = 12; // periodo elegido en Resumen (persiste al navegar por la app)
let charts = [];     // instancias vivas: se destruyen antes de cada render

function destroyCharts() {
  for (const c of charts) c.destroy();
  charts = [];
}

Chart.defaults.font.family = '"Segoe UI", system-ui, -apple-system, sans-serif';
Chart.defaults.font.size = 12;
Chart.defaults.color = '#5d6f73';

const PALETTE = {
  green: '#1f6f5c', orange: '#b3541e', blue: '#2f6db3',
  gold: '#e0a526', purple: '#7c5cbf', gray: '#94a3b8',
};
const MONTHS_ES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const monthLabel = (key) => {
  const [y, m] = key.split('-');
  return `${MONTHS_ES[Number(m) - 1]} ${y.slice(2)}`;
};
const QUOTE_CHART = {
  draft: { label: 'Borrador', color: PALETTE.gray },
  sent: { label: 'Enviada', color: PALETTE.blue },
  accepted: { label: 'Aceptada', color: PALETTE.green },
  rejected: { label: 'Rechazada', color: PALETTE.orange },
  expired: { label: 'Vencida', color: PALETTE.gold },
  converted: { label: 'Convertida', color: PALETTE.purple },
};

// Opciones compartidas: leyenda abajo con puntos, tooltips en dinero completo
// y ejes en dinero compacto (para que no se encimen).
const legendBottom = { position: 'bottom', labels: { usePointStyle: true, boxWidth: 8, padding: 14 } };

const cartesianOpts = () => ({
  responsive: true,
  maintainAspectRatio: false,
  interaction: { mode: 'index', intersect: false },
  plugins: {
    legend: legendBottom,
    tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${money(c.parsed.y)}` } },
  },
  scales: {
    y: { border: { display: false }, grid: { color: '#e7ebe8' }, ticks: { callback: moneyCompact } },
    x: { grid: { display: false }, ticks: { maxRotation: 0 } },
  },
});

const doughnutOpts = (tooltipLabel) => ({
  responsive: true,
  maintainAspectRatio: false,
  cutout: '64%',
  plugins: {
    legend: legendBottom,
    tooltip: { callbacks: { label: (c) => ` ${tooltipLabel ? tooltipLabel(c) : `${c.label}: ${money(c.parsed)}`}` } },
  },
});

const horizontalOpts = (tooltipLabel) => ({
  responsive: true,
  maintainAspectRatio: false,
  indexAxis: 'y',
  plugins: {
    legend: { display: false },
    tooltip: { callbacks: { label: (c) => tooltipLabel(c) } },
  },
  scales: {
    x: { border: { display: false }, grid: { color: '#e7ebe8' }, ticks: { callback: moneyCompact } },
    y: { grid: { display: false } },
  },
});

// Monta la gráfica si su <canvas> existe (si la vista decidió mostrar el
// estado vacío, no existe y esto no hace nada).
function mount(id, config) {
  const el = document.getElementById(id);
  if (el) charts.push(new Chart(el, config));
}

function renderDashCharts(d) {
  const s = d.summary;
  const monthly = d.monthly ?? [];

  // 1) Serie mensual: barras de ventas/compras + línea de cobros reales.
  mount('c-monthly', {
    type: 'bar',
    data: {
      labels: monthly.map((r) => monthLabel(r.month)),
      datasets: [
        { label: 'Ventas', data: monthly.map((r) => r.sales),
          backgroundColor: PALETTE.green, borderRadius: 4, maxBarThickness: 22 },
        { label: 'Compras', data: monthly.map((r) => r.purchases),
          backgroundColor: PALETTE.orange, borderRadius: 4, maxBarThickness: 22 },
        { label: 'Cobros', data: monthly.map((r) => r.collected), type: 'line',
          borderColor: PALETTE.blue, backgroundColor: 'rgba(47,109,179,.12)', fill: true,
          tension: 0.35, borderWidth: 2, pointRadius: 3, pointBackgroundColor: PALETTE.blue },
      ],
    },
    options: cartesianOpts(),
  });

  // 2-3) Cartera: qué parte de las ventas/compras ya está saldada.
  const cobrado = Math.max(0, s.sales - (s.receivable ?? 0));
  mount('c-receivable', {
    type: 'doughnut',
    data: {
      labels: ['Cobrado', 'Por cobrar'],
      datasets: [{ data: [cobrado, s.receivable ?? 0],
        backgroundColor: [PALETTE.green, PALETTE.gold], borderWidth: 0 }],
    },
    options: doughnutOpts(),
  });
  const pagado = Math.max(0, s.purchases - (s.payable ?? 0));
  mount('c-payable', {
    type: 'doughnut',
    data: {
      labels: ['Pagado', 'Por pagar'],
      datasets: [{ data: [pagado, s.payable ?? 0],
        backgroundColor: [PALETTE.blue, PALETTE.orange], borderWidth: 0 }],
    },
    options: doughnutOpts(),
  });

  // 4) Cómo se está cobrando.
  mount('c-methods', {
    type: 'doughnut',
    data: {
      labels: (d.paymentMethods ?? []).map((m) => PAY_METHOD_LABELS[m.method] ?? m.method),
      datasets: [{ data: (d.paymentMethods ?? []).map((m) => m.total),
        backgroundColor: [PALETTE.green, PALETTE.blue, PALETTE.purple, PALETTE.gold], borderWidth: 0 }],
    },
    options: doughnutOpts(),
  });

  // 5) Embudo de cotizaciones por estado.
  mount('c-quotes', {
    type: 'doughnut',
    data: {
      labels: (d.quoteStatuses ?? []).map((q) => QUOTE_CHART[q.status]?.label ?? q.status),
      datasets: [{ data: (d.quoteStatuses ?? []).map((q) => q.count),
        backgroundColor: (d.quoteStatuses ?? []).map((q) => QUOTE_CHART[q.status]?.color ?? PALETTE.gray),
        borderWidth: 0 }],
    },
    options: doughnutOpts((c) => ` ${c.label}: ${c.parsed} cotizacion${c.parsed === 1 ? '' : 'es'}`),
  });

  // 6-7) Rankings: ingresos por producto y facturación por cliente.
  mount('c-products', {
    type: 'bar',
    data: {
      labels: d.topProducts.map((p) => p.name),
      datasets: [{ data: d.topProducts.map((p) => p.revenue),
        backgroundColor: PALETTE.green, borderRadius: 4 }],
    },
    options: horizontalOpts((c) => ` ${money(c.parsed.x)} · ${d.topProducts[c.dataIndex].units} unidades`),
  });
  mount('c-customers', {
    type: 'bar',
    data: {
      labels: d.topCustomers.map((c) => c.name),
      datasets: [{ data: d.topCustomers.map((c) => c.total),
        backgroundColor: PALETTE.blue, borderRadius: 4 }],
    },
    options: horizontalOpts((c) => ` ${money(c.parsed.x)} en ${d.topCustomers[c.dataIndex].orders} venta${d.topCustomers[c.dataIndex].orders === 1 ? '' : 's'}`),
  });
}

/* ---------- Router ---------- */
async function render() {
  const route = location.hash.slice(1) || (session ? 'resumen' : 'login');

  // Guard: sin sesión solo se puede ver el login.
  if (!session && route !== 'login') { location.hash = 'login'; return; }
  if (session && route === 'login') { location.hash = 'resumen'; return; }

  // Liberar las gráficas de la vista anterior (Chart.js no recicla canvases).
  destroyCharts();
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === `#${route}`));
  try { await resolveRoute(route)(); }
  catch (err) {
    if (err.status === 401) { session = null; paintChrome(); location.hash = 'login'; return; }
    view.innerHTML = `<p class="empty">No se pudo cargar: ${esc(err.message)}. ¿Está corriendo la API y PostgreSQL?</p>`;
  }
}
addEventListener('hashchange', render);

// Restaura la sesión si la cookie sigue viva (recargar la página no expulsa).
try {
  const { user } = await api.me();
  session = user;
} catch { session = null; }
paintChrome();
render();
