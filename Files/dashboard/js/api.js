// The dashboard's only backend: the passcode-gated Netlify function. It never
// talks to Supabase directly (see ledger-read.js for why).

const ENDPOINT = '/.netlify/functions/ledger-read';
const STORE_KEY = 'cc-session';

export class ApiError extends Error {
  constructor(code, status = 0) { super(code); this.code = code; this.status = status; }
}

const MESSAGES = {
  invalid_passcode:     "That passcode isn't right. Try again.",
  too_many_attempts:    'Too many attempts. Wait about ten minutes, then try again.',
  unauthorized:         'Your session expired. Sign in again.',
  server_misconfigured: "The server isn't set up yet. Check the DASHBOARD_ environment variables in Netlify.",
  upstream_error:       "The ledger didn't respond. Try again in a moment.",
  network:              "Can't reach the server. Check your connection.",
  timeout:              'The server took too long to answer. Try again.',
  unknown_tenant:       "That client isn't set up in the ledger.",
};
export const friendly = (err) => MESSAGES[err && err.code] || 'Something went wrong. Try again.';

export const session = {
  token() {
    try {
      const s = JSON.parse(sessionStorage.getItem(STORE_KEY) || 'null');
      return s && Date.parse(s.expires_at) > Date.now() ? s.token : null;
    } catch (_) { return null; }
  },
  save(token, expires_at) { try { sessionStorage.setItem(STORE_KEY, JSON.stringify({ token, expires_at })); } catch (_) {} },
  clear() { try { sessionStorage.removeItem(STORE_KEY); } catch (_) {} },
};

async function post(body, { auth = true, timeoutMs = 15000 } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) {
    const t = session.token();
    if (!t) throw new ApiError('unauthorized', 401);
    headers.Authorization = `Bearer ${t}`;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(ENDPOINT, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
  } catch (err) {
    throw new ApiError(err && err.name === 'AbortError' ? 'timeout' : 'network');
  } finally {
    clearTimeout(timer);
  }
  let json = null;
  try { json = await res.json(); } catch (_) { /* non-JSON error body */ }
  if (!res.ok || !json || json.ok === false) {
    const code = (json && json.error) || `http_${res.status}`;
    if (auth && res.status === 401) {
      session.clear();
      window.dispatchEvent(new CustomEvent('cc:unauthorized'));
    }
    throw new ApiError(code, res.status);
  }
  return json;
}

export async function login(passcode) {
  const r = await post({ action: 'login', passcode }, { auth: false });
  session.save(r.token, r.expires_at);
}
export const listTenants = async () => (await post({ action: 'tenants' })).tenants;
export const read = (tenant, view, opts = {}) => post({ action: 'read', tenant, view, ...opts });
