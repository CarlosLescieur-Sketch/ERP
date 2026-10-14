import './style.css';
import { api } from './api.js';

const view = document.querySelector('#view');
const $ = (s, r = document) => r.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => Number(n).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
const date = (d) => new Date(d).toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' });
const table = (heads, rows, empty) => rows.length
  ? `<table><thead><tr>${heads.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`
  : `<p class="empty">${empty}</p>`;

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

/* ---------- Vistas ---------- */
const views = {
  async resumen() {
    const s = await api.summary();
    const card = (label, value) => `<div class="stat"><span>${label}</span><strong>${value}</strong></div>`;
    view.innerHTML = `<h2>Resumen financiero</h2>
      <div class="stats">
        ${card('Ventas', money(s.sales))}${card('Compras', money(s.purchases))}
        ${card('Balance (ventas − compras)', money(s.balance))}
        ${card('Valor del inventario (a costo)', money(s.inventoryValue))}
        ${card('Productos con stock bajo (≤ 5)', s.lowStock)}
      </div>`;
  },

  async productos() {
    const items = await api.products();
    view.innerHTML = `<h2>Inventario</h2>
      <form id="f" class="inline">
        <input name="sku" placeholder="SKU" required />
        <input name="name" placeholder="Nombre" required />
        <input name="cost" type="number" step="0.01" min="0" placeholder="Costo" required />
        <input name="price" type="number" step="0.01" min="0" placeholder="Precio venta" required />
        <input name="stock" type="number" min="0" step="1" placeholder="Stock inicial" value="0" />
        <button>Guardar producto</button>
      </form>
      ${table(['SKU', 'Producto', 'Costo', 'Precio', 'Stock'], items.map((p) =>
        `<tr><td>${esc(p.sku)}</td><td>${esc(p.name)}</td><td>${money(p.cost)}</td><td>${money(p.price)}</td>
         <td class="${p.stock <= 5 ? 'low' : ''}">${p.stock}</td></tr>`), 'Aún no hay productos. Registra el primero arriba.')}`;
    onSubmit($('#f'), api.createProduct, 'Producto guardado');
  },

  async terceros() {
    const items = await api.partners();
    const label = { customer: 'Cliente', supplier: 'Proveedor' };
    view.innerHTML = `<h2>Clientes y proveedores</h2>
      <form id="f" class="inline">
        <select name="kind"><option value="customer">Cliente</option><option value="supplier">Proveedor</option></select>
        <input name="name" placeholder="Nombre" required />
        <input name="email" type="email" placeholder="Correo" />
        <input name="phone" placeholder="Teléfono" />
        <button>Guardar</button>
      </form>
      ${table(['Tipo', 'Nombre', 'Correo', 'Teléfono'], items.map((p) =>
        `<tr><td>${label[p.kind]}</td><td>${esc(p.name)}</td><td>${esc(p.email)}</td><td>${esc(p.phone)}</td></tr>`),
        'Aún no hay registros.')}`;
    onSubmit($('#f'), api.createPartner, 'Registro guardado');
  },
};

// Compras y ventas comparten la misma pantalla: cambia el tipo de tercero y el precio sugerido.
function orderView(kind) {
  const isSale = kind === 'sale';
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

    view.innerHTML = `<h2>${isSale ? 'Ventas' : 'Compras'}</h2>
      ${!partners.length || !products.length
        ? `<p class="empty">Para registrar ${isSale ? 'una venta' : 'una compra'} necesitas al menos un ${isSale ? 'cliente' : 'proveedor'} y un producto.</p>`
        : `<form id="f" class="order">
            <select name="partnerId" required>${partners.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select>
            <div id="lines">${line()}</div>
            <div class="actions"><button type="button" class="ghost" id="add">Agregar producto</button>
            <button>${isSale ? 'Registrar venta' : 'Registrar compra'}</button></div>
          </form>`}
      ${table(['Folio', 'Fecha', isSale ? 'Cliente' : 'Proveedor', 'Unidades', 'Total'], orders.map((o) =>
        `<tr><td>#${o.id}</td><td>${date(o.created_at)}</td><td>${esc(o.partner)}</td><td>${o.units}</td><td>${money(o.total)}</td></tr>`),
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

/* ---------- Router ---------- */
async function render() {
  const route = location.hash.slice(1) || 'resumen';
  document.querySelectorAll('nav a').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === `#${route}`));
  try { await (views[route] ?? views.resumen)(); }
  catch (err) { view.innerHTML = `<p class="empty">No se pudo cargar: ${esc(err.message)}. ¿Está corriendo la API y PostgreSQL?</p>`; }
}
addEventListener('hashchange', render);
render();
