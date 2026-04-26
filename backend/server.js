import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import pdfParse from 'pdf-parse';

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
const SCAN_DB_FILE = path.join(STORE_DIR, 'scan-db.json');
const SCAN_POLL_MS = Number(process.env.SCAN_POLL_MS || 8000);
const SCAN_MIN_FILE_AGE_MS = Number(process.env.SCAN_MIN_FILE_AGE_MS || 3000);
const ATTENDANCE_FILE = path.join(STORE_DIR, 'attendance-db.json');
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://taha-farooq.github.io/catering-inventory-manager/';
const ATT_QR_TTL_SEC = Number(process.env.ATTENDANCE_QR_TTL_SEC || 60);

if (!JWT_SECRET || JWT_SECRET.length < 24) {
  console.error('ADMIN_RESET_JWT_SECRET is missing or too short.');
  process.exit(1);
}

if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });
if (!fs.existsSync(STORE_FILE)) fs.writeFileSync(STORE_FILE, JSON.stringify({ used: [] }, null, 2));
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, JSON.stringify({}, null, 2));
if (!fs.existsSync(SCAN_DB_FILE)) fs.writeFileSync(SCAN_DB_FILE, JSON.stringify({
  config: { enabled: false, inboxPath: '', libraryPath: '' },
  docs: [],
  failures: [],
  known: {},
  activity: [],
  updatedAt: new Date().toISOString()
}, null, 2));
if (!fs.existsSync(ATTENDANCE_FILE)) fs.writeFileSync(ATTENDANCE_FILE, JSON.stringify({
  sessions: [],
  active: {},
  payRates: {},
  qrUsed: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
}, null, 2));

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
function readAttendanceDb() {
  try {
    const v = JSON.parse(fs.readFileSync(ATTENDANCE_FILE, 'utf8'));
    return {
      sessions: Array.isArray(v.sessions) ? v.sessions : [],
      active: v.active && typeof v.active === 'object' ? v.active : {},
      payRates: v.payRates && typeof v.payRates === 'object' ? v.payRates : {},
      qrUsed: Array.isArray(v.qrUsed) ? v.qrUsed : [],
      createdAt: v.createdAt || new Date().toISOString(),
      updatedAt: v.updatedAt || new Date().toISOString()
    };
  } catch {
    return { sessions: [], active: {}, payRates: {}, qrUsed: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  }
}
function writeAttendanceDb(db) {
  db.updatedAt = new Date().toISOString();
  fs.writeFileSync(ATTENDANCE_FILE, JSON.stringify(db, null, 2));
}
function verifyAnyUserFromRequest(req) {
  const username = String(req.headers['x-auth-user'] || req.body?.auth?.username || '').trim().toLowerCase();
  const passwordHash = String(req.headers['x-auth-hash'] || req.body?.auth?.passwordHash || '').trim();
  if (!username || !passwordHash) return { ok: false, error: 'Missing auth' };
  const users = readUsers();
  const u = users[username];
  if (!u) return { ok: false, error: 'Unknown user' };
  if (u.password !== passwordHash) return { ok: false, error: 'Invalid auth hash' };
  const role = u.role || (username === 'admin' ? 'admin' : 'user');
  return { ok: true, username, role };
}
function authUser(req, res, next) {
  const auth = verifyAnyUserFromRequest(req);
  if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
  req.authUser = auth;
  return next();
}
function weekStartISO(dateLike) {
  const d = new Date(dateLike || Date.now());
  const day = d.getDay();
  const diff = (day + 6) % 7;
  d.setDate(d.getDate() - diff);
  d.setHours(0,0,0,0);
  return d.toISOString().slice(0, 10);
}
function hoursBetween(startIso, endIso) {
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  return Math.max(0, ms / (1000 * 60 * 60));
}
function readScanDb() {
  try {
    const v = JSON.parse(fs.readFileSync(SCAN_DB_FILE, 'utf8'));
    if (!v || typeof v !== 'object') throw new Error('invalid');
    return {
      config: v.config && typeof v.config === 'object' ? v.config : { enabled: false, inboxPath: '', libraryPath: '' },
      docs: Array.isArray(v.docs) ? v.docs : [],
      failures: Array.isArray(v.failures) ? v.failures : [],
      known: v.known && typeof v.known === 'object' ? v.known : {},
      activity: Array.isArray(v.activity) ? v.activity : [],
      updatedAt: v.updatedAt || new Date().toISOString()
    };
  } catch {
    return { config: { enabled: false, inboxPath: '', libraryPath: '' }, docs: [], failures: [], known: {}, activity: [], updatedAt: new Date().toISOString() };
  }
}
function writeScanDb(db) {
  db.updatedAt = new Date().toISOString();
  fs.writeFileSync(SCAN_DB_FILE, JSON.stringify(db, null, 2));
}
function scanActivity(db, message, extra = {}) {
  db.activity.push({ id: crypto.randomUUID(), at: new Date().toISOString(), message, ...extra });
  if (db.activity.length > 1000) db.activity = db.activity.slice(-1000);
}
function scanFailure(db, filePath, error) {
  db.failures.push({ id: crypto.randomUUID(), at: new Date().toISOString(), filePath, error: String(error?.message || error || 'Unknown error') });
  if (db.failures.length > 500) db.failures = db.failures.slice(-500);
}
function normalizeDocType(raw) {
  const s = String(raw || '').toLowerCase();
  if (s.includes('legal')) return 'legal';
  if (s.includes('tax')) return 'tax';
  if (s.includes('credit')) return 'credit';
  if (s.includes('invoice')) return 'transaction_invoice';
  if (s.includes('transaction')) return 'transaction_invoice';
  if (s.includes('bank')) return 'bank';
  if (s.includes('payroll')) return 'payroll';
  return 'other';
}
function monthLabel(dateObj) {
  return new Intl.DateTimeFormat('en-US', { month: 'long' }).format(dateObj);
}
function slugSafe(v, fallback = 'unknown') {
  const s = String(v || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return s || fallback;
}
function detectBusiness(textLike) {
  const t = String(textLike || '').toLowerCase();
  if (t.includes('degrill')) return 'degrill';
  if (t.includes('parathas') || t.includes('platters')) return 'parathas';
  if (t.includes('dera')) return 'dera';
  return '';
}
function detectDocType(filename, text) {
  const t = `${filename}\n${text}`.toLowerCase();
  const score = { legal: 0, tax: 0, credit: 0, transaction_invoice: 0, bank: 0, payroll: 0, other: 0 };
  const addScore = (type, regex, points = 1) => { if (regex.test(t)) score[type] += points; };
  addScore('legal', /(agreement|contract|summons|notice to appear|attorney|legal|lawsuit|court)/, 3);
  addScore('tax', /(irs|tax|w-2|1099|w9|sales tax|tax return|ein|state tax|quarterly tax)/, 3);
  addScore('credit', /(credit memo|credit note|credit adjustment|credit)/, 3);
  addScore('transaction_invoice', /(invoice|inv[\s#-]|bill to|amount due|subtotal|line item|purchase order)/, 3);
  addScore('bank', /(statement|bank|deposit|withdrawal|checking|savings|routing number)/, 2);
  addScore('payroll', /(payroll|pay stub|timesheet|gross pay|net pay|pay period)/, 3);
  const top = Object.entries(score).sort((a, b) => b[1] - a[1])[0];
  const docType = (top && top[1] > 0) ? top[0] : 'other';
  const confidence = (top && top[1] >= 6) ? 0.95 : (top && top[1] >= 3) ? 0.84 : 0.58;
  return { docType, confidence };
}
function detectSender(filename, text) {
  const joined = `${filename}\n${text || ''}`;
  const lines = joined.split(/\r?\n/).map(x => x.trim()).filter(Boolean).slice(0, 120);
  for (const line of lines) {
    const m = line.match(/^(from|bill from|vendor|seller|issued by|remit to)[:\s]+(.{2,100})$/i);
    if (m) return m[2].trim();
  }
  for (const line of lines) {
    const m = line.match(/^([a-z0-9&.,' -]{3,90})\s*(llc|inc|corp|co\.|company|bank|group)$/i);
    if (m) return m[1].trim();
  }
  for (const line of lines) {
    if (/llc|inc|corp|co\.|company|bank/i.test(line) && line.length <= 80) return line;
  }
  const guess = path.basename(filename, path.extname(filename)).replace(/[_-]+/g, ' ').trim();
  return guess || 'Unknown Sender';
}
function collectPdfFiles(dir, out = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) collectPdfFiles(full, out);
    else if (ent.isFile() && /\.pdf$/i.test(ent.name)) out.push(full);
  }
  return out;
}
async function extractPdfTextSafe(filePath) {
  try {
    const data = fs.readFileSync(filePath);
    const parsed = await pdfParse(data);
    return String(parsed?.text || '').slice(0, 50000);
  } catch {
    return '';
  }
}
function getUniqueTargetPath(targetPath) {
  if (!fs.existsSync(targetPath)) return targetPath;
  const dir = path.dirname(targetPath);
  const ext = path.extname(targetPath);
  const base = path.basename(targetPath, ext);
  for (let i = 2; i < 500; i += 1) {
    const candidate = path.join(dir, `${base}__${i}${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return path.join(dir, `${base}__${Date.now()}${ext}`);
}
function moveFileSafe(src, dst) {
  const target = getUniqueTargetPath(dst);
  try {
    fs.renameSync(src, target);
    return target;
  } catch (e) {
    // Fallback for cross-device/locked rename edge cases.
    if (e && (e.code === 'EXDEV' || e.code === 'EPERM' || e.code === 'EBUSY')) {
      fs.copyFileSync(src, target);
      fs.unlinkSync(src);
      return target;
    }
    throw e;
  }
}
function verifyAdminFromRequest(req) {
  const username = String(req.headers['x-auth-user'] || req.body?.auth?.username || '').trim().toLowerCase();
  const passwordHash = String(req.headers['x-auth-hash'] || req.body?.auth?.passwordHash || '').trim();
  if (!username || !passwordHash) return { ok: false, error: 'Missing admin auth' };
  const users = readUsers();
  const u = users[username];
  if (!u) return { ok: false, error: 'Unknown user' };
  if (u.password !== passwordHash) return { ok: false, error: 'Invalid auth hash' };
  const role = u.role || (username === 'admin' ? 'admin' : 'user');
  if (role !== 'admin') return { ok: false, error: 'Admin only' };
  return { ok: true, username };
}
function adminOnly(req, res, next) {
  const auth = verifyAdminFromRequest(req);
  if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
  req.adminUser = auth.username;
  return next();
}
let scanJobRunning = false;
let scanTimer = null;
async function processScanOnce() {
  if (scanJobRunning) return;
  scanJobRunning = true;
  const db = readScanDb();
  try {
    const inboxPath = String(db.config?.inboxPath || '').trim();
    const libraryPath = String(db.config?.libraryPath || '').trim();
    if (!inboxPath || !libraryPath) return;
    if (!fs.existsSync(inboxPath)) return;
    if (!fs.existsSync(libraryPath)) fs.mkdirSync(libraryPath, { recursive: true });
    const files = collectPdfFiles(inboxPath);
    for (const filePath of files) {
      try {
        const st = fs.statSync(filePath);
        if (!st.isFile()) continue;
        const ageMs = Date.now() - Number(st.mtimeMs || 0);
        // Skip files that were modified very recently to avoid partial/locked scans.
        if (ageMs < SCAN_MIN_FILE_AGE_MS) continue;
        const knownKey = `${st.size}:${st.mtimeMs}`;
        if (db.known[filePath] === knownKey) continue;
        const fileHash = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
        const duplicate = db.docs.find(d => d.fileHash === fileHash);
        if (duplicate) {
          db.known[filePath] = knownKey;
          scanActivity(db, 'Duplicate detected; skipping import', { filePath, existingId: duplicate.id });
          continue;
        }
        const text = await extractPdfTextSafe(filePath);
        const baseName = path.basename(filePath);
        const typeInfo = detectDocType(baseName, text);
        const docType = typeInfo.docType;
        const sender = detectSender(baseName, text);
        const businessTag = detectBusiness(`${baseName}\n${text}`);
        const dt = new Date(st.mtimeMs || Date.now());
        const year = String(dt.getFullYear());
        const month = monthLabel(dt);
        const folder = path.join(libraryPath, year, month, docType);
        if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });
        const targetName = `${dt.toISOString().slice(0, 10)}__${slugSafe(sender, 'sender')}__${slugSafe(docType, 'other')}__${slugSafe(path.basename(baseName, '.pdf'), 'scan')}.pdf`;
        const targetPath = moveFileSafe(filePath, path.join(folder, targetName));
        const doc = {
          id: crypto.randomUUID(),
          importedAt: new Date().toISOString(),
          sender,
          docType,
          businessTag,
          year,
          month,
          fileHash,
          fileName: path.basename(targetPath),
          filePath: targetPath,
          sourcePath: filePath,
          textPreview: text.slice(0, 1200),
          confidence: text ? typeInfo.confidence : 0.45,
          status: (text && typeInfo.confidence >= 0.75) ? 'classified' : 'needs_review',
          notes: ''
        };
        db.docs.push(doc);
        if (db.docs.length > 20000) db.docs = db.docs.slice(-20000);
        db.known[filePath] = knownKey;
        scanActivity(db, 'Imported scanned PDF', { filePath: targetPath, docId: doc.id, docType });
      } catch (err) {
        scanFailure(db, filePath, err);
      }
    }
  } finally {
    writeScanDb(db);
    scanJobRunning = false;
  }
}
function refreshScanTimer() {
  if (scanTimer) {
    clearInterval(scanTimer);
    scanTimer = null;
  }
  const db = readScanDb();
  if (db.config?.enabled) {
    scanTimer = setInterval(() => { processScanOnce().catch(() => {}); }, SCAN_POLL_MS);
  }
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

app.post('/api/attendance/qr/create', adminOnly, (req, res) => {
  const jti = crypto.randomUUID();
  const payload = { jti, mode: 'attendance', source: 'admin_kiosk' };
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: ATT_QR_TTL_SEC });
  const url = `${FRONTEND_URL}?attMode=1&attToken=${encodeURIComponent(token)}`;
  const decoded = jwt.decode(token);
  return res.json({ ok: true, token, url, expiresAt: decoded?.exp ? decoded.exp * 1000 : null, ttlSec: ATT_QR_TTL_SEC });
});

app.get('/api/attendance/qr/validate', authUser, (req, res) => {
  const token = String(req.query.token || '');
  if (!token) return res.status(400).json({ ok: false, error: 'token required' });
  const db = readAttendanceDb();
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.mode !== 'attendance') return res.status(401).json({ ok: false, error: 'Invalid token mode' });
    if (db.qrUsed.includes(decoded.jti)) return res.status(401).json({ ok: false, error: 'Token already used' });
    return res.json({ ok: true, valid: true, expiresAt: decoded.exp ? decoded.exp * 1000 : null });
  } catch (e) {
    return res.status(401).json({ ok: false, error: e.message || 'Invalid token' });
  }
});

app.get('/api/attendance/me', authUser, (req, res) => {
  const db = readAttendanceDb();
  const username = req.authUser.username;
  const active = db.active[username] || null;
  const recent = db.sessions.filter(s => s.username === username).slice(-20).reverse();
  const weekStart = weekStartISO(new Date());
  const weekHours = db.sessions
    .filter(s => s.username === username && s.weekStart === weekStart)
    .reduce((sum, s) => sum + Number(s.hours || 0), 0);
  return res.json({ ok: true, username, active, weekStart, weekHours: +weekHours.toFixed(2), recent });
});

app.post('/api/attendance/check', authUser, (req, res) => {
  const db = readAttendanceDb();
  const { action = 'toggle', token = '', targetUser = '' } = req.body || {};
  const caller = req.authUser.username;
  const callerRole = req.authUser.role;
  const username = targetUser ? String(targetUser).trim().toLowerCase() : caller;
  if (targetUser && callerRole !== 'admin') return res.status(403).json({ ok: false, error: 'Admin only target override' });

  if (!targetUser) {
    if (!token) return res.status(400).json({ ok: false, error: 'QR token required for self check-in/out' });
    try {
      const decoded = jwt.verify(String(token), JWT_SECRET);
      if (decoded.mode !== 'attendance') return res.status(401).json({ ok: false, error: 'Invalid attendance token' });
      if (db.qrUsed.includes(decoded.jti)) return res.status(401).json({ ok: false, error: 'Token already used' });
      db.qrUsed.push(decoded.jti);
      if (db.qrUsed.length > 5000) db.qrUsed = db.qrUsed.slice(-5000);
    } catch (e) {
      return res.status(401).json({ ok: false, error: e.message || 'Invalid token' });
    }
  }

  const now = new Date().toISOString();
  const open = db.active[username];
  const wantIn = action === 'in' || (action === 'toggle' && !open);
  const wantOut = action === 'out' || (action === 'toggle' && !!open);

  if (wantIn) {
    if (open) return res.status(400).json({ ok: false, error: 'Already checked in' });
    db.active[username] = { checkInAt: now, by: caller, method: targetUser ? 'admin_override' : 'qr_user' };
    writeAttendanceDb(db);
    return res.json({ ok: true, status: 'in', username, active: db.active[username] });
  }
  if (wantOut) {
    if (!open) return res.status(400).json({ ok: false, error: 'Not currently checked in' });
    const hours = hoursBetween(open.checkInAt, now);
    const session = {
      id: crypto.randomUUID(),
      username,
      checkInAt: open.checkInAt,
      checkOutAt: now,
      hours: +hours.toFixed(3),
      weekStart: weekStartISO(open.checkInAt),
      checkInBy: open.by || username,
      checkOutBy: caller,
      method: open.method || (targetUser ? 'admin_override' : 'qr_user')
    };
    db.sessions.push(session);
    if (db.sessions.length > 20000) db.sessions = db.sessions.slice(-20000);
    delete db.active[username];
    writeAttendanceDb(db);
    return res.json({ ok: true, status: 'out', username, session });
  }
  return res.status(400).json({ ok: false, error: 'Invalid action' });
});

app.get('/api/attendance/admin/summary', adminOnly, (req, res) => {
  const db = readAttendanceDb();
  const weekStart = String(req.query.weekStart || weekStartISO(new Date()));
  const users = readUsers();
  const sessions = db.sessions.filter(s => s.weekStart === weekStart);
  const byUser = {};
  for (const s of sessions) {
    if (!byUser[s.username]) byUser[s.username] = { username: s.username, hours: 0, sessions: 0 };
    byUser[s.username].hours += Number(s.hours || 0);
    byUser[s.username].sessions += 1;
  }
  const rows = Object.values(byUser).map(r => {
    const rate = Number(db.payRates[r.username] || 0);
    const regular = Math.min(r.hours, 40);
    const overtime = Math.max(0, r.hours - 40);
    const pay = regular * rate + overtime * rate * 1.5;
    return {
      username: r.username,
      displayName: users[r.username]?.displayName || r.username,
      hours: +r.hours.toFixed(2),
      regularHours: +regular.toFixed(2),
      overtimeHours: +overtime.toFixed(2),
      hourlyRate: rate,
      weeklyPay: +pay.toFixed(2),
      sessions: r.sessions
    };
  }).sort((a,b) => b.hours - a.hours);
  return res.json({ ok: true, weekStart, active: db.active, rows, payRates: db.payRates });
});

app.post('/api/attendance/admin/pay-rate', adminOnly, (req, res) => {
  const { username, hourlyRate } = req.body || {};
  const u = String(username || '').trim().toLowerCase();
  if (!u) return res.status(400).json({ ok: false, error: 'username required' });
  const rate = Number(hourlyRate || 0);
  if (!Number.isFinite(rate) || rate < 0) return res.status(400).json({ ok: false, error: 'hourlyRate must be a non-negative number' });
  const db = readAttendanceDb();
  db.payRates[u] = +rate.toFixed(2);
  writeAttendanceDb(db);
  return res.json({ ok: true, username: u, hourlyRate: db.payRates[u] });
});

app.post('/api/attendance/admin/force-out', adminOnly, (req, res) => {
  const { username } = req.body || {};
  const u = String(username || '').trim().toLowerCase();
  if (!u) return res.status(400).json({ ok: false, error: 'username required' });
  const db = readAttendanceDb();
  const open = db.active[u];
  if (!open) return res.status(400).json({ ok: false, error: 'User is not checked in' });
  const now = new Date().toISOString();
  const hours = hoursBetween(open.checkInAt, now);
  db.sessions.push({
    id: crypto.randomUUID(),
    username: u,
    checkInAt: open.checkInAt,
    checkOutAt: now,
    hours: +hours.toFixed(3),
    weekStart: weekStartISO(open.checkInAt),
    checkInBy: open.by || u,
    checkOutBy: req.adminUser,
    method: 'admin_force_out'
  });
  delete db.active[u];
  writeAttendanceDb(db);
  return res.json({ ok: true });
});

app.get('/api/scan/status', adminOnly, (_req, res) => {
  const db = readScanDb();
  const needsReview = db.docs.filter(d => d.status === 'needs_review').length;
  return res.json({
    ok: true,
    beta: true,
    wip: true,
    config: db.config,
    counts: { total: db.docs.length, needsReview, failures: db.failures.length },
    recentFailures: db.failures.slice(-10).reverse(),
    recentActivity: db.activity.slice(-15).reverse(),
    pollMs: SCAN_POLL_MS
  });
});

app.post('/api/scan/config', adminOnly, (req, res) => {
  const db = readScanDb();
  const { inboxPath, libraryPath, enabled } = req.body || {};
  if (typeof inboxPath === 'string') db.config.inboxPath = inboxPath.trim();
  if (typeof libraryPath === 'string') db.config.libraryPath = libraryPath.trim();
  if (typeof enabled === 'boolean') db.config.enabled = enabled;
  scanActivity(db, 'Updated scan configuration', { by: req.adminUser });
  writeScanDb(db);
  refreshScanTimer();
  return res.json({ ok: true, config: db.config });
});

app.post('/api/scan/scan-now', adminOnly, async (_req, res) => {
  await processScanOnce();
  const db = readScanDb();
  return res.json({ ok: true, total: db.docs.length });
});

app.get('/api/scan/search', adminOnly, (req, res) => {
  const db = readScanDb();
  const q = String(req.query.q || '').toLowerCase().trim();
  const sender = String(req.query.sender || '').toLowerCase().trim();
  const rawType = String(req.query.docType || '').trim();
  const docType = rawType ? normalizeDocType(rawType) : '';
  const year = String(req.query.year || '').trim();
  const month = String(req.query.month || '').trim().toLowerCase();
  const businessTag = String(req.query.businessTag || '').trim().toLowerCase();
  const status = String(req.query.status || '').trim().toLowerCase();
  const items = db.docs.filter(d => {
    if (sender && !String(d.sender || '').toLowerCase().includes(sender)) return false;
    if (docType && String(d.docType || '') !== docType) return false;
    if (year && String(d.year || '') !== year) return false;
    if (month && !String(d.month || '').toLowerCase().includes(month)) return false;
    if (businessTag && String(d.businessTag || '').toLowerCase() !== businessTag) return false;
    if (status && String(d.status || '').toLowerCase() !== status) return false;
    if (q) {
      const blob = `${d.sender || ''}\n${d.docType || ''}\n${d.fileName || ''}\n${d.textPreview || ''}\n${d.notes || ''}`.toLowerCase();
      if (!blob.includes(q)) return false;
    }
    return true;
  }).sort((a, b) => String(b.importedAt).localeCompare(String(a.importedAt)));
  return res.json({ ok: true, items, total: items.length });
});

app.post('/api/scan/update/:id', adminOnly, (req, res) => {
  const db = readScanDb();
  const id = String(req.params.id || '');
  const item = db.docs.find(d => d.id === id);
  if (!item) return res.status(404).json({ ok: false, error: 'Document not found' });
  const { sender, docType, businessTag, notes, status } = req.body || {};
  if (typeof sender === 'string') item.sender = sender.trim() || item.sender;
  if (typeof docType === 'string') item.docType = normalizeDocType(docType);
  if (typeof businessTag === 'string') item.businessTag = businessTag.trim().toLowerCase();
  if (typeof notes === 'string') item.notes = notes.slice(0, 2000);
  if (typeof status === 'string') item.status = status;
  item.updatedAt = new Date().toISOString();
  scanActivity(db, 'Updated scan metadata', { by: req.adminUser, docId: id });
  writeScanDb(db);
  return res.json({ ok: true, item });
});

app.post('/api/scan/bulk-tag', adminOnly, (req, res) => {
  const db = readScanDb();
  const { ids, businessTag, docType, status } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ ok: false, error: 'ids required' });
  const wanted = new Set(ids.map(String));
  let updated = 0;
  for (const d of db.docs) {
    if (!wanted.has(d.id)) continue;
    if (typeof businessTag === 'string') d.businessTag = businessTag.trim().toLowerCase();
    if (typeof docType === 'string') d.docType = normalizeDocType(docType);
    if (typeof status === 'string') d.status = status;
    d.updatedAt = new Date().toISOString();
    updated += 1;
  }
  scanActivity(db, 'Bulk-updated scan metadata', { by: req.adminUser, updated });
  writeScanDb(db);
  return res.json({ ok: true, updated });
});

app.get('/api/scan/export', adminOnly, (_req, res) => {
  const db = readScanDb();
  return res.json({ ok: true, exportedAt: new Date().toISOString(), data: db });
});

app.post('/api/scan/import', adminOnly, (req, res) => {
  const payload = req.body?.data;
  if (!payload || typeof payload !== 'object') return res.status(400).json({ ok: false, error: 'data object required' });
  const db = {
    config: payload.config && typeof payload.config === 'object' ? payload.config : { enabled: false, inboxPath: '', libraryPath: '' },
    docs: Array.isArray(payload.docs) ? payload.docs : [],
    failures: Array.isArray(payload.failures) ? payload.failures : [],
    known: payload.known && typeof payload.known === 'object' ? payload.known : {},
    activity: Array.isArray(payload.activity) ? payload.activity : []
  };
  scanActivity(db, 'Imported scan database backup', { by: req.adminUser });
  writeScanDb(db);
  refreshScanTimer();
  return res.json({ ok: true, total: db.docs.length });
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
  refreshScanTimer();
  processScanOnce().catch(() => {});
});
