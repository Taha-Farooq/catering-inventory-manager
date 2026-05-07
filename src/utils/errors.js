import { load } from './storage.js';
import { FAILURE_LOG_KEY } from '../constants.js';

export function logFailure({ area = 'unknown', action = 'unknown', error = null, extra = {} }) {
  try {
    const v = localStorage.getItem('_session');
    const session = v ? JSON.parse(v) : null;
    const detail = !error
      ? 'Unknown error'
      : typeof error === 'string'
        ? error
        : error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error);
    const entry = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      area,
      action,
      error: detail.slice(0, 2000),
      extra,
      page: typeof window !== 'undefined' ? window.location.href : '',
      username: session?.username || 'anonymous',
    };
    const logs = load(FAILURE_LOG_KEY, []);
    logs.push(entry);
    if (logs.length > 500) logs.splice(0, logs.length - 500);
    localStorage.setItem(FAILURE_LOG_KEY, JSON.stringify(logs));
  } catch { /* ignore */ }
}
