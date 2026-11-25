const crypto = require('node:crypto');
const { config } = require('./config');

const SALT_CORE = 'modular-core-salt-v1';
const SALT_CAJA = 'caja-salt-v1';

function hashPassword(secret) {
  return crypto.scryptSync(String(secret), SALT_CAJA, 32).toString('hex');
}

function verifyPassword(secret, storedHash) {
  if (!secret || !storedHash) return false;
  const bufStored = Buffer.from(storedHash, 'hex');
  for (const salt of [SALT_CAJA, SALT_CORE]) {
    const computed = crypto.scryptSync(String(secret), salt, 32).toString('hex');
    const bufComp = Buffer.from(computed, 'hex');
    if (bufComp.length === bufStored.length && crypto.timingSafeEqual(bufComp, bufStored)) {
      return true;
    }
  }
  return false;
}

function signToken(payload, expiresInSeconds = 43200, type = 'access') {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const nowSec = Math.floor(Date.now() / 1000);
  const body = Buffer.from(
    JSON.stringify({
      ...payload,
      sub: payload.sub || payload.id,
      empresa_id: payload.empresa_id !== undefined ? payload.empresa_id : null,
      type,
      iat: nowSec,
      exp: nowSec + expiresInSeconds,
    })
  ).toString('base64url');

  const signature = crypto
    .createHmac('sha256', config.jwtSecret)
    .update(`${header}.${body}`)
    .digest('base64url');

  return `${header}.${body}.${signature}`;
}

function issueSessionTokens(user, empresaNombre = null) {
  const claims = {
    id: user.id,
    sub: user.id,
    nombre: user.nombre,
    username: user.username,
    email: user.email || null,
    rol: user.rol,
    empresa_id: user.empresa_id !== undefined ? user.empresa_id : null,
    empresa_nombre: empresaNombre,
  };
  const accessToken = signToken(claims, 43200, 'access');
  const refreshToken = signToken(claims, 604800, 'refresh');
  return {
    token: accessToken,
    access_token: accessToken,
    refresh_token: refreshToken,
  };
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts;
  const expected = crypto
    .createHmac('sha256', config.jwtSecret)
    .update(`${header}.${body}`)
    .digest('base64url');
  if (signature !== expected) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

module.exports = {
  hashPassword,
  verifyPassword,
  signToken,
  issueSessionTokens,
  verifyToken,
};
