/**
 * Compatibility shim — import directly from src/utils/ in new code.
 * Re-exports for tabs that were extracted before the canonical utils existed.
 */
export { load, today } from './utils/storage.js';
export { logActivity } from './utils/activity.js';
export { logFailure } from './utils/errors.js';

export function getProfile(username) {
  try {
    const profiles = JSON.parse(localStorage.getItem('_profiles') || '{}');
    return profiles[username] || {
      displayName: username === 'admin' ? 'Administrator' : 'Staff User',
      icon: username === 'admin' ? '👤' : '👨‍🍳',
    };
  } catch {
    return { displayName: username, icon: '👤' };
  }
}
