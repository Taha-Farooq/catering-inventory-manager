import React, { useState, useEffect, useRef } from 'react';
import jsQR from 'jsqr';

const MAX_ATTEMPTS = 3;
const ATT_TOKEN_PARAM = 'attToken';

function Btn({ style = {}, children, ...p }) {
  return (
    <button style={{ border: 'none', borderRadius: 10, fontSize: 15, fontWeight: 600, cursor: 'pointer', padding: '12px 28px', ...style }} {...p}>
      {children}
    </button>
  );
}

export default function QrScanGate({ onPassed, onFailed, attendanceApiCallFn, currentUser }) {
  const [phase, setPhase] = useState('starting');
  // starting | scanning | validating | error | locked | success
  const [attempts, setAttempts] = useState(0);
  const [errMsg, setErrMsg] = useState('');
  const [scanKey, setScanKey] = useState(0); // increment to restart camera

  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const phaseRef = useRef(phase);
  useEffect(() => { phaseRef.current = phase; }, [phase]);

  // Block back button during gate
  useEffect(() => {
    window.history.pushState(null, '', window.location.href);
    const onPop = () => window.history.pushState(null, '', window.location.href);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Camera lifecycle tied to scanKey
  useEffect(() => {
    if (phase === 'error' || phase === 'locked' || phase === 'success' || phase === 'validating') return;
    let active = true;
    let rafId = null;

    navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } } })
      .then(stream => {
        if (!active) { stream.getTracks().forEach(t => t.stop()); return; }
        streamRef.current = stream;
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        video.onloadedmetadata = () => {
          if (!active) return;
          video.play().catch(() => {});
          setPhase('scanning');

          const loop = () => {
            if (!active || phaseRef.current !== 'scanning') return;
            const canvas = canvasRef.current;
            if (video.readyState >= video.HAVE_ENOUGH_DATA && canvas) {
              canvas.width = video.videoWidth;
              canvas.height = video.videoHeight;
              const ctx = canvas.getContext('2d', { willReadFrequently: true });
              ctx.drawImage(video, 0, 0);
              const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
              const code = jsQR(imgData.data, imgData.width, imgData.height, { inversionAttempts: 'dontInvert' });
              if (code?.data) {
                handleQrDetected(code.data);
                return;
              }
            }
            rafId = requestAnimationFrame(loop);
          };
          rafId = requestAnimationFrame(loop);
        };
      })
      .catch(() => {
        if (!active) return;
        setErrMsg('Camera access denied. Please allow camera permissions in your browser settings and reload.');
        setAttempts(a => {
          const next = a + 1;
          setPhase(next >= MAX_ATTEMPTS ? 'locked' : 'error');
          return next;
        });
      });

    return () => {
      active = false;
      if (rafId) cancelAnimationFrame(rafId);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
        streamRef.current = null;
      }
    };
  }, [scanKey]);

  async function handleQrDetected(data) {
    // Stop scan loop first
    phaseRef.current = 'validating';
    setPhase('validating');
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }

    // Extract attendance token from scanned URL or treat as raw token
    let token = '';
    try {
      const url = new URL(data);
      token = url.searchParams.get(ATT_TOKEN_PARAM) || '';
    } catch {
      token = data.trim();
    }

    if (!token) {
      handleFail('Not a valid attendance QR code. Make sure you scan the check-in kiosk QR.');
      return;
    }

    const res = await attendanceApiCallFn('/api/attendance/qr/validate', { currentUser, query: { token } });
    if (res.ok) {
      setPhase('success');
      setTimeout(() => onPassed(token), 900);
    } else if (res.code === 'DMG-E021') {
      handleFail('Cannot reach the server. Check your internet connection and try again.');
    } else {
      handleFail('QR code is expired or not recognised. Ask your manager to generate a fresh QR code.');
    }
  }

  function handleFail(msg) {
    setAttempts(prev => {
      const next = prev + 1;
      setErrMsg(msg);
      setPhase(next >= MAX_ATTEMPTS ? 'locked' : 'error');
      return next;
    });
  }

  function retry() {
    setErrMsg('');
    setPhase('starting');
    setScanKey(k => k + 1);
  }

  // ── Renders ──────────────────────────────────────────────────────────────

  if (phase === 'success') {
    return (
      <div style={fullScreen('#f0fdf4')}>
        <div style={{ fontSize: 72, marginBottom: 12 }}>✅</div>
        <div style={{ fontSize: 22, fontWeight: 700, color: '#166534', marginBottom: 8 }}>QR Verified!</div>
        <div style={{ fontSize: 14, color: '#15803d' }}>Loading check-in / out…</div>
      </div>
    );
  }

  if (phase === 'locked') {
    return (
      <div style={fullScreen('#fff7f7')}>
        <div style={{ fontSize: 72, marginBottom: 12 }}>🔒</div>
        <div style={{ fontSize: 22, fontWeight: 700, color: '#991b1b', marginBottom: 10 }}>Access Denied</div>
        <div style={{ fontSize: 14, color: '#7f1d1d', textAlign: 'center', maxWidth: 300, lineHeight: 1.6, marginBottom: 20 }}>
          {MAX_ATTEMPTS} invalid scan attempts. You have been locked out. Please ask your manager to reset your access.
        </div>
        <Btn style={{ background: '#991b1b', color: 'white' }} onClick={onFailed}>Return to Login</Btn>
      </div>
    );
  }

  if (phase === 'error') {
    return (
      <div style={fullScreen('#1a1a2e')}>
        <div style={{ fontSize: 60, marginBottom: 12 }}>❌</div>
        <div style={{ fontSize: 20, fontWeight: 700, color: 'white', marginBottom: 8, textAlign: 'center' }}>Invalid QR Code</div>
        <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.7)', textAlign: 'center', maxWidth: 300, lineHeight: 1.6, marginBottom: 8 }}>
          {errMsg}
        </div>
        <div style={{ fontSize: 13, color: '#f87171', marginBottom: 24 }}>
          Attempt {attempts} of {MAX_ATTEMPTS} — {MAX_ATTEMPTS - attempts} remaining
        </div>
        <Btn style={{ background: 'white', color: '#1a1a2e', marginBottom: 12 }} onClick={retry}>
          Try Again
        </Btn>
        <Btn style={{ background: 'transparent', color: 'rgba(255,255,255,0.5)', border: '1px solid rgba(255,255,255,0.2)', fontSize: 13, padding: '10px 20px' }} onClick={onFailed}>
          Log Out
        </Btn>
      </div>
    );
  }

  if (phase === 'validating') {
    return (
      <div style={fullScreen('#1a1a2e')}>
        <div style={{ fontSize: 48, marginBottom: 16, animation: 'pulse 1s infinite' }}>🔍</div>
        <div style={{ fontSize: 18, fontWeight: 600, color: 'white' }}>Verifying QR code…</div>
      </div>
    );
  }

  // starting | scanning — show camera view
  return (
    <div style={{ position: 'fixed', inset: 0, background: '#000', zIndex: 9999, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
      {/* Live camera preview */}
      <video
        ref={videoRef}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
        playsInline
        muted
      />
      <canvas ref={canvasRef} style={{ display: 'none' }} />

      {/* Dark overlay with cutout */}
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
        {/* Finder box */}
        <div style={{ width: 260, height: 260, border: '3px solid rgba(255,255,255,0.85)', borderRadius: 14, position: 'relative', boxShadow: '0 0 0 9999px rgba(0,0,0,0.45)', marginBottom: 24 }}>
          {/* Corner accents */}
          {[
            { top: -3, left: -3, borderTop: '4px solid #4ade80', borderLeft: '4px solid #4ade80' },
            { top: -3, right: -3, borderTop: '4px solid #4ade80', borderRight: '4px solid #4ade80' },
            { bottom: -3, left: -3, borderBottom: '4px solid #4ade80', borderLeft: '4px solid #4ade80' },
            { bottom: -3, right: -3, borderBottom: '4px solid #4ade80', borderRight: '4px solid #4ade80' },
          ].map((s, i) => (
            <div key={i} style={{ position: 'absolute', width: 28, height: 28, borderRadius: 3, ...s }} />
          ))}
          {/* Scan line animation */}
          {phase === 'scanning' && (
            <div style={{
              position: 'absolute', left: 0, right: 0, height: 2,
              background: 'linear-gradient(90deg, transparent, #4ade80, transparent)',
              animation: 'scanline 2s linear infinite',
            }} />
          )}
        </div>

        <div style={{ color: 'white', fontSize: 17, fontWeight: 600, marginBottom: 8, textShadow: '0 1px 4px rgba(0,0,0,0.9)' }}>
          Scan the kiosk QR code
        </div>
        <div style={{ color: 'rgba(255,255,255,0.6)', fontSize: 12.5, marginBottom: attempts > 0 ? 8 : 0 }}>
          {phase === 'starting' ? 'Opening camera…' : 'Point camera at the check-in QR code'}
        </div>
        {attempts > 0 && (
          <div style={{ color: '#fca5a5', fontSize: 12, marginBottom: 8 }}>
            Attempt {attempts + 1} of {MAX_ATTEMPTS}
          </div>
        )}

        <Btn
          style={{ marginTop: 28, background: 'rgba(255,255,255,0.12)', color: 'white', border: '1px solid rgba(255,255,255,0.25)', backdropFilter: 'blur(4px)', padding: '11px 28px' }}
          onClick={onFailed}
        >
          Cancel / Log Out
        </Btn>
      </div>

      <style>{`
        @keyframes scanline {
          0%   { top: 0%; }
          100% { top: 100%; }
        }
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50%       { opacity: 0.4; }
        }
      `}</style>
    </div>
  );
}

function fullScreen(bg) {
  return {
    position: 'fixed', inset: 0, zIndex: 9999,
    background: bg,
    display: 'flex', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center',
    padding: 32,
  };
}
