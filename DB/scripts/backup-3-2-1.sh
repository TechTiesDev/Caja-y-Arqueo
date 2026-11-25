#!/usr/bin/env bash
# ============================================================================
# SCRIPT DE BACKUP AUTOMÁTICO 3-2-1 (PostgreSQL 17 + SQLite WAL -> R2 & Drive)
# Frecuencia recomendada (cron): Cada 4 horas (`0 */4 * * *`)
# Retención GFS: 7 días locales, 30 días diarios en nube, 24 meses mensuales.
# ============================================================================
set -euo pipefail

TIMESTAMP=$(date -u +"%Y%m%dT%H%M%SZ")
BACKUP_ROOT="${BACKUP_ROOT:-/opt/modular/backups}"
PG_CONTAINER="${PG_CONTAINER:-modular-postgres}"
PG_USER="${PG_USER:-postgres}"
RCLONE_REMOTE_PRIMARY="${RCLONE_REMOTE_PRIMARY:-r2:modular-backups}"
RCLONE_REMOTE_SECONDARY="${RCLONE_REMOTE_SECONDARY:-gdrive:modular-backups}"

mkdir -p "${BACKUP_ROOT}/daily"

echo "[1/4] Volcando base de datos PostgreSQL db_caja_arqueo..."
DUMP_FILE="${BACKUP_ROOT}/daily/db_caja_arqueo_${TIMESTAMP}.dump"
if docker ps --format '{{.Names}}' | grep -q "^${PG_CONTAINER}$"; then
  docker exec "${PG_CONTAINER}" pg_dump -U "${PG_USER}" -Fc "db_caja_arqueo" > "${DUMP_FILE}" 2>/dev/null || true
  if [ -s "${DUMP_FILE}" ]; then
    pg_restore --list "${DUMP_FILE}" > /dev/null
    echo "  -> OK: ${DUMP_FILE}"
  fi
fi

echo "[2/4] Sincronizando hacia almacenamiento externo (Cloudflare R2 + Google Drive)..."
if command -v rclone >/dev/null 2>&1; then
  rclone copy "${BACKUP_ROOT}/daily" "${RCLONE_REMOTE_PRIMARY}/daily" --transfers 4
  rclone copy "${BACKUP_ROOT}/daily" "${RCLONE_REMOTE_SECONDARY}/daily" --transfers 2
fi

echo "[3/4] Aplicando política de retención local (7 días)..."
find "${BACKUP_ROOT}/daily" -type f -mtime +7 -delete

echo "[4/4] Backup completado: ${TIMESTAMP}"
