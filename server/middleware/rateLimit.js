const rateLimit = require('express-rate-limit');

const trackingLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    message: { error: 'Çok fazla sorgulama yapıldı. Lütfen 15 dakika sonra tekrar deneyiniz.' },
    standardHeaders: true,
    legacyHeaders: false,
});

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: { error: 'Çok fazla giriş denemesi. Lütfen daha sonra tekrar deneyiniz.' },
    standardHeaders: true,
    legacyHeaders: false,
});

module.exports = { trackingLimiter, loginLimiter };
