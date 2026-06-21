/**
 * Telefon numarasını WhatsApp ve eşleşme için standart formata çevirir (905551234567).
 */
const normalizePhone = (phone) => {
    if (!phone) return '';
    let digits = String(phone).replace(/\D/g, '');
    if (digits.startsWith('0')) {
        digits = '90' + digits.slice(1);
    } else if (digits.length === 10 && digits.startsWith('5')) {
        digits = '90' + digits;
    } else if (digits.length === 11 && digits.startsWith('90')) {
        // already ok
    } else if (digits.length === 12 && digits.startsWith('90')) {
        // ok
    }
    return digits;
};

module.exports = { normalizePhone };
