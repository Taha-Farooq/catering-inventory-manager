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
const USERS_FILE = path.join(STORE_DIR, 'credentials.json');

if (!JWT_SECRET || JWT_SECRET.length < 24) {
  console.error('ADMIN_RESET_JWT_SECRET is missing or too short.');
  process.exit(1);
}

if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });
if (!fs.existsSync(STORE_FILE)) fs.writeFileSync(STORE_FILE, JSON.stringify({ used: [] }, null, 2));
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, JSON.stringify({}, null, 2));

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
function readUsers() {
  try {
    const v = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    return (v && typeof v === 'object') ? v : {};
  } catch {
    return {};
  }
}
function writeUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}
function sanitizeCredentials(input) {
  const src = (input && typeof input === 'object') ? input : {};
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    if (!v || typeof v !== 'object') continue;
    if (!/^[a-z0-9_]+$/i.test(k)) continue;
    if (!v.password || typeof v.password !== 'string') continue;
    out[k.toLowerCase()] = {
      password: v.password,
      role: v.role === 'admin' ? 'admin' : 'user',
      displayName: typeof v.displayName === 'string' ? v.displayName : k,
      permissions: Array.isArray(v.permissions) ? v.permissions : undefined
    };
  }
  return out;
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

app.get('/api/auth/status', (_req, res) => {
  const users = readUsers();
  res.json({ ok: true, hasUsers: Object.keys(users).length > 0, userCount: Object.keys(users).length });
});

app.post('/api/auth/login', (req, res) => {
  const { username, passwordHash } = req.body || {};
  if (!username || !passwordHash) return res.status(400).json({ ok: false, error: 'username and passwordHash required' });
  const users = readUsers();
  const key = String(username).trim().toLowerCase();
  const u = users[key];
  if (!u) return res.status(401).json({ ok: false, error: 'Invalid username or password' });
  if (u.password !== passwordHash) return res.status(401).json({ ok: false, error: 'Invalid username or password' });
  return res.json({
    ok: true,
    user: {
      username: key,
      role: u.role || (key === 'admin' ? 'admin' : 'user'),
      displayName: u.displayName || key,
      permissions: u.permissions || []
    },
    credentialsSnapshot: users
  });
});

app.post('/api/auth/sync', (req, res) => {
  const { credentials } = req.body || {};
  const cleaned = sanitizeCredentials(credentials);
  if (!Object.keys(cleaned).length) return res.status(400).json({ ok: false, error: 'No valid credentials to sync' });
  writeUsers(cleaned);
  return res.json({ ok: true, userCount: Object.keys(cleaned).length });
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
