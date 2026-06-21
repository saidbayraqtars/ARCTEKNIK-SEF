const express = require('express');
const { poolPromise } = require('../config/db');
const { authenticate, adminOnly } = require('../middleware/auth');

const router = express.Router();

// GET /api/audit — denetim izi (yalnızca yönetici). Sayfalı + arama/filtre.
router.get('/', authenticate, adminOnly, async (req, res) => {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = (page - 1) * limit;
    const { entity, search } = req.query;

    try {
        const pool = await poolPromise;
        const request = pool.request();
        let where = 'WHERE 1=1';
        if (entity) { where += ' AND Entity = @entity'; request.input('entity', entity); }
        if (search) {
            where += ' AND (Username LIKE @s OR Action LIKE @s OR Detail LIKE @s)';
            request.input('s', `%${search}%`);
        }

        const countRes = await request.query(`SELECT COUNT(*) AS total FROM AuditLog ${where}`);
        const total = countRes.recordset[0].total;

        request.input('offset', offset);
        request.input('limit', limit);
        const result = await request.query(`
            SELECT AuditID, UserID, Username, Action, Entity, EntityID, Detail, CreatedAt
            FROM AuditLog ${where}
            ORDER BY AuditID DESC
            OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
        `);

        res.json({
            data: result.recordset,
            pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
        });
    } catch (error) {
        console.error('Denetim listesi hatası:', error);
        res.status(500).json({ error: 'Denetim kayıtları alınamadı' });
    }
});

module.exports = router;
