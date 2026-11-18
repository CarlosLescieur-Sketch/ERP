// Cliente de la API. La sesión vive en una cookie httpOnly que el navegador
// adjunta automáticamente (mismo origen vía proxy de Vite), por eso `credentials`.
async function request(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'Error de comunicación con el servidor');
    err.status = res.status;
    throw err;
  }
  return data;
}

const post = (path, body) => request(path, { method: 'POST', body: JSON.stringify(body) });
const put = (path, body) => request(path, { method: 'PUT', body: JSON.stringify(body) });
const del = (path) => request(path, { method: 'DELETE' });

// El tercero vive en el query string: `?kind=` y/o `?archived=1`.
const partnerQuery = (kind, archived) =>
  `/partners${kind ? `?kind=${kind}${archived ? '&archived=1' : ''}` : archived ? '?archived=1' : ''}`;

export const api = {
  // --- Sesión ---
  login: (email, password) => post('/auth/login', { email, password }),
  logout: () => post('/auth/logout'),
  me: () => request('/auth/me'),
  changePassword: (currentPassword, newPassword) =>
    post('/auth/change-password', { currentPassword, newPassword }),

  // --- Usuarios (admin) ---
  users: () => request('/users'),
  createUser: (u) => post('/users', u),
  updateUser: (id, u) => put(`/users/${id}`, u),
  deleteUser: (id) => del(`/users/${id}`),

  // --- Negocio ---
  summary: () => request('/summary'),
  dashboard: (months = 12) => request(`/reports/dashboard?months=${months}`),

  // Productos (archived=1 lista solo los archivados)
  products: (archived = false) => request(`/products${archived ? '?archived=1' : ''}`),
  createProduct: (p) => post('/products', p),
  updateProduct: (id, p) => put(`/products/${id}`, p),
  deleteProduct: (id) => del(`/products/${id}`),
  archiveProduct: (id, archived) => post(`/products/${id}/archive`, { archived }),

  // Clientes y proveedores
  partners: (kind, archived = false) => request(partnerQuery(kind, archived)),
  createPartner: (p) => post('/partners', p),
  updatePartner: (id, p) => put(`/partners/${id}`, p),
  deletePartner: (id) => del(`/partners/${id}`),
  archivePartner: (id, archived) => post(`/partners/${id}/archive`, { archived }),

  // Órdenes (ventas y compras)
  orders: (kind) => request(`/${kind === 'sale' ? 'sales' : 'purchases'}`),
  createOrder: (kind, o) => post(`/${kind === 'sale' ? 'sales' : 'purchases'}`, o),
  order: (kind, id) => request(`/${kind === 'sale' ? 'sales' : 'purchases'}/${id}`),
  updateOrder: (kind, id, o) => put(`/${kind === 'sale' ? 'sales' : 'purchases'}/${id}`, o),
  deleteOrder: (kind, id) => del(`/${kind === 'sale' ? 'sales' : 'purchases'}/${id}`),
  payOrder: (kind, id, payment) =>
    post(`/${kind === 'sale' ? 'sales' : 'purchases'}/${id}/payments`, payment),
  updatePayment: (kind, id, pid, payment) =>
    put(`/${kind === 'sale' ? 'sales' : 'purchases'}/${id}/payments/${pid}`, payment),
  deletePayment: (kind, id, pid) =>
    del(`/${kind === 'sale' ? 'sales' : 'purchases'}/${id}/payments/${pid}`),

  // --- Cotizaciones ---
  quotes: () => request('/quotes'),
  quote: (id) => request(`/quotes/${id}`),
  createQuote: (q) => post('/quotes', q),
  updateQuote: (id, q) => put(`/quotes/${id}`, q),
  deleteQuote: (id) => del(`/quotes/${id}`),
  quoteStatus: (id, status) => request(`/quotes/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) }),
  convertQuote: (id) => request(`/quotes/${id}/convert`, { method: 'POST' }),
};
