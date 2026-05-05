import React from 'react';

/**
 * In-app confirmation (Slice 2). Stacks above nested modals (e.g. Settings).
 * Backdrop click = cancel.
 */
export default function Confirm({
  open,
  message,
  onConfirm,
  onCancel,
  confirmLabel = 'Delete',
  confirmClass = 'btn-danger',
  title,
  detail,
  dangerCode,
  wide,
}) {
  if (!open) return null;
  return (
    <div
      className="modal-overlay no-print"
      style={{ zIndex: 5000 }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="modal" style={{ maxWidth: wide ? 520 : 400 }} onClick={(e) => e.stopPropagation()}>
        {title && (
          <h3 style={{ margin: '0 0 12px', fontSize: 17, fontWeight: 700, color: 'var(--brown)' }}>{title}</h3>
        )}
        <p
          style={{
            marginBottom: detail ? 10 : 18,
            fontSize: 15,
            color: '#333',
            lineHeight: 1.55,
            whiteSpace: 'pre-line',
          }}
        >
          {message}
        </p>
        {detail && (
          <p style={{ marginBottom: 18, fontSize: 13, color: '#666', lineHeight: 1.55, whiteSpace: 'pre-line' }}>
            {detail}
          </p>
        )}
        {dangerCode && (
          <p style={{ marginBottom: 16, fontSize: 12, color: '#92400e', fontFamily: 'monospace' }}>{dangerCode}</p>
        )}
        <div className="flex gap-2" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-outline" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className={`btn ${confirmClass}`} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
