// ArcTeknik Şef — terminal (cihaz) başına ayarlar. localStorage, sunucuya gitmez.
// "Garson terminali" işaretliyse sipariş gönderme / masalara dönüş sonrası oturum
// otomatik kapanır (PIN ekranına döner) → garson elini çekince ekran kilitlenir,
// başka garson onun masasına giremez. Ana kasa/host bu işareti KOYMAZ → masada kalır.

const KEY = 'sef_waiter_terminal';

export function isWaiterTerminal() {
  try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
}

export function setWaiterTerminal(on) {
  try {
    if (on) localStorage.setItem(KEY, '1');
    else localStorage.removeItem(KEY);
  } catch { /* yoksay */ }
}
