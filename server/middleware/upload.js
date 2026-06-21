const multer = require('multer');
const path = require('path');
const fs = require('fs');

const { getUploadsDir } = require('../config/paths');
const UPLOAD_ROOT = getUploadsDir();

const ensureDir = (dir) => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
};

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        // GÜVENLİK: serviceId ve mediaType doğrudan dosya yoluna girdiği için
        // path traversal'a (örn. "../../") karşı katı şekilde temizlenir.
        const serviceId = String(req.params.serviceId || '').replace(/[^0-9]/g, '') || 'temp';
        const mediaType = req.body.mediaType === 'repair_proof' ? 'repair_proof' : 'intake';
        const dir = path.join(UPLOAD_ROOT, 'services', serviceId, mediaType);
        ensureDir(dir);
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
        const safeExt = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.mp4', '.webm', '.mov'].includes(ext) ? ext : '.jpg';
        cb(null, `${Date.now()}-${Math.round(Math.random() * 1e6)}${safeExt}`);
    },
});

const fileFilter = (req, file, cb) => {
    const allowed = /^(image\/(jpeg|png|webp|gif)|video\/(mp4|webm|quicktime))$/;
    if (allowed.test(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error('Sadece fotoğraf (JPEG, PNG, WebP) veya video (MP4, WebM) yüklenebilir.'));
    }
};

const upload = multer({
    storage,
    fileFilter,
    limits: { fileSize: 50 * 1024 * 1024, files: 10 },
});

module.exports = { upload, UPLOAD_ROOT };
