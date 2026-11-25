const crypto = require('node:crypto');

/**
 * Generador UUIDv7 (RFC 9562) ordenable cronológicamente.
 * Permite generación offline en cliente y evita fragmentación de índices B-Tree en Postgres/SQLite.
 */
function uuidv7(timestampMs = Date.now()) {
  const bytes = crypto.randomBytes(16);
  const timeBigInt = BigInt(timestampMs);

  bytes[0] = Number((timeBigInt >> 40n) & 0xffn);
  bytes[1] = Number((timeBigInt >> 32n) & 0xffn);
  bytes[2] = Number((timeBigInt >> 24n) & 0xffn);
  bytes[3] = Number((timeBigInt >> 16n) & 0xffn);
  bytes[4] = Number((timeBigInt >> 8n) & 0xffn);
  bytes[5] = Number(timeBigInt & 0xffn);

  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

module.exports = { uuidv7 };
