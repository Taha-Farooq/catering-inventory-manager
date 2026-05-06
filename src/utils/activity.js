import { load, save, uid } from './storage.js';

export function logActivity(action, details = '') {
  try {
    const session = load('_session', null);
    if (!session) return;
    const entry = { id: uid(), username: session.username, action, details, timestamp: new Date().toISOString() };
    const log = load('_activityLog', []);
    log.push(entry);
    if (log.length > 2000) log.splice(0, log.length - 2000);
    save('_activityLog', log);
  } catch { /* ignore */ }
}
