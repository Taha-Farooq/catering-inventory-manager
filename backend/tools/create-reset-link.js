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

const requestId = `APR-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${randomId(6).toUpperCase()}`;
const token = jwt.sign(
  {
    jti: randomId(24),
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
console.log(`Request ID: ${requestId}`);
console.log(`Expires in: ${TTL_MIN} minutes`);
