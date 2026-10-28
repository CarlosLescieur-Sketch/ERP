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

  // --- Negocio ---
  summary: () => request('/summary'),
  dashboard: (months = 12) => request(`/reports/dashboard?months=${months}`),
  products: () => request('/products'),
  createProduct: (p) => post('/products', p),
  partners: (kind) => request(`/partners${kind ? `?kind=${kind}` : ''}`),
  createPartner: (p) => post('/partners', p),
  orders: (kind) => request(`/${kind === 'sale' ? 'sales' : 'purchases'}`),
  createOrder: (kind, o) => post(`/${kind === 'sale' ? 'sales' : 'purchases'}`, o),
  order: (kind, id) => request(`/${kind === 'sale' ? 'sales' : 'purchases'}/${id}`),
  payOrder: (kind, id, payment) =>
    post(`/${kind === 'sale' ? 'sales' : 'purchases'}/${id}/payments`, payment),

  // --- Cotizaciones ---
  quotes: () => request('/quotes'),
  quote: (id) => request(`/quotes/${id}`),
  createQuote: (q) => post('/quotes', q),
  quoteStatus: (id, status) => request(`/quotes/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) }),
  convertQuote: (id) => request(`/quotes/${id}/convert`, { method: 'POST' }),
};
