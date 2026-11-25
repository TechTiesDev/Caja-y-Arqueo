function formatEntry(level, message, meta = {}) {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    message,
    ...meta,
  });
}

const logger = {
  silent: process.env.LOG_SILENT === 'true',
  info(message, meta = {}) {
    if (!this.silent) console.log(formatEntry('INFO', message, meta));
  },
  warn(message, meta = {}) {
    if (!this.silent) console.warn(formatEntry('WARN', message, meta));
  },
  error(message, meta = {}) {
    if (!this.silent) console.error(formatEntry('ERROR', message, meta));
  },
  audit(message, meta = {}) {
    if (!this.silent) console.log(formatEntry('AUDIT', message, meta));
  },
};

module.exports = { logger, formatEntry };
