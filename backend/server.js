import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';

dotenv.config();

const PORT = Number(process.env.PORT || 8787);
const JWT_SECRET = process.env.ADMIN_RESET_JWT_SECRET || '';
const RESET_TTL_MIN = Number(process.env.ADMIN_RESET_TTL_MIN || 30);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://taha-farooq.github.io';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const STORE_DIR = path.join(process.cwd(), 'data');
const STORE_FILE = path.join(STORE_DIR, 'used-reset-tokens.json');

if (!JWT_SECRET || JWT_SECRET.length < 24) {
  console.error('ADMIN_RESET_JWT_SECRET is missing or too short.');
  process.exit(1);
}

if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });
if (!fs.existsSync(STORE_FILE)) fs.writeFileSync(STORE_FILE, JSON.stringify({ used: [] }, null, 2));

function readUsedStore() {
  try {
    return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
  } catch {
    return { used: [] };
  }
}
function writeUsedStore(store) {
  fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2));
}
function markUsed(jti, requestId, approver) {
  const store = readUsedStore();
  store.used.push({ jti, requestId, approver, usedAt: new Date().toISOString() });
  if (store.used.length > 2000) store.used = store.used.slice(-2000);
  writeUsedStore(store);
}
function isUsed(jti) {
  const store = readUsedStore();
  return store.used.some(x => x.jti === jti);
}
function createAuditId() {
  return 'AUD-' + Date.now().toString(36).toUpperCase();
}

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    const allowed = new Set([ALLOWED_ORIGIN, ...ALLOWED_ORIGINS, 'http://localhost:5500', 'http://127.0.0.1:5500']);
    if (allowed.has(origin)) return cb(null, true);
    return cb(new Error(`Origin not allowed: ${origin}`));
  }
}));

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'admin-reset-backend' });
});

app.post('/api/admin-reset/validate', (req, res) => {
  const { token, requestId } = req.body || {};
  if (!token || !requestId) return res.status(400).json({ valid: false, error: 'token and requestId are required' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.requestId !== requestId) return res.status(401).json({ valid: false, error: 'requestId mismatch' });
    if (isUsed(decoded.jti)) return res.status(401).json({ valid: false, error: 'token already used' });

    return res.json({
      valid: true,
      requestId: decoded.requestId,
      source: decoded.source || 'email',
      expiresAt: decoded.exp ? decoded.exp * 1000 : null
    });
  } catch (e) {
    return res.status(401).json({ valid: false, error: e.message || 'invalid token' });
  }
});

app.post('/api/admin-reset/complete', (req, res) => {
  const { token, requestId, approver, newPasswordHash } = req.body || {};
  if (!token || !requestId || !approver || !newPasswordHash) {
    return res.status(400).json({ ok: false, error: 'token, requestId, approver, newPasswordHash required' });
  }
  if (!/^[a-f0-9]{64}$/i.test(newPasswordHash)) {
    return res.status(400).json({ ok: false, error: 'newPasswordHash must be a sha256 hex string' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.requestId !== requestId) return res.status(401).json({ ok: false, error: 'requestId mismatch' });
    if (isUsed(decoded.jti)) return res.status(401).json({ ok: false, error: 'token already used' });

    markUsed(decoded.jti, requestId, approver);
    const auditId = createAuditId();
    return res.json({ ok: true, auditId });
  } catch (e) {
    return res.status(401).json({ ok: false, error: e.message || 'invalid token' });
  }
});

app.listen(PORT, () => {
  console.log(`Admin reset backend running on http://localhost:${PORT}`);
  console.log(`Allowed origin: ${ALLOWED_ORIGIN}`);
  if (ALLOWED_ORIGINS.length) console.log(`Extra allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);
  console.log(`Reset TTL: ${RESET_TTL_MIN} min`);
});
