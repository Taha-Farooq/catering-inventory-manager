// Soft-delete safety net. Deleted records land here for 30 days and can be
// restored from Settings → Recently Deleted. Confirm dialogs prevent most
// accidents; this catches the rest — an accidentally deleted invoice or
// customer is no longer simply gone.

import { load, save } from './storage.js';

const TRASH_KEY = '_recentlyDeleted';
const MAX_ITEMS = 200;
const RETENTION_DAYS = 30;

/** Record a deletion. kind: 'cateringInvoices' | 'purchaseInvoices' |
 *  'transferInvoices' | 'customers' — the storage key it restores into. */
export function moveToTrash(kind, label, record) {
  const trash = load(TRASH_KEY, []);
  trash.push({
    trashId: crypto.randomUUID(),
    kind,
    label,
    record,
    deletedAt: new Date().toISOString(),
  });
  // Keep bounded; drop oldest first.
  save(TRASH_KEY, trash.slice(-MAX_ITEMS));
}

/** Entries still within the retention window, newest first. */
export function listTrash() {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 3600 * 1000;
  return load(TRASH_KEY, [])
    .filter(t => new Date(t.deletedAt).getTime() >= cutoff)
    .reverse();
}

/** Restore one entry into its original collection. Returns the restored
 *  record, or null if the entry no longer exists. A record whose id is
 *  already present (e.g. re-created manually) is appended with a suffixed
 *  id rather than clobbering. */
export function restoreFromTrash(trashId) {
  const trash = load(TRASH_KEY, []);
  const idx = trash.findIndex(t => t.trashId === trashId);
  if (idx === -1) return null;
  const entry = trash[idx];
  const collection = load(entry.kind, []);
  const rec = { ...entry.record };
  if (rec.id && collection.some(x => x.id === rec.id)) {
    rec.id = `${rec.id}-restored`;
  }
  collection.push(rec);
  save(entry.kind, collection);
  trash.splice(idx, 1);
  save(TRASH_KEY, trash);
  return rec;
}

/** Permanently remove one entry (or all expired ones when no id given). */
export function purgeTrash(trashId = null) {
  if (trashId === null) {
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 3600 * 1000;
    save(TRASH_KEY, load(TRASH_KEY, []).filter(t => new Date(t.deletedAt).getTime() >= cutoff));
    return;
  }
  save(TRASH_KEY, load(TRASH_KEY, []).filter(t => t.trashId !== trashId));
}
