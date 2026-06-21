const fs = require('fs');
const path = require('path');
const { getDataDir } = require('./paths');

const SETUP_FILE = () => path.join(getDataDir(), 'setup.json');

const DEFAULT_STATE = {
    sqlConfigured: false,
    whatsappConfigured: false,
    whatsappSkipped: false,
    complete: false,
    windowsStartup: false,
};

const readSetupState = () => {
    const file = SETUP_FILE();
    if (!fs.existsSync(file)) {
        if (process.env.SETUP_COMPLETE === 'true' || process.env.SETUP_COMPLETE === '1') {
            return { ...DEFAULT_STATE, sqlConfigured: true, complete: true };
        }
        return { ...DEFAULT_STATE };
    }
    try {
        return { ...DEFAULT_STATE, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch {
        return { ...DEFAULT_STATE };
    }
};

const writeSetupState = (patch) => {
    const dir = getDataDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const next = { ...readSetupState(), ...patch };
    fs.writeFileSync(SETUP_FILE(), JSON.stringify(next, null, 2), 'utf8');
    return next;
};

const isSetupComplete = () => {
    const s = readSetupState();
    return s.complete === true;
};

const needsSetupWizard = () => !isSetupComplete();

module.exports = { readSetupState, writeSetupState, isSetupComplete, needsSetupWizard };
