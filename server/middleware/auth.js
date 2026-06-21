const jwt = require('jsonwebtoken');

// Lazy accessor — server.js loadEnv() runs after this module loads,
// so reading process.env at call time guarantees we see the value from .env
const getJwtSecret = () => process.env.JWT_SECRET || 'fallback-secret-key-dev-only';

const authenticate = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Oturum açmanız gerekiyor.' });
    }

    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.verify(token, getJwtSecret());
        req.user = decoded;
        next();
    } catch (error) {
        return res.status(401).json({ error: 'Oturum süresi doldu, tekrar giriş yapınız.' });
    }
};

const adminOnly = (req, res, next) => {
    if (req.user.role !== 'Admin') {
        return res.status(403).json({ error: 'Bu işlem için yetkiniz bulunmuyor.' });
    }
    next();
};

module.exports = { authenticate, adminOnly, getJwtSecret };
