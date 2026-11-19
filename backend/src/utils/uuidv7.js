const crypto = require('node:crypto');

/**
 * Genera un UUIDv7 (RFC 9562) ordenable cronológicamente.
 * Ideal para operaciones Offline (RNF-02): evita colisiones entre terminales POS
 * y preserva el orden exacto en que se realizaron las ventas sin red.
 * @param {number} [timestampMs]
 * @returns {string}
 */
function uuidv7(timestampMs = Date.now()) {
  const bytes = crypto.randomBytes(16);
  const timeBigInt = BigInt(timestampMs);

  // 48 bits de timestamp en milisegundos
  bytes[0] = Number((timeBigInt >> 40n) & 0xffn);
  bytes[1] = Number((timeBigInt >> 32n) & 0xffn);
  bytes[2] = Number((timeBigInt >> 24n) & 0xffn);
  bytes[3] = Number((timeBigInt >> 16n) & 0xffn);
  bytes[4] = Number((timeBigInt >> 8n) & 0xffn);
  bytes[5] = Number(timeBigInt & 0xffn);

  // Version 7 (0111xxxx)
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  // Variant RFC 4122 (10xxxxxx)
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

module.exports = { uuidv7 };
