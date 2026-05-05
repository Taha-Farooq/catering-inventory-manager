import React from 'react';

export default function Modal({ open, onClose, title, children, wide, maxW, closeOnBackdrop = false }) {
  if (!open) return null;
  return (
    <div
      className="modal-overlay no-print"
      onClick={closeOnBackdrop ? (e) => { if (e.target === e.currentTarget) onClose(); } : undefined}
    >
      <div className="modal" style={{ maxWidth: maxW || (wide ? 840 : 560) }} onClick={(e) => e.stopPropagation()}>
        <div className="flex-between mb-4">
          <h2 style={{ color: 'var(--brown)', fontSize: 'clamp(15px,2vw,18px)', fontWeight: 700 }}>{title}</h2>
          <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: '#bbb', lineHeight: 1 }} aria-label="Close">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}
