const STATUSES = {
    RECEIVED: 'Teslim Alındı',
    AWAITING_APPROVAL: 'Onay Bekliyor',
    APPROVED_PARTS: 'Onaylandı - Parça Bekleniyor',
    IN_PROGRESS: 'İşleme Alındı',
    RETURN_REQUESTED: 'İade İstendi',
    REPAIRED: 'Tamir Edildi',
    DELIVERED: 'Teslim Edildi',
};

const CUSTOMER_APPROVAL = {
    PENDING: 'Bekliyor',
    APPROVED: 'Onaylandı',
    REJECTED: 'Reddedildi',
};

const TIMELINE_STATUSES = [
    STATUSES.RECEIVED,
    STATUSES.AWAITING_APPROVAL,
    STATUSES.APPROVED_PARTS,
    STATUSES.IN_PROGRESS,
    STATUSES.REPAIRED,
    STATUSES.DELIVERED,
];

const ALL_STATUSES = Object.values(STATUSES);

module.exports = { STATUSES, CUSTOMER_APPROVAL, TIMELINE_STATUSES, ALL_STATUSES };
