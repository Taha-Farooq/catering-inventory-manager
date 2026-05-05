import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';

const ToastContext = createContext(null);

let _toastAdd = null;

/** Global toast API (works from login screen and inside modals). */
export function showToast(msg, type = 'success') {
  if (_toastAdd) _toastAdd(msg, type);
}

export function toastApiFailure(res, fallback = 'Request failed') {
  if (!res || res.ok) return;
  const suffix = res.code ? ` (${res.code})` : '';
  showToast(`${res.error || fallback}${suffix}`, 'warning');
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be used within ToastProvider');
  }
  return ctx;
}

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const addToast = useCallback((msg, type = 'success') => {
    const id = Date.now() + Math.random();
    setToasts((p) => [...p, { id, msg, type }]);
    setTimeout(() => setToasts((p) => p.filter((t) => t.id !== id)), 3000);
  }, []);

  useEffect(() => {
    _toastAdd = addToast;
    return () => {
      _toastAdd = null;
    };
  }, [addToast]);

  const getStyle = (t) =>
    t === 'error'
      ? { background: '#fee2e2', color: '#991b1b' }
      : t === 'warning'
        ? { background: '#fff3cd', color: '#856404' }
        : { background: '#d4edda', color: '#155724' };
  const getIcon = (t) => (t === 'error' ? '❌ ' : t === 'warning' ? '⚠️ ' : '✅ ');

  const value = { showToast: addToast };

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        style={{
          position: 'fixed',
          bottom: 24,
          right: 24,
          zIndex: 9999,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          alignItems: 'flex-end',
          pointerEvents: 'none',
        }}
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            style={{
              ...getStyle(t.type),
              padding: '10px 16px',
              borderRadius: 8,
              boxShadow: '0 4px 12px rgba(0,0,0,.18)',
              fontSize: 13.5,
              fontWeight: 500,
              maxWidth: 340,
              animation: 'fadeInUp .25s ease',
            }}
          >
            {getIcon(t.type)}
            {t.msg}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
