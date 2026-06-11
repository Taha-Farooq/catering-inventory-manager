import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';

dotenv.config();

const JWT_SECRET = process.env.ADMIN_RESET_JWT_SECRET || '';
const TTL_MIN = Number(process.env.ADMIN_RESET_TTL_MIN || 30);
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://taha-farooq.github.io/catering-inventory-manager/';

if (!JWT_SECRET || JWT_SECRET.length < 24) {
  console.error('ADMIN_RESET_JWT_SECRET is missing or too short.');
  process.exit(1);
}

function randomId(len = 20) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

// Optional CLI: `node create-reset-link.js <username>` — defaults to "admin".
// SECURITY (docs/SECURITY_REVIEW.md A8): bind the reset link to a specific
// user via the JWT `sub` claim so a stolen link can't pivot to another
// account.
const targetUser = String(process.argv[2] || 'admin').trim().toLowerCase();
if (!/^[a-z0-9_]+$/i.test(targetUser)) {
  console.error('Username must contain only letters, digits, and underscore.');
  process.exit(1);
}

const requestId = `APR-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${randomId(6).toUpperCase()}`;
const token = jwt.sign(
  {
    jti: randomId(24),
    sub: targetUser,
    requestId,
    source: 'fatim-manual'
  },
  JWT_SECRET,
  { expiresIn: `${TTL_MIN}m` }
);

const url = new URL(FRONTEND_URL);
url.searchParams.set('adminResetToken', token);
url.searchParams.set('adminResetReq', requestId);

console.log('Reset link (send privately):');
console.log(url.toString());
console.log('');
console.log(`Target user: ${targetUser}`);
console.log(`Request ID: ${requestId}`);
console.log(`Expires in: ${TTL_MIN} minutes`);
