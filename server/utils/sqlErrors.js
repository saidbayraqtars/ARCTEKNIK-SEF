const friendlySqlError = (err) => {
    const msg = (err?.message || String(err)).toLowerCase();
    const code = err?.code || err?.number;

    if (msg.includes('elogin') || msg.includes('login failed') || code === 'ELOGIN') {
        return 'SQL Server kullanıcı adı veya şifre hatalı. Lütfen bilgilerinizi kontrol edin.';
    }
    if (msg.includes('econnrefused') || msg.includes('could not connect') || msg.includes('failed to connect')) {
        return 'SQL Server\'a ulaşılamıyor. SQL Express kurulu ve çalışıyor mu? Sunucu adını kontrol edin (örn: localhost\\SQLEXPRESS).';
    }
    if (msg.includes('getaddrinfo') || msg.includes('enotfound')) {
        return 'Sunucu adı çözümlenemedi. Örnek: localhost\\SQLEXPRESS veya BILGISAYARADI\\SQLEXPRESS';
    }
    if (msg.includes('timeout') || msg.includes('timed out')) {
        return 'Bağlantı zaman aşımına uğradı. SQL Server hizmetinin çalıştığından emin olun.';
    }
    if (msg.includes('self-signed') || msg.includes('certificate')) {
        return 'SSL/sertifika hatası. Windows kimlik doğrulaması veya trustServerCertificate ayarını deneyin.';
    }
    return `SQL bağlantı hatası: ${err?.message || err}`;
};

module.exports = { friendlySqlError };
