import React from 'react';
import { getBootCapabilityWarnings } from './browserCaps.js';

export function OfflineBanner({ online }) {
  if (online) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        background: '#eff6ff',
        border: '1px solid #93c5fd',
        borderRadius: 8,
        padding: '10px 12px',
        marginBottom: 12,
        fontSize: 13,
        color: '#1e40af',
      }}
    >
      <strong>You appear offline.</strong> Inventory and invoices on this device still work. Login with central auth,
      scanner sync, and attendance checks need the network when you reconnect — failures may show as DMG-E030 /
      DMG-E021.
    </div>
  );
}

export function BrowserCapsBanner({ warnings }) {
  if (!warnings?.length) return null;
  return (
    <div style={{ marginBottom: 12 }}>
      {warnings.map((w, i) => (
        <div
          key={`${w.code}-${i}`}
          style={{
            background: '#fef2f2',
            border: '1px solid #fecaca',
            borderRadius: 8,
            padding: '10px 12px',
            marginBottom: i < warnings.length - 1 ? 8 : 0,
            fontSize: 13,
            color: '#991b1b',
          }}
        >
          {w.message}
        </div>
      ))}
    </div>
  );
}
