/*
 * SK106 SMART RES SENDER v2.1 — časová simulácia obchodníkov, trhov a skladov
 * Originálny samostatný skript pre vlastné dediny Divokých kmeňov.
 * JEDNO kliknutie = najviac JEDEN transport. Budúce vlny vyžadujú nové načítanie.
 *
 */
(function () {
  'use strict';
  const VERSION = '2.1';
  const ROOT_ID = 'sk106-sender-v2';
  const CSS_ID = ROOT_ID + '-css';
  const STORAGE_KEY = 'sk106SmartSenderV2';
  const RES = ['wood', 'stone', 'iron'];
  const DEFAULTS = {
    target: '544|473',
    speed: 4, horizonHours: 4, mode: 'auto',
    assumeAllMerchants: true,
    maxLegMinutes: 60,
    hubMaxPct: 80,
    reservePct: 0, warehouseSafetyPct: 0, merchantsReserve: 0,
    merchantCarry: 1000, minSend: 1000,
    coinCosts: [28000, 30000, 25000],
    simulateMint: true,
    packagePercent: 0, packagesPerVillage: 0,
    maxTransports: 4000,
    relayThresholdFields: 4.5,
    hybridRelayWeight: 0.7
  };
  const root = typeof window === 'object' ? window : globalThis;
  const coord = str => {
    const m = String(str || '').match(/(\d{1,3})\s*\|\s*(\d{1,3})/);
    return m ? { x: +m[1], y: +m[2], key: `${+m[1]}|${+m[2]}` } : null;
  };
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const summ = arr => arr.reduce((s, n) => s + n, 0);
  const fmt = n => Math.round(n).toLocaleString('sk-SK');
  const timeMin = m => `${Math.floor(m / 60)}h ${String(Math.floor(m % 60)).padStart(2, '0')}m`;
  const html = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toInt = x => {
    if (typeof x === 'number') return Number.isFinite(x) ? Math.max(0, Math.floor(x)) : 0;
    return Number(String(x ?? '').replace(/[^\d]/g, '')) || 0;
  };
  const cap = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const EPS = 0.00001;

  // Vyrovná pomer surovín voči razeniu. Nevyžaduje všetky 3 typy na zdroji.
  function allocate(avail, room, maxLoad, costs, reference) {
    const upper = avail.map((n, j) => Math.max(0, Math.floor(Math.min(n, room[j]))));
    const n = Math.min(summ(upper), Math.max(0, Math.floor(maxLoad)));
    if (n <= 0) return [0, 0, 0];
    const b = reference.map((x, i) => x / costs[i]);
    let lo = Math.min(...b), hi = Math.max(...b) + n / Math.min(...costs) + 2;
    for (let z = 0; z < 44; z++) {
      const mid = (lo + hi) / 2;
      const used = summ(upper.map((u, j) => Math.min(u, Math.max(0, (mid - b[j]) * costs[j]))));
      if (used < n) lo = mid; else hi = mid;
    }
    const out = upper.map((u, j) => Math.min(u, Math.max(0, Math.floor((hi - b[j]) * costs[j]))));
    let left = n - summ(out);
    while (left-- > 0) {
      const j = [0, 1, 2].filter(k => out[k] < upper[k])
        .sort((a, b) => (reference[a] + out[a]) / costs[a] - (reference[b] + out[b]) / costs[b])[0];
      if (j === undefined) break;
      out[j]++;
    }
    return out;
  }

  function prepare(raw, input) {
    const s = { ...DEFAULTS, ...input };
    const targetCoord = coord(s.target);
    if (!targetCoord) throw new Error('Neplatná súradnica razenice.');
    if (!(Number(s.speed) > 0 && Number(s.horizonHours) > 0)) throw new Error('Neplatná rýchlosť alebo dĺžka simulácie.');
    const villages = raw.map(r => {
      const p = coord(r.coord);
      if (!p) return null;
      const total = toInt(r.totalMerchants ?? r.merchants);
      const realFree = toInt(r.merchants);
      const stock = RES.map(k => toInt(r[k]));
      const capacity = toInt(r.capacity);
      const existingTransfers = (Array.isArray(r.incomingTransfers) ? r.incomingTransfers : []).map(t => ({
        cargo: RES.map((_,j) => toInt(t.cargo?.[j])),
        etaMinutes: t.etaMinutes == null ? null : Number(t.etaMinutes)
      })).filter(t => t.cargo.some(x => x > 0));
      const unknownIncoming = RES.map((_,j) => toInt(r.incomingUnknown?.[j]));
      const initialIncoming = unknownIncoming.map((amount,j) => amount + existingTransfers.reduce((n,t) => n + t.cargo[j],0));
      return {
        id: String(r.id), name: String(r.name || p.key), coord: p.key, x: p.x, y: p.y,
        stock, capacity, realFree, totalMerchants: total,
        free: Math.max(0, (s.assumeAllMerchants ? total : Math.min(total, realFree)) - toInt(s.merchantsReserve)),
        incoming: initialIncoming, existingTransfers,
        initial: stock.slice(),
        packageLeft: toInt(s.packagesPerVillage),
        mintDistance: distance(p, targetCoord),
        url: r.url || ''
      };
    }).filter(Boolean);
    const target = villages.find(v => v.coord === targetCoord.key);
    if (!target) throw new Error(`Razenica ${targetCoord.key} sa nenachádza v načítanom prehľade.`);
    if (villages.length < 2) throw new Error('Potrebujeme aspoň dve dediny.');
    if (villages.some(v => !v.capacity || !v.totalMerchants)) {
      throw new Error('Niektorá dedina nemá kapacitu skladu alebo celkový počet obchodníkov.');
    }
    villages.sort((a, b) => a.mintDistance - b.mintDistance);
    s.speed = Number(s.speed);
    s.horizonHours = Number(s.horizonHours);
    s.coinCosts = s.coinCosts.map(n => Math.max(1, toInt(n)));
    s.merchantCarry = Math.max(1, toInt(s.merchantCarry));
    s.minSend = Math.max(1, toInt(s.minSend));
    s.maxLegMinutes = Math.max(1, Number(s.maxLegMinutes));
    s.reservePct = cap(Number(s.reservePct) || 0, 0, 80);
    s.warehouseSafetyPct = cap(Number(s.warehouseSafetyPct) || 0, 0, 60);
    s.hubMaxPct = cap(Number(s.hubMaxPct) || 80, 30, 100);
    s.packagePercent = cap(Number(s.packagePercent) || 0, 0, 100);
    s.maxTransports = cap(toInt(s.maxTransports), 10, 10000);
    return { villages, target, s };
  }

  // Diskrétna simulácia s 1-minútovým krokom: prílety, návraty, skladová
  // rezervácia na trase, razenie a prípadné aktivácie balíčkov.
  function simulate(raw, input = {}, mode = 'hybrid') {
    const { villages: v, target, s } = prepare(raw, input);
    const maxMinute = Math.ceil(s.horizonHours * 60);
    const arrivalByMinute = new Map();
    const returnByMinute = new Map();
    const allActions = [];
    const coinTimeline = [];
    const packageActions = [];
    const delivered = [0, 0, 0];
    let coins = 0;
    let lastCoinAt = null;
    let merchantMinutes = 0;

    const schedule = (map, minute, item) => {
      if (!map.has(minute)) map.set(minute, []);
      map.get(minute).push(item);
    };
    for (const village of v) for (const pending of village.existingTransfers) {
      if (Number.isFinite(pending.etaMinutes) && pending.etaMinutes >= 0) {
        schedule(arrivalByMinute, Math.ceil(pending.etaMinutes), { dst:village, cargo:pending.cargo, direct:village === target });
      }
    }
    const canMint = () => Math.min(...target.stock.map((n, j) => Math.floor(n / s.coinCosts[j])));
    const mint = now => {
      if (!s.simulateMint) return;
      const count = canMint();
      if (count <= 0) return;
      for (let j = 0; j < 3; j++) target.stock[j] -= s.coinCosts[j] * count;
      coins += count;
      lastCoinAt = now;
      coinTimeline.push({ minute: now, count, total: coins });
    };
    const maybePackages = now => {
      if (!(s.packagePercent > 0 && s.packagesPerVillage > 0)) return;
      for (const a of v) {
        if (a.packageLeft <= 0) continue;
        const amount = Math.floor(a.capacity * s.packagePercent / 100);
        if (amount < 1) continue;
        const ceiling = Math.floor(a.capacity * (1 - s.warehouseSafetyPct / 100));
        const hasRoom = RES.every((_, j) => a.stock[j] + a.incoming[j] + amount <= ceiling);
        if (!hasRoom) continue;
        // Model len predpokladá manuálne použitie balíčka v uvedenom okne.
        for (let j = 0; j < 3; j++) a.stock[j] += amount;
        a.packageLeft--;
        packageActions.push({ minute: now, coord: a.coord, amount });
      }
    };
    // Limit počtu obchodníkov je rýchlejším nástrojom na vyváženie toku než
    // jednoduché poradie podľa polí. Nepripúšťame presun smerom od razenice.
    const consider = (src, dst, now, strategy) => {
      if (src === dst || src === target || dst.mintDistance >= src.mintDistance - EPS) return null;
      const d = distance(src, dst);
      const direct = dst === target;
      if (!direct && d * s.speed > s.maxLegMinutes + EPS) return null;
      // Priame trasy smú byť aj dlhšie; max. úsek platí len pre prekladiská.
      if (!direct && d + dst.mintDistance > src.mintDistance * 1.30 + 0.4) return null;
      if (strategy === 'direct' && !direct) return null;
      if (strategy === 'relay' && direct && src.mintDistance > s.relayThresholdFields) return null;
      if (strategy === 'relay' && !direct && src.mintDistance <= s.relayThresholdFields) return null;
      const usable = src.stock.map((n, j) => Math.max(0, n - Math.floor(src.capacity * s.reservePct / 100)));
      const ceiling = Math.floor(dst.capacity * (direct ? (1 - s.warehouseSafetyPct / 100) : Math.min(1 - s.warehouseSafetyPct / 100, s.hubMaxPct / 100)));
      const room = dst.stock.map((n, j) => Math.max(0, ceiling - n - dst.incoming[j]));
      const maxLoad = Math.min(src.free * s.merchantCarry, summ(usable));
      if (maxLoad < s.minSend || summ(room) < s.minSend) return null;
      // V prekladisku príjem spomaľujeme, keď má neúmerne veľa rezervovaných
      // príchodov oproti obchodníkom, ktorí môžu ďalej suroviny otáčať.
      const inFlight = summ(dst.incoming);
      const hubLoad = direct ? 0 : inFlight / Math.max(1, dst.totalMerchants * s.merchantCarry);
      if (!direct && hubLoad > 3) return null;
      const reference = dst.stock.map((n, j) => n + dst.incoming[j]);
      // Prekladiská smerujeme na rastúcu potrebu razenice, ak je surovina
      // v jej reálnom/predpokladanom sklade nízka.
      if (!direct) {
        const central = target.stock.map((n, j) => n + target.incoming[j]);
        const gap = Math.max(...central.map((n, j) => n / s.coinCosts[j]));
        for (let j = 0; j < 3; j++) {
          const urgency = Math.max(0, (gap - central[j] / s.coinCosts[j]) * s.coinCosts[j]);
          reference[j] = Math.max(0, reference[j] - Math.min(urgency, s.merchantCarry * 60));
        }
      }
      const cargo = allocate(usable, room, maxLoad, s.coinCosts, reference);
      const amount = summ(cargo);
      if (amount < s.minSend) return null;
      const traders = Math.ceil(amount / s.merchantCarry);
      if (traders > src.free) return null;
      const next = dst.mintDistance;
      const delay = d * s.speed;
      const traderOpportunity = d * (strategy === 'relay' && !direct ? 0.9 : 1);
      const relayBurden = direct ? 0 : next * (strategy === 'hybrid' ? Number(s.hybridRelayWeight) : 0.34) + hubLoad * 2.5 + 0.15;
      let score = traderOpportunity + relayBurden;
      if (!direct) {
        const roundtrip = Math.max(1, 2 * dst.mintDistance * s.speed);
        const waitingRounds = (summ(dst.incoming) / s.merchantCarry) / Math.max(1, dst.totalMerchants);
        score += Math.min(4, waitingRounds * roundtrip / 60);
      }
      if (strategy === 'relay' && !direct) score -= 1.5;
      if (strategy === 'hybrid' && direct) score -= 0.1;
      // Zohľadni využitie prepravnej dávky a momentálne voľný sklad.
      score -= Math.min(1, amount / (src.totalMerchants * s.merchantCarry)) * 0.12;
      return { src, dst, d, delay, cargo, amount, traders, score, direct, now };
    };

    const assign = x => {
      const { src, dst, d, delay, cargo, amount, traders, now } = x;
      const arrival = now + delay;
      const back = now + 2 * delay;
      src.free -= traders;
      for (let j = 0; j < 3; j++) {
        src.stock[j] -= cargo[j];
        dst.incoming[j] += cargo[j];
      }
      merchantMinutes += 2 * delay * traders;
      const action = {
        id: `srs-${allActions.length + 1}`, minute: now, fromId: src.id, toId: dst.id,
        from: src.name, to: dst.name, fromCoord: src.coord, toCoord: dst.coord,
        cargo, amount, traders, fields: d, oneWay: delay, arrival, back,
        direct: dst === target, simulated: true
      };
      allActions.push(action);
      schedule(arrivalByMinute, Math.ceil(arrival - EPS), { dst, cargo, direct: dst === target });
      schedule(returnByMinute, Math.ceil(back - EPS), { src, traders });
    };

    for (let minute = 0; minute <= maxMinute; minute++) {
      for (const e of arrivalByMinute.get(minute) || []) {
        for (let j = 0; j < 3; j++) {
          e.dst.incoming[j] -= e.cargo[j];
          e.dst.stock[j] += e.cargo[j];
          if (e.direct) delivered[j] += e.cargo[j];
        }
      }
      for (const e of returnByMinute.get(minute) || []) e.src.free += e.traders;
      mint(minute);
      maybePackages(minute);
      mint(minute);
      if (minute === maxMinute || allActions.length >= s.maxTransports) continue;
      for (const src of v) {
        if (src === target || src.free <= 0) continue;
        if (allActions.length >= s.maxTransports) break;
        const best = [];
        for (const dst of v) {
          const c = consider(src, dst, minute, mode);
          if (c) best.push(c);
        }
        if (!best.length) {
          // V režime relay ak nie je použiteľné prekladisko, radšej pošli
          // priamo ako držať suroviny na zemi. Priame rameno nemá limit.
          if (mode === 'relay') {
            const forced = consider(src, target, minute, 'direct');
            if (forced) assign(forced);
          }
          continue;
        }
        best.sort((a, b) => a.score - b.score || b.amount - a.amount);
        assign(best[0]);
      }
    }
    const inTransit = v.reduce((total, x) => total + summ(x.incoming), 0);
    const remaining = v.reduce((total, x) => total + summ(x.stock), 0);
    return {
      mode, coins, targetId: target.id, targetCoord: target.coord,
      actions: allActions, coinTimeline, packageActions,
      delivered, merchantMinutes, lastCoinAt,
      remaining, inTransit, targetStock: target.stock.slice(),
      villageCount: v.length, source: s,
      initialCoins: Math.min(...target.initial.map((n,j) => Math.floor(n / s.coinCosts[j]))),
      initialStock: target.initial.slice(),
      targetCapacity: target.capacity
    };
  }

  function compareStrategies(raw, cfg = {}) {
    const direct = simulate(raw, cfg, 'direct');
    const relay = simulate(raw, cfg, 'relay');
    // Pre hybrid prever viac agresivít prekladania. Nesmie to byť len
    // heuristika "vždy na najbližší hub"; prepočítame reálne doručené mince.
    const weights = [0.4, 0.55, 0.7, 0.85, 1.0, 1.2];
    const hybrids = weights.map(w => simulate(raw, { ...cfg, hybridRelayWeight:w }, 'hybrid'));
    const priority = (a,b) => b.coins - a.coins ||
      summ(b.delivered) - summ(a.delivered) ||
      a.merchantMinutes - b.merchantMinutes;
    const hybrid = hybrids.slice().sort(priority)[0];
    const trials = [direct, relay, hybrid];
    const candidates = trials.slice().sort(priority);
    const chosen = cfg.mode === 'auto' || !cfg.mode
      ? candidates[0] : trials.find(t => t.mode === cfg.mode) || candidates[0];
    return { chosen, trials };
  }

  root.SK106SmartSupplyCoreV2 = { simulate, compareStrategies, prepare, allocate, coord, distance };
  if (typeof document === 'undefined') return;
  if (!root.game_data || !root.TribalWars) {
    alert('Spusť skript na prihlásenom svete Divoké kmene.');
    return;
  }
  if (document.getElementById(ROOT_ID)) {
    document.getElementById(ROOT_ID).remove();
    document.getElementById(CSS_ID)?.remove();
    return;
  }

  const style = document.createElement('style');
  style.id = CSS_ID;
  style.textContent = `
    #${ROOT_ID}{font:13px/1.5 Arial,sans-serif;color:#eaf0f8;background:#1c2734;border:1px solid #50657a;
      border-radius:10px;padding:14px;margin:8px 0 18px;max-width:1400px;box-sizing:border-box}
    #${ROOT_ID} *{box-sizing:border-box}#${ROOT_ID} h2{font-size:20px;color:#ffcf72;margin:0 0 5px}
    #${ROOT_ID} .srs-row{display:flex;gap:10px;align-items:end;flex-wrap:wrap;margin:10px 0}
    #${ROOT_ID} .srs-row>div{display:flex;flex-direction:column;gap:3px}
    #${ROOT_ID} label{font-size:11px;font-weight:bold;color:#cbd8e7}
    #${ROOT_ID} input,#${ROOT_ID} select{background:#111c29;border:1px solid #637c95;color:white;
      padding:7px 8px;border-radius:4px;max-width:190px}
    #${ROOT_ID} input[type=checkbox]{align-self:start;margin:8px 0 0}
    #${ROOT_ID} button{background:#355576;color:#fff;border:1px solid #62829f;border-radius:4px;
      padding:7px 10px;cursor:pointer}#${ROOT_ID} button:disabled{opacity:.45;cursor:not-allowed}
    #${ROOT_ID} button.srs-send{background:#287544;border-color:#60ae75}
    #${ROOT_ID} .srs-note{color:#afbdce}#${ROOT_ID} .srs-warn{background:#533b2c;padding:9px;margin:8px 0;border-radius:5px}
    #${ROOT_ID} .srs-summary{background:#243d4c;padding:9px;margin:9px 0;border-radius:6px}
    #${ROOT_ID} .srs-scroll{overflow:auto;max-height:58vh}
    #${ROOT_ID} table{border-collapse:collapse;width:100%;min-width:1090px}
    #${ROOT_ID} td,#${ROOT_ID} th{padding:6px;border-bottom:1px solid #405168;text-align:left;vertical-align:middle}
    #${ROOT_ID} th{background:#111a27;color:#ffdc8e;position:sticky;top:0}
    #${ROOT_ID} tbody tr:nth-child(odd){background:#273648}
    #${ROOT_ID} .srs-tag{padding:2px 5px;background:#415267;border-radius:3px}
    #${ROOT_ID} .srs-ok{color:#7bdda2}#${ROOT_ID} .srs-bad{color:#ffb38f}
  `;
  document.head.appendChild(style);
  const el = document.createElement('section');
  el.id = ROOT_ID;
  el.innerHTML = `
    <button id="srsClose" style="float:right">✕</button>
    <h2>⚒ SMART RES SENDER v${VERSION} · SK106</h2>
    <div class="srs-note">Dynamické trhy + sklady + návraty obchodníkov + prekladiská. Simulácia plánuje aj budúce vlny. Odoslanie je vždy ručné.</div>
    <div class="srs-row">
      <div><label>Razenica</label><input id="srsTarget" style="width:96px"></div>
      <div><label>Obchodník min/pole</label><input id="srsSpeed" type="number" min="0.1" step="0.1" style="width:75px"></div>
      <div><label>Simulovať hodín</label><select id="srsHorizon"><option value="2">2h</option><option value="4">4h</option><option value="8">8h</option><option value="12">12h</option><option value="24">24h</option></select></div>
      <div><label>Strategická voľba</label><select id="srsMode"><option value="auto">AUTO · najviac mincí</option><option value="direct">Všetko priamo</option><option value="relay">Cez prekladiská</option><option value="hybrid">Hybrid</option></select></div>
      <div><label>Max cesta pri relay (min)</label><input id="srsLeg" type="number" min="1" style="width:85px"></div>
      <div><label>Všetci obchodníci voľní (simulácia)</label><input id="srsAll" type="checkbox"></div>
    </div>
    <div class="srs-row">
      <div><label>Rezerva surovín (% skladu)</label><input id="srsReserve" type="number" min="0" max="80" style="width:90px"></div>
      <div><label>Rezerva miesta v sklade (%)</label><input id="srsSafety" type="number" min="0" max="60" style="width:85px"></div>
      <div><label>Max náplň prekladiska (%)</label><input id="srsHubFill" type="number" min="30" max="100" style="width:90px"></div>
      <div><label>Rezerva obchodníkov (ks)</label><input id="srsMerch" type="number" min="0" style="width:85px"></div>
      <div><label>Balíček (% skladu, všetky 3)</label><input id="srsPackPct" type="number" min="0" max="100" style="width:95px"></div>
      <div><label>Balíčky na dedinu (sim.)</label><input id="srsPackCount" type="number" min="0" max="100" style="width:85px"></div>
      <div><label>Raziť okamžite v simulácii</label><input id="srsMint" type="checkbox"></div>
    </div>
    <div class="srs-row">
      <div><label>Minca: drevo</label><input id="srsCost0" type="number" min="1" style="width:95px"></div>
      <div><label>Hlina</label><input id="srsCost1" type="number" min="1" style="width:95px"></div>
      <div><label>Železo</label><input id="srsCost2" type="number" min="1" style="width:95px"></div>
      <button id="srsReload">↻ Aktualizovať dediny</button>
      <button id="srsRun">⚙ Vypočítať plán</button>
      <button id="srsCsv">↓ CSV plán</button>
      <button id="srsCsvCoins">↓ Raziaci harmonogram</button>
    </div>
    <div id="srsStatus" class="srs-note">Načítavam údaje…</div>
    <div id="srsOutput"></div>
    <p class="srs-note">Do plánu vstupujú rozpoznané prichádzajúce transporty a kapacita skladov.</p>
  `;
  (document.querySelector('#contentContainer') || document.body).prepend(el);
  const $id = id => el.querySelector('#' + id);
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch (_) {}
  let settings = { ...DEFAULTS, ...saved };
  let villages = [], snapshotAt = 0, chosen = null, results = null;
  const alreadySent = new Set();
  const fieldMap = {
    srsTarget:'target',srsSpeed:'speed',srsHorizon:'horizonHours',srsMode:'mode',
    srsLeg:'maxLegMinutes',srsReserve:'reservePct',srsSafety:'warehouseSafetyPct',srsHubFill:'hubMaxPct',
    srsMerch:'merchantsReserve',srsPackPct:'packagePercent',srsPackCount:'packagesPerVillage'
  };
  function applyForm() {
    for (const [id,key] of Object.entries(fieldMap)) $id(id).value = settings[key];
    $id('srsAll').checked = settings.assumeAllMerchants;
    $id('srsMint').checked = settings.simulateMint;
    for (let j=0;j<3;j++) $id('srsCost'+j).value = settings.coinCosts[j];
  }
  function readForm() {
    for (const [id,key] of Object.entries(fieldMap)) {
      settings[key] = ['target','mode'].includes(key) ? $id(id).value : Number($id(id).value);
    }
    settings.assumeAllMerchants = $id('srsAll').checked;
    settings.simulateMint = $id('srsMint').checked;
    settings.coinCosts = [0,1,2].map(j => Number($id('srsCost'+j).value));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }
  applyForm();
  $id('srsClose').addEventListener('click', () => { el.remove(); style.remove(); });
  function getText(n) { return n ? (n.textContent || '') : ''; }
  function merchantPair(txt) {
    const m = String(txt).match(/([\d.\s\u00a0]+)\s*\/\s*([\d.\s\u00a0]+)/);
    return m ? [toInt(m[1]), toInt(m[2])] : null;
  }
  function parseOverview(markup) {
    const dom = new DOMParser().parseFromString(markup, 'text/html');
    const nodes = [...dom.querySelectorAll('.quickedit-vn')];
    const data = [], warnings = [];
    for (const node of nodes) {
      const tr = node.closest('tr');
      const p = coord(getText(node));
      if (!tr || !p) continue;
      const resource = RES.map(k => tr.querySelector(`.wood.${k},.res.${k},.warn_90.${k},.warn.${k},.m${k}`));
      if (resource.some(x => !x)) { warnings.push(`${p.key}: chýbajú suroviny`); continue; }
      const rtd = resource[0].closest('td');
      const warehouseText = getText(rtd?.nextElementSibling);
      const tradersText = getText(rtd?.nextElementSibling?.nextElementSibling);
      const traders = merchantPair(tradersText) || merchantPair(getText(tr.querySelector('.trader_img')?.closest('td')));
      const warehouse = toInt(warehouseText);
      const villageId = node.dataset.id || node.querySelector('a[href*="village="]')?.href.match(/village=(\d+)/)?.[1] ||
        node.innerHTML.match(/village=(\d+)/)?.[1];
      if (!warehouse || !traders || !villageId) { warnings.push(`${p.key}: neúplné dáta skladu/trhu/ID`); continue; }
      const res = resource.map(r => toInt(getText(r)));
      data.push({id:villageId, coord:p.key, name:getText(node).trim(),
        wood:res[0],stone:res[1],iron:res[2],capacity:warehouse,
        merchants:traders[0], totalMerchants:traders[1] });
    }
    return { data, warnings, seen:nodes.length };
  }

  // WH Balancer approach: count already inbound resource shipments as reserved.
  function parseIncoming(markup) {
    const dom = new DOMParser().parseFromString(markup, 'text/html');
    const rows = [...dom.querySelectorAll('#trades_table tr')];
    const byId = {};
    const mobile = !!document.querySelector('#mobileHeader');
    let parsed = 0, withoutETA = 0;
    for (const row of rows) {
      const cells = [...row.children].filter(x => x.tagName === 'TD');
      if (cells.length < 6) continue;
      // Desktop and mobile overview place destination links and resource icons in different cells.
      const targetCell = cells[mobile ? 3 : 4];
      const targetLink = [...(targetCell?.querySelectorAll('a[href]') || [])]
        .map(x => x.getAttribute('href') || '').find(h => /[?&]id=\\d+/.test(h));
      const id = targetLink?.match(/[?&]id=(\\d+)/)?.[1];
      if (!id) continue;
      const resourceCell = cells[mobile ? 5 : 8];
      if (!resourceCell) continue;
      const cargo = [0, 0, 0];
      for (const k of RES) {
        const found = resourceCell.querySelectorAll('.icon.' + k + ',.icon.m' + k + ',.header.' + k + ',.mheader.m' + k);
        for (const icon of found) {
          const wrap = icon.parentElement || icon;
          const value = toInt(wrap.textContent);
          if (value) cargo[RES.indexOf(k)] += value;
        }
      }
      if (!cargo.some(Boolean)) continue;
      const timer = row.querySelector('.timer,[data-endtime]');
      let etaMinutes = null;
      const stampText = timer?.getAttribute('data-endtime');
      const timestamp = Number(stampText);
      if (timestamp > 1e9) {
        const epoch = timestamp > 1e12 ? timestamp / 1000 : timestamp;
        etaMinutes = Math.max(0, (epoch - Date.now() / 1000) / 60);
      } else if (timer) {
        const match = timer.textContent.match(/(\\d+):(\\d{2}):(\\d{2})/);
        if (match) etaMinutes = +match[1]*60 + +match[2] + +match[3]/60;
      }
      if (!byId[id]) byId[id] = { transfers:[], unknown:[0,0,0] };
      if (etaMinutes == null) {
        for (let j = 0; j < 3; j++) byId[id].unknown[j] += cargo[j];
        withoutETA++;
      } else byId[id].transfers.push({ cargo, etaMinutes });
      parsed++;
    }
    return { byId, parsed, withoutETA };
  }
  async function fetchIncoming() {
    const gd = root.game_data || {};
    const sitterQuery = Number(gd.player?.sitter) > 0 ? 't=' + encodeURIComponent(gd.player.id) + '&' : '';
    const response = await fetch('game.php?' + sitterQuery +
      'screen=overview_villages&mode=trader&type=inc&page=-1',
      { credentials:'same-origin', cache:'no-store' });
    if (!response.ok) throw new Error('Prehľad transportov: HTTP ' + response.status);
    return parseIncoming(await response.text());
  }
  async function fetchOverview() {
    const gd = root.game_data || {};
    const sitter = Number(gd.player?.sitter) > 0;
    const sitterQuery = sitter ? `t=${encodeURIComponent(gd.player.id)}&` : '';
    const url = `game.php?${sitterQuery}screen=overview_villages&mode=prod&page=-1`;
    const response = await fetch(url, { credentials:'same-origin', cache:'no-store' });
    if (!response.ok) throw new Error(`Prehľad Produkcia: HTTP ${response.status}`);
    return parseOverview(await response.text());
  }
  async function reload() {
    $id('srsStatus').textContent = 'Načítavam Produkciu…';
    try {
      const p = await fetchOverview();
      if (!p.data.length) throw new Error(`Nepodarilo sa načítať údaje dedín (${p.seen} riadkov).`);
      let inbound = { byId:{}, parsed:0, withoutETA:0 };
      try { inbound = await fetchIncoming(); }
      catch (err) { console.warn('Prichádzajúce transporty sa nenačítali:', err.message); }
      villages = p.data.map(v => ({
        ...v,
        incomingTransfers: inbound.byId[v.id]?.transfers || [],
        incomingUnknown: inbound.byId[v.id]?.unknown || [0,0,0]
      }));
      snapshotAt = Date.now();
      alreadySent.clear();
      $id('srsStatus').innerHTML = `<span class="srs-ok">✓ ${p.data.length}/${p.seen} dedín načítaných</span>` +
        (p.warnings.length ? ` · <span class="srs-bad">${p.warnings.length} problémových riadkov: ${html(p.warnings.slice(0,4).join('; '))}</span>` : '') +
        ` · Na ceste: ${inbound.parsed} transportov${inbound.withoutETA ? ' ('+inbound.withoutETA+' bez času)' : ''}` +
        ` · ${new Date(snapshotAt).toLocaleTimeString('sk-SK')}`;
      run();
    } catch (err) { $id('srsStatus').textContent = 'Chyba: '+err.message; $id('srsOutput').textContent = ''; }
  }
  function run() {
    readForm();
    if (!villages.length) return;
    try {
      results = compareStrategies(villages, settings);
      chosen = results.chosen;
      render();
    } catch (err) {
      chosen = null;
      $id('srsOutput').innerHTML = `<div class="srs-warn">${html(err.message)}</div>`;
    }
  }
  function render() {
    if (!chosen) return;
    const names = {direct:'PRIAMO',relay:'PREKLADISKÁ',hybrid:'HYBRID'};
    const a = chosen.actions;
    const initial = a.filter(x => x.minute === 0);
    const later = a.length - initial.length;
    const rounds = results.trials.map(p => `<tr><td>${names[p.mode]}</td><td><b>${fmt(p.coins)}</b></td><td>${fmt(summ(p.delivered))}</td><td>${fmt(p.actions.length)}</td><td>${fmt(p.merchantMinutes)} min</td></tr>`).join('');
    const hubStats = {};
    for (const t of a) {
      if (t.direct) continue;
      const key = t.toCoord;
      if (!hubStats[key]) hubStats[key] = { to: key, incoming: 0, count: 0, minArrival: Infinity };
      hubStats[key].incoming += t.amount;
      hubStats[key].count++;
      hubStats[key].minArrival = Math.min(hubStats[key].minArrival,t.arrival);
    }
    const topHubs = Object.values(hubStats).sort((x,y)=>y.incoming-x.incoming).slice(0,12);
    const hubTable = topHubs.length ? `<details><summary>Najviac využívané prekladiská (${Object.keys(hubStats).length})</summary><div class="srs-scroll"><table><thead><tr><th>Prekladisko</th><th>Plánovaný príjem</th><th>Zásielok</th><th>Prvý príjem</th></tr></thead><tbody>${topHubs.map(h=>`<tr><td>${html(h.to)}</td><td>${fmt(h.incoming)}</td><td>${h.count}</td><td>${timeMin(h.minArrival)}</td></tr>`).join('')}</tbody></table></div></details>` : '';
    const notActuallyFree = settings.assumeAllMerchants ?
      `<div class="srs-warn">Plán počíta so všetkými obchodníkmi ako voľnými.</div>` : '';
    $id('srsOutput').innerHTML = `
      <div class="srs-summary"><b>Vybrané: ${names[chosen.mode]}</b> · horizont ${settings.horizonHours} h ·
        <b>${fmt(chosen.coins)} mincí</b> (simulácia okamžitého razenia) ·
        ${fmt(a.length)} presunov (${fmt(initial.length)} v čase 0 / ${fmt(later)} neskôr) ·
        ${fmt(chosen.packageActions.length)} simulovaných aktivácií balíčkov.<br>
        Do razenice počas horizontu: ${chosen.delivered.map(fmt).join(' / ')} drevo/hlina/železo. Posledné razenie: ${chosen.lastCoinAt === null ? 'žiadne' : timeMin(chosen.lastCoinAt)}.</div>
      ${notActuallyFree}
      ${settings.packagesPerVillage > 0 && settings.packagePercent > 0 ? `<div class="srs-warn">Balíčky sú len hypotetické. Simulované ${settings.packagePercent}% skladu každej suroviny × ${settings.packagesPerVillage} ks V KAŽDEJ DEDINE; pred použitím nastav skutočné hodnoty.</div>` : ''}
      <details><summary>Porovnanie troch stratégií (priame / relay / hybrid)</summary><div class="srs-scroll"><table><tr><th>Stratégia</th><th>Mince</th><th>Doručené do 003</th><th>Transporty</th><th>Obchodník-minúty</th></tr>${rounds}</table></div></details>
      ${hubTable}
      <div class="srs-row" style="margin-bottom:5px"><b>Harmonogram presunov</b><span class="srs-note">Zelené tlačidlo len pri krokoch plánovaných na začiatok. Po ďalších príchodoch vždy obnov prehľad.</span></div>
      <div class="srs-scroll"><table><thead><tr><th>#</th><th>Odoslať v</th><th>Zdroj → cieľ</th><th>Druh</th><th>Príchod</th><th>Návrat</th><th>Obch.</th><th>Drevo</th><th>Hlina</th><th>Železo</th><th>Akcia</th></tr></thead>
      <tbody>${a.map((t,i) => `<tr data-plan="${html(t.id)}"><td>${i+1}</td><td>${timeMin(t.minute)}</td>
        <td><b>${html(t.fromCoord)}</b> → <b>${html(t.toCoord)}</b><br><small>${html(t.from)}</small></td>
        <td><span class="srs-tag">${t.direct?'🎯 RAZENICA':'🔁 PREKLAD'}</span></td>
        <td>${timeMin(t.arrival)}</td><td>${timeMin(t.back)}</td><td>${t.traders}</td>
        <td>${fmt(t.cargo[0])}</td><td>${fmt(t.cargo[1])}</td><td>${fmt(t.cargo[2])}</td>
        <td>${t.minute === 0 ? `<button class="srs-send" data-send="${html(t.id)}">Poslať</button>` : `<button disabled title="Najprv načítaj aktuálny stav">Obnov plán</button>`}</td></tr>`).join('')}</tbody></table></div>
      <details><summary>Simulované razenie (${chosen.coinTimeline.length} udalostí)</summary>
        ${chosen.coinTimeline.map(c=>`<div>${timeMin(c.minute)} · +${c.count} mincí · celkom ${c.total}</div>`).join('') || 'Žiadne'}</details>
      <details><summary>Simulované aktivácie balíčkov (${chosen.packageActions.length})</summary>
        ${chosen.packageActions.slice(0,200).map(e=>`<div>${timeMin(e.minute)} · ${html(e.coord)} · +${fmt(e.amount)} / druh</div>`).join('') || 'Žiadne'}
      </details>`;
    for (const b of $id('srsOutput').querySelectorAll('[data-send]')) {
      b.addEventListener('click', async () => {
        const transport = a.find(x=>x.id===b.dataset.send);
        if (transport) await sendOne(transport,b);
      });
    }
  }
  async function sendOne(t, button) {
    if (button.disabled || alreadySent.has(t.id)) return;
    button.disabled = true;
    button.textContent = 'Overujem…';
    try {
      // Nikdy never iba virtuálne voľným obchodníkom. Skontroluj živý stav.
      const live = await fetchOverview();
      const source = live.data.find(x => x.id === t.fromId);
      const destination = live.data.find(x => x.id === t.toId);
      if (!source || !destination) throw new Error('Zdroj/cieľ už nie je dostupný v prehľade.');
      if (source.merchants < t.traders) throw new Error(`V ${t.fromCoord} je iba ${source.merchants} voľných obchodníkov, potrebuješ ${t.traders}.`);
      if (RES.some((k,j) => source[k] < t.cargo[j])) throw new Error('V zdroji už nie je dosť surovín. Obnov plán.');
      // Kapacitu pri príchode nemožno bez znalosti ďalších transportov garantovať.
      // Hra prípadný presah skladu spracuje podľa svojich pravidiel.
      button.textContent = 'Posielam…';
      root.TribalWars.post('market', { ajaxaction:'map_send', village:t.fromId },
        { target_id:t.toId, wood:t.cargo[0], stone:t.cargo[1], iron:t.cargo[2] },
        response => {
          alreadySent.add(t.id);
          button.disabled = true;
          button.textContent = '✓ Odoslané';
          if (root.UI && typeof root.UI.SuccessMessage === 'function') root.UI.SuccessMessage(response?.message || 'Transport odoslaný.');
        }, false);
    } catch (err) {
      button.disabled = false;
      button.textContent = 'Znova skúsiť';
      alert('SMART RES SENDER: '+err.message);
      console.error('SMART RES SENDER',err);
    }
  }
  function csv(type) {
    if (!chosen) return;
    const encode = x=>'"'+String(x).replace(/"/g,'""')+'"';
    let header, lines, file;
    if (type==='coins') {
      header=['Čas od štartu (min)','Vyrazené mince','Spolu'];
      lines=chosen.coinTimeline.map(x=>[x.minute,x.count,x.total]);
      file='SK106-razenie-harmonogram.csv';
    } else {
      header=['Poradie','Od štartu (min)','Zdroj ID','Zdroj súradnice','Cieľ ID','Cieľ súradnice','Druh','Drevo','Hlina','Železo','Obchodníci','Polia','Príchod od štartu (min)','Návrat od štartu (min)'];
      lines=chosen.actions.map((x,i)=>[i+1,x.minute,x.fromId,x.fromCoord,x.toId,x.toCoord,x.direct?'RAZENICA':'PREKLAD',...x.cargo,x.traders,x.fields.toFixed(3),x.arrival.toFixed(2),x.back.toFixed(2)]);
      file='SK106-SMART-transporty-v2.csv';
    }
    const content='\ufeff'+[header,...lines].map(r=>r.map(encode).join(';')).join('\r\n');
    const url=URL.createObjectURL(new Blob([content],{type:'text/csv;charset=utf-8'}));
    const link=document.createElement('a');link.href=url;link.download=file;document.body.append(link);link.click();link.remove();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  $id('srsReload').addEventListener('click', reload);
  $id('srsRun').addEventListener('click', run);
  $id('srsCsv').addEventListener('click', ()=>csv('transport'));
  $id('srsCsvCoins').addEventListener('click', ()=>csv('coins'));
  reload();
})();