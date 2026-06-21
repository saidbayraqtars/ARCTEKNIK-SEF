import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import {
  Utensils, Plus, Minus, Trash2, Banknote, CreditCard, ArrowLeft, ArrowRightLeft,
  SplitSquareHorizontal, StickyNote, Loader2, X, ChefHat, Settings, RefreshCw, Gift, Check,
  Users, Printer, ClipboardList, BarChart3, Ticket, Send, Percent, Tag, Clock, Layers, Bike, Wallet, Search,
  CalendarDays, CalendarClock, TrendingUp, UserPlus, Star, ChevronRight, Power, Monitor, Lock,
} from 'lucide-react';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import RestaurantPrint from '../components/RestaurantPrint';
import RestaurantPackages from '../components/RestaurantPackages';
import { silentReady, silentAvailable, silentPrintJob, getPrinterMap, setPrinterMap, getPrintQueue, retryPrintQueue, clearPrintQueue } from '../utils/sefPrint';
import { getApiBaseUrl } from '../api/client';
import { isWaiterTerminal, setWaiterTerminal } from '../utils/sefTerminal';

const fmtTL = (v) =>
  `${(Number(v) || 0).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₺`;

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Masa durumuna göre renk (Yeşil=Boş, Kırmızı=Dolu, Amber=Rezerve).
const TABLE_STYLE = {
  'Boş': 'bg-emerald-500/15 border-emerald-500/50 text-emerald-100 hover:bg-emerald-500/25',
  'Dolu': 'bg-rose-500/20 border-rose-500/60 text-rose-50 hover:bg-rose-500/30',
  'Rezerve': 'bg-amber-500/15 border-amber-500/50 text-amber-100 hover:bg-amber-500/25',
};

const KITCHEN_NEXT = { 'Bekliyor': 'Hazırlanıyor', 'Hazırlanıyor': 'Hazır', 'Hazır': 'Bekliyor' };
const KITCHEN_COLOR = {
  'Bekliyor': 'bg-slate-600 text-slate-100',
  'Hazırlanıyor': 'bg-amber-500 text-amber-950',
  'Hazır': 'bg-emerald-500 text-emerald-950',
  'İkram': 'bg-fuchsia-500 text-fuchsia-950',
};

const PAY_METHODS = ['Nakit', 'Kredi Kartı', 'Yemek Fişi'];

// Menü ürün butonu boyut ön ayarları. Tailwind JIT için sınıflar TAM literal yazılı.
const PROD_BTN_SIZES = {
  sm: { wrap: 'grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-2', btn: 'h-24', name: 'text-sm', price: 'text-base' },
  md: { wrap: 'grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3', btn: 'h-28', name: '', price: 'text-lg' },
  lg: { wrap: 'grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-3', btn: 'h-36', name: 'text-lg', price: 'text-2xl' },
};

export default function Restaurant({ standalone = false }) {
  const navigate = useNavigate();
  const { isAdmin, logout } = useAuth();

  // Garson terminali otomatik kilit: sipariş gönderme / masalara dönüş sonrası oturumu
  // kapat → PIN ekranı. Yalnızca bu cihaz "garson terminali" işaretliyse. true dönerse
  // kilitlendi (çağıran sonraki adımı atlasın).
  const lockIfWaiterTerminal = useCallback(() => {
    if (isWaiterTerminal()) {
      logout();
      navigate('/login');
      return true;
    }
    return false;
  }, [logout, navigate]);

  const [view, setView] = useState('floor'); // 'floor' | 'order'
  const [sections, setSections] = useState([]);
  const [menu, setMenu] = useState([]);
  const [happyActive, setHappyActive] = useState(false);
  const [features, setFeatures] = useState({}); // restoran özelleştirme bayrakları
  const [company, setCompany] = useState(null);
  // Bayrak açık mı? Tanımsız/'1'/true = açık; '0'/false = kapalı (varsayılan açık).
  const ff = (k) => features[k] !== '0' && features[k] !== false;
  // Menü ürün butonu boyutu (sm/md/lg). Sınıflar TAM yazılmalı (Tailwind JIT).
  const prodBtn = PROD_BTN_SIZES[features.buttonSize] || PROD_BTN_SIZES.md;
  const [loadingFloor, setLoadingFloor] = useState(true);

  const [activeTable, setActiveTable] = useState(null); // {tableId, tableNo}
  const [order, setOrder] = useState(null);             // {orderId, items[], total, guestCount}
  const [pendingGuests, setPendingGuests] = useState(null); // yeni adisyonda kişi sayısı
  const [activeCat, setActiveCat] = useState(0);
  const [busy, setBusy] = useState(false);

  // Modallar
  const [guestPrompt, setGuestPrompt] = useState(null); // kişi sayısı sorulacak masa
  const [guestInput, setGuestInput] = useState('');
  const [noteItem, setNoteItem] = useState(null);
  const [noteText, setNoteText] = useState('');
  const [payModal, setPayModal] = useState(false);
  const [received, setReceived] = useState('');
  const [discount, setDiscount] = useState('');
  const [multiPay, setMultiPay] = useState(false);
  const [payParts, setPayParts] = useState({ 'Nakit': '', 'Kredi Kartı': '', 'Yemek Fişi': '' });
  const [acctMode, setAcctMode] = useState(false);          // açık hesap (veresiye) alt-adımı
  const [acctQ, setAcctQ] = useState('');
  const [accounts, setAccounts] = useState([]);
  const [optionProduct, setOptionProduct] = useState(null); // seçenekli ürün ekleme
  const [optionSel, setOptionSel] = useState({});           // { groupId: Set(optionId) }
  const [transferOpen, setTransferOpen] = useState(false);
  const [splitOpen, setSplitOpen] = useState(false);
  const [splitSel, setSplitSel] = useState(new Set());
  const [mgmtOpen, setMgmtOpen] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [summary, setSummary] = useState(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState([]);
  const [historyDetail, setHistoryDetail] = useState(null);
  const [packagesOpen, setPackagesOpen] = useState(false);
  const [reservationsOpen, setReservationsOpen] = useState(false);
  const [reportsOpen, setReportsOpen] = useState(false);
  const [staffOpen, setStaffOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [exitOpen, setExitOpen] = useState(false);
  // Mutfağa gitmiş kalem iptali (neden + yönetici şifresi)
  const [cancelCtx, setCancelCtx] = useState(null); // { item, mode:'delete'|'reduce', nextQty }
  const [cancelReason, setCancelReason] = useState('');
  const [cancelPwd, setCancelPwd] = useState('');
  // Masa birleştirme (floor drag-drop) + ürün taşıma
  const [dragTable, setDragTable] = useState(null);
  const [mergeCtx, setMergeCtx] = useState(null); // { source, target }
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveSel, setMoveSel] = useState(new Set());
  const [moveTarget, setMoveTarget] = useState('');

  const [printJob, setPrintJob] = useState(null);
  const [printerSetupOpen, setPrinterSetupOpen] = useState(false);
  // Salon adisyonuna müşteri bağı (sadakat puanı kazanımı/kullanımı için).
  const [custModalOpen, setCustModalOpen] = useState(false);
  const [custSearch, setCustSearch] = useState('');
  const [custResults, setCustResults] = useState([]);
  const [custPoints, setCustPoints] = useState(0);
  const [newCustName, setNewCustName] = useState('');
  const [newCustPhone, setNewCustPhone] = useState('');
  const [redeem, setRedeem] = useState('');
  // Sessiz basım hazırsa (masaüstü + yazıcı tanımlı) Windows diyaloğu olmadan bas;
  // değilse window.print() diyaloğuna düş (tarayıcı/dev veya tanım yok).
  const doPrint = async (job) => {
    if (silentReady()) {
      try {
        const res = await silentPrintJob(job, company);
        if (res.ok) return;
        if (res.queued > 0) {
          // Fiş KAYBOLMADI — kuyruğa alındı, 30 sn'de bir otomatik denenir.
          // Kiosk'ta Windows yazdırma diyaloğu açmak işe yaramaz → açmıyoruz.
          toast.error(`${res.queued} fiş basılamadı — kuyruğa alındı. Yazıcıyı (kağıt/güç) kontrol edin.`, { duration: 6000 });
          return;
        }
      } catch {
        toast.error('Yazıcıya ulaşılamadı — yazdırma penceresi açılıyor.');
      }
    }
    setPrintJob(job);
    setTimeout(() => { window.print(); }, 80);
  };

  // ── Yazdırma kuyruğu gözcüsü ───────────────────────────────────────────────
  // Basılamayan fişler localStorage kuyruğunda bekler; 30 sn'de bir yeniden
  // denenir, başarıda yeşil bildirim düşer. Rozet TÜM kullanıcılara görünür
  // (garson da kağıt bitince görmeli), temizleme yalnız yönetici işidir.
  const [printQueueCount, setPrintQueueCount] = useState(() => getPrintQueue().length);
  useEffect(() => {
    const onQ = (e) => setPrintQueueCount(e.detail?.count ?? getPrintQueue().length);
    window.addEventListener('sef-print-queue', onQ);
    return () => window.removeEventListener('sef-print-queue', onQ);
  }, []);
  useEffect(() => {
    if (printQueueCount === 0) return;
    const t = setInterval(async () => {
      const { printed } = await retryPrintQueue();
      if (printed > 0) toast.success(`${printed} bekleyen fiş basıldı.`);
    }, 30000);
    return () => clearInterval(t);
  }, [printQueueCount]);

  // ── Yükleme ──────────────────────────────────────────────────────────────
  const loadFloor = useCallback(async (silent) => {
    if (!silent) setLoadingFloor(true);
    try {
      const { data } = await api.get('/restoran/floor');
      setSections(Array.isArray(data) ? data : []);
    } catch (e) {
      if (e?.response?.status === 403) toast.error('ArcTeknik Şef modülü lisanslı değil veya yetkiniz yok.');
      else if (!silent) toast.error('Masa planı yüklenemedi.');
    } finally {
      if (!silent) setLoadingFloor(false);
    }
  }, []);

  const loadMenu = useCallback(async () => {
    try {
      const { data } = await api.get('/restoran/menu');
      const cats = Array.isArray(data) ? data : (data.categories || []);
      setMenu(cats);
      setHappyActive(!!(data && data.happyActive));
      if (data && data.features) setFeatures(data.features);
    } catch { /* sessiz */ }
  }, []);

  useEffect(() => {
    loadFloor(); loadMenu();
    api.get('/settings').then(({ data }) => setCompany(data)).catch(() => {});
  }, [loadFloor, loadMenu]);

  // Masa planındayken canlı durum güncellemesi.
  useEffect(() => {
    if (view !== 'floor') return;
    const t = setInterval(() => loadFloor(true), 12000);
    return () => clearInterval(t);
  }, [view, loadFloor]);

  // Gerçek-zamanlı güncelleme (SSE): sunucudaki her restoran mutasyonunda
  // "değişti" sinyali gelir → masa planı ANINDA tazelenir. 12 sn'lik polling
  // yedek mekanizma olarak durur; EventSource koparsa kendisi yeniden bağlanır.
  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token || typeof EventSource === 'undefined') return;
    const es = new EventSource(`${getApiBaseUrl()}/restoran/events?token=${encodeURIComponent(token)}`);
    let t = null;
    es.onmessage = () => {
      clearTimeout(t);
      t = setTimeout(() => { loadFloor(true); }, 250); // ardışık olayları tek yenilemeye indir
    };
    return () => { clearTimeout(t); es.close(); };
  }, [loadFloor]);

  // Açık hesap (veresiye) cari arama — pay modalı açık hesap alt-adımında.
  useEffect(() => {
    if (!acctMode) return;
    const t = setTimeout(async () => {
      try { const { data } = await api.get('/restoran/accounts', { params: { q: acctQ } }); setAccounts(Array.isArray(data) ? data : []); }
      catch { /* sessiz */ }
    }, 300);
    return () => clearTimeout(t);
  }, [acctMode, acctQ]);

  // Adisyona bağlı müşterinin güncel puan bakiyesi (sadakat).
  useEffect(() => {
    if (!order?.customerId) { setCustPoints(0); return; }
    let alive = true;
    api.get(`/restoran/customers/${order.customerId}`)
      .then(({ data }) => { if (alive) setCustPoints(Number(data.points) || 0); })
      .catch(() => { if (alive) setCustPoints(0); });
    return () => { alive = false; };
  }, [order?.customerId]);

  // Müşteri bağlama modalı — ad/telefon ile ara.
  useEffect(() => {
    if (!custModalOpen) return;
    const t = setTimeout(async () => {
      try { const { data } = await api.get('/restoran/customers', { params: { q: custSearch } }); setCustResults(Array.isArray(data) ? data : []); }
      catch { /* sessiz */ }
    }, 300);
    return () => clearTimeout(t);
  }, [custModalOpen, custSearch]);

  // ── Adisyon ──────────────────────────────────────────────────────────────
  const openTable = useCallback(async (table, guests) => {
    setPendingGuests(guests ?? null);
    setActiveTable({ tableId: table.tableId, tableNo: table.tableNo });
    setView('order');
    setActiveCat(0);
    try {
      const { data } = await api.get(`/restoran/tables/${table.tableId}/order`);
      setOrder(data.order || { orderId: null, items: [], total: 0, guestCount: guests ?? null });
    } catch {
      toast.error('Adisyon açılamadı.');
      setOrder({ orderId: null, items: [], total: 0, guestCount: guests ?? null });
    }
  }, []);

  // Boş masaya dokununca kişi sayısı sor; dolu masayı doğrudan aç.
  const handleTap = (table) => {
    if (table.status === 'Dolu' || table.currentOrderId) openTable(table, null);
    else if (!ff('askGuestCount')) openTable(table, null); // kişi sayısı sorma kapalı → direkt aç
    else { setGuestPrompt(table); setGuestInput(''); }
  };
  const confirmGuest = (skip) => {
    const t = guestPrompt;
    if (!t) return;
    const g = skip ? null : (parseInt(guestInput, 10) || null);
    setGuestPrompt(null);
    openTable(t, g);
  };

  const refreshOrder = useCallback(async (tableId) => {
    try {
      const { data } = await api.get(`/restoran/tables/${tableId}/order`);
      setOrder(data.order || { orderId: null, items: [], total: 0 });
    } catch { /* sessiz */ }
  }, []);

  // Ürüne dokun: seçenek grubu varsa modal aç, yoksa doğrudan ekle.
  const addProduct = (product) => {
    if (product.optionGroups && product.optionGroups.length) {
      const init = {};
      for (const g of product.optionGroups) init[g.id] = new Set();
      setOptionSel(init);
      setOptionProduct(product);
      return;
    }
    doAddProduct(product, []);
  };

  const doAddProduct = async (product, optionIds) => {
    if (!activeTable || busy) return;
    setBusy(true);
    try {
      const body = { productId: product.id, quantity: 1, optionIds };
      if (!order?.orderId && pendingGuests) body.guestCount = pendingGuests;
      await api.post(`/restoran/tables/${activeTable.tableId}/items`, body);
      setOptionProduct(null); setOptionSel({});
      await refreshOrder(activeTable.tableId);
    } catch (e) {
      toast.error(e?.response?.data?.error || 'Ürün eklenemedi.');
    } finally { setBusy(false); }
  };

  // Seçenek aç/kapa (max=1 → tekli, aksi çoklu).
  const toggleOption = (group, optionId) => {
    setOptionSel((prev) => {
      const cur = new Set(prev[group.id] || []);
      if (group.max === 1) { cur.clear(); cur.add(optionId); }
      else if (cur.has(optionId)) cur.delete(optionId);
      else { if (group.max > 0 && cur.size >= group.max) return prev; cur.add(optionId); }
      return { ...prev, [group.id]: cur };
    });
  };

  const confirmOptions = () => {
    const p = optionProduct;
    if (!p) return;
    for (const g of p.optionGroups) {
      const n = (optionSel[g.id] || new Set()).size;
      if (g.min > 0 && n < g.min) { toast.error(`"${g.name}" için en az ${g.min} seçim gerekli.`); return; }
    }
    const ids = Object.values(optionSel).flatMap((s) => [...s]);
    doAddProduct(p, ids);
  };

  // Seçenek modalında anlık fiyat (taban + seçili farklar).
  const optionPrice = useMemo(() => {
    if (!optionProduct) return 0;
    let total = optionProduct.price;
    for (const g of optionProduct.optionGroups) {
      for (const oid of (optionSel[g.id] || [])) {
        const o = g.options.find((x) => x.id === oid);
        if (o) total += o.priceDelta;
      }
    }
    return round2(total);
  }, [optionProduct, optionSel]);

  const changeQty = async (item, delta) => {
    if (busy) return;
    const next = item.quantity + delta;
    // Mutfağa gitmiş kalemde azaltma/silme → iptal nedeni + yetkili şifresi modalı.
    if (delta < 0 && item.sent) {
      setCancelCtx({ item, mode: next <= 0 ? 'delete' : 'reduce', nextQty: next });
      setCancelReason(''); setCancelPwd('');
      return;
    }
    setBusy(true);
    try {
      if (next <= 0) await api.delete(`/restoran/items/${item.itemId}`);
      else await api.patch(`/restoran/items/${item.itemId}`, { quantity: next });
      await refreshOrder(activeTable.tableId);
    } catch (e) {
      toast.error(e?.response?.data?.error || 'Güncellenemedi.');
    } finally { setBusy(false); }
  };

  const removeItem = async (item) => {
    if (busy) return;
    // Mutfağa gitmiş kalem iptali → iptal nedeni + yetkili şifresi modalı.
    if (item.sent) {
      setCancelCtx({ item, mode: 'delete', nextQty: 0 });
      setCancelReason(''); setCancelPwd('');
      return;
    }
    setBusy(true);
    try {
      await api.delete(`/restoran/items/${item.itemId}`);
      await refreshOrder(activeTable.tableId);
    } catch (e) {
      toast.error(e?.response?.data?.error || 'Silinemedi.');
    } finally { setBusy(false); }
  };

  // Mutfağa gitmiş kalem iptali/azaltması onayı (neden + yönetici şifresi).
  const confirmCancelItem = async () => {
    if (!cancelCtx) return;
    if (ff('askCancelReason') && !cancelReason) { toast.error('İptal nedeni seçin.'); return; }
    if (!isAdmin && !cancelPwd) { toast.error('Yönetici şifresi girin.'); return; }
    const { item, mode, nextQty } = cancelCtx;
    setBusy(true);
    try {
      const body = { reason: cancelReason || undefined, managerPassword: cancelPwd || undefined };
      if (mode === 'delete') await api.delete(`/restoran/items/${item.itemId}`, { data: body });
      else await api.patch(`/restoran/items/${item.itemId}`, { quantity: nextQty, ...body });
      setCancelCtx(null); setCancelReason(''); setCancelPwd('');
      await refreshOrder(activeTable.tableId);
      toast.success('İptal kaydedildi.');
    } catch (e) {
      toast.error(e?.response?.data?.error || 'İşlem başarısız.');
    } finally { setBusy(false); }
  };

  const cycleKitchen = async (item) => {
    if (busy || item.kitchenStatus === 'İkram') return;
    const next = KITCHEN_NEXT[item.kitchenStatus] || 'Hazırlanıyor';
    setBusy(true);
    try {
      await api.patch(`/restoran/items/${item.itemId}`, { kitchenStatus: next });
      await refreshOrder(activeTable.tableId);
    } catch (e) { toast.error(e?.response?.data?.error || 'Güncellenemedi.'); }
    finally { setBusy(false); }
  };

  const toggleTreat = async (item) => {
    if (busy) return;
    const next = item.kitchenStatus === 'İkram' ? 'Bekliyor' : 'İkram';
    setBusy(true);
    try {
      await api.patch(`/restoran/items/${item.itemId}`, { kitchenStatus: next });
      await refreshOrder(activeTable.tableId);
    } catch (e) { toast.error(e?.response?.data?.error || 'Güncellenemedi.'); }
    finally { setBusy(false); }
  };

  const saveNote = async () => {
    if (!noteItem) return;
    setBusy(true);
    try {
      await api.patch(`/restoran/items/${noteItem.itemId}`, { note: noteText });
      setNoteItem(null); setNoteText('');
      await refreshOrder(activeTable.tableId);
    } catch (e) { toast.error(e?.response?.data?.error || 'Not kaydedilemedi.'); }
    finally { setBusy(false); }
  };

  // Mutfağa gönder: yeni (gönderilmemiş) kalemleri damgala + yazıcı hedefine göre bas.
  const sendKitchen = async () => {
    if (!order?.orderId || busy) return;
    setBusy(true);
    try {
      const { data } = await api.post(`/restoran/orders/${order.orderId}/send-kitchen`);
      if (!data.groups || data.groups.length === 0) {
        toast('Gönderilecek yeni kalem yok.', { icon: 'ℹ️' });
      } else {
        doPrint({ type: 'kitchen', tableNo: data.tableNo, label: data.label, guestCount: data.guestCount, at: data.at, groups: data.groups });
        toast.success('Mutfağa gönderildi.');
      }
      // Garson terminali: sipariş gönderildi → ekranı kilitle (PIN ekranına dön).
      if (lockIfWaiterTerminal()) { setBusy(false); return; }
      await refreshOrder(activeTable.tableId);
    } catch (e) { toast.error(e?.response?.data?.error || 'Gönderilemedi.'); }
    finally { setBusy(false); }
  };

  const doTransfer = async (targetTableId) => {
    if (!order?.orderId) return;
    setBusy(true);
    try {
      await api.post(`/restoran/orders/${order.orderId}/transfer`, { targetTableId });
      toast.success('Masa taşındı.');
      setTransferOpen(false);
      backToFloor();
    } catch (e) { toast.error(e?.response?.data?.error || 'Taşınamadı.'); }
    finally { setBusy(false); }
  };

  // Masa planında bir masayı diğerinin üstüne bırakınca birleştir (onay modalı aç).
  const onTableDrop = (target) => {
    if (!dragTable) return;
    const src = dragTable;
    setDragTable(null);
    if (src.tableId === target.tableId || !src.currentOrderId) return;
    setMergeCtx({ source: src, target });
  };
  const confirmMerge = async () => {
    if (!mergeCtx) return;
    const { source, target } = mergeCtx;
    setBusy(true);
    try {
      await api.post(`/restoran/orders/${source.currentOrderId}/merge`, { targetTableId: target.tableId });
      toast.success(`Masa ${source.tableNo} → Masa ${target.tableNo} birleştirildi.`);
      setMergeCtx(null);
      loadFloor(true);
    } catch (e) { toast.error(e?.response?.data?.error || 'Birleştirilemedi.'); }
    finally { setBusy(false); }
  };

  // Ön hesap (pusula) yazdır — masayı KAPATMAZ, Dolu kalır. Mali değeri yoktur.
  const printPreview = () => {
    const lines = (order?.items || []).filter((i) => !i.paid)
      .map((i) => ({ name: i.name, options: i.options, unitPrice: i.unitPrice, quantity: i.quantity, treat: i.kitchenStatus === 'İkram' }));
    if (lines.length === 0) { toast('Yazdırılacak kalem yok.', { icon: 'ℹ️' }); return; }
    doPrint({
      type: 'preview', tableNo: activeTable?.tableNo, guestCount: order.guestCount,
      lines, subtotal: order.total, total: order.total, at: new Date(),
    });
    toast.success('Ön hesap (pusula) yazdırıldı.');
  };

  // Seçili kalemleri başka masaya taşı (move-items).
  const doMoveItems = async () => {
    if (!order?.orderId || moveSel.size === 0 || !moveTarget) return;
    setBusy(true);
    try {
      const { data } = await api.post(`/restoran/orders/${order.orderId}/move-items`, {
        targetTableId: Number(moveTarget), itemIds: [...moveSel],
      });
      toast.success('Ürünler taşındı.');
      setMoveOpen(false); setMoveSel(new Set()); setMoveTarget('');
      if (data.sourceClosed) backToFloor();
      else await refreshOrder(activeTable.tableId);
    } catch (e) { toast.error(e?.response?.data?.error || 'Taşınamadı.'); }
    finally { setBusy(false); }
  };

  // Adisyona müşteri bağla/çöz (customerId null → bağı çöz).
  const attachCustomer = async (customerId) => {
    if (!order?.orderId) return;
    setBusy(true);
    try {
      const { data } = await api.patch(`/restoran/orders/${order.orderId}/customer`, { customerId });
      setOrder((o) => (o ? { ...o, customerId: data.customerId, customerName: data.customerName } : o));
      setCustModalOpen(false); setCustSearch('');
      toast.success(customerId ? `Müşteri bağlandı: ${data.customerName}` : 'Müşteri bağı çözüldü.');
    } catch (e) { toast.error(e?.response?.data?.error || 'Müşteri bağlanamadı.'); }
    finally { setBusy(false); }
  };

  // Yeni müşteri oluştur + adisyona bağla (hızlı kayıt).
  const createAndAttach = async () => {
    const name = newCustName.trim();
    if (!name) { toast.error('Müşteri adı girin.'); return; }
    setBusy(true);
    try {
      const { data } = await api.post('/restoran/customers', { name, phone: newCustPhone.trim() });
      setNewCustName(''); setNewCustPhone('');
      setBusy(false);
      await attachCustomer(data.id);
    } catch (e) { toast.error(e?.response?.data?.error || 'Müşteri eklenemedi.'); setBusy(false); }
  };

  // Tahsilat. opts: { method } tek ödeme | { payments:[{method,amount}] } çoklu | itemIds split.
  const doCheckout = async (opts) => {
    if (!order?.orderId) return;
    const { method, payments, itemIds, discount: disc } = opts;
    // Hesap fişi için ödenen kalemlerin anlık görüntüsü.
    const payingItems = itemIds
      ? order.items.filter((i) => itemIds.includes(i.itemId))
      : order.items.filter((i) => !i.paid);
    setBusy(true);
    try {
      const body = {};
      if (itemIds) body.itemIds = itemIds;
      if (opts.compType) {
        body.compType = opts.compType; // bedelsiz kapanış (Ödenmez/İkram/Personel)
      } else {
        if (disc > 0) body.discount = disc;
        if (opts.redeemPoints > 0) body.redeemPoints = opts.redeemPoints;
        if (payments) body.payments = payments;
        else {
          body.paymentMethod = method;
          if (opts.accountId) body.accountId = opts.accountId;
          if (method === 'Nakit' && received) body.received = Number(received);
        }
      }
      const { data } = await api.post(`/restoran/orders/${order.orderId}/checkout`, body);
      const changeMsg = data.change > 0 ? ` · Para üstü ${fmtTL(data.change)}` : '';
      if (data.compType) toast.success(`${data.compType}: ${fmtTL(data.compAmount)} (ciroya yazılmadı)`, { icon: '🎁' });
      else toast.success(`Tahsilat: ${fmtTL(data.paidAmount)}${changeMsg}`);
      if (data.pointsRedeemed > 0) toast.success(`${fmtTL(data.pointsRedeemed)} puan kullanıldı.`, { icon: '🎁' });
      if (data.pointsEarned > 0) toast.success(`${fmtTL(data.pointsEarned)} puan kazandırıldı.`, { icon: '⭐' });
      // Hesap fişi bas.
      doPrint({
        type: 'bill', tableNo: activeTable?.tableNo, guestCount: order.guestCount,
        lines: payingItems.map((i) => ({ name: i.name, options: i.options, unitPrice: i.unitPrice, quantity: i.quantity, treat: i.kitchenStatus === 'İkram' })),
        subtotal: data.subtotal, discount: data.discount,
        total: data.paidAmount, paymentMethod: data.paymentMethod, received: data.received, change: data.change, at: new Date(),
      });
      setPayModal(false); setSplitOpen(false); setSplitSel(new Set()); setReceived(''); setDiscount(''); setRedeem('');
      setMultiPay(false); setPayParts({ 'Nakit': '', 'Kredi Kartı': '', 'Yemek Fişi': '' });
      setAcctMode(false); setAcctQ(''); setAccounts([]);
      if (data.orderClosed) { backToFloor(); }
      else { await refreshOrder(activeTable.tableId); }
    } catch (e) { toast.error(e?.response?.data?.error || 'Tahsilat başarısız.'); }
    finally { setBusy(false); }
  };

  const submitMultiPay = () => {
    const payments = PAY_METHODS
      .map((m) => ({ method: m, amount: round2(payParts[m]) }))
      .filter((p) => p.amount > 0);
    const sum = round2(payments.reduce((s, p) => s + p.amount, 0));
    if (payments.length === 0) { toast.error('Tutar girin.'); return; }
    if (Math.abs(sum - order.total) > 0.01) {
      toast.error(`Toplam ${fmtTL(sum)} ≠ hesap ${fmtTL(order.total)}.`);
      return;
    }
    doCheckout({ payments });
  };

  const backToFloor = () => {
    setView('floor'); setActiveTable(null); setOrder(null); setPendingGuests(null);
    setPayModal(false); setTransferOpen(false); setSplitOpen(false); setSplitSel(new Set());
    setMultiPay(false); setPayParts({ 'Nakit': '', 'Kredi Kartı': '', 'Yemek Fişi': '' });
    setReceived(''); setDiscount(''); setRedeem(''); setOptionProduct(null);
    // Garson terminali: masalara dönüldü → ekranı kilitle (PIN ekranına dön).
    if (lockIfWaiterTerminal()) return;
    loadFloor(true);
  };

  // Gün sonu (Z).
  const openSummary = async () => {
    setSummary(null); setSummaryOpen(true);
    try { const { data } = await api.get('/restoran/summary'); setSummary(data); }
    catch { toast.error('Gün sonu alınamadı.'); }
  };

  // Adisyon geçmişi.
  const openHistory = async () => {
    setHistoryDetail(null); setHistory([]); setHistoryOpen(true);
    try { const { data } = await api.get('/restoran/orders'); setHistory(Array.isArray(data) ? data : []); }
    catch { toast.error('Geçmiş alınamadı.'); }
  };
  const openHistoryDetail = async (id) => {
    try { const { data } = await api.get(`/restoran/orders/${id}`); setHistoryDetail(data); }
    catch { toast.error('Adisyon alınamadı.'); }
  };
  const reprintBill = (d) => {
    doPrint({
      type: 'bill', tableNo: d.tableNo, guestCount: d.guestCount,
      lines: (d.items || []).filter((l) => l.paid).map((l) => ({ name: l.name, unitPrice: l.unitPrice, quantity: l.quantity, treat: l.treat })),
      total: d.total, paymentMethod: d.paymentMethod, at: d.closedAt || new Date(),
    });
  };

  // Boş masalar (taşıma hedefi).
  const emptyTables = useMemo(
    () => sections.flatMap((s) => (s.tables || []).filter((t) => t.status === 'Boş')
      .map((t) => ({ ...t, section: s.name }))),
    [sections]
  );

  const splitTotal = useMemo(() => {
    if (!order) return 0;
    return order.items.filter((i) => splitSel.has(i.itemId) && i.kitchenStatus !== 'İkram')
      .reduce((s, i) => s + i.unitPrice * i.quantity, 0);
  }, [order, splitSel]);

  const unsentCount = useMemo(
    () => (order?.items || []).filter((i) => !i.sent && !i.paid).length,
    [order]
  );

  // ════════════════════════════════════════════════════════════════════════
  return (
    <div className="fixed inset-0 bg-slate-950 text-slate-100 flex flex-col select-none">
      {/* Üst bar */}
      <header className="h-16 shrink-0 flex items-center gap-3 px-4 bg-slate-900 border-b border-slate-800">
        {view === 'order' ? (
          <button onClick={backToFloor} className="flex items-center gap-2 px-4 h-11 rounded-xl bg-slate-800 hover:bg-slate-700 font-semibold">
            <ArrowLeft size={20} /> Masalar
          </button>
        ) : (
          <div className="flex items-center gap-2 text-amber-400 font-extrabold text-xl">
            <ChefHat size={26} /> ArcTeknik Şef
          </div>
        )}
        <div className="flex-1 text-center font-bold text-lg truncate">
          {view === 'order'
            ? <>Masa {activeTable?.tableNo}{order?.guestCount ? <span className="text-sm text-slate-400 font-medium"> · {order.guestCount} kişi</span> : null}</>
            : 'Masa Planı'}
        </div>
        {view === 'floor' ? (
          <div className="flex items-center gap-2">
            {printQueueCount > 0 && (
              <button
                onClick={async () => {
                  const { printed, remaining } = await retryPrintQueue();
                  if (printed > 0) toast.success(`${printed} bekleyen fiş basıldı.`);
                  if (remaining > 0) toast.error(`${remaining} fiş hâlâ basılamıyor — yazıcıyı kontrol edin.`);
                }}
                onDoubleClick={() => { if (isAdmin && window.confirm('Bekleyen fiş kuyruğu TEMİZLENSİN mi? (Fişler basılmadan silinir)')) clearPrintQueue(); }}
                className="h-11 px-3 flex items-center gap-2 rounded-xl bg-rose-600 hover:bg-rose-500 font-bold animate-pulse"
                title="Basılamayan fişler — dokun: yeniden dene · çift dokun (yönetici): kuyruğu temizle">
                <Printer size={18} /> {printQueueCount} fiş bekliyor
              </button>
            )}
            <button onClick={() => loadFloor()} className="h-11 w-11 grid place-items-center rounded-xl bg-slate-800 hover:bg-slate-700" title="Yenile">
              <RefreshCw size={20} />
            </button>
            <button onClick={() => setPackagesOpen(true)} className="h-11 px-3 flex items-center gap-2 rounded-xl bg-sky-600 hover:bg-sky-500 font-semibold" title="Paket servis / gel-al">
              <Bike size={18} /> <span className="hidden sm:inline">Paket Servis</span>
            </button>
            <button onClick={() => setReservationsOpen(true)} className="h-11 px-3 flex items-center gap-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 font-semibold" title="Rezervasyonlar">
              <CalendarDays size={18} /> <span className="hidden sm:inline">Rezervasyon</span>
            </button>
            <button onClick={openHistory} className="h-11 px-3 flex items-center gap-2 rounded-xl bg-slate-800 hover:bg-slate-700 font-semibold" title="Adisyon geçmişi">
              <ClipboardList size={18} /> <span className="hidden sm:inline">Geçmiş</span>
            </button>
            {isAdmin && (
              <>
                <button onClick={openSummary} className="h-11 px-3 flex items-center gap-2 rounded-xl bg-slate-800 hover:bg-slate-700 font-semibold" title="Gün sonu">
                  <BarChart3 size={18} /> <span className="hidden sm:inline">Gün Sonu</span>
                </button>
                <button onClick={() => setReportsOpen(true)} className="h-11 px-3 flex items-center gap-2 rounded-xl bg-slate-800 hover:bg-slate-700 font-semibold" title="Raporlar (tarih aralığı)">
                  <TrendingUp size={18} /> <span className="hidden sm:inline">Raporlar</span>
                </button>
                <button onClick={() => setMgmtOpen(true)} className="h-11 px-3 flex items-center gap-2 rounded-xl bg-slate-800 hover:bg-slate-700 font-semibold">
                  <Settings size={18} /> <span className="hidden sm:inline">Yönetim</span>
                </button>
                <button onClick={() => setStaffOpen(true)} className="h-11 px-3 flex items-center gap-2 rounded-xl bg-slate-800 hover:bg-slate-700 font-semibold" title="Personel / garson hesapları">
                  <UserPlus size={18} /> <span className="hidden sm:inline">Personel</span>
                </button>
                <button onClick={() => setTerminalOpen(true)} className="h-11 px-3 flex items-center gap-2 rounded-xl bg-slate-800 hover:bg-slate-700 font-semibold" title="Bu cihazın terminal ayarları">
                  <Monitor size={18} /> <span className="hidden sm:inline">Terminal</span>
                </button>
                {silentAvailable() && (
                  <button onClick={() => setPrinterSetupOpen(true)} className="h-11 px-3 flex items-center gap-2 rounded-xl bg-slate-800 hover:bg-slate-700 font-semibold" title="Yazıcı eşleme (sessiz yazdırma)">
                    <Printer size={18} /> <span className="hidden sm:inline">Yazıcılar</span>
                  </button>
                )}
              </>
            )}
            {!standalone && (
              <button onClick={() => navigate('/')} className="h-11 px-4 rounded-xl bg-slate-800 hover:bg-slate-700 font-semibold">Panele Dön</button>
            )}
          </div>
        ) : (
          <div className="text-right">
            <div className="text-xs text-slate-400">Adisyon</div>
            <div className="text-xl font-extrabold text-amber-400">{fmtTL(order?.total || 0)}</div>
          </div>
        )}
      </header>

      {/* ── MASA PLANI ── */}
      {view === 'floor' && (
        <div className="flex-1 overflow-y-auto p-4">
          {loadingFloor ? (
            <div className="h-full grid place-items-center text-slate-500"><Loader2 className="animate-spin" size={40} /></div>
          ) : sections.length === 0 ? (
            <div className="h-full grid place-items-center text-center text-slate-400">
              <div>
                <Utensils size={48} className="mx-auto mb-3 opacity-60" />
                <p className="text-lg font-semibold">Henüz bölüm/masa yok.</p>
                {isAdmin
                  ? <p className="mt-1">Sağ üstteki <b>Yönetim</b>’den bölüm, masa ve menü ekleyin.</p>
                  : <p className="mt-1">Yöneticiniz bölüm ve masaları tanımlamalı.</p>}
              </div>
            </div>
          ) : (
            <div className="space-y-6">
              {sections.map((sec) => (
                <section key={sec.id ?? 'x'}>
                  <h2 className="text-sm font-bold uppercase tracking-wider text-slate-400 mb-3">{sec.name}</h2>
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-3">
                    {(sec.tables || []).map((t) => (
                      <button key={t.tableId} onClick={() => handleTap(t)}
                        draggable={t.status === 'Dolu'}
                        onDragStart={(e) => { if (t.status === 'Dolu') { setDragTable(t); e.dataTransfer.effectAllowed = 'move'; } }}
                        onDragOver={(e) => { if (dragTable && dragTable.tableId !== t.tableId) e.preventDefault(); }}
                        onDrop={() => onTableDrop(t)}
                        className={`aspect-square rounded-2xl border-2 flex flex-col items-center justify-center gap-1 transition-all active:scale-95 ${TABLE_STYLE[t.status] || TABLE_STYLE['Boş']} ${dragTable && dragTable.tableId !== t.tableId ? 'ring-2 ring-sky-400/40' : ''}`}>
                        <span className="text-3xl font-black">{t.tableNo}</span>
                        <span className="text-xs font-semibold opacity-80">{t.status}</span>
                        {t.status === 'Dolu' && ff('showTableTotal') && <span className="text-sm font-bold">{fmtTL(t.orderTotal)}</span>}
                        {t.status === 'Dolu' && ff('showTableTimer') && t.openMinutes != null && <TableTimer baseMinutes={t.openMinutes} />}
                        {t.status === 'Dolu' && ff('showTableGuests') && t.guestCount ? <span className="text-[11px] opacity-70 flex items-center gap-1"><Users size={11} /> {t.guestCount}</span> : null}
                        {t.status === 'Dolu' && ff('showTableWaiter') && t.waiter ? <span className="text-[11px] opacity-70 truncate max-w-full px-1">{t.waiter}</span> : null}
                      </button>
                    ))}
                    {(sec.tables || []).length === 0 && <p className="text-slate-600 text-sm">Bu bölümde masa yok.</p>}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── ADİSYON ── */}
      {view === 'order' && order && (
        <div className="flex-1 min-h-0 flex">
          {/* Sol: adisyon sepeti */}
          <div className="w-[42%] max-w-[520px] shrink-0 flex flex-col bg-slate-900 border-r border-slate-800">
            {/* Müşteri (sadakat) */}
            <div className="shrink-0 px-3 pt-3">
              <button onClick={() => { setCustSearch(''); setCustResults([]); setNewCustName(''); setNewCustPhone(''); setCustModalOpen(true); }} disabled={!order.orderId}
                className="w-full h-11 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 flex items-center justify-between px-3 disabled:opacity-40">
                <span className="flex items-center gap-2 font-semibold truncate">
                  <UserPlus size={16} className="text-sky-400 shrink-0" />
                  {order.customerName ? <span className="truncate">{order.customerName}</span> : <span className="text-slate-400">Müşteri Bağla</span>}
                </span>
                {order.customerId
                  ? <span className="text-xs font-bold text-amber-400 flex items-center gap-1 shrink-0"><Star size={12} /> {fmtTL(custPoints)} P</span>
                  : <ChevronRight size={16} className="text-slate-500 shrink-0" />}
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-3 space-y-2">
              {order.items.length === 0 && <p className="text-center text-slate-500 mt-10">Adisyon boş. Sağdan ürün ekleyin.</p>}
              {order.items.map((it) => (
                <div key={it.itemId} className={`rounded-xl p-3 border ${it.paid ? 'border-emerald-700 bg-emerald-900/20 opacity-70' : 'border-slate-700 bg-slate-800'}`}>
                  <div className="flex items-start gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="font-bold truncate">{it.name}{!it.sent && !it.paid && <span className="ml-1 text-[10px] text-amber-400">●yeni</span>}</div>
                      {it.options && <div className="text-xs text-sky-300 truncate">{it.options}</div>}
                      <div className="text-sm text-slate-400">{fmtTL(it.unitPrice)} × {it.quantity} = <b className="text-slate-200">{fmtTL(it.unitPrice * it.quantity)}</b></div>
                      {it.note && <div className="text-xs mt-1 text-amber-300 flex items-center gap-1"><StickyNote size={12} /> {it.note}</div>}
                      <button onClick={() => cycleKitchen(it)} disabled={it.paid}
                        className={`mt-1.5 text-[11px] font-bold px-2 py-0.5 rounded-full ${KITCHEN_COLOR[it.kitchenStatus]}`}>
                        {it.kitchenStatus}
                      </button>
                    </div>
                    {!it.paid && (
                      <div className="flex flex-col items-end gap-1.5">
                        <div className="flex items-center gap-1">
                          <button onClick={() => changeQty(it, -1)} className="h-9 w-9 grid place-items-center rounded-lg bg-slate-700 hover:bg-slate-600"><Minus size={16} /></button>
                          <span className="w-7 text-center font-bold">{it.quantity}</span>
                          <button onClick={() => changeQty(it, +1)} className="h-9 w-9 grid place-items-center rounded-lg bg-slate-700 hover:bg-slate-600"><Plus size={16} /></button>
                        </div>
                        <div className="flex items-center gap-1">
                          <button onClick={() => { setNoteItem(it); setNoteText(it.note || ''); }} className="h-8 w-8 grid place-items-center rounded-lg bg-slate-700 hover:bg-slate-600" title="Mutfak notu"><StickyNote size={15} /></button>
                          <button onClick={() => toggleTreat(it)} className={`h-8 w-8 grid place-items-center rounded-lg hover:bg-slate-600 ${it.kitchenStatus === 'İkram' ? 'bg-fuchsia-600' : 'bg-slate-700'}`} title="İkram et"><Gift size={15} /></button>
                          <button onClick={() => removeItem(it)} className="h-8 w-8 grid place-items-center rounded-lg bg-rose-900/60 hover:bg-rose-800 text-rose-200" title="İptal"><Trash2 size={15} /></button>
                        </div>
                      </div>
                    )}
                    {it.paid && <span className="text-xs font-bold text-emerald-400 flex items-center gap-1"><Check size={14} /> Ödendi</span>}
                  </div>
                </div>
              ))}
            </div>

            {/* Adisyon aksiyonları */}
            <div className="shrink-0 p-3 border-t border-slate-800 space-y-2">
              <button onClick={sendKitchen} disabled={!order.orderId || unsentCount === 0 || busy}
                className="w-full h-12 rounded-xl bg-amber-500 text-amber-950 font-extrabold flex items-center justify-center gap-2 disabled:opacity-40">
                <Send size={18} /> Mutfağa Gönder{unsentCount > 0 ? ` (${unsentCount})` : ''}
              </button>
              <div className="flex items-center justify-between text-lg">
                <span className="text-slate-400">Toplam</span>
                <span className="font-extrabold text-amber-400 text-2xl">{fmtTL(order.total)}</span>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <button onClick={() => setTransferOpen(true)} disabled={!order.orderId} className="h-12 rounded-xl bg-slate-800 hover:bg-slate-700 font-semibold flex items-center justify-center gap-2 disabled:opacity-40"><ArrowRightLeft size={18} /> Masa Taşı</button>
                <button onClick={() => { setMoveSel(new Set()); setMoveTarget(''); setMoveOpen(true); }} disabled={!order.orderId || order.items.filter((i) => !i.paid).length === 0} className="h-12 rounded-xl bg-slate-800 hover:bg-slate-700 font-semibold flex items-center justify-center gap-2 disabled:opacity-40"><ArrowRightLeft size={18} /> Ürün Taşı</button>
                <button onClick={() => { setSplitSel(new Set()); setSplitOpen(true); }} disabled={!order.orderId || order.total <= 0} className="h-12 rounded-xl bg-slate-800 hover:bg-slate-700 font-semibold flex items-center justify-center gap-2 disabled:opacity-40"><SplitSquareHorizontal size={18} /> Hesap Böl</button>
              </div>
              <button onClick={printPreview} disabled={!order.orderId || order.items.filter((i) => !i.paid).length === 0}
                className="w-full h-12 rounded-xl bg-slate-800 hover:bg-slate-700 font-semibold flex items-center justify-center gap-2 disabled:opacity-40">
                <Printer size={18} /> Pusula (Ön Hesap)
              </button>
              <button onClick={() => { setReceived(''); setMultiPay(false); setPayModal(true); }} disabled={!order.orderId || order.total <= 0}
                className="w-full h-14 rounded-xl bg-emerald-600 hover:bg-emerald-500 font-extrabold text-lg flex items-center justify-center gap-2 disabled:opacity-40">
                <Banknote size={22} /> Hesabı Kapat
              </button>
            </div>
          </div>

          {/* Sağ: menü */}
          <div className="flex-1 min-w-0 flex flex-col">
            <div className="shrink-0 flex gap-2 p-3 overflow-x-auto border-b border-slate-800">
              {happyActive && <span className="px-3 h-12 grid place-items-center rounded-xl bg-fuchsia-500/20 text-fuchsia-300 font-bold text-sm whitespace-nowrap shrink-0">🕒 Happy Hour</span>}
              {menu.length === 0 && <span className="text-slate-500 text-sm py-2">Menü boş. Yönetim’den ürün ekleyin.</span>}
              {menu.map((c, i) => (
                <button key={c.id ?? `c${i}`} onClick={() => setActiveCat(i)}
                  className={`px-5 h-12 rounded-xl font-bold whitespace-nowrap ${i === activeCat ? 'bg-amber-500 text-amber-950' : 'bg-slate-800 hover:bg-slate-700'}`}>
                  {c.name}
                </button>
              ))}
            </div>
            <div className="flex-1 overflow-y-auto p-3">
              <div className={prodBtn.wrap}>
                {(menu[activeCat]?.products || []).map((p) => (
                  <button key={p.id} onClick={() => addProduct(p)} disabled={busy}
                    className={`${prodBtn.btn} rounded-2xl bg-slate-800 hover:bg-slate-700 border border-slate-700 active:scale-95 transition-all p-3 flex flex-col justify-between text-left disabled:opacity-50`}>
                    <span className={`font-bold leading-tight flex items-start gap-1 ${prodBtn.name}`}>
                      {p.name}
                      {p.optionGroups?.length > 0 && <Layers size={13} className="text-sky-400 shrink-0 mt-0.5" />}
                    </span>
                    <span>
                      {p.happyActive && p.basePrice > p.price && <span className="text-slate-500 line-through text-xs mr-1">{fmtTL(p.basePrice)}</span>}
                      <span className={`text-amber-400 font-extrabold ${prodBtn.price}`}>{fmtTL(p.price)}</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Kişi sayısı modalı ── */}
      {guestPrompt && (
        <Modal onClose={() => confirmGuest(true)} title={`Masa ${guestPrompt.tableNo} — Kişi Sayısı`}>
          <div className="flex items-center gap-2 mb-3 text-slate-300"><Users size={20} /> Kaç kişi oturuyor?</div>
          <div className="grid grid-cols-4 gap-2 mb-3">
            {[1, 2, 3, 4, 5, 6, 8, 10].map((n) => (
              <button key={n} onClick={() => setGuestInput(String(n))} className={`h-14 rounded-xl font-bold text-lg ${String(n) === guestInput ? 'bg-amber-500 text-amber-950' : 'bg-slate-800 hover:bg-slate-700'}`}>{n}</button>
            ))}
          </div>
          <input value={guestInput} onChange={(e) => setGuestInput(e.target.value)} inputMode="numeric" placeholder="Diğer (sayı)"
            className="w-full h-12 rounded-xl bg-slate-800 border border-slate-700 px-4 text-slate-100 outline-none focus:border-amber-500 mb-3" />
          <div className="grid grid-cols-2 gap-3">
            <button onClick={() => confirmGuest(true)} className="h-12 rounded-xl bg-slate-700 hover:bg-slate-600 font-bold">Atla</button>
            <button onClick={() => confirmGuest(false)} className="h-12 rounded-xl bg-emerald-600 hover:bg-emerald-500 font-extrabold">Aç</button>
          </div>
        </Modal>
      )}

      {/* ── Mutfak notu modalı ── */}
      {noteItem && (
        <Modal onClose={() => setNoteItem(null)} title={`Mutfak Notu — ${noteItem.name}`}>
          <div className="flex flex-wrap gap-2 mb-3">
            {['Az pişsin', 'Çok pişsin', 'Soğansız', 'Acısız', 'Acılı', 'Servis sona'].map((s) => (
              <button key={s} onClick={() => setNoteText(s)} className="px-3 h-10 rounded-lg bg-slate-700 hover:bg-slate-600 text-sm font-semibold">{s}</button>
            ))}
          </div>
          <textarea value={noteText} onChange={(e) => setNoteText(e.target.value)} rows={3} maxLength={300}
            placeholder="Mutfak notu…" className="w-full rounded-xl bg-slate-800 border border-slate-700 p-3 text-slate-100 outline-none focus:border-amber-500" />
          <button onClick={saveNote} disabled={busy} className="mt-3 w-full h-12 rounded-xl bg-amber-500 text-amber-950 font-extrabold">Notu Kaydet</button>
        </Modal>
      )}

      {/* ── Müşteri bağlama modalı (sadakat) ── */}
      {custModalOpen && order && (
        <Modal onClose={() => setCustModalOpen(false)} title="Müşteri Bağla">
          {order.customerId && (
            <div className="mb-3 p-3 rounded-xl bg-emerald-900/30 border border-emerald-700 flex items-center justify-between">
              <span className="font-semibold flex items-center gap-2"><Star size={15} className="text-amber-400" /> {order.customerName} <span className="text-amber-400 text-sm">· {fmtTL(custPoints)} P</span></span>
              <button onClick={() => attachCustomer(null)} disabled={busy} className="text-xs font-bold px-3 h-9 rounded-lg bg-rose-900/60 hover:bg-rose-800 text-rose-200">Bağı Çöz</button>
            </div>
          )}
          <div className="relative mb-2">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <input value={custSearch} onChange={(e) => setCustSearch(e.target.value)} autoFocus placeholder="Müşteri ara (ad/telefon)…"
              className="w-full h-12 rounded-xl bg-slate-800 border border-slate-700 pl-9 pr-3 outline-none focus:border-amber-500" />
          </div>
          <div className="max-h-48 overflow-y-auto space-y-1 mb-3">
            {custResults.map((c) => (
              <button key={c.customerId} onClick={() => attachCustomer(c.customerId)} disabled={busy}
                className="w-full text-left p-3 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 flex items-center justify-between">
                <span className="font-semibold truncate">{c.name} <span className="text-slate-400 font-normal text-sm">{c.phone}</span></span>
                <span className="text-xs font-bold text-amber-400 shrink-0 flex items-center gap-1"><Star size={11} /> {fmtTL(c.points)} P</span>
              </button>
            ))}
            {custSearch && custResults.length === 0 && <p className="text-center text-slate-500 text-sm py-2">Müşteri bulunamadı.</p>}
          </div>
          {/* Hızlı yeni müşteri */}
          <div className="border-t border-slate-800 pt-3">
            <div className="text-sm font-semibold text-slate-300 mb-2 flex items-center gap-1"><UserPlus size={14} /> Yeni Müşteri</div>
            <div className="grid grid-cols-2 gap-2 mb-2">
              <input value={newCustName} onChange={(e) => setNewCustName(e.target.value)} placeholder="Ad Soyad"
                className="h-11 rounded-xl bg-slate-800 border border-slate-700 px-3 outline-none focus:border-amber-500" />
              <input value={newCustPhone} onChange={(e) => setNewCustPhone(e.target.value)} inputMode="tel" placeholder="Telefon (ops.)"
                className="h-11 rounded-xl bg-slate-800 border border-slate-700 px-3 outline-none focus:border-amber-500" />
            </div>
            <button onClick={createAndAttach} disabled={busy || !newCustName.trim()} className="w-full h-11 rounded-xl bg-sky-600 hover:bg-sky-500 font-bold disabled:opacity-40">Ekle & Bağla</button>
          </div>
        </Modal>
      )}

      {/* ── Tahsilat (tüm hesap) modalı ── */}
      {payModal && order && (
        <Modal onClose={() => { setPayModal(false); setAcctMode(false); setAcctQ(''); }} title={`Masa ${activeTable?.tableNo} — Hesap Kapat`}>
          <div className="text-center mb-4">
            <div className="text-slate-400">Ödenecek tutar</div>
            <div className="text-4xl font-black text-amber-400">{fmtTL(order.total)}</div>
          </div>

          {acctMode ? (
            (() => {
              const disc = Math.min(round2(discount) || 0, order.total);
              const net = round2(order.total - disc);
              return (
                <>
                  <div className="relative mb-2">
                    <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
                    <input value={acctQ} onChange={(e) => setAcctQ(e.target.value)} autoFocus placeholder="Cari ara (ad/telefon)…"
                      className="w-full h-12 rounded-xl bg-slate-800 border border-slate-700 pl-9 pr-3 outline-none focus:border-amber-500" />
                  </div>
                  <div className="max-h-52 overflow-y-auto space-y-1 mb-2">
                    {accounts.map((a) => (
                      <button key={a.accountId} onClick={() => doCheckout({ method: 'Açık Hesap', accountId: a.accountId, discount: disc })} disabled={busy}
                        className="w-full text-left p-3 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 flex items-center justify-between">
                        <span className="font-semibold">{a.name} <span className="text-slate-400 font-normal text-sm">{a.phone}</span></span>
                        <span className={`text-sm font-bold ${a.balance > 0 ? 'text-rose-400' : 'text-emerald-400'}`}>{fmtTL(a.balance)}</span>
                      </button>
                    ))}
                    {acctQ && accounts.length === 0 && <p className="text-center text-slate-500 text-sm py-2">Cari bulunamadı.</p>}
                  </div>
                  <div className="text-center text-sm text-slate-400 mb-2">Veresiye tutarı: <b className="text-orange-300">{fmtTL(net)}</b></div>
                  <button onClick={() => { setAcctMode(false); setAcctQ(''); }} className="w-full h-11 rounded-xl bg-slate-700 hover:bg-slate-600 font-bold">Geri</button>
                </>
              );
            })()
          ) : !multiPay ? (
            (() => {
              const disc = Math.min(round2(discount) || 0, order.total);
              const maxRedeem = Math.max(0, round2(order.total - disc));
              const rdm = order.customerId ? Math.min(round2(redeem) || 0, custPoints, maxRedeem) : 0;
              const net = round2(order.total - disc - rdm);
              return (
            <>
              <div className="flex items-center gap-2 mb-2">
                <span className="w-24 text-sm font-semibold text-slate-300 flex items-center gap-1"><Percent size={14} /> İndirim</span>
                <input value={discount} onChange={(e) => setDiscount(e.target.value)} inputMode="decimal" placeholder="0,00 ₺"
                  className="flex-1 h-11 rounded-xl bg-slate-800 border border-slate-700 px-3 text-slate-100 outline-none focus:border-amber-500" />
              </div>
              {order.customerId && custPoints > 0 && (
                <div className="flex items-center gap-2 mb-2">
                  <span className="w-24 text-sm font-semibold text-slate-300 flex items-center gap-1"><Star size={14} className="text-amber-400" /> Puan</span>
                  <input value={redeem} onChange={(e) => setRedeem(e.target.value)} inputMode="decimal" placeholder={`0 / ${fmtTL(custPoints)}`}
                    className="flex-1 h-11 rounded-xl bg-slate-800 border border-slate-700 px-3 text-slate-100 outline-none focus:border-amber-500" />
                  <button onClick={() => setRedeem(String(Math.min(custPoints, maxRedeem)))} className="h-11 px-3 rounded-xl bg-slate-700 hover:bg-slate-600 font-bold text-sm">Tümü</button>
                </div>
              )}
              {(disc > 0 || rdm > 0) && <div className="text-center font-bold text-amber-400 mb-2">Net: {fmtTL(net)}{rdm > 0 && <span className="text-sm text-slate-400 font-medium"> · {fmtTL(rdm)} puan</span>}</div>}
              <div className="mb-3">
                <input value={received} onChange={(e) => setReceived(e.target.value)} inputMode="decimal" placeholder="Alınan nakit (opsiyonel)"
                  className="w-full h-12 rounded-xl bg-slate-800 border border-slate-700 px-4 text-slate-100 outline-none focus:border-emerald-500" />
                {received && Number(received) >= net && (
                  <div className="text-emerald-400 font-bold mt-2 text-center">Para üstü: {fmtTL(Number(received) - net)}</div>
                )}
              </div>
              <div className={`grid gap-2 ${[ff('payCash'), ff('payCard'), ff('payTicket')].filter(Boolean).length <= 1 ? 'grid-cols-1' : [ff('payCash'), ff('payCard'), ff('payTicket')].filter(Boolean).length === 2 ? 'grid-cols-2' : 'grid-cols-3'}`}>
                {ff('payCash') && <button onClick={() => doCheckout({ method: 'Nakit', discount: disc, redeemPoints: rdm })} disabled={busy} className="h-16 rounded-xl bg-emerald-600 hover:bg-emerald-500 font-extrabold flex flex-col items-center justify-center gap-1"><Banknote size={20} /> Nakit</button>}
                {ff('payCard') && <button onClick={() => doCheckout({ method: 'Kredi Kartı', discount: disc, redeemPoints: rdm })} disabled={busy} className="h-16 rounded-xl bg-sky-600 hover:bg-sky-500 font-extrabold flex flex-col items-center justify-center gap-1"><CreditCard size={20} /> Kart</button>}
                {ff('payTicket') && <button onClick={() => doCheckout({ method: 'Yemek Fişi', discount: disc, redeemPoints: rdm })} disabled={busy} className="h-16 rounded-xl bg-violet-600 hover:bg-violet-500 font-extrabold flex flex-col items-center justify-center gap-1"><Ticket size={20} /> Fiş</button>}
              </div>
              <div className="grid grid-cols-2 gap-2 mt-3">
                <button onClick={() => { setMultiPay(true); }} className="h-11 rounded-xl bg-slate-800 hover:bg-slate-700 font-semibold flex items-center justify-center gap-2"><SplitSquareHorizontal size={16} /> Çoklu Öde</button>
                <button onClick={() => { setAcctQ(''); setAccounts([]); setAcctMode(true); }} className="h-11 rounded-xl bg-orange-600 hover:bg-orange-500 font-bold flex items-center justify-center gap-2"><Wallet size={16} /> Veresiye</button>
              </div>
              {/* Bedelsiz kapanış: ciroya yazmaz, stok düşer, Z'de ayrı görünür. */}
              <div className="border-t border-slate-700 mt-3 pt-3">
                <div className="text-xs text-slate-400 mb-2 flex items-center gap-1"><Gift size={14} /> Bedelsiz Kapat (ciroya yazılmaz)</div>
                <div className="grid grid-cols-3 gap-2">
                  <button onClick={() => doCheckout({ compType: 'İkram' })} disabled={busy} className="h-12 rounded-xl bg-fuchsia-700/80 hover:bg-fuchsia-600 font-bold text-sm">İkram</button>
                  <button onClick={() => doCheckout({ compType: 'Ödenmez' })} disabled={busy} className="h-12 rounded-xl bg-slate-700 hover:bg-slate-600 font-bold text-sm">Ödenmez</button>
                  <button onClick={() => doCheckout({ compType: 'Personel' })} disabled={busy} className="h-12 rounded-xl bg-slate-700 hover:bg-slate-600 font-bold text-sm">Personel</button>
                </div>
              </div>
            </>
              );
            })()
          ) : (
            <>
              <div className="space-y-2 mb-3">
                {PAY_METHODS.map((m) => (
                  <div key={m} className="flex items-center gap-2">
                    <span className="w-28 text-sm font-semibold text-slate-300">{m}</span>
                    <input value={payParts[m]} onChange={(e) => setPayParts({ ...payParts, [m]: e.target.value })} inputMode="decimal" placeholder="0,00"
                      className="flex-1 h-11 rounded-xl bg-slate-800 border border-slate-700 px-3 text-slate-100 outline-none focus:border-emerald-500" />
                  </div>
                ))}
              </div>
              {(() => {
                const sum = round2(PAY_METHODS.reduce((s, m) => s + (round2(payParts[m]) || 0), 0));
                const diff = round2(order.total - sum);
                return <div className={`text-center font-bold mb-3 ${Math.abs(diff) < 0.01 ? 'text-emerald-400' : 'text-amber-400'}`}>Girilen: {fmtTL(sum)} · Kalan: {fmtTL(diff)}</div>;
              })()}
              <div className="grid grid-cols-2 gap-3">
                <button onClick={() => setMultiPay(false)} className="h-12 rounded-xl bg-slate-700 hover:bg-slate-600 font-bold">Geri</button>
                <button onClick={submitMultiPay} disabled={busy} className="h-12 rounded-xl bg-emerald-600 hover:bg-emerald-500 font-extrabold">Tahsil Et</button>
              </div>
            </>
          )}
        </Modal>
      )}

      {/* ── Hesap böl (split) modalı ── */}
      {splitOpen && order && (
        <Modal onClose={() => setSplitOpen(false)} title="Hesabı Böl — Ödenecek kalemleri seçin">
          <div className="max-h-[40vh] overflow-y-auto space-y-2 mb-3">
            {order.items.filter((i) => !i.paid).map((it) => {
              const sel = splitSel.has(it.itemId);
              const treat = it.kitchenStatus === 'İkram';
              return (
                <button key={it.itemId} disabled={treat}
                  onClick={() => { const n = new Set(splitSel); n.has(it.itemId) ? n.delete(it.itemId) : n.add(it.itemId); setSplitSel(n); }}
                  className={`w-full flex items-center justify-between p-3 rounded-xl border ${treat ? 'border-fuchsia-700 bg-fuchsia-900/20 opacity-60' : sel ? 'border-amber-500 bg-amber-500/15' : 'border-slate-700 bg-slate-800'}`}>
                  <span className="font-semibold">{it.name} × {it.quantity}{treat ? ' (İkram)' : ''}</span>
                  <span className="font-bold">{treat ? '—' : fmtTL(it.unitPrice * it.quantity)}</span>
                </button>
              );
            })}
          </div>
          <div className="flex items-center justify-between text-lg mb-3">
            <span className="text-slate-400">Seçili tutar</span>
            <span className="font-extrabold text-amber-400">{fmtTL(splitTotal)}</span>
          </div>
          <div className={`grid gap-2 ${[ff('payCash'), ff('payCard'), ff('payTicket')].filter(Boolean).length <= 1 ? 'grid-cols-1' : [ff('payCash'), ff('payCard'), ff('payTicket')].filter(Boolean).length === 2 ? 'grid-cols-2' : 'grid-cols-3'}`}>
            {ff('payCash') && <button onClick={() => doCheckout({ method: 'Nakit', itemIds: [...splitSel] })} disabled={busy || splitSel.size === 0} className="h-14 rounded-xl bg-emerald-600 hover:bg-emerald-500 font-extrabold flex flex-col items-center justify-center gap-1 disabled:opacity-40"><Banknote size={18} /> Nakit</button>}
            {ff('payCard') && <button onClick={() => doCheckout({ method: 'Kredi Kartı', itemIds: [...splitSel] })} disabled={busy || splitSel.size === 0} className="h-14 rounded-xl bg-sky-600 hover:bg-sky-500 font-extrabold flex flex-col items-center justify-center gap-1 disabled:opacity-40"><CreditCard size={18} /> Kart</button>}
            {ff('payTicket') && <button onClick={() => doCheckout({ method: 'Yemek Fişi', itemIds: [...splitSel] })} disabled={busy || splitSel.size === 0} className="h-14 rounded-xl bg-violet-600 hover:bg-violet-500 font-extrabold flex flex-col items-center justify-center gap-1 disabled:opacity-40"><Ticket size={18} /> Fiş</button>}
          </div>
        </Modal>
      )}

      {/* ── Masa taşıma modalı ── */}
      {transferOpen && (
        <Modal onClose={() => setTransferOpen(false)} title="Masayı Taşı — Boş masa seçin">
          {emptyTables.length === 0 ? (
            <p className="text-center text-slate-400 py-6">Boş masa yok.</p>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(110px,1fr))] gap-2 max-h-[50vh] overflow-y-auto">
              {emptyTables.map((t) => (
                <button key={t.tableId} onClick={() => doTransfer(t.tableId)} disabled={busy}
                  className="aspect-square rounded-xl border-2 border-emerald-500/50 bg-emerald-500/15 hover:bg-emerald-500/25 flex flex-col items-center justify-center">
                  <span className="text-2xl font-black">{t.tableNo}</span>
                  <span className="text-[11px] opacity-70">{t.section}</span>
                </button>
              ))}
            </div>
          )}
        </Modal>
      )}

      {/* ── Gün sonu (Z) modalı ── */}
      {summaryOpen && (
        <Modal onClose={() => setSummaryOpen(false)} title="Gün Sonu (Z) Raporu">
          {!summary ? (
            <div className="grid place-items-center py-8"><Loader2 className="animate-spin" size={32} /></div>
          ) : (
            <div className="space-y-2">
              <div className="text-center text-slate-400 mb-2">{summary.date}</div>
              <Row label="Adisyon (kapanan)" value={summary.orders} />
              <Row label="Toplam kişi" value={summary.guests} />
              <div className="border-t border-slate-700 my-2" />
              <Row label="Nakit" value={fmtTL(summary.cash)} />
              <Row label="Kredi Kartı" value={fmtTL(summary.card)} />
              <Row label="Yemek Fişi" value={fmtTL(summary.ticket)} />
              <div className="border-t border-slate-700 my-2" />
              <div className="flex items-center justify-between text-xl font-extrabold text-amber-400"><span>TOPLAM (ciro)</span><span>{fmtTL(summary.total)}</span></div>
              {summary.compTotal > 0 && (
                <div className="mt-3 rounded-xl border border-fuchsia-700/40 bg-fuchsia-900/15 p-3 space-y-1">
                  <div className="text-xs text-fuchsia-300 font-semibold flex items-center gap-1 mb-1"><Gift size={14} /> Bedelsiz (ciro DIŞI)</div>
                  {summary.compTreat > 0 && <Row label="İkram" value={fmtTL(summary.compTreat)} />}
                  {summary.compUnpaid > 0 && <Row label="Ödenmez (patron)" value={fmtTL(summary.compUnpaid)} />}
                  {summary.compStaff > 0 && <Row label="Personel" value={fmtTL(summary.compStaff)} />}
                  <div className="flex items-center justify-between font-bold text-fuchsia-300 pt-1 border-t border-fuchsia-700/30"><span>Toplam bedelsiz</span><span>{fmtTL(summary.compTotal)}</span></div>
                </div>
              )}
              <button onClick={() => doPrint({ type: 'summary', summary })} className="mt-3 w-full h-12 rounded-xl bg-slate-800 hover:bg-slate-700 font-bold flex items-center justify-center gap-2"><Printer size={18} /> Yazdır</button>
            </div>
          )}
        </Modal>
      )}

      {/* ── Adisyon geçmişi modalı ── */}
      {historyOpen && (
        <Modal onClose={() => setHistoryOpen(false)} title={historyDetail ? `Adisyon #${historyDetail.orderId} — Masa ${historyDetail.tableNo}` : 'Bugünün Kapanan Adisyonları'}>
          {!historyDetail ? (
            history.length === 0 ? (
              <p className="text-center text-slate-400 py-6">Bugün kapanan adisyon yok.</p>
            ) : (
              <div className="max-h-[55vh] overflow-y-auto space-y-2">
                {history.map((h) => (
                  <button key={h.orderId} onClick={() => openHistoryDetail(h.orderId)}
                    className="w-full flex items-center justify-between p-3 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700">
                    <span className="text-left">
                      <span className="font-bold">Masa {h.tableNo}</span>
                      <span className="block text-xs text-slate-400">{new Date(h.closedAt).toLocaleTimeString('tr-TR')} · {h.paymentMethod || '—'}{h.guestCount ? ` · ${h.guestCount} kişi` : ''}</span>
                    </span>
                    <span className="font-extrabold text-amber-400">{fmtTL(h.total)}</span>
                  </button>
                ))}
              </div>
            )
          ) : (
            <div>
              <div className="max-h-[45vh] overflow-y-auto space-y-1 mb-3">
                {historyDetail.items.map((l, i) => (
                  <div key={i} className="flex items-center justify-between text-sm">
                    <span>{l.name} × {l.quantity}{l.treat ? ' (İkram)' : ''}{!l.paid ? ' (ödenmedi)' : ''}</span>
                    <span>{l.treat ? '—' : fmtTL(l.unitPrice * l.quantity)}</span>
                  </div>
                ))}
              </div>
              <div className="flex items-center justify-between text-lg font-extrabold text-amber-400 border-t border-slate-700 pt-2"><span>TOPLAM</span><span>{fmtTL(historyDetail.total)}</span></div>
              <div className="grid grid-cols-2 gap-3 mt-3">
                <button onClick={() => setHistoryDetail(null)} className="h-12 rounded-xl bg-slate-700 hover:bg-slate-600 font-bold">Listeye Dön</button>
                <button onClick={() => reprintBill(historyDetail)} className="h-12 rounded-xl bg-amber-500 text-amber-950 font-extrabold flex items-center justify-center gap-2"><Printer size={18} /> Fişi Yazdır</button>
              </div>
            </div>
          )}
        </Modal>
      )}

      {/* ── Seçenek (modifier) seçim modalı ── */}
      {optionProduct && (
        <Modal onClose={() => setOptionProduct(null)} title={optionProduct.name}>
          <div className="space-y-4 max-h-[55vh] overflow-y-auto">
            {optionProduct.optionGroups.map((g) => (
              <div key={g.id}>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="font-bold">{g.name}</span>
                  <span className="text-xs text-slate-400">{g.min > 0 ? `en az ${g.min}` : 'opsiyonel'}{g.max > 0 ? ` · en çok ${g.max}` : ''}</span>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {g.options.map((o) => {
                    const sel = (optionSel[g.id] || new Set()).has(o.id);
                    return (
                      <button key={o.id} onClick={() => toggleOption(g, o.id)}
                        className={`h-12 rounded-xl px-3 flex items-center justify-between font-semibold border ${sel ? 'border-amber-500 bg-amber-500/15 text-amber-100' : 'border-slate-700 bg-slate-800'}`}>
                        <span className="truncate">{o.name}</span>
                        {o.priceDelta !== 0 && <span className="text-xs shrink-0 ml-1">{o.priceDelta > 0 ? '+' : ''}{fmtTL(o.priceDelta)}</span>}
                      </button>
                    );
                  })}
                  {g.options.length === 0 && <span className="text-slate-500 text-sm col-span-2">Seçenek yok.</span>}
                </div>
              </div>
            ))}
          </div>
          <div className="flex items-center justify-between mt-4 mb-2 text-lg">
            <span className="text-slate-400">Fiyat</span>
            <span className="font-extrabold text-amber-400">{fmtTL(optionPrice)}</span>
          </div>
          <button onClick={confirmOptions} disabled={busy} className="w-full h-13 py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 font-extrabold flex items-center justify-center gap-2"><Plus size={20} /> Adisyona Ekle</button>
        </Modal>
      )}

      {/* ── Yönetim modalı (Admin) ── */}
      {mgmtOpen && <ManagementModal onClose={() => { setMgmtOpen(false); loadFloor(); loadMenu(); }} sections={sections} menu={menu} reload={loadMenu} />}

      {/* ── Yazıcı eşleme modalı (Admin, sessiz yazdırma) ── */}
      {printerSetupOpen && <PrinterSetupModal menu={menu} onClose={() => setPrinterSetupOpen(false)} />}

      {/* ── Paket Servis & Gel-Al paneli (tam ekran overlay) ── */}
      {packagesOpen && (
        <RestaurantPackages menu={menu} company={company} isAdmin={isAdmin} onPrint={doPrint} onClose={() => setPackagesOpen(false)} />
      )}

      {/* ── Rezervasyon modalı ── */}
      {reservationsOpen && <ReservationsModal sections={sections} onClose={() => setReservationsOpen(false)} />}

      {/* ── Raporlar modalı (Admin) ── */}
      {reportsOpen && <ReportsModal onClose={() => setReportsOpen(false)} />}

      {/* ── Personel (garson) yönetimi modalı (Admin) ── */}
      {staffOpen && <StaffModal onClose={() => setStaffOpen(false)} />}

      {/* ── Terminal (cihaz) ayarları modalı (Admin) ── */}
      {terminalOpen && <TerminalModal onClose={() => setTerminalOpen(false)} />}

      {/* ── Güvenli kapatma onayı (dokunmatik kiosk) ── */}
      {exitOpen && <ExitModal onClose={() => setExitOpen(false)} />}

      {/* ── İptal/zayi nedeni + yönetici şifresi (mutfağa gitmiş kalem) ── */}
      {cancelCtx && (
        <Modal title={cancelCtx.mode === 'delete' ? 'Kalem İptali' : 'Miktar Azaltma'} onClose={() => setCancelCtx(null)}>
          <p className="text-sm text-slate-300 mb-1">
            <b>{cancelCtx.item.name}</b> {cancelCtx.mode === 'delete' ? 'iptal edilecek' : `(${cancelCtx.item.quantity} → ${cancelCtx.nextQty})`}.
          </p>
          <p className="text-xs text-amber-300 mb-3">Bu kalem mutfağa gönderilmiş. İşlem güvenlik kaydına (Audit) düşer.</p>

          {ff('askCancelReason') && (
            <>
              <label className="text-sm text-slate-400">İptal nedeni</label>
              <div className="grid grid-cols-1 gap-2 mt-1 mb-3">
                {['Yanlış Giriş', 'Müşteri Vazgeçti', 'Döküldü/Zayi'].map((r) => (
                  <button
                    key={r}
                    onClick={() => setCancelReason(r)}
                    className={`h-11 rounded-xl font-semibold border ${cancelReason === r ? 'bg-amber-500 text-amber-950 border-amber-400' : 'bg-slate-800 border-slate-700 hover:bg-slate-700'}`}
                  >
                    {r}
                  </button>
                ))}
              </div>
            </>
          )}

          {!isAdmin && (
            <div className="mb-3">
              <label className="text-sm text-slate-400">Yönetici şifresi</label>
              <input
                type="password"
                value={cancelPwd}
                onChange={(e) => setCancelPwd(e.target.value)}
                placeholder="Yetkili onayı"
                className="w-full h-11 mt-1 rounded-xl bg-slate-800 border border-slate-700 px-3 outline-none focus:border-amber-500"
              />
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <button onClick={() => setCancelCtx(null)} disabled={busy} className="h-12 rounded-xl bg-slate-700 hover:bg-slate-600 font-semibold">Vazgeç</button>
            <button onClick={confirmCancelItem} disabled={busy || (ff('askCancelReason') && !cancelReason) || (!isAdmin && !cancelPwd)} className="h-12 rounded-xl bg-rose-600 hover:bg-rose-500 font-bold flex items-center justify-center gap-2 disabled:opacity-50">
              {busy ? <Loader2 className="animate-spin" size={18} /> : <Trash2 size={18} />} Onayla
            </button>
          </div>
        </Modal>
      )}

      {/* ── Masa birleştirme onayı (floor drag-drop) ── */}
      {mergeCtx && (
        <Modal title="Masaları Birleştir" onClose={() => setMergeCtx(null)}>
          <p className="text-slate-300 mb-4">
            <b>Masa {mergeCtx.source.tableNo}</b> adisyonu <b>Masa {mergeCtx.target.tableNo}</b>
            {mergeCtx.target.status === 'Dolu' ? ' hesabına aktarılacak (birleştirme).' : ' masasına taşınacak.'}
          </p>
          <div className="grid grid-cols-2 gap-3">
            <button onClick={() => setMergeCtx(null)} disabled={busy} className="h-12 rounded-xl bg-slate-700 hover:bg-slate-600 font-semibold">Vazgeç</button>
            <button onClick={confirmMerge} disabled={busy} className="h-12 rounded-xl bg-sky-600 hover:bg-sky-500 font-bold flex items-center justify-center gap-2 disabled:opacity-60">
              {busy ? <Loader2 className="animate-spin" size={18} /> : <ArrowRightLeft size={18} />} Birleştir
            </button>
          </div>
        </Modal>
      )}

      {/* ── Ürün taşıma modalı (seçili kalemleri başka masaya) ── */}
      {moveOpen && order && (
        <Modal title="Ürün Taşı — kalem seç + hedef masa" onClose={() => setMoveOpen(false)}>
          <div className="space-y-2 max-h-[40vh] overflow-y-auto mb-3">
            {order.items.filter((i) => !i.paid).map((it) => {
              const on = moveSel.has(it.itemId);
              return (
                <button key={it.itemId} onClick={() => setMoveSel((s) => { const n = new Set(s); if (n.has(it.itemId)) n.delete(it.itemId); else n.add(it.itemId); return n; })}
                  className={`w-full flex items-center gap-2 rounded-xl border px-3 py-2 text-left ${on ? 'border-sky-500 bg-sky-500/10' : 'border-slate-700 bg-slate-800'}`}>
                  <span className={`h-5 w-5 grid place-items-center rounded ${on ? 'bg-sky-500' : 'bg-slate-700'}`}>{on && <Check size={14} />}</span>
                  <span className="flex-1 truncate">{it.name} <span className="text-slate-400 text-sm">×{it.quantity}</span></span>
                  <span className="text-amber-400 font-semibold text-sm">{fmtTL(it.unitPrice * it.quantity)}</span>
                </button>
              );
            })}
          </div>
          <label className="text-sm text-slate-400">Hedef masa</label>
          <select value={moveTarget} onChange={(e) => setMoveTarget(e.target.value)} className="w-full h-11 mt-1 mb-3 rounded-xl bg-slate-800 border border-slate-700 px-3 outline-none focus:border-sky-500">
            <option value="">Masa seçin…</option>
            {sections.flatMap((s) => (s.tables || []).filter((t) => t.tableId !== activeTable?.tableId).map((t) => (
              <option key={t.tableId} value={t.tableId}>Masa {t.tableNo} ({t.status})</option>
            )))}
          </select>
          <button onClick={doMoveItems} disabled={busy || moveSel.size === 0 || !moveTarget} className="w-full h-12 rounded-xl bg-sky-600 hover:bg-sky-500 font-bold flex items-center justify-center gap-2 disabled:opacity-40">
            {busy ? <Loader2 className="animate-spin" size={18} /> : <ArrowRightLeft size={18} />} {moveSel.size > 0 ? `${moveSel.size} kalemi taşı` : 'Taşı'}
          </button>
        </Modal>
      )}

      {/* ── Diskret güç/kapat ikonu (sol alt köşe, yalnız masaüstü) ── */}
      {window.bayraktarDesktop?.isDesktop && (
        <button
          onClick={() => setExitOpen(true)}
          title="Uygulamayı kapat"
          className="fixed bottom-3 left-3 z-40 h-10 w-10 grid place-items-center rounded-full bg-slate-800/60 hover:bg-rose-700/80 text-slate-400 hover:text-white border border-slate-700/60 transition-colors"
        >
          <Power size={18} />
        </button>
      )}

      {/* Yazdırma alanı (ekranda gizli) */}
      <RestaurantPrint job={printJob} company={company} />
    </div>
  );
}

function Row({ label, value }) {
  return <div className="flex items-center justify-between"><span className="text-slate-400">{label}</span><span className="font-bold">{value}</span></div>;
}

// Masa süre takibi: server'dan gelen açılış dakikası (tz-güvenli) + mount'tan beri geçen.
// 30sn'de bir tazelenir. 60dk+ amber, 120dk+ kırmızı (camping uyarısı).
function TableTimer({ baseMinutes }) {
  const [extra, setExtra] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setExtra((e) => e + 1), 60000);
    return () => clearInterval(id);
  }, []);
  const mins = Math.max(0, (Number(baseMinutes) || 0) + extra);
  const h = Math.floor(mins / 60), m = mins % 60;
  const label = h > 0 ? `${h}s ${m}dk` : `${m}dk`;
  const color = mins >= 120 ? 'text-rose-300' : mins >= 60 ? 'text-amber-300' : 'opacity-70';
  return <span className={`text-[11px] font-semibold flex items-center gap-1 ${color}`}><Clock size={11} /> {label}</span>;
}

// ── Özelleştirme aç/kapa anahtarı (sade toggle satırı) ──────────────────────
function FeatureToggle({ label, hint, on, onToggle }) {
  return (
    <button type="button" onClick={onToggle}
      className="w-full flex items-center justify-between h-11 px-3 rounded-xl bg-slate-800 border border-slate-700 hover:bg-slate-700">
      <span className="text-left">
        <span className="font-semibold block">{label}</span>
        {hint && <span className="text-[11px] text-slate-500 block leading-tight">{hint}</span>}
      </span>
      <span className={`h-6 w-11 rounded-full relative transition-colors shrink-0 ml-2 ${on ? 'bg-emerald-500' : 'bg-slate-600'}`}>
        <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${on ? 'right-0.5' : 'left-0.5'}`} />
      </span>
    </button>
  );
}

// ── Basit modal kabuğu ─────────────────────────────────────────────────────
function Modal({ title, children, onClose }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div className="w-full max-w-md bg-slate-900 border border-slate-700 rounded-2xl p-5 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-bold text-lg">{title}</h3>
          <button onClick={onClose} className="h-9 w-9 grid place-items-center rounded-lg bg-slate-800 hover:bg-slate-700"><X size={20} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ── Personel / Garson yönetimi (Admin) — mevcut /api/users üzerinden ─────────
// Garson = Teknisyen rolü + use_restaurant yetkisi. Yönetici = Admin (tam yetki).
// Kullanıcı (seat) lisans limiti + son-yönetici koruması server tarafında zorlanır;
// 409/400 mesajları kullanıcıya gösterilir. Şef bağımsız üründe garson hesapları
// buradan açılır (ERP UserManagement ekranına gerek kalmadan).
export function StaffModal({ onClose }) {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ fullName: '', username: '', password: '', pin: '', isManager: false });
  const [pwFor, setPwFor] = useState(null);
  const [pwVal, setPwVal] = useState('');
  const [pinFor, setPinFor] = useState(null);
  const [pinVal, setPinVal] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/users');
      setUsers(Array.isArray(data) ? data : []);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Personel listesi alınamadı.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const roleLabel = (u) => (u.Role === 'Admin' ? 'Yönetici' : 'Garson');

  const addStaff = async () => {
    const fullName = form.fullName.trim();
    const username = form.username.trim();
    if (!fullName || !username || !form.password) { toast.error('Ad soyad, kullanıcı adı ve şifre zorunlu.'); return; }
    if (form.password.length < 6) { toast.error('Şifre en az 6 karakter olmalı.'); return; }
    const pin = form.pin.trim();
    if (pin && !/^\d{4,8}$/.test(pin)) { toast.error('PIN 4-8 rakam olmalı.'); return; }
    setSaving(true);
    try {
      await api.post('/users', {
        fullName,
        username,
        password: form.password,
        pin: pin || undefined,
        role: form.isManager ? 'Admin' : 'Teknisyen',
        permissions: form.isManager ? [] : ['use_restaurant'],
      });
      toast.success('Personel eklendi.');
      setForm({ fullName: '', username: '', password: '', pin: '', isManager: false });
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Personel eklenemedi.');
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (u) => {
    try {
      await api.put(`/users/${u.UserID}`, { isActive: !u.IsActive });
      toast.success(u.IsActive ? 'Pasife alındı.' : 'Aktifleştirildi.');
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'İşlem başarısız.');
    }
  };

  const savePw = async () => {
    if (!pwVal || pwVal.length < 6) { toast.error('Şifre en az 6 karakter olmalı.'); return; }
    try {
      await api.put(`/users/${pwFor.UserID}`, { password: pwVal });
      toast.success('Şifre güncellendi.');
      setPwFor(null); setPwVal('');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Şifre güncellenemedi.');
    }
  };

  const savePin = async () => {
    const v = pinVal.trim();
    if (v && !/^\d{4,8}$/.test(v)) { toast.error('PIN 4-8 rakam olmalı.'); return; }
    try {
      await api.put(`/users/${pinFor.UserID}`, { pin: v }); // '' → PIN kaldır
      toast.success(v ? 'PIN güncellendi.' : 'PIN kaldırıldı.');
      setPinFor(null); setPinVal('');
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'PIN güncellenemedi.');
    }
  };

  return (
    <Modal title="Personel (Garson) Yönetimi" onClose={onClose}>
      <div className="space-y-2 mb-4">
        <input value={form.fullName} onChange={(e) => setForm((f) => ({ ...f, fullName: e.target.value }))} placeholder="Ad Soyad" className="w-full h-11 rounded-xl bg-slate-800 border border-slate-700 px-3 outline-none focus:border-amber-500" />
        <div className="grid grid-cols-2 gap-2">
          <input value={form.username} onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))} placeholder="Kullanıcı adı" autoCapitalize="none" autoCorrect="off" className="h-11 rounded-xl bg-slate-800 border border-slate-700 px-3 outline-none focus:border-amber-500" />
          <input value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} type="password" placeholder="Şifre (min 6)" className="h-11 rounded-xl bg-slate-800 border border-slate-700 px-3 outline-none focus:border-amber-500" />
        </div>
        <input value={form.pin} onChange={(e) => setForm((f) => ({ ...f, pin: e.target.value.replace(/\D/g, '') }))} inputMode="numeric" maxLength={8} placeholder="Dokunmatik PIN (4-8 rakam, opsiyonel)" className="w-full h-11 rounded-xl bg-slate-800 border border-slate-700 px-3 outline-none focus:border-amber-500" />
        <label className="flex items-center gap-2 text-sm text-slate-300 select-none">
          <input type="checkbox" checked={form.isManager} onChange={(e) => setForm((f) => ({ ...f, isManager: e.target.checked }))} className="h-4 w-4 accent-amber-500" />
          Yönetici (tam yetki) — işaretsiz = garson (yalnız restoran)
        </label>
        <button onClick={addStaff} disabled={saving} className="w-full h-11 rounded-xl bg-emerald-600 hover:bg-emerald-500 font-bold flex items-center justify-center gap-2 disabled:opacity-60">
          {saving ? <Loader2 className="animate-spin" size={18} /> : <UserPlus size={18} />} Personel Ekle
        </button>
      </div>

      <div className="border-t border-slate-700 pt-3">
        {loading ? (
          <div className="py-6 flex items-center justify-center text-slate-400"><Loader2 className="animate-spin mr-2" size={18} /> Yükleniyor…</div>
        ) : users.length === 0 ? (
          <p className="text-center text-slate-400 py-4 text-sm">Henüz personel yok.</p>
        ) : (
          <ul className="space-y-2">
            {users.map((u) => (
              <li key={u.UserID} className={`rounded-xl border px-3 py-2 ${u.IsActive ? 'border-slate-700 bg-slate-800/50' : 'border-slate-800 bg-slate-900 opacity-60'}`}>
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-semibold truncate">{u.FullName} {!u.IsActive && <span className="text-xs text-rose-400">(pasif)</span>}</div>
                    <div className="text-xs text-slate-400 truncate">@{u.Username} · {roleLabel(u)} · {u.HasPin ? <span className="text-emerald-400">PIN ✓</span> : <span className="text-slate-500">PIN yok</span>}</div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button onClick={() => { setPinFor(u); setPinVal(''); setPwFor(null); }} className="h-9 px-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-xs font-semibold" title="PIN ayarla/sıfırla">PIN</button>
                    <button onClick={() => { setPwFor(u); setPwVal(''); setPinFor(null); }} className="h-9 px-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-xs font-semibold" title="Şifre sıfırla">Şifre</button>
                    <button onClick={() => toggleActive(u)} className={`h-9 px-2 rounded-lg text-xs font-semibold ${u.IsActive ? 'bg-rose-600/80 hover:bg-rose-600' : 'bg-emerald-600/80 hover:bg-emerald-600'}`}>
                      {u.IsActive ? 'Pasife Al' : 'Aktifleştir'}
                    </button>
                  </div>
                </div>
                {pwFor?.UserID === u.UserID && (
                  <div className="mt-2 flex items-center gap-2">
                    <input value={pwVal} onChange={(e) => setPwVal(e.target.value)} type="password" placeholder="Yeni şifre (min 6)" className="flex-1 h-10 rounded-lg bg-slate-900 border border-slate-700 px-3 outline-none focus:border-amber-500" />
                    <button onClick={savePw} className="h-10 px-3 rounded-lg bg-amber-600 hover:bg-amber-500 font-bold text-sm">Kaydet</button>
                    <button onClick={() => { setPwFor(null); setPwVal(''); }} className="h-10 px-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-sm">İptal</button>
                  </div>
                )}
                {pinFor?.UserID === u.UserID && (
                  <div className="mt-2 flex items-center gap-2">
                    <input value={pinVal} onChange={(e) => setPinVal(e.target.value.replace(/\D/g, ''))} inputMode="numeric" maxLength={8} placeholder="Yeni PIN (4-8 rakam, boş=kaldır)" className="flex-1 h-10 rounded-lg bg-slate-900 border border-slate-700 px-3 outline-none focus:border-amber-500" />
                    <button onClick={savePin} className="h-10 px-3 rounded-lg bg-amber-600 hover:bg-amber-500 font-bold text-sm">Kaydet</button>
                    <button onClick={() => { setPinFor(null); setPinVal(''); }} className="h-10 px-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-sm">İptal</button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}

// ── Terminal (cihaz) ayarları — garson terminali kilidi (localStorage) ───────
export function TerminalModal({ onClose }) {
  const [waiter, setWaiter] = useState(() => isWaiterTerminal());

  const toggle = (on) => {
    setWaiter(on);
    setWaiterTerminal(on);
    toast.success(on ? 'Bu cihaz garson terminali olarak işaretlendi.' : 'Garson terminali işareti kaldırıldı.');
  };

  return (
    <Modal title="Terminal Ayarları (Bu Cihaz)" onClose={onClose}>
      <p className="text-xs text-slate-400 mb-4">
        Ayarlar yalnızca <b>bu cihaza</b> kaydedilir (sunucuya gitmez).
      </p>
      <button
        type="button"
        onClick={() => toggle(!waiter)}
        className={`w-full flex items-center justify-between gap-3 rounded-xl border px-4 py-3 transition-colors ${waiter ? 'border-amber-500 bg-amber-500/10' : 'border-slate-700 bg-slate-800/50'}`}
      >
        <span className="flex items-center gap-3 text-left">
          <Lock size={20} className={waiter ? 'text-amber-400' : 'text-slate-400'} />
          <span>
            <span className="block font-semibold">Garson terminali (otomatik kilit)</span>
            <span className="block text-xs text-slate-400">Sipariş gönderildiğinde veya masalara dönüldüğünde oturum kapanır → PIN ekranı.</span>
          </span>
        </span>
        <span className={`shrink-0 w-12 h-7 rounded-full p-1 transition-colors ${waiter ? 'bg-amber-500' : 'bg-slate-600'}`}>
          <span className={`block w-5 h-5 rounded-full bg-white transition-transform ${waiter ? 'translate-x-5' : ''}`} />
        </span>
      </button>
      <p className="text-xs text-slate-500 mt-3">
        Ana kasada (host) bu seçeneği <b>kapalı</b> bırakın → kasa masa planında kalır.
      </p>
    </Modal>
  );
}

// ── Güvenli kapatma onayı (klavyesiz dokunmatik kiosk) ───────────────────────
export function ExitModal({ onClose }) {
  const [busy, setBusy] = useState(false);
  const doQuit = async () => {
    setBusy(true);
    try {
      await window.bayraktarDesktop?.quitApp?.();
    } catch {
      setBusy(false);
      toast.error('Kapatılamadı.');
    }
  };
  return (
    <Modal title="Uygulamayı Kapat" onClose={onClose}>
      <div className="flex items-start gap-3 mb-5">
        <div className="h-11 w-11 shrink-0 grid place-items-center rounded-full bg-rose-600/20 text-rose-400"><Power size={22} /></div>
        <p className="text-slate-300 pt-1">ArcTeknik Şef uygulamasını kapatmak istediğinize emin misiniz?</p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <button onClick={onClose} disabled={busy} className="h-12 rounded-xl bg-slate-700 hover:bg-slate-600 font-semibold">Vazgeç</button>
        <button onClick={doQuit} disabled={busy} className="h-12 rounded-xl bg-rose-600 hover:bg-rose-500 font-bold flex items-center justify-center gap-2 disabled:opacity-60">
          {busy ? <Loader2 className="animate-spin" size={18} /> : <Power size={18} />} Kapat
        </button>
      </div>
    </Modal>
  );
}

// ── Yazıcı eşleme (sessiz yazdırma) — terminal başına, localStorage ──────────
// Her hedef (Mutfak/Bar/Kasa) → bu cihazdaki FİZİKSEL yazıcı. Hesap & Z fişi
// "Kasa" hedefine, mutfak/bar sipariş fişleri ilgili hedefe basılır. "Varsayılan"
// eşlemesi, ayrı tanımlanmamış hedefler için yedektir ('' = OS varsayılanı).
export function PrinterSetupModal({ menu, onClose }) {
  const [regTargets, setRegTargets] = useState([]); // yazıcı defterinden
  const TARGETS = useMemo(() => {
    // Çoklu hedef ('Kasa;Pide') tek tek yazıcılara ayrılır → her biri eşleme satırı alır.
    const fromMenu = (menu || []).flatMap((c) => String(c.printerTarget || '').split(';').map((x) => x.trim()).filter(Boolean));
    return Array.from(new Set(['Kasa', 'Mutfak', 'Bar', ...regTargets, ...fromMenu]));
  }, [menu, regTargets]);

  const [printers, setPrinters] = useState([]);
  const [loading, setLoading] = useState(true);
  const [map, setMap] = useState(() => getPrinterMap());

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const list = await window.bayraktarDesktop.listPrinters();
        if (alive) setPrinters(Array.isArray(list) ? list : []);
      } catch {
        if (alive) setPrinters([]);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    // Yazıcı defterindeki hedef adları (Fırın, Ocakbaşı…) eşleme satırlarına eklensin.
    api.get('/restoran/printers')
      .then(({ data }) => { if (alive) setRegTargets((data.printers || []).map((p) => p.name)); })
      .catch(() => { /* */ });
    return () => { alive = false; };
  }, []);

  const setTarget = (key, name) => setMap((m) => ({ ...m, [key]: name }));

  const save = () => {
    // Boş seçimleri eşlemeden çıkar (OS varsayılanına düşsün).
    const clean = {};
    for (const [k, v] of Object.entries(map)) if (v) clean[k] = v;
    setPrinterMap(clean);
    toast.success('Yazıcı eşlemesi kaydedildi.');
    onClose();
  };

  const PrinterSelect = ({ label, hint, mapKey }) => (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-sm font-semibold">{label}</span>
        {hint && <span className="text-xs text-slate-500">{hint}</span>}
      </div>
      <select
        value={map[mapKey] || ''}
        onChange={(e) => setTarget(mapKey, e.target.value)}
        className="w-full h-11 rounded-xl bg-slate-800 border border-slate-700 px-3 outline-none focus:border-amber-500"
      >
        <option value="">Sistem varsayılanı</option>
        {printers.map((p) => (
          <option key={p.name} value={p.name}>
            {p.displayName || p.name}{p.isDefault ? ' (varsayılan)' : ''}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <Modal title="Yazıcı Eşleme (Sessiz Yazdırma)" onClose={onClose}>
      <p className="text-xs text-slate-400 mb-3">
        Her hedef için bu cihazdaki yazıcıyı seçin. Eşleme yalnızca bu terminale kaydedilir.
        Tanımlı yazıcı varsa fişler Windows yazdırma penceresi açılmadan doğrudan basılır.
      </p>

      {loading ? (
        <div className="py-8 flex items-center justify-center text-slate-400"><Loader2 className="animate-spin mr-2" size={18} /> Yazıcılar yükleniyor…</div>
      ) : printers.length === 0 ? (
        <div className="py-6 text-center text-amber-300 text-sm">
          Yüklü yazıcı bulunamadı. Windows'ta yazıcıyı ekleyip yeniden deneyin.
        </div>
      ) : (
        <div className="space-y-3">
          <PrinterSelect label="Kasa (hesap & Z fişi)" hint="hesap fişi" mapKey="Kasa" />
          {TARGETS.filter((t) => t !== 'Kasa').map((t) => (
            <PrinterSelect key={t} label={`${t} (sipariş fişi)`} hint="mutfak/bar" mapKey={t} />
          ))}
          <div className="border-t border-slate-700 pt-3">
            <PrinterSelect label="Varsayılan (eşlenmemiş hedefler)" hint="yedek" mapKey="_default" />
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 mt-5">
        <button onClick={onClose} className="h-12 rounded-xl bg-slate-700 hover:bg-slate-600 font-bold">Vazgeç</button>
        <button onClick={save} disabled={loading} className="h-12 rounded-xl bg-emerald-600 hover:bg-emerald-500 font-extrabold disabled:opacity-40 flex items-center justify-center gap-2"><Check size={18} /> Kaydet</button>
      </div>
    </Modal>
  );
}

// ── Rezervasyon modalı (gün takvimi + yeni kayıt + durum) ────────────────────
const RES_STATUS_STYLE = {
  'Bekliyor': 'bg-amber-500/20 text-amber-200 border-amber-500/50',
  'Geldi': 'bg-emerald-500/20 text-emerald-200 border-emerald-500/50',
  'İptal': 'bg-slate-600/40 text-slate-300 border-slate-600',
  'No-Show': 'bg-rose-500/20 text-rose-200 border-rose-500/50',
};

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function ReservationsModal({ sections, onClose }) {
  const allTables = useMemo(
    () => (sections || []).flatMap((s) => (s.tables || []).map((t) => ({ ...t, sectionName: s.name }))),
    [sections]
  );

  const [date, setDate] = useState(todayStr());
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ customerName: '', customerPhone: '', guestCount: '2', tableId: '', time: '19:00', durationMin: '120', note: '' });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/restoran/reservations', { params: { date } });
      setList(Array.isArray(data) ? data : []);
    } catch {
      toast.error('Rezervasyonlar yüklenemedi.');
    } finally {
      setLoading(false);
    }
  }, [date]);

  useEffect(() => { load(); }, [load]);

  const create = async () => {
    const name = form.customerName.trim();
    if (!name) return toast.error('Müşteri adı gerekli.');
    if (!/^\d{2}:\d{2}$/.test(form.time)) return toast.error('Saat formatı HH:MM olmalı.');
    setBusy(true);
    try {
      // Yerel zaman (Z'siz) gönder — sunucu aynı makinede aynı saat diliminde çözer.
      await api.post('/restoran/reservations', {
        customerName: name,
        customerPhone: form.customerPhone.trim() || null,
        guestCount: parseInt(form.guestCount, 10) || 2,
        tableId: form.tableId ? parseInt(form.tableId, 10) : null,
        reservedAt: `${date}T${form.time}:00`,
        durationMin: parseInt(form.durationMin, 10) || 120,
        note: form.note.trim() || null,
      });
      toast.success('Rezervasyon eklendi.');
      setForm({ customerName: '', customerPhone: '', guestCount: '2', tableId: '', time: '19:00', durationMin: '120', note: '' });
      setShowForm(false);
      load();
    } catch (e) {
      toast.error(e?.response?.data?.error || 'Rezervasyon eklenemedi.');
    } finally {
      setBusy(false);
    }
  };

  const setStatus = async (id, status) => {
    try {
      await api.patch(`/restoran/reservations/${id}`, { status });
      setList((xs) => xs.map((r) => (r.reservationId === id ? { ...r, status } : r)));
    } catch {
      toast.error('Durum güncellenemedi.');
    }
  };

  const remove = async (id) => {
    try {
      await api.delete(`/restoran/reservations/${id}`);
      setList((xs) => xs.filter((r) => r.reservationId !== id));
    } catch {
      toast.error('Silinemedi.');
    }
  };

  const fmtTime = (iso) => new Date(iso).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });

  return (
    <Modal title="Rezervasyonlar" onClose={onClose}>
      <div className="flex items-center gap-2 mb-3">
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
          className="h-11 flex-1 rounded-xl bg-slate-800 border border-slate-700 px-3 outline-none focus:border-indigo-500" />
        <button onClick={() => setShowForm((v) => !v)} className="h-11 px-4 rounded-xl bg-indigo-600 hover:bg-indigo-500 font-bold flex items-center gap-2">
          <Plus size={18} /> Yeni
        </button>
      </div>

      {showForm && (
        <div className="mb-4 p-3 rounded-xl bg-slate-800/60 border border-slate-700 space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <input value={form.customerName} onChange={(e) => setForm({ ...form, customerName: e.target.value })} placeholder="Müşteri adı *" className="h-11 rounded-xl bg-slate-800 border border-slate-700 px-3 outline-none focus:border-indigo-500" />
            <input value={form.customerPhone} onChange={(e) => setForm({ ...form, customerPhone: e.target.value })} placeholder="Telefon" inputMode="tel" className="h-11 rounded-xl bg-slate-800 border border-slate-700 px-3 outline-none focus:border-indigo-500" />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="text-xs text-slate-400">Saat</label>
              <input type="time" value={form.time} onChange={(e) => setForm({ ...form, time: e.target.value })} className="w-full h-11 rounded-xl bg-slate-800 border border-slate-700 px-2 outline-none focus:border-indigo-500" />
            </div>
            <div>
              <label className="text-xs text-slate-400">Kişi</label>
              <input value={form.guestCount} onChange={(e) => setForm({ ...form, guestCount: e.target.value })} inputMode="numeric" className="w-full h-11 rounded-xl bg-slate-800 border border-slate-700 px-3 text-center outline-none focus:border-indigo-500" />
            </div>
            <div>
              <label className="text-xs text-slate-400">Süre (dk)</label>
              <input value={form.durationMin} onChange={(e) => setForm({ ...form, durationMin: e.target.value })} inputMode="numeric" className="w-full h-11 rounded-xl bg-slate-800 border border-slate-700 px-3 text-center outline-none focus:border-indigo-500" />
            </div>
          </div>
          <select value={form.tableId} onChange={(e) => setForm({ ...form, tableId: e.target.value })} className="w-full h-11 rounded-xl bg-slate-800 border border-slate-700 px-3 outline-none focus:border-indigo-500">
            <option value="">Masa (opsiyonel)</option>
            {allTables.map((t) => (
              <option key={t.tableId} value={t.tableId}>{t.sectionName} · Masa {t.tableNo}</option>
            ))}
          </select>
          <input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="Not (opsiyonel)" className="w-full h-11 rounded-xl bg-slate-800 border border-slate-700 px-3 outline-none focus:border-indigo-500" />
          <button onClick={create} disabled={busy} className="w-full h-11 rounded-xl bg-emerald-600 hover:bg-emerald-500 font-extrabold disabled:opacity-40 flex items-center justify-center gap-2">
            <Check size={18} /> Kaydet
          </button>
        </div>
      )}

      {loading ? (
        <div className="py-8 flex items-center justify-center text-slate-400"><Loader2 className="animate-spin mr-2" size={18} /> Yükleniyor…</div>
      ) : list.length === 0 ? (
        <p className="text-center text-slate-400 py-6">Bu güne ait rezervasyon yok.</p>
      ) : (
        <div className="space-y-2 max-h-[50vh] overflow-y-auto">
          {list.map((r) => (
            <div key={r.reservationId} className="p-3 rounded-xl bg-slate-800 border border-slate-700">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="flex items-center gap-1 font-extrabold text-indigo-300"><CalendarClock size={16} /> {fmtTime(r.reservedAt)}</span>
                  <span className="font-bold truncate">{r.customerName}</span>
                </div>
                <span className={`text-xs px-2 py-0.5 rounded-full border ${RES_STATUS_STYLE[r.status] || 'bg-slate-700 border-slate-600'}`}>{r.status}</span>
              </div>
              <div className="text-xs text-slate-400 mt-1 flex flex-wrap gap-x-3">
                <span className="flex items-center gap-1"><Users size={12} /> {r.guestCount} kişi</span>
                {r.tableNo ? <span>{r.sectionName ? `${r.sectionName} · ` : ''}Masa {r.tableNo}</span> : <span>Masa atanmadı</span>}
                {r.customerPhone ? <span>{r.customerPhone}</span> : null}
              </div>
              {r.note ? <div className="text-xs text-slate-400 italic mt-1">» {r.note}</div> : null}
              <div className="flex items-center gap-1.5 mt-2">
                <button onClick={() => setStatus(r.reservationId, 'Geldi')} className="flex-1 h-8 rounded-lg bg-emerald-600/80 hover:bg-emerald-500 text-xs font-bold">Geldi</button>
                <button onClick={() => setStatus(r.reservationId, 'No-Show')} className="flex-1 h-8 rounded-lg bg-rose-600/70 hover:bg-rose-500 text-xs font-bold">Gelmedi</button>
                <button onClick={() => setStatus(r.reservationId, 'İptal')} className="flex-1 h-8 rounded-lg bg-slate-700 hover:bg-slate-600 text-xs font-bold">İptal</button>
                <button onClick={() => remove(r.reservationId)} title="Sil" className="h-8 w-8 grid place-items-center rounded-lg bg-slate-700 hover:bg-rose-600"><Trash2 size={14} /></button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

// ── Raporlar modalı (tarih aralığı: ciro/ürün/garson/saatlik) ────────────────
function fmtDateLocal(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function ReportsModal({ onClose }) {
  const [from, setFrom] = useState(todayStr());
  const [to, setTo] = useState(todayStr());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/restoran/reports', { params: { from, to } });
      setData(data);
    } catch (e) {
      toast.error(e?.response?.data?.error || 'Rapor alınamadı.');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => { load(); }, [load]);

  const preset = (kind) => {
    const now = new Date();
    if (kind === 'today') { setFrom(todayStr()); setTo(todayStr()); }
    else if (kind === 'yesterday') { const y = new Date(now); y.setDate(now.getDate() - 1); const s = fmtDateLocal(y); setFrom(s); setTo(s); }
    else if (kind === 'week') { const a = new Date(now); a.setDate(now.getDate() - 6); setFrom(fmtDateLocal(a)); setTo(todayStr()); }
    else if (kind === 'month') { const a = new Date(now.getFullYear(), now.getMonth(), 1); setFrom(fmtDateLocal(a)); setTo(todayStr()); }
  };

  const t = data?.totals;
  const maxQty = Math.max(1, ...(data?.topProducts || []).map((p) => p.qty));
  const maxHour = Math.max(1, ...(data?.hourly || []).map((h) => h.revenue));

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div className="w-full max-w-3xl bg-slate-900 border border-slate-700 rounded-2xl p-5 max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-bold text-lg flex items-center gap-2"><TrendingUp size={20} /> Raporlar</h3>
          <button onClick={onClose} className="h-9 w-9 grid place-items-center rounded-lg bg-slate-800 hover:bg-slate-700"><X size={20} /></button>
        </div>

        {/* Tarih aralığı + hazır filtreler */}
        <div className="flex flex-wrap items-end gap-2 mb-4">
          <div>
            <label className="text-xs text-slate-400">Başlangıç</label>
            <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className="block h-10 rounded-xl bg-slate-800 border border-slate-700 px-3 outline-none focus:border-amber-500" />
          </div>
          <div>
            <label className="text-xs text-slate-400">Bitiş</label>
            <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} className="block h-10 rounded-xl bg-slate-800 border border-slate-700 px-3 outline-none focus:border-amber-500" />
          </div>
          <div className="flex gap-1.5 ml-auto">
            {[['today', 'Bugün'], ['yesterday', 'Dün'], ['week', '7 Gün'], ['month', 'Bu Ay']].map(([k, label]) => (
              <button key={k} onClick={() => preset(k)} className="h-10 px-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-sm font-semibold">{label}</button>
            ))}
          </div>
        </div>

        {loading ? (
          <div className="py-12 flex items-center justify-center text-slate-400"><Loader2 className="animate-spin mr-2" size={20} /> Hesaplanıyor…</div>
        ) : !t ? (
          <p className="text-center text-slate-400 py-10">Veri yok.</p>
        ) : (
          <div className="space-y-5">
            {/* Özet kartları */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <StatCard label="Ciro" value={fmtTL(t.revenue)} accent="text-amber-400" />
              <StatCard label="Adisyon" value={t.orders} />
              <StatCard label="Ort. Adisyon" value={fmtTL(t.avgTicket)} />
              <StatCard label="Kişi Başı" value={fmtTL(t.avgPerGuest)} />
            </div>
            <div className="grid grid-cols-3 gap-2">
              <StatCard label="Nakit" value={fmtTL(t.cash)} accent="text-emerald-400" small />
              <StatCard label="Kredi Kartı" value={fmtTL(t.card)} accent="text-sky-400" small />
              <StatCard label="Yemek Fişi" value={fmtTL(t.ticket)} accent="text-fuchsia-400" small />
            </div>
            {t.cost > 0 && (
              <div className="grid grid-cols-2 gap-2">
                <StatCard label="Reçete Maliyeti (tahmini)" value={fmtTL(t.cost)} accent="text-rose-400" small />
                <StatCard label="Brüt Kâr (tahmini)" value={fmtTL(t.grossProfit)} accent="text-emerald-400" small />
              </div>
            )}

            {/* En çok satan ürünler */}
            <div>
              <h4 className="font-bold mb-2 text-slate-200">En Çok Satan Ürünler</h4>
              {data.topProducts.length === 0 ? (
                <p className="text-sm text-slate-500">Kayıt yok.</p>
              ) : (
                <div className="space-y-1.5">
                  {data.topProducts.map((p, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <span className="w-40 truncate text-sm">{p.name}</span>
                      <div className="flex-1 h-5 rounded bg-slate-800 overflow-hidden">
                        <div className="h-full bg-amber-500/70" style={{ width: `${Math.round((p.qty / maxQty) * 100)}%` }} />
                      </div>
                      <span className="w-10 text-right text-sm font-bold">{p.qty}</span>
                      <span className="w-24 text-right text-xs text-slate-400">{fmtTL(p.revenue)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Garson performansı */}
            <div>
              <h4 className="font-bold mb-2 text-slate-200">Garson Performansı</h4>
              {data.byWaiter.length === 0 ? (
                <p className="text-sm text-slate-500">Kayıt yok.</p>
              ) : (
                <div className="space-y-1">
                  {data.byWaiter.map((w, i) => (
                    <div key={i} className="flex items-center justify-between p-2 rounded-lg bg-slate-800">
                      <span className="font-semibold text-sm">{w.name}</span>
                      <span className="text-sm text-slate-400">{w.orders} adisyon · <span className="font-bold text-amber-400">{fmtTL(w.revenue)}</span></span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Saatlik yoğunluk */}
            {data.hourly.length > 0 && (
              <div>
                <h4 className="font-bold mb-2 text-slate-200">Saatlik Ciro</h4>
                <div className="flex items-end gap-1 h-28">
                  {data.hourly.map((h) => (
                    <div key={h.hour} className="flex-1 flex flex-col items-center justify-end" title={`${h.hour}:00 — ${fmtTL(h.revenue)} (${h.count})`}>
                      <div className="w-full bg-sky-500/70 rounded-t" style={{ height: `${Math.max(4, Math.round((h.revenue / maxHour) * 100))}%` }} />
                      <span className="text-[10px] text-slate-500 mt-0.5">{h.hour}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Günlük dağılım (aralık > 1 gün) */}
            {data.daily.length > 1 && (
              <div>
                <h4 className="font-bold mb-2 text-slate-200">Günlük Ciro</h4>
                <div className="space-y-1">
                  {data.daily.map((d, i) => (
                    <div key={i} className="flex items-center justify-between text-sm p-1.5 rounded bg-slate-800/60">
                      <span className="text-slate-300">{new Date(d.date).toLocaleDateString('tr-TR')}</span>
                      <span><span className="text-slate-500 mr-2">{d.orders} ödeme</span><span className="font-bold text-amber-400">{fmtTL(d.revenue)}</span></span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({ label, value, accent, small }) {
  return (
    <div className="rounded-xl bg-slate-800 border border-slate-700 p-3">
      <div className="text-xs text-slate-400">{label}</div>
      <div className={`font-extrabold ${small ? 'text-base' : 'text-lg'} ${accent || 'text-slate-100'}`}>{value}</div>
    </div>
  );
}

// ── Reçete sekmesi (menü ürünü ↔ ERP hammadde; satışta opt-in stok düşümü) ────
// ── Yazıcı yönlendirme: yazıcı(lar) → çoklu kategori eşleme (Admin) ──────────
function PrinterRoutingTab({ catalog, reload }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [editId, setEditId] = useState(null);
  const [editName, setEditName] = useState('');
  const [sel, setSel] = useState(null); // { printerId, ids:Set } — düzenlenen eşleme

  const printers = catalog.printers || [];
  const categories = catalog.categories || [];
  // Çoklu hedef: 'Kasa;Pide' → ['Kasa','Pide']. Bir kategori birden çok yazıcıya bağlı olabilir.
  const targetsOf = (s) => String(s || '').split(';').map((x) => x.trim()).filter(Boolean);
  const idsFor = (pName) => new Set(categories.filter((c) => targetsOf(c.printerTarget).includes(pName)).map((c) => c.id));

  const addPrinter = async () => {
    const n = name.trim();
    if (!n) return;
    setBusy(true);
    try { await api.post('/restoran/printers', { name: n }); toast.success('Yazıcı eklendi.'); setName(''); reload(); }
    catch (e) { toast.error(e?.response?.data?.error || 'Eklenemedi.'); }
    finally { setBusy(false); }
  };
  const renamePrinter = async (id) => {
    const n = editName.trim();
    if (!n) return;
    try { await api.patch(`/restoran/printers/${id}`, { name: n }); toast.success('Yazıcı güncellendi.'); setEditId(null); reload(); }
    catch (e) { toast.error(e?.response?.data?.error || 'Güncellenemedi.'); }
  };
  const delPrinter = async (id) => {
    try { await api.delete(`/restoran/printers/${id}`); toast.success('Yazıcı silindi.'); reload(); }
    catch (e) { toast.error(e?.response?.data?.error || 'Silinemedi.'); }
  };
  const saveAssign = async (p) => {
    try {
      await api.post(`/restoran/printers/${p.id}/categories`, { categoryIds: [...sel.ids] });
      toast.success('Kategori eşlemesi kaydedildi.');
      setSel(null); reload();
    } catch (e) { toast.error(e?.response?.data?.error || 'Kaydedilemedi.'); }
  };

  return (
    <div className="space-y-4">
      <div>
        <label className="text-sm text-slate-400">Yeni Yazıcı (Mutfak-1, Ocakbaşı, Fırın, Bar…)</label>
        <div className="flex gap-2 mt-1">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Yazıcı adı" className="flex-1 h-11 rounded-xl bg-slate-800 border border-slate-700 px-3 outline-none focus:border-amber-500" />
          <button disabled={busy || !name.trim()} onClick={addPrinter} className="h-11 px-4 rounded-xl bg-amber-500 text-amber-950 font-bold disabled:opacity-40">Ekle</button>
        </div>
        <p className="text-xs text-slate-500 mt-1">Bir yazıcıya birden fazla kategori bağlayabilirsiniz. Aynı kategoriyi <b>birden fazla yazıcıya</b> da bağlayabilirsiniz (ör. içecekler hem Kasa hem Bar'a basılır). Fiziksel cihaz eşlemesi (sessiz yazdırma) "Terminal → Yazıcı Eşleme" ekranındadır.</p>
      </div>

      {printers.length === 0 ? (
        <p className="text-center text-slate-400 py-4 text-sm">Henüz yazıcı yok.</p>
      ) : (
        <div className="space-y-2">
          {printers.map((p) => {
            const bound = categories.filter((c) => targetsOf(c.printerTarget).includes(p.name));
            const editing = sel?.printerId === p.id;
            return (
              <div key={p.id} className="rounded-xl border border-slate-700 bg-slate-800/40 p-3">
                <div className="flex items-center gap-2">
                  <Printer size={16} className="text-slate-400 shrink-0" />
                  {editId === p.id ? (
                    <>
                      <input value={editName} onChange={(e) => setEditName(e.target.value)} className="flex-1 h-9 rounded-lg bg-slate-900 border border-slate-700 px-2 outline-none" />
                      <button onClick={() => renamePrinter(p.id)} className="h-9 px-3 rounded-lg bg-amber-600 hover:bg-amber-500 text-sm font-bold">Kaydet</button>
                      <button onClick={() => setEditId(null)} className="h-9 px-2 rounded-lg bg-slate-700 text-sm">İptal</button>
                    </>
                  ) : (
                    <>
                      <span className="flex-1 font-semibold truncate">{p.name}</span>
                      <button onClick={() => { setEditId(p.id); setEditName(p.name); }} className="h-8 px-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-xs">Yeniden Adlandır</button>
                      <button onClick={() => delPrinter(p.id)} className="h-8 w-8 grid place-items-center rounded-lg bg-slate-700 hover:bg-rose-600/80 text-slate-300"><Trash2 size={14} /></button>
                    </>
                  )}
                </div>

                <div className="mt-2 text-xs text-slate-400">
                  Bağlı kategoriler: {bound.length === 0 ? <span className="text-slate-500">yok</span> : bound.map((c) => c.name).join(', ')}
                </div>

                {editing ? (
                  <div className="mt-2">
                    <div className="grid grid-cols-2 gap-1 max-h-40 overflow-y-auto pr-1">
                      {categories.map((c) => (
                        <label key={c.id} className="flex items-center gap-2 text-sm rounded-lg bg-slate-900/60 px-2 py-1.5 cursor-pointer select-none">
                          <input
                            type="checkbox"
                            checked={sel.ids.has(c.id)}
                            onChange={(e) => setSel((s) => {
                              const ids = new Set(s.ids);
                              if (e.target.checked) ids.add(c.id); else ids.delete(c.id);
                              return { ...s, ids };
                            })}
                            className="h-4 w-4 accent-amber-500"
                          />
                          <span className="truncate">{c.name}</span>
                        </label>
                      ))}
                    </div>
                    <div className="flex gap-2 mt-2">
                      <button onClick={() => saveAssign(p)} className="flex-1 h-10 rounded-xl bg-emerald-600 hover:bg-emerald-500 font-bold text-sm">Eşlemeyi Kaydet</button>
                      <button onClick={() => setSel(null)} className="h-10 px-3 rounded-xl bg-slate-700 text-sm">İptal</button>
                    </div>
                  </div>
                ) : (
                  <button onClick={() => setSel({ printerId: p.id, ids: idsFor(p.name) })} className="mt-2 h-9 px-3 rounded-lg bg-sky-600 hover:bg-sky-500 text-sm font-semibold">Kategori Bağla</button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Combo / Kampanya menü yönetimi (Admin) ──────────────────────────────────
function ComboTab({ catalog, reload }) {
  const [combos, setCombos] = useState([]);
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [comps, setComps] = useState([]); // [{productId, name, quantity}]
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);

  // Bileşen seçilebilir ürünler: combo OLMAYAN ürünler (combo içinde combo olmaz).
  const pickable = (catalog.categories || []).flatMap((c) => (c.products || []).filter((p) => !p.isCombo).map((p) => ({ id: p.id, name: p.name, cat: c.name })));

  const load = useCallback(async () => {
    try { const { data } = await api.get('/restoran/combos'); setCombos(Array.isArray(data) ? data : []); } catch { /* */ }
  }, []);
  useEffect(() => { load(); }, [load]);

  const addComp = () => {
    const pid = parseInt(pick, 10);
    if (!pid) return;
    const prod = pickable.find((p) => p.id === pid);
    if (!prod) return;
    setComps((cs) => cs.find((c) => c.productId === pid) ? cs.map((c) => c.productId === pid ? { ...c, quantity: c.quantity + 1 } : c) : [...cs, { productId: pid, name: prod.name, quantity: 1 }]);
    setPick('');
  };
  const setQty = (pid, q) => setComps((cs) => cs.map((c) => c.productId === pid ? { ...c, quantity: Math.max(1, q) } : c));
  const rmComp = (pid) => setComps((cs) => cs.filter((c) => c.productId !== pid));

  const create = async () => {
    const nm = name.trim();
    if (!nm) { toast.error('Combo adı girin.'); return; }
    if (!price || Number(price) < 0) { toast.error('Geçerli fiyat girin.'); return; }
    if (comps.length < 2) { toast.error('Combo en az 2 bileşen içermeli.'); return; }
    setBusy(true);
    try {
      await api.post('/restoran/combos', {
        name: nm, price: Number(price), categoryId: categoryId || null,
        components: comps.map((c) => ({ productId: c.productId, quantity: c.quantity })),
      });
      toast.success('Combo eklendi.');
      setName(''); setPrice(''); setCategoryId(''); setComps([]);
      load(); reload();
    } catch (e) { toast.error(e?.response?.data?.error || 'Combo eklenemedi.'); }
    finally { setBusy(false); }
  };
  const del = async (id) => {
    try { await api.delete(`/restoran/combos/${id}`); toast.success('Combo silindi.'); load(); reload(); }
    catch (e) { toast.error(e?.response?.data?.error || 'Silinemedi.'); }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-slate-700 bg-slate-800/40 p-3 space-y-2">
        <label className="text-sm text-slate-400">Yeni Combo / Kampanya</label>
        <div className="flex gap-2">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Combo adı (Kampanya 1)" className="flex-1 h-11 rounded-xl bg-slate-900 border border-slate-700 px-3 outline-none focus:border-amber-500" />
          <input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" placeholder="Fiyat" className="w-24 h-11 rounded-xl bg-slate-900 border border-slate-700 px-3 outline-none focus:border-amber-500" />
        </div>
        <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className="w-full h-11 rounded-xl bg-slate-900 border border-slate-700 px-3 outline-none">
          <option value="">Kategorisiz (menüde "Diğer")</option>
          {(catalog.categories || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>

        <div className="flex gap-2">
          <select value={pick} onChange={(e) => setPick(e.target.value)} className="flex-1 h-11 rounded-xl bg-slate-900 border border-slate-700 px-3 outline-none">
            <option value="">Bileşen ürün seç…</option>
            {pickable.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.cat})</option>)}
          </select>
          <button onClick={addComp} disabled={!pick} className="h-11 px-4 rounded-xl bg-sky-600 hover:bg-sky-500 font-bold disabled:opacity-40">Ekle</button>
        </div>

        {comps.length > 0 && (
          <ul className="space-y-1">
            {comps.map((c) => (
              <li key={c.productId} className="flex items-center gap-2 rounded-lg bg-slate-900/60 px-2 py-1.5">
                <span className="flex-1 text-sm truncate">{c.name}</span>
                <button onClick={() => setQty(c.productId, c.quantity - 1)} className="h-7 w-7 grid place-items-center rounded bg-slate-700 hover:bg-slate-600"><Minus size={13} /></button>
                <span className="w-6 text-center text-sm">{c.quantity}</span>
                <button onClick={() => setQty(c.productId, c.quantity + 1)} className="h-7 w-7 grid place-items-center rounded bg-slate-700 hover:bg-slate-600"><Plus size={13} /></button>
                <button onClick={() => rmComp(c.productId)} className="h-7 w-7 grid place-items-center rounded bg-slate-700 hover:bg-rose-600/80"><X size={13} /></button>
              </li>
            ))}
          </ul>
        )}

        <button onClick={create} disabled={busy} className="w-full h-11 rounded-xl bg-emerald-600 hover:bg-emerald-500 font-bold disabled:opacity-60 flex items-center justify-center gap-2">
          {busy ? <Loader2 className="animate-spin" size={18} /> : <Layers size={18} />} Combo Oluştur
        </button>
      </div>

      <div>
        <label className="text-sm text-slate-400">Mevcut Combolar</label>
        {combos.length === 0 ? (
          <p className="text-center text-slate-400 py-3 text-sm">Henüz combo yok.</p>
        ) : (
          <ul className="space-y-2 mt-1">
            {combos.map((c) => (
              <li key={c.id} className="rounded-xl border border-slate-700 bg-slate-800/40 p-2">
                <div className="flex items-center gap-2">
                  <Layers size={15} className="text-amber-400 shrink-0" />
                  <span className="flex-1 font-semibold truncate">{c.name}</span>
                  <span className="text-amber-400 font-bold text-sm">{fmtTL(c.price)}</span>
                  <button onClick={() => del(c.id)} className="h-8 w-8 grid place-items-center rounded-lg bg-slate-700 hover:bg-rose-600/80 text-slate-300"><Trash2 size={14} /></button>
                </div>
                <div className="text-xs text-slate-400 mt-1 pl-6">{c.components.map((x) => `${x.name}${x.quantity > 1 ? ` x${x.quantity}` : ''}`).join(' + ')}</div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function RecipeTab({ allProducts }) {
  const [productId, setProductId] = useState('');
  const [recipe, setRecipe] = useState([]);
  const [loading, setLoading] = useState(false);
  const [stockQ, setStockQ] = useState('');
  const [stockResults, setStockResults] = useState([]);
  const [selStock, setSelStock] = useState(null);
  const [qty, setQty] = useState('');
  const [busy, setBusy] = useState(false);

  const loadRecipe = useCallback(async (pid) => {
    if (!pid) { setRecipe([]); return; }
    setLoading(true);
    try { const { data } = await api.get(`/restoran/products/${pid}/recipe`); setRecipe(Array.isArray(data) ? data : []); }
    catch { toast.error('Reçete alınamadı.'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { loadRecipe(productId); }, [productId, loadRecipe]);

  useEffect(() => {
    if (!stockQ.trim()) { setStockResults([]); return; }
    const t = setTimeout(async () => {
      try { const { data } = await api.get('/restoran/stocks-search', { params: { q: stockQ } }); setStockResults(Array.isArray(data) ? data : []); }
      catch { /* sessiz */ }
    }, 300);
    return () => clearTimeout(t);
  }, [stockQ]);

  const addRow = async () => {
    if (!productId) return toast.error('Önce ürün seçin.');
    if (!selStock) return toast.error('Hammadde seçin.');
    const q = Number(qty);
    if (!Number.isFinite(q) || q <= 0) return toast.error('Geçerli miktar girin.');
    setBusy(true);
    try {
      await api.post(`/restoran/products/${productId}/recipe`, { stockId: selStock.stockId, quantity: q });
      toast.success('Reçeteye eklendi.');
      setSelStock(null); setStockQ(''); setQty(''); setStockResults([]);
      loadRecipe(productId);
    } catch (e) { toast.error(e?.response?.data?.error || 'Eklenemedi.'); }
    finally { setBusy(false); }
  };

  const removeRow = async (rid) => {
    try { await api.delete(`/restoran/recipe/${rid}`); setRecipe((xs) => xs.filter((r) => r.recipeId !== rid)); }
    catch { toast.error('Silinemedi.'); }
  };

  const totalCost = recipe.reduce((s, r) => s + (r.lineCost || 0), 0);

  return (
    <div className="space-y-4">
      <p className="text-[11px] text-slate-500">
        Reçete tanımlı ürün satıldığında, tanımlı hammadde miktarı ERP stoğundan otomatik düşer (İkram dahil).
        Reçetesi olmayan ürün stoğa dokunmaz.
      </p>

      <div>
        <label className="text-sm text-slate-400">Ürün</label>
        <select value={productId} onChange={(e) => setProductId(e.target.value)} className="w-full h-11 rounded-xl bg-slate-800 border border-slate-700 px-3 outline-none mt-1 focus:border-amber-500">
          <option value="">Ürün seç…</option>
          {allProducts.map((p) => <option key={p.id} value={p.id}>{p.cat ? `${p.cat} · ` : ''}{p.name}</option>)}
        </select>
      </div>

      {productId && (
        <>
          {loading ? (
            <div className="py-4 flex items-center justify-center text-slate-400"><Loader2 className="animate-spin mr-2" size={16} /> Yükleniyor…</div>
          ) : recipe.length === 0 ? (
            <p className="text-sm text-slate-500">Bu ürün için reçete yok. Aşağıdan hammadde ekleyin.</p>
          ) : (
            <div className="space-y-1.5">
              {recipe.map((r) => (
                <div key={r.recipeId} className="flex items-center gap-2 p-2 rounded-lg bg-slate-800 border border-slate-700">
                  <span className="flex-1 text-sm truncate">{r.stockName}
                    <span className="text-xs text-slate-500"> · stok: {r.stockQty != null ? r.stockQty : '—'} {r.unit}</span>
                  </span>
                  <span className="text-sm font-bold">{r.quantity} {r.unit}</span>
                  {r.lineCost != null && <span className="text-xs text-slate-400 w-20 text-right">{fmtTL(r.lineCost)}</span>}
                  <button onClick={() => removeRow(r.recipeId)} className="h-8 w-8 grid place-items-center rounded-lg bg-rose-900/60 hover:bg-rose-800 text-rose-200"><Trash2 size={14} /></button>
                </div>
              ))}
              <div className="flex items-center justify-between pt-1 text-sm">
                <span className="text-slate-400">Porsiyon maliyeti</span>
                <span className="font-extrabold text-rose-300">{fmtTL(totalCost)}</span>
              </div>
            </div>
          )}

          {/* Hammadde ekle */}
          <div className="rounded-xl border border-slate-700 bg-slate-800/50 p-3 space-y-2">
            <label className="text-sm text-slate-400">Hammadde ekle (ERP stoğundan)</label>
            {selStock ? (
              <div className="flex items-center gap-2">
                <span className="flex-1 px-3 h-11 flex items-center rounded-xl bg-slate-800 border border-amber-500/50 text-sm">
                  {selStock.name} <span className="text-xs text-slate-500 ml-1">({selStock.unit})</span>
                </span>
                <input value={qty} onChange={(e) => setQty(e.target.value)} inputMode="decimal" placeholder={`Miktar (${selStock.unit})`} className="w-32 h-11 rounded-xl bg-slate-800 border border-slate-700 px-3 outline-none focus:border-amber-500" />
                <button onClick={addRow} disabled={busy} className="h-11 px-4 rounded-xl bg-amber-500 text-amber-950 font-bold disabled:opacity-40">Ekle</button>
                <button onClick={() => { setSelStock(null); setQty(''); }} className="h-11 w-11 grid place-items-center rounded-xl bg-slate-700 hover:bg-slate-600"><X size={16} /></button>
              </div>
            ) : (
              <>
                <input value={stockQ} onChange={(e) => setStockQ(e.target.value)} placeholder="Stok ara (ad)…" className="w-full h-11 rounded-xl bg-slate-800 border border-slate-700 px-3 outline-none focus:border-amber-500" />
                {stockResults.length > 0 && (
                  <div className="max-h-44 overflow-y-auto space-y-1">
                    {stockResults.map((s) => (
                      <button key={s.stockId} onClick={() => { setSelStock(s); setStockResults([]); setStockQ(''); }} className="w-full flex items-center justify-between p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-left">
                        <span className="text-sm truncate">{s.name}</span>
                        <span className="text-xs text-slate-400 ml-2 shrink-0">{s.quantity} {s.unit}{s.purchasePrice != null ? ` · ${fmtTL(s.purchasePrice)}` : ''}</span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ── Yönetim: bölüm / masa / kategori (yazıcı hedefi) / ürün ──────────────────
export function ManagementModal({ onClose, sections, menu, reload }) {
  const [tab, setTab] = useState('tables');
  const [busy, setBusy] = useState(false);
  const [secName, setSecName] = useState('');
  const [tblNo, setTblNo] = useState('');
  const [tblSection, setTblSection] = useState('');
  const [catName, setCatName] = useState('');
  const [prodName, setProdName] = useState('');
  const [prodPrice, setProdPrice] = useState('');
  const [prodCat, setProdCat] = useState('');
  // Tam katalog (boş kategoriler dahil) + yazıcı defteri — yönetim/sıralama için.
  const [catalog, setCatalog] = useState({ categories: [], printers: [] });
  const [dragProd, setDragProd] = useState(null); // {catId, id}
  // Seçenekler + ayarlar
  const [groups, setGroups] = useState([]);
  const [gName, setGName] = useState(''); const [gMin, setGMin] = useState('0'); const [gMax, setGMax] = useState('1');
  const [optDraft, setOptDraft] = useState({}); // { groupId: { name, delta } }
  const [assignProd, setAssignProd] = useState('');
  const [settings, setSettings] = useState(null);

  const allProducts = menu.flatMap((c) => (c.products || []).map((p) => ({ ...p, cat: c.name })));

  const loadGroups = async () => { try { const { data } = await api.get('/restoran/option-groups'); setGroups(Array.isArray(data) ? data : []); } catch { /* */ } };
  const loadSettings = async () => { try { const { data } = await api.get('/restoran/settings'); setSettings(data); } catch { /* */ } };
  const loadCatalog = useCallback(async () => {
    try { const { data } = await api.get('/restoran/catalog'); setCatalog({ categories: data.categories || [], printers: data.printers || [] }); }
    catch { /* */ }
  }, []);
  useEffect(() => { loadGroups(); loadSettings(); loadCatalog(); }, [loadCatalog]);
  // reload (prop) menüyü yeniler; katalogu da tazele.
  const reloadAll = () => { reload && reload(); loadCatalog(); };

  // Ürün sürükle-bırak / yukarı-aşağı sıralama (kategori içinde). Persist: /products/reorder.
  const saveProductOrder = async (catId, orderedIds) => {
    setCatalog((c) => ({
      ...c,
      categories: c.categories.map((k) => k.id === catId
        ? { ...k, products: orderedIds.map((id) => k.products.find((p) => p.id === id)).filter(Boolean) }
        : k),
    }));
    try { await api.post('/restoran/products/reorder', { orderedIds }); } catch (e) { toast.error('Sıralama kaydedilemedi.'); loadCatalog(); }
  };
  const moveProduct = (cat, idx, dir) => {
    const arr = cat.products.map((p) => p.id);
    const j = idx + dir;
    if (j < 0 || j >= arr.length) return;
    [arr[idx], arr[j]] = [arr[j], arr[idx]];
    saveProductOrder(cat.id, arr);
  };
  const dropProduct = (cat, targetId) => {
    if (!dragProd || dragProd.catId !== cat.id || dragProd.id === targetId) { setDragProd(null); return; }
    const arr = cat.products.map((p) => p.id);
    const from = arr.indexOf(dragProd.id); const to = arr.indexOf(targetId);
    if (from < 0 || to < 0) { setDragProd(null); return; }
    arr.splice(to, 0, arr.splice(from, 1)[0]);
    setDragProd(null);
    saveProductOrder(cat.id, arr);
  };

  const post = async (url, body, ok, after) => {
    setBusy(true);
    try { await api.post(url, body); toast.success(ok); if (after) after(); reloadAll(); }
    catch (e) { toast.error(e?.response?.data?.error || 'İşlem başarısız.'); }
    finally { setBusy(false); }
  };
  const delReq = async (url, ok, after) => {
    try { await api.delete(url); toast.success(ok); if (after) after(); reloadAll(); }
    catch (e) { toast.error(e?.response?.data?.error || 'Silinemedi.'); }
  };
  const toggleAssign = async (productId, groupId, has) => {
    try {
      if (has) await api.delete(`/restoran/products/${productId}/option-groups/${groupId}`);
      else await api.post(`/restoran/products/${productId}/option-groups`, { groupId });
      reload && reload();
    } catch (e) { toast.error(e?.response?.data?.error || 'Güncellenemedi.'); }
  };
  const saveSettings = async () => {
    setBusy(true);
    try { await api.patch('/restoran/settings', settings); toast.success('Ayarlar kaydedildi.'); reload && reload(); }
    catch (e) { toast.error(e?.response?.data?.error || 'Kaydedilemedi.'); }
    finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div className="w-full max-w-lg bg-slate-900 border border-slate-700 rounded-2xl p-5 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-bold text-lg flex items-center gap-2"><Settings size={20} /> Restoran Yönetimi</h3>
          <button onClick={onClose} className="h-9 w-9 grid place-items-center rounded-lg bg-slate-800 hover:bg-slate-700"><X size={20} /></button>
        </div>
        <div className="flex flex-wrap gap-2 mb-4">
          {[['tables', 'Bölüm & Masa'], ['menu', 'Menü'], ['combo', 'Combo'], ['printers', 'Yazıcılar'], ['options', 'Seçenekler'], ['recipe', 'Reçete'], ['settings', 'Ayarlar']].map(([k, l]) => (
            <button key={k} onClick={() => setTab(k)} className={`flex-1 min-w-[44%] h-11 rounded-xl font-bold text-sm ${tab === k ? 'bg-amber-500 text-amber-950' : 'bg-slate-800'}`}>{l}</button>
          ))}
        </div>

        {tab === 'tables' && (
          <div className="space-y-4">
            <div>
              <label className="text-sm text-slate-400">Yeni Bölüm (Salon, Bahçe, Teras…)</label>
              <div className="flex gap-2 mt-1">
                <input value={secName} onChange={(e) => setSecName(e.target.value)} placeholder="Bölüm adı" className="flex-1 h-11 rounded-xl bg-slate-800 border border-slate-700 px-3 outline-none focus:border-amber-500" />
                <button disabled={busy || !secName.trim()} onClick={() => post('/restoran/sections', { name: secName }, 'Bölüm eklendi.', () => setSecName(''))} className="h-11 px-4 rounded-xl bg-amber-500 text-amber-950 font-bold disabled:opacity-40">Ekle</button>
              </div>
            </div>
            <div>
              <label className="text-sm text-slate-400">Yeni Masa</label>
              <div className="flex gap-2 mt-1">
                <select value={tblSection} onChange={(e) => setTblSection(e.target.value)} className="h-11 rounded-xl bg-slate-800 border border-slate-700 px-3 outline-none">
                  <option value="">Bölümsüz</option>
                  {sections.filter((s) => s.id != null).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
                <input value={tblNo} onChange={(e) => setTblNo(e.target.value)} placeholder="Masa no" className="flex-1 h-11 rounded-xl bg-slate-800 border border-slate-700 px-3 outline-none focus:border-amber-500" />
                <button disabled={busy || !tblNo.trim()} onClick={() => post('/restoran/tables', { tableNo: tblNo, sectionId: tblSection || null }, 'Masa eklendi.', () => setTblNo(''))} className="h-11 px-4 rounded-xl bg-amber-500 text-amber-950 font-bold disabled:opacity-40">Ekle</button>
              </div>
            </div>
          </div>
        )}

        {tab === 'menu' && (
          <div className="space-y-4">
            <div>
              <label className="text-sm text-slate-400">Yeni Kategori (Ana Yemekler, Tatlılar…)</label>
              <div className="flex gap-2 mt-1">
                <input value={catName} onChange={(e) => setCatName(e.target.value)} placeholder="Kategori adı" className="flex-1 h-11 rounded-xl bg-slate-800 border border-slate-700 px-3 outline-none focus:border-amber-500" />
                <button disabled={busy || !catName.trim()} onClick={() => post('/restoran/categories', { name: catName }, 'Kategori eklendi.', () => setCatName(''))} className="h-11 px-4 rounded-xl bg-amber-500 text-amber-950 font-bold disabled:opacity-40">Ekle</button>
              </div>
              <p className="text-xs text-slate-500 mt-1">Yazıcı yönlendirme artık <b>Yazıcılar</b> sekmesinden yapılır.</p>
            </div>

            <div>
              <label className="text-sm text-slate-400">Yeni Ürün</label>
              <div className="space-y-2 mt-1">
                <select value={prodCat} onChange={(e) => setProdCat(e.target.value)} className="w-full h-11 rounded-xl bg-slate-800 border border-slate-700 px-3 outline-none">
                  <option value="">Kategorisiz</option>
                  {catalog.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                <div className="flex gap-2">
                  <input value={prodName} onChange={(e) => setProdName(e.target.value)} placeholder="Ürün adı" className="flex-1 h-11 rounded-xl bg-slate-800 border border-slate-700 px-3 outline-none focus:border-amber-500" />
                  <input value={prodPrice} onChange={(e) => setProdPrice(e.target.value)} inputMode="decimal" placeholder="Fiyat" className="w-28 h-11 rounded-xl bg-slate-800 border border-slate-700 px-3 outline-none focus:border-amber-500" />
                  <button disabled={busy || !prodName.trim() || !prodPrice} onClick={() => post('/restoran/products', { name: prodName, price: Number(prodPrice), categoryId: prodCat || null }, 'Ürün eklendi.', () => { setProdName(''); setProdPrice(''); })} className="h-11 px-4 rounded-xl bg-amber-500 text-amber-950 font-bold disabled:opacity-40">Ekle</button>
                </div>
              </div>
            </div>

            {/* Kategoriler + ürün sıralama (sürükle-bırak ya da ↑↓) */}
            {catalog.categories.length > 0 && (
              <div className="space-y-3">
                <label className="text-sm text-slate-400">Kategoriler & Ürün Sırası</label>
                {catalog.categories.map((c) => (
                  <div key={c.id} className="rounded-xl border border-slate-700 bg-slate-800/40 p-2">
                    <div className="flex items-center justify-between px-1 mb-1">
                      <span className="font-semibold text-sm truncate">{c.name} <span className="text-xs text-slate-500">→ {c.printerTarget || 'Mutfak'}</span></span>
                      <button onClick={() => delReq(`/restoran/categories/${c.id}`, 'Kategori silindi.')} className="h-7 w-7 grid place-items-center rounded-lg bg-slate-700 hover:bg-rose-600/80 text-slate-300" title="Kategoriyi sil"><Trash2 size={14} /></button>
                    </div>
                    {c.products.length === 0 ? (
                      <p className="text-xs text-slate-500 px-1 py-1">Bu kategoride ürün yok.</p>
                    ) : (
                      <ul className="space-y-1">
                        {c.products.map((p, idx) => (
                          <li
                            key={p.id}
                            draggable
                            onDragStart={() => setDragProd({ catId: c.id, id: p.id })}
                            onDragOver={(e) => e.preventDefault()}
                            onDrop={() => dropProduct(c, p.id)}
                            className={`flex items-center gap-2 rounded-lg px-2 py-1.5 bg-slate-900/60 border border-slate-700/60 ${dragProd?.id === p.id ? 'opacity-50' : ''}`}
                          >
                            <Layers size={14} className="text-slate-500 cursor-grab shrink-0" />
                            <span className="flex-1 text-sm truncate">{p.name}</span>
                            <span className="text-xs text-amber-400 font-semibold shrink-0">{fmtTL(p.price)}</span>
                            <button onClick={() => moveProduct(c, idx, -1)} disabled={idx === 0} className="h-7 w-7 grid place-items-center rounded bg-slate-700 hover:bg-slate-600 disabled:opacity-30 text-xs">↑</button>
                            <button onClick={() => moveProduct(c, idx, 1)} disabled={idx === c.products.length - 1} className="h-7 w-7 grid place-items-center rounded bg-slate-700 hover:bg-slate-600 disabled:opacity-30 text-xs">↓</button>
                            <button onClick={() => delReq(`/restoran/products/${p.id}`, 'Ürün silindi.')} className="h-7 w-7 grid place-items-center rounded bg-slate-700 hover:bg-rose-600/80 text-slate-300" title="Ürünü sil"><Trash2 size={13} /></button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === 'printers' && <PrinterRoutingTab catalog={catalog} reload={loadCatalog} />}

        {tab === 'combo' && <ComboTab catalog={catalog} reload={reloadAll} />}

        {tab === 'recipe' && <RecipeTab allProducts={allProducts} />}

        {tab === 'options' && (
          <div className="space-y-4">
            <div>
              <label className="text-sm text-slate-400">Yeni Seçenek Grubu (Porsiyon, Ekstra, Çıkar…)</label>
              <div className="flex gap-2 mt-1">
                <input value={gName} onChange={(e) => setGName(e.target.value)} placeholder="Grup adı" className="flex-1 h-11 rounded-xl bg-slate-800 border border-slate-700 px-3 outline-none focus:border-amber-500" />
                <input value={gMin} onChange={(e) => setGMin(e.target.value)} inputMode="numeric" title="En az" className="w-14 h-11 rounded-xl bg-slate-800 border border-slate-700 px-2 text-center outline-none" />
                <input value={gMax} onChange={(e) => setGMax(e.target.value)} inputMode="numeric" title="En çok (0=sınırsız)" className="w-14 h-11 rounded-xl bg-slate-800 border border-slate-700 px-2 text-center outline-none" />
                <button disabled={busy || !gName.trim()} onClick={() => post('/restoran/option-groups', { name: gName, minSelect: Number(gMin) || 0, maxSelect: Number(gMax) || 0 }, 'Grup eklendi.', () => { setGName(''); loadGroups(); })} className="h-11 px-3 rounded-xl bg-amber-500 text-amber-950 font-bold disabled:opacity-40">Ekle</button>
              </div>
              <p className="text-[11px] text-slate-500 mt-1">En az: zorunlu seçim sayısı · En çok: 0 = sınırsız, 1 = tekli.</p>
            </div>

            {groups.map((g) => (
              <div key={g.id} className="rounded-xl border border-slate-700 bg-slate-800/50 p-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="font-bold">{g.name} <span className="text-xs text-slate-400">(min {g.min} / max {g.max || '∞'})</span></span>
                  <button onClick={() => delReq(`/restoran/option-groups/${g.id}`, 'Grup silindi.', loadGroups)} className="h-8 w-8 grid place-items-center rounded-lg bg-rose-900/60 hover:bg-rose-800 text-rose-200"><Trash2 size={14} /></button>
                </div>
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {g.options.map((o) => (
                    <span key={o.id} className="flex items-center gap-1 px-2 h-8 rounded-lg bg-slate-700 text-sm">
                      {o.name}{o.priceDelta !== 0 ? ` (${o.priceDelta > 0 ? '+' : ''}${o.priceDelta})` : ''}
                      <button onClick={() => delReq(`/restoran/options/${o.id}`, 'Seçenek silindi.', loadGroups)} className="text-rose-300 hover:text-rose-100"><X size={13} /></button>
                    </span>
                  ))}
                  {g.options.length === 0 && <span className="text-xs text-slate-500">Seçenek yok.</span>}
                </div>
                <div className="flex gap-2">
                  <input value={optDraft[g.id]?.name || ''} onChange={(e) => setOptDraft({ ...optDraft, [g.id]: { ...optDraft[g.id], name: e.target.value } })} placeholder="Seçenek adı" className="flex-1 h-10 rounded-lg bg-slate-800 border border-slate-700 px-3 text-sm outline-none focus:border-amber-500" />
                  <input value={optDraft[g.id]?.delta || ''} onChange={(e) => setOptDraft({ ...optDraft, [g.id]: { ...optDraft[g.id], delta: e.target.value } })} inputMode="decimal" placeholder="± fiyat" className="w-24 h-10 rounded-lg bg-slate-800 border border-slate-700 px-2 text-sm outline-none" />
                  <button disabled={busy || !(optDraft[g.id]?.name || '').trim()} onClick={() => post(`/restoran/option-groups/${g.id}/options`, { name: optDraft[g.id].name, priceDelta: Number(optDraft[g.id]?.delta) || 0 }, 'Seçenek eklendi.', () => { setOptDraft({ ...optDraft, [g.id]: { name: '', delta: '' } }); loadGroups(); })} className="h-10 px-3 rounded-lg bg-amber-500 text-amber-950 font-bold text-sm disabled:opacity-40">+</button>
                </div>
              </div>
            ))}

            <div>
              <label className="text-sm text-slate-400">Ürüne grup ata</label>
              <select value={assignProd} onChange={(e) => setAssignProd(e.target.value)} className="w-full h-11 rounded-xl bg-slate-800 border border-slate-700 px-3 outline-none mt-1">
                <option value="">Ürün seç…</option>
                {allProducts.map((p) => <option key={p.id} value={p.id}>{p.cat} · {p.name}</option>)}
              </select>
              {assignProd && (
                <div className="flex flex-wrap gap-2 mt-2">
                  {groups.map((g) => {
                    const prod = allProducts.find((p) => String(p.id) === String(assignProd));
                    const has = !!prod?.optionGroups?.some((x) => x.id === g.id);
                    return (
                      <button key={g.id} onClick={() => toggleAssign(assignProd, g.id, has)}
                        className={`px-3 h-9 rounded-lg text-sm font-semibold border ${has ? 'border-amber-500 bg-amber-500/15 text-amber-100' : 'border-slate-700 bg-slate-800'}`}>
                        {has ? '✓ ' : ''}{g.name}
                      </button>
                    );
                  })}
                  {groups.length === 0 && <span className="text-xs text-slate-500">Önce grup ekleyin.</span>}
                </div>
              )}
            </div>
          </div>
        )}

        {tab === 'settings' && (
          <div className="space-y-4">
            {!settings ? <div className="grid place-items-center py-6"><Loader2 className="animate-spin" size={28} /></div> : (
              <>
                <div>
                  <label className="text-sm text-slate-400 flex items-center gap-1"><Tag size={14} /> Kuver (kişi başı ücret)</label>
                  <input value={settings.coverCharge} onChange={(e) => setSettings({ ...settings, coverCharge: e.target.value })} inputMode="decimal" placeholder="0,00 ₺"
                    className="w-full h-11 rounded-xl bg-slate-800 border border-slate-700 px-3 outline-none focus:border-amber-500 mt-1" />
                  <p className="text-[11px] text-slate-500 mt-1">Masa açılışında kişi sayısı × bu tutar otomatik adisyona eklenir (0 = kapalı).</p>
                </div>
                <div className="border-t border-slate-700 pt-3">
                  <label className="flex items-center gap-2 font-semibold mb-2">
                    <input type="checkbox" checked={!!settings.happyEnabled} onChange={(e) => setSettings({ ...settings, happyEnabled: e.target.checked })} className="w-5 h-5" />
                    <Clock size={16} /> Happy Hour
                  </label>
                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <span className="text-xs text-slate-400">Başlangıç (saat)</span>
                      <input value={settings.happyStart} onChange={(e) => setSettings({ ...settings, happyStart: e.target.value })} inputMode="numeric" className="w-full h-11 rounded-xl bg-slate-800 border border-slate-700 px-3 outline-none mt-1" />
                    </div>
                    <div>
                      <span className="text-xs text-slate-400">Bitiş (saat)</span>
                      <input value={settings.happyEnd} onChange={(e) => setSettings({ ...settings, happyEnd: e.target.value })} inputMode="numeric" className="w-full h-11 rounded-xl bg-slate-800 border border-slate-700 px-3 outline-none mt-1" />
                    </div>
                    <div>
                      <span className="text-xs text-slate-400">İndirim %</span>
                      <input value={settings.happyPercent} onChange={(e) => setSettings({ ...settings, happyPercent: e.target.value })} inputMode="decimal" className="w-full h-11 rounded-xl bg-slate-800 border border-slate-700 px-3 outline-none mt-1" />
                    </div>
                  </div>
                  <p className="text-[11px] text-slate-500 mt-1">Örn. 15–18 arası %20: bu saatlerde menü fiyatları otomatik düşer.</p>
                </div>
                <div className="border-t border-slate-700 pt-3">
                  <label className="text-sm text-slate-400 flex items-center gap-1"><Gift size={14} /> Sadakat puanı (%)</label>
                  <input value={settings.loyaltyPercent ?? ''} onChange={(e) => setSettings({ ...settings, loyaltyPercent: e.target.value })} inputMode="decimal" placeholder="0"
                    className="w-full h-11 rounded-xl bg-slate-800 border border-slate-700 px-3 outline-none focus:border-amber-500 mt-1" />
                  <p className="text-[11px] text-slate-500 mt-1">Müşterili siparişlerde tahsilatın bu yüzdesi puan olarak yazılır (1 puan = 1 ₺). 0 = kapalı. Puan tahsilatta indirim olarak kullanılır.</p>
                </div>
                {(() => {
                  // Özelleştirme bayrakları (varsayılan açık). Toggle = '1'/'0'.
                  const featOn = (k) => settings.features?.[k] !== '0' && settings.features?.[k] !== false;
                  const toggleFeat = (k) => setSettings({ ...settings, features: { ...(settings.features || {}), [k]: featOn(k) ? '0' : '1' } });
                  const featVal = (k, def) => settings.features?.[k] ?? def;
                  const setFeatVal = (k, v) => setSettings({ ...settings, features: { ...(settings.features || {}), [k]: v } });
                  return (
                    <>
                      <div className="border-t border-slate-700 pt-3">
                        <label className="text-sm text-slate-400 flex items-center gap-1 mb-2"><Wallet size={14} /> Ödeme Yöntemleri</label>
                        <div className="space-y-2">
                          {[['payCash', 'Nakit'], ['payCard', 'Kredi Kartı'], ['payTicket', 'Yemek Fişi']].map(([k, l]) => (
                            <FeatureToggle key={k} label={l} on={featOn(k)} onToggle={() => toggleFeat(k)} />
                          ))}
                        </div>
                        <p className="text-[11px] text-slate-500 mt-1">Kapatılan ödeme yöntemi ödeme ve hızlı ödeme ekranlarında görünmez.</p>
                      </div>
                      <div className="border-t border-slate-700 pt-3">
                        <label className="text-sm text-slate-400 flex items-center gap-1 mb-2"><Utensils size={14} /> Masa Ekranı</label>
                        <div className="space-y-2">
                          <FeatureToggle label="Masada tutar göster" hint="Dolu masa kartında adisyon toplamı." on={featOn('showTableTotal')} onToggle={() => toggleFeat('showTableTotal')} />
                          <FeatureToggle label="Masada süre göster" hint="Masanın ne kadar süredir açık olduğu." on={featOn('showTableTimer')} onToggle={() => toggleFeat('showTableTimer')} />
                          <FeatureToggle label="Masada kişi sayısı göster" hint="Dolu masa kartında oturan kişi sayısı." on={featOn('showTableGuests')} onToggle={() => toggleFeat('showTableGuests')} />
                          <FeatureToggle label="Masada garson göster" hint="Masayı açan garsonun adı." on={featOn('showTableWaiter')} onToggle={() => toggleFeat('showTableWaiter')} />
                          <FeatureToggle label="Kişi sayısı sor" hint="Kapalıysa boş masa dokununca direkt açılır." on={featOn('askGuestCount')} onToggle={() => toggleFeat('askGuestCount')} />
                        </div>
                      </div>
                      <div className="border-t border-slate-700 pt-3">
                        <label className="text-sm text-slate-400 flex items-center gap-1 mb-2"><Layers size={14} /> Ürün Butonu Boyutu</label>
                        <div className="grid grid-cols-3 gap-2">
                          {[['sm', 'Küçük'], ['md', 'Orta'], ['lg', 'Büyük']].map(([v, l]) => {
                            const on = featVal('buttonSize', 'md') === v;
                            return (
                              <button key={v} type="button" onClick={() => setFeatVal('buttonSize', v)}
                                className={`h-11 rounded-xl font-semibold border ${on ? 'bg-amber-500 text-amber-950 border-amber-400' : 'bg-slate-800 border-slate-700 hover:bg-slate-700'}`}>{l}</button>
                            );
                          })}
                        </div>
                        <p className="text-[11px] text-slate-500 mt-1">Menü ekranındaki ürün butonlarının boyutu.</p>
                      </div>
                      <div className="border-t border-slate-700 pt-3">
                        <label className="text-sm text-slate-400 flex items-center gap-1 mb-2"><Banknote size={14} /> Tahsilat</label>
                        <div className="space-y-2">
                          <FeatureToggle label="Tutarı tam TL'ye yuvarla" hint="Tam tek tahsilatta küsuratı siler; fark iskonto olarak yazılır." on={featOn('roundTotal')} onToggle={() => toggleFeat('roundTotal')} />
                        </div>
                      </div>
                      <div className="border-t border-slate-700 pt-3">
                        <label className="text-sm text-slate-400 flex items-center gap-1 mb-2"><Trash2 size={14} /> İptal & Zayi</label>
                        <div className="space-y-2">
                          <FeatureToggle label="İptal nedeni sor" hint="Mutfağa gitmiş kalem iptalinde neden sorulur. Kapalıysa neden zorunlu değil (yönetici onayı yine geçerli)." on={featOn('askCancelReason')} onToggle={() => toggleFeat('askCancelReason')} />
                        </div>
                      </div>
                    </>
                  );
                })()}
                <button onClick={saveSettings} disabled={busy} className="w-full h-12 rounded-xl bg-emerald-600 hover:bg-emerald-500 font-extrabold">Ayarları Kaydet</button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
