import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
// SECURITY (docs/SECURITY_REVIEW.md A12): pdf-parse@1.1.1 was unmaintained.
// pdf-parse-fork is the maintained drop-in replacement.
import pdfParse from 'pdf-parse-fork';
import { aiEnabled, aiModel, aiProvider, extractDocumentAI } from './scanAi.js';

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
const SESSION_TTL = process.env.SESSION_TTL || '30d';
const BCRYPT_COST = Number(process.env.BCRYPT_COST || 10);
const TIMEZONE = process.env.TIMEZONE || 'America/New_York';
// SECURITY (docs/SECURITY_REVIEW.md A11): when set, scan inboxPath /
// libraryPath must live under this root. Refuses paths escaping via `..`
// or pointing outside the allowlist. Empty string = disabled (legacy
// behavior, useful only for dev).
const SCAN_ROOT = String(process.env.SCAN_ROOT || '').trim();
// SECURITY (A12): cap a single PDF parse to avoid OOM / DoS via malicious
// PDFs. Files larger than this are skipped (logged as a failure). Per-file
// parse wall-clock cap also applied via Promise.race below.
const SCAN_MAX_PDF_BYTES = Number(process.env.SCAN_MAX_PDF_BYTES || 50 * 1024 * 1024);
const SCAN_PARSE_TIMEOUT_MS = Number(process.env.SCAN_PARSE_TIMEOUT_MS || 30000);

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

// SECURITY (docs/SECURITY_REVIEW.md A9): write JSON via temp+rename so a
// crash mid-write can never leave a truncated credentials/attendance/scan
// file. The rename is atomic on the same filesystem.
function writeJsonAtomic(filePath, data) {
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

// SECURITY (A6): server stores bcrypt(client_sha256). The client still sends
// a SHA-256 hex string (no bcrypt in the browser, no UI change). Legacy
// stored hashes (64 hex chars) are accepted once via constant-time compare,
// then upgraded to bcrypt on first successful login.
const LEGACY_HEX_RE = /^[a-f0-9]{64}$/i;
function isBcryptHash(s) {
  return typeof s === 'string' && /^\$2[aby]\$/.test(s);
}
function constantTimeEqualsString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}
async function verifyHashAgainstStored(clientHash, storedHash) {
  if (!clientHash || !storedHash) return false;
  if (isBcryptHash(storedHash)) {
    try { return await bcrypt.compare(String(clientHash), storedHash); }
    catch { return false; }
  }
  if (LEGACY_HEX_RE.test(storedHash)) {
    return constantTimeEqualsString(String(clientHash).toLowerCase(), storedHash.toLowerCase());
  }
  return false;
}
async function ensureHashUpgraded(users, username, clientHash) {
  const u = users[username];
  if (!u || isBcryptHash(u.password)) return;
  u.password = await bcrypt.hash(String(clientHash), BCRYPT_COST);
  writeUsers(users);
  console.log(`[auth] Upgraded ${username} password storage to bcrypt`);
}

function readUsedStore() {
  try {
    return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
  } catch {
    return { used: [] };
  }
}
function writeUsedStore(store) {
  writeJsonAtomic(STORE_FILE, store);
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
  writeJsonAtomic(USERS_FILE, users);
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

// SECURITY (A6): incoming sync payload is from the client where hashes are
// SHA-256 hex. Persist them as bcrypt so credentials.json on disk never
// contains the same string the client sends. If a user already has a
// matching bcrypt stored (i.e., the client is re-syncing a hash that
// bcrypt-compares to what we already have), keep the existing bcrypt to
// avoid pointless rehashing.
async function bcryptifyForStorage(cleaned, existing) {
  for (const [username, rec] of Object.entries(cleaned)) {
    const incoming = String(rec.password);
    if (isBcryptHash(incoming)) {
      continue; // client somehow sent a bcrypt hash (e.g., backup restore) — accept as-is
    }
    const prev = existing[username]?.password;
    if (prev && isBcryptHash(prev)) {
      try {
        if (await bcrypt.compare(incoming, prev)) {
          rec.password = prev; // same password, keep existing bcrypt
          continue;
        }
      } catch {}
    }
    rec.password = await bcrypt.hash(incoming, BCRYPT_COST);
  }
  return cleaned;
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
  writeJsonAtomic(ATTENDANCE_FILE, db);
}
// SECURITY (A1): prefer Bearer session JWT. Fall back to x-auth-hash for
// rolling-update compatibility — once all clients are on the new code we
// can drop the fallback. The fallback now uses bcrypt-compare under the
// hood so the stored credential is no longer the same string as what's
// transmitted.
async function verifyAnyUserFromRequest(req) {
  const authHeader = String(req.headers['authorization'] || '');
  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      if (decoded.mode !== 'session') return { ok: false, error: 'Invalid token mode' };
      const users = readUsers();
      const u = users[decoded.sub];
      if (!u) return { ok: false, error: 'Unknown user' };
      const role = decoded.role || u.role || (decoded.sub === 'admin' ? 'admin' : 'user');
      return { ok: true, username: decoded.sub, role };
    } catch (e) {
      return { ok: false, error: e?.message || 'Invalid session token' };
    }
  }
  const username = String(req.headers['x-auth-user'] || req.body?.auth?.username || '').trim().toLowerCase();
  const passwordHash = String(req.headers['x-auth-hash'] || req.body?.auth?.passwordHash || '').trim();
  if (!username || !passwordHash) return { ok: false, error: 'Missing auth' };
  const users = readUsers();
  const u = users[username];
  if (!u) return { ok: false, error: 'Unknown user' };
  const ok = await verifyHashAgainstStored(passwordHash, u.password);
  if (!ok) return { ok: false, error: 'Invalid auth hash' };
  const role = u.role || (username === 'admin' ? 'admin' : 'user');
  return { ok: true, username, role };
}
async function authUser(req, res, next) {
  const auth = await verifyAnyUserFromRequest(req);
  if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
  req.authUser = auth;
  return next();
}
// SECURITY/CORRECTNESS (A19): payroll weeks roll over at NY local Monday,
// not UTC. The old version mixed local getDay() with UTC toISOString() and
// classified Sunday-evening NY shifts into the next week. We compute the
// week start entirely in TIMEZONE (default America/New_York) so DST-safe.
const _ISO_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit'
});
const _WKDAY_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: TIMEZONE, weekday: 'short'
});
const _WKDAY_OFFSET = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
function weekStartISO(dateLike) {
  const d = new Date(dateLike || Date.now());
  const localDate = _ISO_FMT.format(d);
  const weekday = _WKDAY_FMT.format(d);
  const offset = _WKDAY_OFFSET[weekday] ?? 0;
  const [y, m, day] = localDate.split('-').map(Number);
  const base = new Date(Date.UTC(y, m - 1, day));
  base.setUTCDate(base.getUTCDate() - offset);
  return base.toISOString().slice(0, 10);
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
  writeJsonAtomic(SCAN_DB_FILE, db);
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
const SCAN_EXTS = /\.(pdf|jpe?g|png|webp)$/i;
const SCAN_MEDIA_TYPES = { '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
function collectPdfFiles(dir, out = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) collectPdfFiles(full, out);
    else if (ent.isFile() && SCAN_EXTS.test(ent.name)) out.push(full);
  }
  return out;
}
async function extractPdfTextSafe(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > SCAN_MAX_PDF_BYTES) {
      return '';
    }
    const data = fs.readFileSync(filePath);
    // SECURITY (A12): hard cap on parse wall-clock so a malformed PDF can't
    // stall the scan loop. The single-file timeout falls through to an empty
    // string and the file gets re-tried (or marked needs_review) on next pass.
    const parsed = await Promise.race([
      pdfParse(data),
      new Promise((_, rej) => setTimeout(() => rej(new Error('pdf parse timeout')), SCAN_PARSE_TIMEOUT_MS)),
    ]);
    return String(parsed?.text || '').slice(0, 50000);
  } catch {
    return '';
  }
}
function isPathUnderScanRoot(p) {
  if (!SCAN_ROOT) return true;
  try {
    const abs = path.resolve(p);
    const root = path.resolve(SCAN_ROOT);
    const rel = path.relative(root, abs);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  } catch { return false; }
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
async function verifyAdminFromRequest(req) {
  const auth = await verifyAnyUserFromRequest(req);
  if (!auth.ok) return { ok: false, error: auth.error || 'Missing admin auth' };
  if (auth.role !== 'admin') return { ok: false, error: 'Admin only' };
  return { ok: true, username: auth.username };
}
async function adminOnly(req, res, next) {
  const auth = await verifyAdminFromRequest(req);
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
        const baseName = path.basename(filePath);
        const ext = path.extname(baseName).toLowerCase();
        const mediaType = SCAN_MEDIA_TYPES[ext] || 'application/pdf';

        // AI-first: Claude reads scanned PDFs and photos natively, which the
        // legacy pdf-parse + regex path cannot (image-only PDFs yield no
        // text). Falls back to the regex path if AI is disabled or fails.
        let ai = null;
        if (aiEnabled()) {
          ai = await extractDocumentAI(fs.readFileSync(filePath), mediaType, baseName);
          if (!ai) scanActivity(db, 'AI extraction failed; using keyword fallback', { filePath });
        }

        const text = ext === '.pdf' ? await extractPdfTextSafe(filePath) : '';
        const typeInfo = ai
          ? { docType: normalizeDocType(ai.docType), confidence: ai.confidence }
          : detectDocType(baseName, text);
        const docType = typeInfo.docType;
        const sender = ai ? ai.sender : detectSender(baseName, text);
        const businessTag = ai ? ai.businessTag : detectBusiness(`${baseName}\n${text}`);

        // File under the date printed ON the document when AI found one.
        // A pile of old paper all scanned today gets today's mtime — the
        // document's own date is what matters for the Year/Month folders.
        const dt = ai?.docDate ? new Date(ai.docDate + 'T12:00:00') : new Date(st.mtimeMs || Date.now());
        const year = String(dt.getFullYear());
        const month = monthLabel(dt);
        const folder = path.join(libraryPath, year, month, docType);
        if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });
        const targetName = `${dt.toISOString().slice(0, 10)}__${slugSafe(sender, 'sender')}__${slugSafe(docType, 'other')}__${slugSafe(path.basename(baseName, ext), 'scan')}${ext}`;
        const targetPath = moveFileSafe(filePath, path.join(folder, targetName));
        const doc = {
          id: crypto.randomUUID(),
          importedAt: new Date().toISOString(),
          sender,
          docType,
          businessTag,
          year,
          month,
          docDate: ai?.docDate || null,
          totalAmount: ai?.totalAmount ?? null,
          referenceNumber: ai?.referenceNumber || null,
          summary: ai?.summary || '',
          extractedBy: ai ? 'ai' : 'keywords',
          fileHash,
          fileName: path.basename(targetPath),
          filePath: targetPath,
          sourcePath: filePath,
          textPreview: ai?.summary || text.slice(0, 1200),
          confidence: ai ? ai.confidence : (text ? typeInfo.confidence : 0.45),
          status: (ai ? ai.confidence >= 0.75 : (text && typeInfo.confidence >= 0.75)) ? 'classified' : 'needs_review',
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
// Render (and most reverse proxies) sit in front of us; trust X-Forwarded-For
// so express-rate-limit keys per real client IP, not Render's edge.
app.set('trust proxy', 1);
// The scan-upload route carries base64 documents (phone photos, scanned
// PDFs) and needs a much larger body cap than the rest of the API. It is
// registered with its own parser BEFORE the global 256kb parser; everything
// else stays tight.
const scanUploadParser = express.json({ limit: '40mb' });
const defaultJsonParser = express.json({ limit: '256kb' });
app.use((req, res, next) => {
  if (req.path === '/api/scan/upload') return scanUploadParser(req, res, next);
  return defaultJsonParser(req, res, next);
});
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    const allowed = new Set([ALLOWED_ORIGIN, ...ALLOWED_ORIGINS, 'http://localhost:5500', 'http://127.0.0.1:5500']);
    if (allowed.has(origin)) return cb(null, true);
    return cb(new Error(`Origin not allowed: ${origin}`));
  }
}));

// SECURITY (A5): friendly rate limit on auth + reset endpoints. Tuned so a
// real user who mistypes their password a few times never gets blocked.
// Limits apply per source IP across a 15-minute window.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { ok: false, error: 'Too many attempts. Please wait a moment and try again.' },
  skipSuccessfulRequests: true
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'admin-reset-backend' });
});

app.get('/api/auth/status', (_req, res) => {
  const users = readUsers();
  res.json({ ok: true, hasUsers: Object.keys(users).length > 0, userCount: Object.keys(users).length });
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  const { username, passwordHash } = req.body || {};
  if (!username || !passwordHash) return res.status(400).json({ ok: false, error: 'username and passwordHash required' });
  const users = readUsers();
  const key = String(username).trim().toLowerCase();
  const u = users[key];
  if (!u) return res.status(401).json({ ok: false, error: 'Invalid username or password' });
  const ok = await verifyHashAgainstStored(passwordHash, u.password);
  if (!ok) return res.status(401).json({ ok: false, error: 'Invalid username or password' });

  // Transparent migration: legacy plain-SHA-256 storage gets upgraded to
  // bcrypt on first successful login (SECURITY_REVIEW.md A6).
  await ensureHashUpgraded(users, key, passwordHash);

  const role = u.role || (key === 'admin' ? 'admin' : 'user');
  const token = jwt.sign({ sub: key, role, mode: 'session' }, JWT_SECRET, { expiresIn: SESSION_TTL });

  // SECURITY (A2): no credentialsSnapshot. Each session sees only itself.
  // The client recomputes the local SHA-256 from the password the user just
  // typed for its offline-fallback cache; nothing about other users leaks.
  return res.json({
    ok: true,
    token,
    user: {
      username: key,
      role,
      displayName: u.displayName || key,
      permissions: u.permissions || []
    }
  });
});

app.post('/api/auth/sync', async (req, res) => {
  // SECURITY (docs/SECURITY_REVIEW.md A0): this endpoint overwrites the entire
  // users file. Require admin auth unless the file is empty (first-run starter
  // ZIP bootstrap). The bootstrap window only exists between deploy and the
  // first valid sync — keep it short by uploading the starter ZIP immediately
  // after creating the service.
  const existingUsers = readUsers();
  const isBootstrap = Object.keys(existingUsers).length === 0;

  if (!isBootstrap) {
    const auth = await verifyAdminFromRequest(req);
    if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
  }

  const { credentials } = req.body || {};
  const cleaned = sanitizeCredentials(credentials);
  if (!Object.keys(cleaned).length) return res.status(400).json({ ok: false, error: 'No valid credentials to sync' });

  if (isBootstrap && !Object.values(cleaned).some(u => u.role === 'admin')) {
    return res.status(400).json({ ok: false, error: 'Bootstrap sync must include at least one admin user' });
  }

  if (isBootstrap) {
    console.warn(`[auth/sync] BOOTSTRAP: writing initial user file with ${Object.keys(cleaned).length} users.`);
  }

  await bcryptifyForStorage(cleaned, existingUsers);
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
  if (!targetUser && callerRole === 'admin') return res.status(403).json({ ok: false, error: 'Admins are not tracked for check in/out' });

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
    pollMs: SCAN_POLL_MS,
    ai: { enabled: aiEnabled(), provider: aiProvider(), model: aiEnabled() ? aiModel() : null }
  });
});

// Direct upload from the browser — lets the admin photograph documents on a
// phone or drag PDFs into the web app, with no folder watcher required.
// Files are written into the configured inbox and run through the same
// pipeline (AI extraction, dedupe, foldering) as watcher-discovered files.
app.post('/api/scan/upload', adminOnly, async (req, res) => {
  const db = readScanDb();
  const inboxPath = String(db.config?.inboxPath || '').trim();
  if (!inboxPath) {
    return res.status(400).json({ ok: false, error: 'Set the Inbox folder in scanner config first.' });
  }
  if (!fs.existsSync(inboxPath)) fs.mkdirSync(inboxPath, { recursive: true });

  const files = Array.isArray(req.body?.files) ? req.body.files : [];
  if (!files.length) return res.status(400).json({ ok: false, error: 'No files in upload.' });
  if (files.length > 20) return res.status(400).json({ ok: false, error: 'Upload at most 20 files at a time.' });

  const saved = [];
  for (const f of files) {
    const rawName = String(f?.name || 'scan');
    const ext = path.extname(rawName).toLowerCase();
    if (!SCAN_EXTS.test(rawName)) {
      return res.status(400).json({ ok: false, error: `Unsupported file type: ${rawName}. Use PDF, JPG, PNG, or WEBP.` });
    }
    let buf;
    try {
      buf = Buffer.from(String(f?.dataBase64 || ''), 'base64');
    } catch {
      return res.status(400).json({ ok: false, error: `Could not decode ${rawName}.` });
    }
    if (!buf.length) return res.status(400).json({ ok: false, error: `${rawName} is empty.` });
    if (buf.length > SCAN_MAX_PDF_BYTES) {
      return res.status(400).json({ ok: false, error: `${rawName} is too large.` });
    }
    const safeBase = slugSafe(path.basename(rawName, ext), 'scan');
    const target = getUniqueTargetPath(path.join(inboxPath, `upload__${safeBase}${ext}`));
    fs.writeFileSync(target, buf);
    // Backdate mtime so the min-file-age guard doesn't delay processing.
    const aged = new Date(Date.now() - SCAN_MIN_FILE_AGE_MS - 1000);
    fs.utimesSync(target, aged, aged);
    saved.push(path.basename(target));
  }
  scanActivity(db, `Uploaded ${saved.length} document(s) from the web app`, { by: req.adminUser });
  writeScanDb(db);

  // Process immediately so the uploader sees results in one round trip.
  await processScanOnce();
  const after = readScanDb();
  return res.json({
    ok: true,
    uploaded: saved.length,
    counts: { total: after.docs.length, needsReview: after.docs.filter(d => d.status === 'needs_review').length },
    recent: after.docs.slice(-saved.length).reverse().map(d => ({
      id: d.id, sender: d.sender, docType: d.docType, businessTag: d.businessTag,
      docDate: d.docDate, totalAmount: d.totalAmount, summary: d.summary,
      status: d.status, fileName: d.fileName, extractedBy: d.extractedBy,
    })),
  });
});

app.post('/api/scan/config', adminOnly, (req, res) => {
  const db = readScanDb();
  const { inboxPath, libraryPath, enabled } = req.body || {};
  if (typeof inboxPath === 'string') {
    const trimmed = inboxPath.trim();
    // SECURITY (A11): require paths under SCAN_ROOT when configured. This
    // prevents an authenticated admin (or anyone with the admin session token)
    // from setting the scanner at, say, %USERPROFILE%\Documents to slurp every
    // PDF on the machine.
    if (trimmed && !isPathUnderScanRoot(trimmed)) {
      return res.status(400).json({ ok: false, error: `inboxPath must live under ${SCAN_ROOT || '(SCAN_ROOT not configured)'}` });
    }
    db.config.inboxPath = trimmed;
  }
  if (typeof libraryPath === 'string') {
    const trimmed = libraryPath.trim();
    if (trimmed && !isPathUnderScanRoot(trimmed)) {
      return res.status(400).json({ ok: false, error: `libraryPath must live under ${SCAN_ROOT || '(SCAN_ROOT not configured)'}` });
    }
    db.config.libraryPath = trimmed;
  }
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

app.post('/api/admin-reset/validate', authLimiter, (req, res) => {
  const { token, requestId } = req.body || {};
  if (!token || !requestId) return res.status(400).json({ valid: false, error: 'token and requestId are required' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.requestId !== requestId) return res.status(401).json({ valid: false, error: 'requestId mismatch' });
    if (isUsed(decoded.jti)) return res.status(401).json({ valid: false, error: 'token already used' });
    // SECURITY (A8): legacy tokens (pre-username-binding) had no `sub` claim.
    // Tolerate them but default to "admin" so existing in-flight links keep
    // working through the rolling deploy. New tokens carry sub explicitly.
    const targetUser = String(decoded.sub || 'admin').trim().toLowerCase();
    return res.json({
      valid: true,
      requestId: decoded.requestId,
      username: targetUser,
      source: decoded.source || 'email',
      expiresAt: decoded.exp ? decoded.exp * 1000 : null
    });
  } catch (e) {
    return res.status(401).json({ valid: false, error: e.message || 'invalid token' });
  }
});

app.post('/api/admin-reset/complete', authLimiter, async (req, res) => {
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

    // SECURITY (A3 + A8): actually write the new password on the server, bound
    // to the username from the JWT. Pre-A3 this endpoint only marked the JTI
    // used and trusted the client to persist the new hash — that was
    // structurally broken because the client and server could diverge.
    const targetUser = String(decoded.sub || 'admin').trim().toLowerCase();
    const users = readUsers();
    if (!users[targetUser]) {
      return res.status(400).json({ ok: false, error: `User '${targetUser}' does not exist on this server` });
    }
    users[targetUser].password = await bcrypt.hash(String(newPasswordHash), BCRYPT_COST);
    writeUsers(users);

    markUsed(decoded.jti, requestId, approver);
    const auditId = createAuditId();
    console.log(`[admin-reset] ${targetUser} password reset complete (audit ${auditId}, approver=${approver})`);
    return res.json({ ok: true, auditId, username: targetUser });
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
