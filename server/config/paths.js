const path = require('path');

const getDataDir = () => process.env.TEKNIK_DATA_DIR || path.resolve(__dirname, '..');

const getEnvPath = () => path.join(getDataDir(), '.env');

const getUploadsDir = () => path.join(getDataDir(), 'uploads');

module.exports = { getDataDir, getEnvPath, getUploadsDir };
