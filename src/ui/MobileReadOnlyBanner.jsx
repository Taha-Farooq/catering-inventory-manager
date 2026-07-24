// Sticky banner shown when the current device is in mobile (read-only)
// sync mode. Tells mom what she's looking at and offers a manual refresh
// + a one-tap shortcut to the Settings panel where she can override.

import React from 'react';

export default function MobileReadOnlyBanner({ syncMode, syncStatus, onRefresh, onOpenSettings }) {
  if (syncMode !== 'mobile') return null;
  const stale = syncStatus?.snapshotAt
    ? `Last refreshed ${formatRelative(syncStatus.snapshotAt)}`
    : 'No data pulled yet — tap Refresh.';
  return (
    <div style={{
      position: 'sticky', top: 0, zIndex: 90,
      background: '#FFFBEB', borderBottom: '1.5px solid #FDE68A',
      padding: '8px 14px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
      fontSize: 12.5,
    }}>
      <span style={{ fontSize: 16 }}>📱</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <strong style={{ color: '#7a5c20' }}>Phone view (read-only).</strong>{' '}
        <span style={{ color: '#7a5c20' }}>{stale}</span>
        {syncStatus?.lastError && (
          <span style={{ color: '#b91c1c', marginLeft: 8 }}>· {syncStatus.lastError}</span>
        )}
      </div>
      <button
        onClick={onRefresh}
        disabled={syncStatus?.pulling}
        className="btn btn-outline btn-sm"
        style={{ minHeight: 32 }}
      >
        {syncStatus?.pulling ? '⏳ Refreshing…' : '↻ Refresh'}
      </button>
      {onOpenSettings && (
        <button
          onClick={onOpenSettings}
          className="btn btn-ghost btn-sm"
          style={{ minHeight: 32, color: '#7a5c20', borderColor: '#FDE68A' }}
          title="Switch this device to Desktop mode if it should be the master"
        >
          ⚙
        </button>
      )}
    </div>
  );
}

function formatRelative(iso) {
  try {
    const then = new Date(iso).getTime();
    const diff = Date.now() - then;
    if (diff < 60_000) return 'just now';
    if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
    return `${Math.round(diff / 86_400_000)}d ago`;
  } catch { return 'recently'; }
}
