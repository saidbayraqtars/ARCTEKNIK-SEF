const { needsSetupWizard } = require('../config/setupState');

/** Kurulum tamamlanmadan /api/* isteklerini engeller; /api/setup/* serbest */
const blockApiUnlessSetup = (req, res, next) => {
    if (!needsSetupWizard()) return next();

    const p = req.path;
    if (p.startsWith('/setup') || p === '/health' || p === '/setup-status') {
        return next();
    }

    return res.status(503).json({
        error: 'Kurulum henüz tamamlanmadı.',
        setupRequired: true,
    });
};

module.exports = { blockApiUnlessSetup };
