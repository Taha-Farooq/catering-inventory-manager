/**
 * Maps backend fetch failures to DMG-E020–E031 for diagnostics + UI copy.
 * Browsers rarely distinguish CORS from offline; both surface as TypeError.
 */

export function classifyFetchException(err, context = '') {
  const msg = String(err?.message ?? err ?? '');
  const name = err?.name || '';

  if (/abort/i.test(msg) || name === 'AbortError') {
    return { code: 'DMG-E030', detail: 'aborted', hint: context };
  }
  if (msg === 'Timeout' || /timeout/i.test(msg)) {
    return { code: 'DMG-E021', detail: 'timeout', hint: context };
  }
  if (name === 'TypeError' && /fetch|Failed to fetch|NetworkError|Load failed|network/i.test(msg)) {
    return { code: 'DMG-E021', detail: 'network', hint: context };
  }
  return { code: 'DMG-E030', detail: 'exception', message: msg.slice(0, 400), hint: context };
}

export function classifyHttpStatus(status, path = '') {
  const p = String(path || '');
  if (status === 401) {
    if (p.includes('/auth/login')) return { code: 'DMG-E020', detail: 'unauthorized_login' };
    return { code: 'DMG-E022', detail: 'unauthorized' };
  }
  if (status === 403) {
    return { code: 'DMG-E031', detail: 'forbidden_or_cors', note: 'May be wrong origin (ALLOWED_ORIGINS) or blocked request.' };
  }
  if (status === 404) return { code: 'DMG-E021', detail: 'not_found' };
  if (status >= 500 && status < 600) return { code: 'DMG-E021', detail: `http_${status}` };
  if (status === 0) return { code: 'DMG-E031', detail: 'status_0' };
  return { code: 'DMG-E030', detail: `http_${status}` };
}

export function mergeApiFailure({ exception, response, path }) {
  if (response && typeof response.status === 'number') {
    const h = classifyHttpStatus(response.status, path);
    if (h.code !== 'DMG-E030' || response.status >= 400) return h;
  }
  if (exception) return classifyFetchException(exception, path);
  return { code: 'DMG-E030', detail: 'unknown' };
}

export function userMessageForCode(code, fallback = '') {
  switch (code) {
    case 'DMG-E020':
      return 'Invalid username or password (DMG-E020).';
    case 'DMG-E021':
      return 'Login service unreachable (DMG-E021). Check your connection, VPN, or try again later.';
    case 'DMG-E022':
      return 'Session expired or access denied (DMG-E022). Sign in again.';
    case 'DMG-E030':
      return `Request failed (DMG-E030). ${fallback || 'Try again or contact support.'}`;
    case 'DMG-E031':
      return 'Connection blocked (DMG-E031). Admin: confirm site URL is listed in backend ALLOWED_ORIGINS.';
    default:
      return fallback || 'Request failed. Try again.';
  }
}
