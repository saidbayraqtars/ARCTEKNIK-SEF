const express = require('express');
const { poolPromise } = require('../config/db');
const { normalizePhone } = require('../utils/phone');
const { trackingLimiter } = require('../middleware/rateLimit');
const { STATUSES, CUSTOMER_APPROVAL } = require('../utils/statuses');

const router = express.Router();

const getMediaBase = (req) => `${req.protocol}://${req.get('host')}`;

const verifyServicePhone = async (pool, serviceId, phone) => {
    const normalizedPhone = normalizePhone(phone);
    const result = await pool.request()
        .input('serviceId', serviceId)
        .query(`
            SELECT s.*, c.Phone, c.FullName, d.Brand, d.Model
            FROM Services s
            JOIN Devices d ON s.DeviceID = d.DeviceID
            JOIN Customers c ON d.CustomerID = c.CustomerID
            WHERE s.ServiceID = @serviceId
        `);
    if (result.recordset.length === 0) return null;
    const service = result.recordset[0];
    if (normalizePhone(service.Phone) !== normalizedPhone) return null;
    return service;
};

router.post('/tracking', trackingLimiter, async (req, res) => {
    const { serviceId, phone } = req.body;
    if (!serviceId || !phone) {
        return res.status(400).json({ error: 'Servis numarası ve telefon numarası gereklidir.' });
    }

    try {
        const pool = await poolPromise;
        const service = await verifyServicePhone(pool, serviceId, phone);
        if (!service) {
            return res.status(404).json({ error: 'Kayıt bulunamadı. Lütfen bilgilerinizi kontrol ediniz.' });
        }

        const historyResult = await pool.request()
            .input('serviceId', serviceId)
            .query(`
                SELECT OldStatus, NewStatus, ChangedAt, ChangedBy
                FROM ServiceHistory WHERE ServiceID = @serviceId ORDER BY ChangedAt ASC
            `);

        const mediaResult = await pool.request()
            .input('serviceId', serviceId)
            .query(`
                SELECT MediaID, MediaType, FileName, MimeType, CreatedAt
                FROM ServiceMedia
                WHERE ServiceID = @serviceId AND MediaType = 'repair_proof'
                ORDER BY CreatedAt ASC
            `);

        const base = getMediaBase(req);
        const repairMedia = mediaResult.recordset.map((m) => ({
            mediaId: m.MediaID,
            mimeType: m.MimeType,
            isVideo: m.MimeType?.startsWith('video/'),
            url: `${base}/uploads/services/${serviceId}/repair_proof/${m.FileName}`,
        }));

        const canApprove =
            service.Status === STATUSES.AWAITING_APPROVAL &&
            service.CustomerApproval === CUSTOMER_APPROVAL.PENDING &&
            service.EstimatedPrice != null;

        res.json({
            service: {
                serviceId: service.ServiceID,
                status: service.Status,
                entryDate: service.EntryDate,
                exitDate: service.ExitDate,
                estimatedPrice: service.EstimatedPrice,
                faultDescription: service.FaultDescription,
                brand: service.Brand,
                model: service.Model,
                customerName: service.FullName,
                customerApproval: service.CustomerApproval,
                canApprove,
            },
            history: historyResult.recordset,
            repairMedia,
        });
    } catch (error) {
        console.error('Sorgulama hatası:', error);
        res.status(500).json({ error: 'Sorgulama sırasında hata oluştu.' });
    }
});

router.post('/approve', trackingLimiter, async (req, res) => {
    const { serviceId, phone, action } = req.body;
    if (!serviceId || !phone || !['approve', 'reject'].includes(action)) {
        return res.status(400).json({ error: 'Geçersiz istek.' });
    }

    try {
        const pool = await poolPromise;
        const service = await verifyServicePhone(pool, serviceId, phone);
        if (!service) {
            return res.status(404).json({ error: 'Kayıt bulunamadı.' });
        }

        if (service.Status !== STATUSES.AWAITING_APPROVAL || service.CustomerApproval !== CUSTOMER_APPROVAL.PENDING) {
            return res.status(400).json({ error: 'Bu servis için onay işlemi yapılamaz.' });
        }

        const newStatus = action === 'approve' ? STATUSES.APPROVED_PARTS : STATUSES.RETURN_REQUESTED;
        const approval = action === 'approve' ? CUSTOMER_APPROVAL.APPROVED : CUSTOMER_APPROVAL.REJECTED;

        await pool.request()
            .input('id', serviceId)
            .input('status', newStatus)
            .input('approval', approval)
            .query(`
                UPDATE Services SET
                    Status = @status,
                    CustomerApproval = @approval,
                    ApprovalAt = GETDATE()
                WHERE ServiceID = @id
            `);

        await pool.request()
            .input('serviceId', serviceId)
            .input('oldStatus', service.Status)
            .input('newStatus', newStatus)
            .query(`
                INSERT INTO ServiceHistory (ServiceID, OldStatus, NewStatus, ChangedBy)
                VALUES (@serviceId, @oldStatus, @newStatus, N'Müşteri (Portal)')
            `);

        res.json({
            success: true,
            message: action === 'approve'
                ? 'Onayınız alındı. Cihazınız işleme alınacaktır.'
                : 'İade talebiniz kaydedildi. Sizinle iletişime geçilecektir.',
            newStatus,
        });
    } catch (error) {
        console.error('Onay hatası:', error);
        res.status(500).json({ error: 'İşlem başarısız.' });
    }
});

module.exports = router;
