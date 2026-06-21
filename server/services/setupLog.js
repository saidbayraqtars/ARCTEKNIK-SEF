const MAX = 80;
const logs = [];

const addLog = (level, message, detail = null) => {
    const entry = {
        time: new Date().toISOString(),
        level,
        message,
        detail: detail ? String(detail) : null,
    };
    logs.unshift(entry);
    if (logs.length > MAX) logs.pop();
    const prefix = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : 'ℹ️';
    console.log(`[Setup] ${prefix} ${message}`, detail || '');
    return entry;
};

const getLogs = () => [...logs];

const clearLogs = () => {
    logs.length = 0;
};

module.exports = { addLog, getLogs, clearLogs };
