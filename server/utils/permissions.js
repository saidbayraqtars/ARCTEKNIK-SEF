const PERMISSIONS = {
    DELETE_SERVICE: 'delete_service',
    ADD_CUSTOMER: 'add_customer',
    VIEW_PRICING: 'view_pricing',
    // RBAC genişletmesi — yöneticinin teknisyen/kasiyer hesaplarına seçici erişim vermesi için.
    MANAGE_STOCK: 'manage_stock',
    MANAGE_ACCOUNTS: 'manage_accounts',
    MANAGE_DOCUMENTS: 'manage_documents',
    VIEW_REPORTS: 'view_reports',
    USE_RESTAURANT: 'use_restaurant',
};

const ALL_PERMISSIONS = Object.values(PERMISSIONS);

const parsePermissions = (raw) => {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw.filter((p) => ALL_PERMISSIONS.includes(p));
    try {
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr.filter((p) => ALL_PERMISSIONS.includes(p)) : [];
    } catch {
        return [];
    }
};

const sanitizePermissions = (raw) => {
    const arr = parsePermissions(raw);
    return Array.from(new Set(arr));
};

const hasPermission = (user, perm) => {
    if (!user) return false;
    if (user.role === 'Admin') return true;
    const list = Array.isArray(user.permissions) ? user.permissions : parsePermissions(user.permissions);
    return list.includes(perm);
};

const requirePermission = (perm) => (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Oturum açmanız gerekiyor.' });
    if (hasPermission(req.user, perm)) return next();
    return res.status(403).json({ error: 'Bu işlem için yetkiniz bulunmuyor.' });
};

module.exports = {
    PERMISSIONS,
    ALL_PERMISSIONS,
    parsePermissions,
    sanitizePermissions,
    hasPermission,
    requirePermission,
};
