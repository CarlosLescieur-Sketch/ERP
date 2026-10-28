// Cookies de sesión sin dependencias: parseo de la cabecera Cookie y
// construcción de Set-Cookie con las banderas de seguridad.
const COOKIE_NAME = 'erp_session';

export function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// httpOnly (JS no puede leerla), SameSite=Lax (mitiga CSRF, sigue permitiendo
// navegación normal) y Path=/. `Secure` solo en HTTPS para no romper dev local.
export function sessionCookie(token, { maxAgeSeconds, secure }) {
  return [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

export function clearSessionCookie({ secure } = {}) {
  return [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0', ...(secure ? ['Secure'] : [])].join('; ');
}

export const sessionTokenFrom = (req) => parseCookies(req.headers.cookie)[COOKIE_NAME];
