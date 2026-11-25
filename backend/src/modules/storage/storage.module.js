const { config } = require('../../core/config');
const { runHotBackup } = require('../../core/database');
const { uuidv7 } = require('../../core/uuidv7');
const { ValidationError } = require('../../core/errors');
const { recordAudit } = require('../audit/audit.module');

const storageModule = {
  name: 'storage',
  prefix: '/api/v1/sistema',
  permissions: {
    SOPORTE_PLATAFORMA: ['SOPORTE'],
    GESTIONAR_BACKUPS_STORAGE: ['DUENO', 'SOPORTE'],
  },
  routes: [
    {
      method: 'GET',
      path: '/storage/status',
      permission: 'GESTIONAR_BACKUPS_STORAGE',
      allowWithoutCompany: true,
      handler: ({ db, actor }) => {
        const stats = actor.empresa_id
          ? db
              .prepare(
                `SELECT COUNT(*) AS total_files, COALESCE(SUM(tamano_bytes), 0) AS used_bytes
                 FROM archivos_storage
                 WHERE empresa_id = ?`
              )
              .get(actor.empresa_id)
          : db
              .prepare(
                `SELECT COUNT(*) AS total_files, COALESCE(SUM(tamano_bytes), 0) AS used_bytes
                 FROM archivos_storage`
              )
              .get();

        const quotaBytes = config.storageQuotaMb * 1024 * 1024;
        const usedBytes = Number(stats.used_bytes || 0);
        const percentUsed =
          quotaBytes > 0 ? Number(((usedBytes / quotaBytes) * 100).toFixed(2)) : 0;

        return {
          status: 200,
          data: {
            storage_provider: 'local',
            bucket: 'uploads',
            empresa_id: actor.empresa_id || null,
            total_archivos: Number(stats.total_files || 0),
            used_mb: Number((usedBytes / (1024 * 1024)).toFixed(2)),
            quota_mb: config.storageQuotaMb,
            percent_used: percentUsed,
            alert_near_limit: percentUsed >= 80,
            alert_critical: percentUsed >= 90,
          },
        };
      },
    },
    {
      method: 'GET',
      path: '/storage/backup',
      permission: 'SOPORTE_PLATAFORMA',
      allowWithoutCompany: true,
      handler: ({ db, actor }) => {
        const files = actor.empresa_id
          ? db
              .prepare('SELECT * FROM archivos_storage WHERE empresa_id = ? ORDER BY creado_en ASC')
              .all(actor.empresa_id)
          : db.prepare('SELECT * FROM archivos_storage ORDER BY creado_en ASC').all();

        return {
          status: 200,
          data: {
            manifest: {
              exported_at: new Date().toISOString(),
              total_archivos: files.length,
              archivos: files,
            },
          },
        };
      },
    },
    {
      method: 'POST',
      path: '/storage/restore',
      permission: 'SOPORTE_PLATAFORMA',
      allowWithoutCompany: true,
      handler: ({ db, actor, body }) => {
        const archivos = Array.isArray(body?.manifest?.archivos)
          ? body.manifest.archivos
          : Array.isArray(body?.archivos)
            ? body.archivos
            : null;
        if (!archivos) {
          throw new ValidationError(
            'Se requiere una lista `archivos` o `manifest.archivos` para restaurar.'
          );
        }

        let restoredCount = 0;
        const insertStmt = db.prepare(`
          INSERT OR REPLACE INTO archivos_storage
            (id, empresa_id, subido_por_id, modulo, entidad_id, proveedor, bucket, ruta_objeto, url_publica, mime_type, tamano_bytes, creado_en)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        db.exec('BEGIN IMMEDIATE TRANSACTION;');
        try {
          for (const item of archivos) {
            insertStmt.run(
              item.id || uuidv7(),
              item.empresa_id,
              item.subido_por_id || actor.id,
              item.modulo || 'RESTORED',
              item.entidad_id || 'N/A',
              item.proveedor || 'local',
              item.bucket || 'uploads',
              item.ruta_objeto || '',
              item.url_publica || '',
              item.mime_type || 'application/octet-stream',
              Number(item.tamano_bytes || 0),
              item.creado_en || new Date().toISOString()
            );
            restoredCount += 1;
          }
          db.exec('COMMIT;');
        } catch (err) {
          db.exec('ROLLBACK;');
          throw err;
        }

        recordAudit(db, {
          empresaId: actor.empresa_id || null,
          usuarioId: actor.id,
          rolUsuario: actor.rol,
          modulo: 'STORAGE',
          accion: 'RESTAURAR_STORAGE_BACKUP',
          entidadAfectada: 'archivos_storage',
          detalle: { restored_files: restoredCount },
        });

        return { status: 200, data: { restored_files: restoredCount } };
      },
    },
    {
      method: 'DELETE',
      path: '/storage/clear',
      permission: 'SOPORTE_PLATAFORMA',
      allowWithoutCompany: true,
      handler: ({ db, actor }) => {
        const res = actor.empresa_id
          ? db.prepare('DELETE FROM archivos_storage WHERE empresa_id = ?').run(actor.empresa_id)
          : db.prepare('DELETE FROM archivos_storage').run();

        recordAudit(db, {
          empresaId: actor.empresa_id || null,
          usuarioId: actor.id,
          rolUsuario: actor.rol,
          modulo: 'STORAGE',
          accion: 'VACIAR_STORAGE',
          entidadAfectada: 'archivos_storage',
          detalle: { deleted_files: res.changes },
        });

        return { status: 200, data: { deleted_files: res.changes } };
      },
    },
    {
      method: 'POST',
      path: '/backups/ejecutar',
      permission: 'GESTIONAR_BACKUPS_STORAGE',
      allowWithoutCompany: true,
      handler: ({ db, actor }) => {
        const backup = runHotBackup(db, undefined, actor.id, actor.empresa_id || null);

        recordAudit(db, {
          empresaId: actor.empresa_id || null,
          usuarioId: actor.id,
          rolUsuario: actor.rol,
          modulo: 'STORAGE',
          accion: 'EJECUCION_HOT_BACKUP',
          entidadAfectada: 'respaldos_sistema',
          entidadId: backup.id,
          detalle: {
            archivo: backup.archivo,
            tamano_bytes: backup.tamano_bytes,
            checksum_sha256: backup.checksum_sha256,
          },
        });

        return { status: 201, data: { backup } };
      },
    },
    {
      method: 'GET',
      path: '/backups',
      permission: 'GESTIONAR_BACKUPS_STORAGE',
      allowWithoutCompany: true,
      handler: ({ db, actor }) => {
        const rows = actor.empresa_id
          ? db
              .prepare(
                'SELECT * FROM respaldos_sistema WHERE empresa_id = ? OR empresa_id IS NULL ORDER BY creado_en DESC LIMIT 50'
              )
              .all(actor.empresa_id)
          : db.prepare('SELECT * FROM respaldos_sistema ORDER BY creado_en DESC LIMIT 50').all();

        return { status: 200, data: { items: rows, total: rows.length } };
      },
    },
  ],
};

module.exports = { storageModule };
