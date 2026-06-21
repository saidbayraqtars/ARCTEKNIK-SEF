const express = require('express');
const bcrypt = require('bcryptjs');
const { poolPromise } = require('../config/db');
const { authenticate, adminOnly } = require('../middleware/auth');
const { parsePermissions, sanitizePermissions, ALL_PERMISSIONS } = require('../utils/permissions');
const { getCachedStatus } = require('../services/license');
const { logAudit } = require('../services/audit');
const { STATUSES } = require('../utils/statuses');

// "Açık iş" = tamamlanmamış servis: durum 'Tamir Edildi' veya 'Teslim Edildi' DEĞİL.
const CLOSED_STATUSES = [STATUSES.REPAIRED, STATUSES.DELIVERED];

const router = express.Router();

// PIN doğrula + benzersizlik. PIN'ler hash'li tutulduğundan benzersizlik için tüm
// PIN'li kullanıcılarla karşılaştırılır (restoranda az kullanıcı). Dönüş: {error} | {hash}.
async function preparePin(pool, pin, excludeUserId = null) {
    const p = String(pin).trim();
    if (!/^\d{4,8}$/.test(p)) {
        return { error: 'PIN 4-8 rakam olmalıdır.' };
    }
    const others = await pool.request().query(`
        SELECT UserID, Pin FROM Users WHERE Pin IS NOT NULL AND Pin <> '' AND IsActive = 1
    `);
    for (const u of others.recordset) {
        if (excludeUserId != null && String(u.UserID) === String(excludeUserId)) continue;
        // eslint-disable-next-line no-await-in-loop
        if (await bcrypt.compare(p, u.Pin)) {
            return { error: 'Bu PIN başka bir kullanıcıda kullanılıyor. Farklı bir PIN seçin.' };
        }
    }
    const salt = await bcrypt.genSalt(10);
    return { hash: await bcrypt.hash(p, salt) };
}

router.get('/', authenticate, adminOnly, async (req, res) => {
    try {
        const pool = await poolPromise;
        const result = await pool.request().query(`
            SELECT UserID, Username, FullName, Role, Permissions, IsActive, CreatedAt,
                   CASE WHEN Pin IS NOT NULL AND Pin <> '' THEN 1 ELSE 0 END AS HasPin
            FROM Users
            ORDER BY CreatedAt ASC
        `);
        const users = result.recordset.map((u) => ({
            ...u,
            Permissions: parsePermissions(u.Permissions),
        }));
        res.json(users);
    } catch (error) {
        console.error('Kullanıcı listesi hatası:', error);
        res.status(500).json({ error: 'Kullanıcılar alınamadı' });
    }
});

router.get('/permissions/catalog', authenticate, adminOnly, (req, res) => {
    res.json({ permissions: ALL_PERMISSIONS });
});

// Atama açılır listesi için aktif kullanıcılar (oturum açmış herkes erişebilir).
router.get('/assignable', authenticate, async (req, res) => {
    try {
        const pool = await poolPromise;
        const result = await pool.request().query(`
            SELECT UserID, FullName, Username, Role
            FROM Users WHERE IsActive = 1 ORDER BY FullName ASC
        `);
        res.json(result.recordset);
    } catch (error) {
        console.error('Atanabilir kullanıcılar hatası:', error);
        res.status(500).json({ error: 'Kullanıcılar alınamadı' });
    }
});

// Bir kullanıcının üzerindeki AÇIK iş sayısı (pasife alma öncesi devir kontrolü).
router.get('/:id/open-services', authenticate, adminOnly, async (req, res) => {
    try {
        const pool = await poolPromise;
        const result = await pool.request()
            .input('id', req.params.id)
            .query(`
                SELECT COUNT(*) AS openCount FROM Services
                WHERE AssignedTechnicianID = @id AND Status NOT IN ('${CLOSED_STATUSES.join("','")}')
            `);
        res.json({ openCount: result.recordset[0].openCount });
    } catch (error) {
        console.error('Açık iş sayısı hatası:', error);
        res.status(500).json({ error: 'Açık işler alınamadı' });
    }
});

router.post('/', authenticate, adminOnly, async (req, res) => {
    const { username, password, fullName, role, permissions, pin } = req.body;

    if (!username || !password || !fullName) {
        return res.status(400).json({ error: 'Kullanıcı adı, şifre ve ad soyad zorunludur.' });
    }

    const validRoles = ['Admin', 'Teknisyen'];
    const userRole = validRoles.includes(role) ? role : 'Teknisyen';

    if (password.length < 6) {
        return res.status(400).json({ error: 'Şifre en az 6 karakter olmalıdır.' });
    }

    try {
        const pool = await poolPromise;

        // Seat (kullanıcı) lisans limiti — maxUsers null ise sınırsız (geriye dönük).
        const lic = getCachedStatus();
        if (lic.valid && lic.maxUsers != null) {
            // Yalnızca AKTİF kullanıcılar seat sayar; pasifler kotadan düşmez.
            const cnt = await pool.request().query(`SELECT COUNT(*) AS c FROM Users WHERE IsActive = 1`);
            if (cnt.recordset[0].c >= lic.maxUsers) {
                return res.status(409).json({
                    error: `Lisansınız ${lic.maxUsers} kullanıcı ile sınırlı. Daha fazla personel eklemek için lisansınızı yükseltin.`,
                    reason: 'USER_LIMIT_REACHED',
                    maxUsers: lic.maxUsers,
                });
            }
        }

        const salt = await bcrypt.genSalt(10);
        const hash = await bcrypt.hash(password, salt);
        const permList = userRole === 'Admin' ? [] : sanitizePermissions(permissions);

        // Opsiyonel PIN (ArcTeknik Şef dokunmatik giriş).
        let pinHash = null;
        if (pin != null && String(pin).trim() !== '') {
            const pr = await preparePin(pool, pin);
            if (pr.error) return res.status(400).json({ error: pr.error });
            pinHash = pr.hash;
        }

        const ins = await pool.request()
            .input('username', username)
            .input('passwordHash', hash)
            .input('fullName', fullName)
            .input('role', userRole)
            .input('permissions', JSON.stringify(permList))
            .input('pin', pinHash)
            .query(`
                INSERT INTO Users (Username, PasswordHash, FullName, Role, Permissions, Pin)
                OUTPUT INSERTED.UserID
                VALUES (@username, @passwordHash, @fullName, @role, @permissions, @pin)
            `);

        await logAudit(req, {
            action: 'user.create', entity: 'User', entityId: ins.recordset[0].UserID,
            detail: `${fullName} (${username}) — rol: ${userRole}`,
        });
        res.status(201).json({ success: true, message: 'Kullanıcı oluşturuldu.' });
    } catch (error) {
        if (error.number === 2627 || error.message?.includes('UNIQUE')) {
            return res.status(409).json({ error: 'Bu kullanıcı adı zaten kullanılıyor.' });
        }
        console.error('Kullanıcı oluşturma hatası:', error);
        res.status(500).json({ error: 'Kullanıcı oluşturulamadı' });
    }
});

router.put('/me/password', authenticate, async (req, res) => {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
        return res.status(400).json({ error: 'Mevcut ve yeni şifre gereklidir.' });
    }
    if (newPassword.length < 6) {
        return res.status(400).json({ error: 'Yeni şifre en az 6 karakter olmalıdır.' });
    }

    try {
        const pool = await poolPromise;
        const result = await pool.request()
            .input('userId', req.user.userId)
            .query(`SELECT PasswordHash FROM Users WHERE UserID = @userId`);

        if (result.recordset.length === 0) {
            return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });
        }

        const isMatch = await bcrypt.compare(currentPassword, result.recordset[0].PasswordHash);
        if (!isMatch) {
            return res.status(401).json({ error: 'Mevcut şifre hatalı.' });
        }

        const salt = await bcrypt.genSalt(10);
        const hash = await bcrypt.hash(newPassword, salt);
        await pool.request()
            .input('userId', req.user.userId)
            .input('passwordHash', hash)
            .query(`UPDATE Users SET PasswordHash = @passwordHash WHERE UserID = @userId`);

        res.json({ success: true, message: 'Şifreniz güncellendi.' });
    } catch (error) {
        console.error('Şifre değiştirme hatası:', error);
        res.status(500).json({ error: 'Şifre güncellenemedi' });
    }
});

router.put('/:id', authenticate, adminOnly, async (req, res) => {
    const { id } = req.params;
    const { fullName, role, password, permissions, isActive, pin } = req.body;

    try {
        const pool = await poolPromise;

        // Aktif/pasif değiştirme (soft-delete toggle) — ayrı, kendi içinde tamamlanan işlem.
        if (typeof isActive === 'boolean') {
            if (String(id) === String(req.user.userId) && !isActive) {
                return res.status(400).json({ error: 'Kendi hesabınızı pasife alamazsınız.' });
            }
            if (isActive) {
                // Aktifleştirme seat tüketir → lisans limiti kontrolü.
                const lic = getCachedStatus();
                if (lic.valid && lic.maxUsers != null) {
                    const cnt = await pool.request().query(`SELECT COUNT(*) AS c FROM Users WHERE IsActive = 1`);
                    if (cnt.recordset[0].c >= lic.maxUsers) {
                        return res.status(409).json({
                            error: `Lisansınız ${lic.maxUsers} kullanıcı ile sınırlı. Aktif kullanıcı eklemek için lisansınızı yükseltin.`,
                            reason: 'USER_LIMIT_REACHED', maxUsers: lic.maxUsers,
                        });
                    }
                }
            } else {
                // Son aktif yöneticiyi pasife almayı engelle.
                const t = await pool.request().input('id', id).query(`SELECT Role FROM Users WHERE UserID = @id`);
                if (t.recordset[0]?.Role === 'Admin') {
                    const others = await pool.request().input('id', id)
                        .query(`SELECT COUNT(*) AS cnt FROM Users WHERE Role='Admin' AND IsActive=1 AND UserID <> @id`);
                    if (others.recordset[0].cnt === 0) {
                        return res.status(400).json({ error: 'Sistemde en az bir aktif yönetici kalmalıdır.' });
                    }
                }
            }
            await pool.request().input('id', id).input('act', isActive ? 1 : 0)
                .query(`UPDATE Users SET IsActive = @act WHERE UserID = @id`);
            await logAudit(req, {
                action: isActive ? 'user.activate' : 'user.deactivate',
                entity: 'User', entityId: id,
            });
            return res.json({ success: true, message: isActive ? 'Kullanıcı aktifleştirildi.' : 'Kullanıcı pasife alındı.' });
        }

        if (fullName || role || permissions !== undefined) {
            const validRoles = ['Admin', 'Teknisyen'];
            const updates = [];
            const request = pool.request().input('id', id);
            if (fullName) {
                updates.push('FullName = @fullName');
                request.input('fullName', fullName);
            }
            const targetRole = role && validRoles.includes(role) ? role : null;
            if (targetRole === 'Teknisyen') {
                // Son yöneticiyi (kendisi dahil) düşürerek sistemi kilitlemeyi engelle.
                const adminCount = await pool.request()
                    .input('id', id)
                    .query(`SELECT COUNT(*) AS cnt FROM Users WHERE Role = 'Admin' AND UserID <> @id`);
                if (adminCount.recordset[0].cnt === 0) {
                    return res.status(400).json({ error: 'Sistemde en az bir yönetici kalmalıdır; bu kullanıcının yetkisi düşürülemez.' });
                }
            }
            if (targetRole) {
                updates.push('Role = @role');
                request.input('role', targetRole);
            }
            if (permissions !== undefined) {
                const effectiveRole = targetRole || (await pool.request().input('id', id)
                    .query(`SELECT Role FROM Users WHERE UserID = @id`)).recordset[0]?.Role;
                const permList = effectiveRole === 'Admin' ? [] : sanitizePermissions(permissions);
                updates.push('Permissions = @permissions');
                request.input('permissions', JSON.stringify(permList));
            }
            if (updates.length > 0) {
                await request.query(`UPDATE Users SET ${updates.join(', ')} WHERE UserID = @id`);
            }
        }

        if (password) {
            if (password.length < 6) {
                return res.status(400).json({ error: 'Şifre en az 6 karakter olmalıdır.' });
            }
            const salt = await bcrypt.genSalt(10);
            const hash = await bcrypt.hash(password, salt);
            await pool.request()
                .input('id', id)
                .input('passwordHash', hash)
                .query(`UPDATE Users SET PasswordHash = @passwordHash WHERE UserID = @id`);
        }

        // PIN güncelle/temizle (ArcTeknik Şef). '' → PIN kaldır (NULL).
        if (pin !== undefined) {
            if (String(pin).trim() === '') {
                await pool.request().input('id', id)
                    .query(`UPDATE Users SET Pin = NULL WHERE UserID = @id`);
            } else {
                const pr = await preparePin(pool, pin, id);
                if (pr.error) return res.status(400).json({ error: pr.error });
                await pool.request().input('id', id).input('pin', pr.hash)
                    .query(`UPDATE Users SET Pin = @pin WHERE UserID = @id`);
            }
        }

        res.json({ success: true, message: 'Kullanıcı güncellendi.' });
    } catch (error) {
        console.error('Kullanıcı güncelleme hatası:', error);
        res.status(500).json({ error: 'Kullanıcı güncellenemedi' });
    }
});


// Kullanıcı "silme" = SOFT-DELETE (pasife alma). Kayıt veritabanında kalır →
// geçmiş servis/fatura/stok userId bağları kopmaz (FK güvenliği + rapor bütünlüğü).
router.delete('/:id', authenticate, adminOnly, async (req, res) => {
    const { id } = req.params;

    if (String(id) === String(req.user.userId)) {
        return res.status(400).json({ error: 'Kendi hesabınızı pasife alamazsınız.' });
    }

    const transferTo = req.body?.transferTo;

    try {
        const pool = await poolPromise;
        const target = await pool.request().input('id', id)
            .query(`SELECT UserID, FullName, Role FROM Users WHERE UserID = @id`);
        if (target.recordset.length === 0) {
            return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });
        }
        // Son aktif yöneticiyi pasife almayı engelle (sistem kilitlenmesin).
        if (target.recordset[0].Role === 'Admin') {
            const others = await pool.request().input('id', id)
                .query(`SELECT COUNT(*) AS cnt FROM Users WHERE Role='Admin' AND IsActive=1 AND UserID <> @id`);
            if (others.recordset[0].cnt === 0) {
                return res.status(400).json({ error: 'Sistemde en az bir aktif yönetici kalmalıdır.' });
            }
        }

        // Üzerindeki açık işleri say — varsa devir zorunlu.
        const openRes = await pool.request().input('id', id)
            .query(`SELECT COUNT(*) AS c FROM Services WHERE AssignedTechnicianID=@id AND Status NOT IN ('${CLOSED_STATUSES.join("','")}')`);
        const openCount = openRes.recordset[0].c;

        if (openCount > 0 && !transferTo) {
            // İstemci bu yanıtta devir modalını açar.
            return res.status(409).json({
                reason: 'HAS_OPEN_SERVICES', openCount,
                error: `Bu kullanıcının ${openCount} açık işi var. Pasife almadan önce işleri başka bir kullanıcıya devredin.`,
            });
        }

        if (transferTo) {
            if (String(transferTo) === String(id)) {
                return res.status(400).json({ error: 'İşler aynı kullanıcıya devredilemez.' });
            }
            const tt = await pool.request().input('tt', transferTo)
                .query(`SELECT UserID FROM Users WHERE UserID=@tt AND IsActive=1`);
            if (tt.recordset.length === 0) {
                return res.status(400).json({ error: 'Devralacak aktif kullanıcı bulunamadı.' });
            }
        }

        // Devir + pasife alma TEK transaction (ya hepsi ya hiçbiri).
        const transaction = pool.transaction();
        await transaction.begin();
        try {
            let transferred = 0;
            if (transferTo && openCount > 0) {
                const upd = await transaction.request()
                    .input('id', id).input('tt', transferTo)
                    .query(`UPDATE Services SET AssignedTechnicianID=@tt
                            WHERE AssignedTechnicianID=@id AND Status NOT IN ('${CLOSED_STATUSES.join("','")}')`);
                transferred = upd.rowsAffected[0];
            }
            await transaction.request().input('id', id)
                .query(`UPDATE Users SET IsActive=0 WHERE UserID=@id`);
            await transaction.commit();

            await logAudit(req, {
                action: 'user.deactivate', entity: 'User', entityId: id,
                detail: transferred > 0
                    ? `${target.recordset[0].FullName} pasife alındı; ${transferred} açık iş devredildi (→ kullanıcı #${transferTo})`
                    : `${target.recordset[0].FullName} pasife alındı`,
            });
            if (transferred > 0) {
                await logAudit(req, { action: 'service.transfer', entity: 'Service', entityId: id, detail: `${transferred} açık iş #${id} → #${transferTo}` });
            }

            res.json({
                success: true,
                transferred,
                message: transferred > 0 ? `Kullanıcı pasife alındı; ${transferred} iş devredildi.` : 'Kullanıcı pasife alındı.',
            });
        } catch (e) {
            await transaction.rollback();
            throw e;
        }
    } catch (error) {
        console.error('Kullanıcı pasife alma hatası:', error);
        res.status(500).json({ error: 'Kullanıcı pasife alınamadı' });
    }
});

module.exports = router;
