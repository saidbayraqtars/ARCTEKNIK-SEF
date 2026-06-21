'use strict';
const { poolPromise } = require('../config/db');

// Kritik işlemleri AuditLog'a yazar (kim + ne + ne zaman). Best-effort: log
// başarısız olsa bile ana işlemi DURDURMAZ. Aynı transaction içinde tutarlı
// kalmak için opsiyonel `executor` (transaction veya pool) verilebilir.
async function logAudit(req, { action, entity = null, entityId = null, detail = null }, executor = null) {
    try {
        const runner = executor || (await poolPromise);
        await runner.request()
            .input('userId', req?.user?.userId ?? null)
            .input('username', req?.user?.username || req?.user?.fullName || null)
            .input('action', action)
            .input('entity', entity)
            .input('entityId', entityId != null ? String(entityId) : null)
            .input('detail', detail != null ? String(detail).slice(0, 1000) : null)
            .query(`
                INSERT INTO AuditLog (UserID, Username, Action, Entity, EntityID, Detail)
                VALUES (@userId, @username, @action, @entity, @entityId, @detail)
            `);
    } catch (err) {
        console.error('Audit log yazılamadı:', err.message);
    }
}

module.exports = { logAudit };
