async function request(path, options) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Error de comunicación con el servidor');
  return data;
}

const post = (path, body) => request(path, { method: 'POST', body: JSON.stringify(body) });

export const api = {
  summary: () => request('/summary'),
  products: () => request('/products'),
  createProduct: (p) => post('/products', p),
  partners: (kind) => request(`/partners${kind ? `?kind=${kind}` : ''}`),
  createPartner: (p) => post('/partners', p),
  orders: (kind) => request(`/${kind === 'sale' ? 'sales' : 'purchases'}`),
  createOrder: (kind, o) => post(`/${kind === 'sale' ? 'sales' : 'purchases'}`, o),
};
