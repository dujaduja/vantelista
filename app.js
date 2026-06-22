/* Digital Väntelista – huvudlogik.
   Ren frontend, all data i IndexedDB (via DB i db.js). */
(function () {
  'use strict';

  /** @type {Array} alla sällskap (alla statusar, alla dagar) */
  let parties = [];

  /** @type {Set<string>} id på kort som är expanderade (endast mobilvyn) */
  const expandedCards = new Set();

  // ---- Hjälpare -----------------------------------------------------------

  const $ = (sel) => document.querySelector(sel);

  function uid() {
    return 'p-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  function dayKey(ts) {
    const d = new Date(ts);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  const todayKey = () => dayKey(Date.now());

  function fmtTime(ts) {
    if (!ts) return '–';
    const d = new Date(ts);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function fmtDuration(ms) {
    if (ms == null || ms < 0) return '–';
    const totalMin = Math.floor(ms / 60000);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return h > 0 ? `${h}h ${m}m` : `${m} min`;
  }

  let toastTimer = null;
  // Visa en kort notis. action = { label, fn } ger en knapp (t.ex. "Ångra").
  function toast(msg, action) {
    const el = $('#toast');
    el.innerHTML = '';
    const span = document.createElement('span');
    span.textContent = msg;
    el.appendChild(span);
    if (action) {
      const btn = document.createElement('button');
      btn.className = 'toast-action';
      btn.textContent = action.label;
      btn.addEventListener('click', () => {
        el.hidden = true;
        clearTimeout(toastTimer);
        action.fn();
      });
      el.appendChild(btn);
    }
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, action ? 6000 : 2200);
  }

  // ---- Persistens ---------------------------------------------------------
  // Två lager för trygghet:
  //  1) IndexedDB – primärt lager (överlever omladdning, omstart, offline).
  //  2) localStorage – synkron spegel som skrivs vid *varje* ändring. Eftersom
  //     den skrivs direkt (inte asynkront som IndexedDB) är den ett skyddsnät
  //     om appen kraschar mitt i en skrivning. Vid start slås lagren ihop och
  //     nyaste posten per id vinner.

  const LS_KEY = 'vantelista-snapshot';

  function writeLocalSnapshot() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ savedAt: Date.now(), parties }));
    } catch (e) { /* localStorage full/avstängt – IndexedDB är ändå primärt */ }
  }

  function readLocalSnapshot() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function markSaveError() {
    // Data finns kvar i localStorage-spegeln; varna så man kan exportera.
    toast('⚠️ Kunde inte spara till databasen – exportera som backup');
  }

  // Skriv en ändrad post till IndexedDB. Debounce *per post* (inte globalt),
  // så att snabba ändringar på olika rader aldrig skriver över varandra.
  const idbTimers = new Map();
  function persistParty(p) {
    p.updatedAt = Date.now();
    writeLocalSnapshot(); // synkront skyddsnät direkt
    clearTimeout(idbTimers.get(p.id));
    idbTimers.set(p.id, setTimeout(() => {
      idbTimers.delete(p.id);
      DB.put(p).catch((e) => { console.error(e); markSaveError(); });
    }, 200));
  }

  // Skriv direkt (för viktiga händelser: lägga till, klart, gick utan bord).
  function persistNow(p) {
    p.updatedAt = Date.now();
    writeLocalSnapshot();
    DB.put(p).catch((e) => { console.error(e); markSaveError(); });
  }

  // Spola allt vid bakgrund/nedstängning. localStorage hinner alltid (synkront).
  function flushAll() {
    writeLocalSnapshot();
    DB.putAll(parties).catch((e) => console.error(e));
  }

  // Slå ihop två källor på id, behåll den med nyast updatedAt.
  function mergeSources(a, b) {
    const map = new Map();
    [].concat(a || [], b || []).forEach((p) => {
      if (!p || !p.id) return;
      const cur = map.get(p.id);
      if (!cur || (p.updatedAt || 0) >= (cur.updatedAt || 0)) map.set(p.id, p);
    });
    return Array.from(map.values());
  }

  async function saveAll() {
    writeLocalSnapshot();
    try {
      await DB.putAll(parties);
      toast('Sparat lokalt ✓');
    } catch (e) {
      console.error(e);
      toast('Sparat som säkerhetskopia ⚠️');
    }
  }

  // ---- Vyer / filter ------------------------------------------------------

  const waiting = () => parties.filter((p) => p.status === 'waiting');

  // ---- Rendering av kö ----------------------------------------------------

  function updateClock() {
    const el = $('#clock');
    if (!el) return;
    const d = new Date();
    el.textContent = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function renderCounters() {
    const w = waiting();
    $('#countParties').textContent = w.length;
    $('#countPax').textContent = w.reduce((sum, p) => sum + (Number(p.pax) || 0), 0);
  }

  function rowHtml(p) {
    const ctag = countryInfo(p.phone);
    const flag = countryFlag(p.phone);
    return `
      <tr data-id="${p.id}" class="row" data-status="${p.status}">
        <td class="col-status"><span class="dot"></span></td>
        <td class="card-summary" data-act="toggle-card">
          <span class="cs-dot"></span>
          <span class="cs-name">${escapeHtml(p.name) || '<span class="cs-noname">(utan namn)</span>'}</span>
          ${flag ? `<span class="cs-flag">${flag}</span>` : ''}
          ${p.pax ? `<span class="cs-pax">${p.pax} pers</span>` : ''}
          ${String(p.table || '').trim() ? `<span class="cs-bord">Bord ${escapeHtml(p.table)}</span>` : ''}
          <span class="cs-wait" data-elapsed-sum>–</span>
          <span class="cs-chevron">▾</span>
        </td>
        <td class="col-phone" data-label="Telefon">
          <span class="phone" data-act="copy">${escapeHtml(p.phone) || '<span class="muted">–</span>'}</span>
          ${ctag ? `<span class="country-tag">${ctag}</span>` : ''}
          <button class="phone-edit" data-act="edit-phone" title="Ändra nummer">✎</button>
          ${p.calledAt ? `<span class="called-badge" title="Uppringd">📞 ${fmtTime(p.calledAt)}</span>` : ''}
        </td>
        <td data-label="Namn"><input class="cell" data-f="name" value="${escapeAttr(p.name)}" placeholder="Namn" /></td>
        <td class="col-pax" data-label="PAX"><input class="cell num" data-f="pax" type="number" min="1" inputmode="numeric" value="${p.pax ?? ''}" placeholder="–" /></td>
        <td data-label="Kommentar"><input class="cell" data-f="comment" value="${escapeAttr(p.comment)}" placeholder="–" /></td>
        <td class="col-table" data-label="Bord"><input class="cell num" data-f="table" value="${escapeAttr(p.table)}" placeholder="–" /></td>
        <td class="col-checks" data-label="Skugga / Brygga">
          <label class="chk"><input type="checkbox" data-f="shadow" ${p.shadow ? 'checked' : ''}/> S</label>
          <label class="chk"><input type="checkbox" data-f="bridge" ${p.bridge ? 'checked' : ''}/> B</label>
        </td>
        <td class="col-time arrival" data-label="Ankomst">${fmtTime(p.arrival)}</td>
        <td class="col-time" data-label="Est."><input class="cell num est" data-f="est" type="number" min="0" step="15" inputmode="numeric" value="${p.est ?? ''}" placeholder="–" /></td>
        <td class="col-time elapsed" data-elapsed data-label="Väntat">–</td>
        <td class="col-actions">
          <button class="btn btn-call ${p.calledAt ? 'is-called' : ''}" data-act="called" title="Markera uppringd">📞</button>
          <button class="btn btn-done" data-act="done" title="Klart">✓</button>
          <button class="btn btn-left" data-act="left" title="Gick utan bord">✕</button>
        </td>
      </tr>`;
  }

  function renderQueue() {
    const body = $('#queueBody');
    const all = waiting();
    const list = all.filter(paxMatches);
    const empty = $('#emptyState');

    if (list.length === 0) {
      body.innerHTML = '';
      empty.hidden = false;
      empty.textContent = all.length > 0
        ? 'Inga sällskap matchar PAX-filtret.'
        : 'Inga sällskap i kö. Lägg till ovan.';
    } else {
      empty.hidden = true;
      body.innerHTML = list.map(rowHtml).join('');
    }
    applyRowStates();
    updateElapsed();
    renderCounters();
    updatePaxCounts();
  }

  /** Sätt gul/utgråad markering per rad utan att rendera om. */
  function applyRowStates() {
    document.querySelectorAll('#queueBody tr').forEach((tr) => {
      const p = byId(tr.dataset.id);
      if (!p) return;
      tr.classList.toggle('assigned', p.status === 'waiting' && !!String(p.table || '').trim());
      tr.classList.toggle('is-done', p.status === 'done');
      tr.classList.toggle('expanded', expandedCards.has(tr.dataset.id));
    });
  }

  /** Uppdatera "väntat"-cellerna varje sekund och färga rött vid övertid. */
  function updateElapsed() {
    const now = Date.now();
    document.querySelectorAll('#queueBody tr').forEach((tr) => {
      const p = byId(tr.dataset.id);
      if (!p) return;
      const end = p.status === 'waiting' ? now : (p.statusTime || now);
      const elapsedMs = end - p.arrival;
      const text = fmtDuration(elapsedMs);
      const over = !!(p.est != null && p.est !== '' && elapsedMs > Number(p.est) * 60000) && p.status === 'waiting';
      const cell = tr.querySelector('[data-elapsed]');
      if (cell) { cell.textContent = text; cell.classList.toggle('overdue', over); }
      const sum = tr.querySelector('[data-elapsed-sum]');
      if (sum) { sum.textContent = text; sum.classList.toggle('overdue', over); }
      tr.classList.toggle('overdue-row', over);
    });
  }

  // ---- Datamanipulation ---------------------------------------------------

  const byId = (id) => parties.find((p) => p.id === id);

  function addParty(data) {
    const p = {
      id: uid(),
      phone: data.phone || '',
      name: data.name || '',
      pax: data.pax === '' || data.pax == null ? null : Number(data.pax),
      comment: data.comment || '',
      table: data.table || '',
      shadow: !!data.shadow,
      bridge: !!data.bridge,
      est: data.est === '' || data.est == null ? null : Number(data.est),
      arrival: data.arrival || Date.now(),
      status: 'waiting',
      statusTime: null,
      day: todayKey(),
      updatedAt: Date.now(),
    };
    parties.push(p);
    persistNow(p);
    renderQueue();
    return p;
  }

  function setStatus(id, status) {
    const p = byId(id);
    if (!p) return;
    const prev = { status: p.status, statusTime: p.statusTime };
    p.status = status;
    p.statusTime = Date.now();
    expandedCards.delete(id);
    persistNow(p);
    renderQueue();
    if (status === 'done' || status === 'left') {
      const label = status === 'done' ? 'Klart' : 'Gick utan bord';
      const who = p.name || p.phone || 'sällskap';
      toast(`${label}: ${who}`, { label: 'Ångra', fn: () => revertStatus(id, prev) });
    }
  }

  function revertStatus(id, prev) {
    const p = byId(id);
    if (!p) return;
    p.status = prev.status;
    p.statusTime = prev.statusTime;
    persistNow(p);
    renderQueue();
    toast('Återställd');
  }

  // Återför ett sällskap från historiken till kön (vid felklick).
  function restoreToQueue(id) {
    const p = byId(id);
    if (!p) return;
    p.status = 'waiting';
    p.statusTime = null;
    persistNow(p);
    renderQueue();
    renderHistory();
    toast('Återförd till kön');
  }

  // Fäll ut/ihop ett kort (endast mobilvyn). Tillståndet sparas i en Set så
  // det överlever omrendering.
  function toggleCard(tr, id) {
    if (expandedCards.has(id)) { expandedCards.delete(id); tr.classList.remove('expanded'); }
    else { expandedCards.add(id); tr.classList.add('expanded'); }
  }

  // Markera/avmarkera att sällskapet är uppringt (med tidsstämpel).
  function toggleCalled(id) {
    const p = byId(id);
    if (!p) return;
    p.calledAt = p.calledAt ? null : Date.now();
    persistNow(p);
    renderQueue();
  }

  function updateField(id, field, value) {
    const p = byId(id);
    if (!p) return;
    if (field === 'pax' || field === 'est') {
      p[field] = value === '' ? null : Number(value);
    } else if (field === 'shadow' || field === 'bridge') {
      p[field] = !!value;
    } else {
      p[field] = value;
    }
    persistParty(p);
  }

  // ---- Clipboard / Handoff ------------------------------------------------

  async function copyPhone(phone) {
    if (!phone) return;
    try {
      await navigator.clipboard.writeText(phone);
      toast(`Kopierat: ${phone}`);
    } catch (e) {
      // Fallback för äldre webkit
      const ta = document.createElement('textarea');
      ta.value = phone;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); toast(`Kopierat: ${phone}`); }
      catch (_) { toast('Kunde inte kopiera'); }
      document.body.removeChild(ta);
    }
  }

  // ---- Landsdetektering från landskod -------------------------------------
  // Karta landskod -> ISO-landskod. Längsta prefix vinner (1–4 siffror).
  const DIAL_CODES = {
    '1': 'US', '7': 'RU', '20': 'EG', '27': 'ZA', '30': 'GR', '31': 'NL',
    '32': 'BE', '33': 'FR', '34': 'ES', '36': 'HU', '39': 'IT', '40': 'RO',
    '41': 'CH', '43': 'AT', '44': 'GB', '45': 'DK', '46': 'SE', '47': 'NO',
    '48': 'PL', '49': 'DE', '51': 'PE', '52': 'MX', '53': 'CU', '54': 'AR',
    '55': 'BR', '56': 'CL', '57': 'CO', '58': 'VE', '60': 'MY', '61': 'AU',
    '62': 'ID', '63': 'PH', '64': 'NZ', '65': 'SG', '66': 'TH', '81': 'JP',
    '82': 'KR', '84': 'VN', '86': 'CN', '90': 'TR', '91': 'IN', '92': 'PK',
    '212': 'MA', '213': 'DZ', '216': 'TN', '218': 'LY', '234': 'NG',
    '254': 'KE', '297': 'AW', '298': 'FO', '299': 'GL', '350': 'GI',
    '351': 'PT', '352': 'LU', '353': 'IE', '354': 'IS', '355': 'AL',
    '356': 'MT', '357': 'CY', '358': 'FI', '359': 'BG', '370': 'LT',
    '371': 'LV', '372': 'EE', '373': 'MD', '374': 'AM', '375': 'BY',
    '376': 'AD', '377': 'MC', '378': 'SM', '380': 'UA', '381': 'RS',
    '382': 'ME', '385': 'HR', '386': 'SI', '387': 'BA', '389': 'MK',
    '420': 'CZ', '421': 'SK', '423': 'LI', '852': 'HK', '853': 'MO',
    '880': 'BD', '886': 'TW', '960': 'MV', '961': 'LB', '962': 'JO',
    '964': 'IQ', '965': 'KW', '966': 'SA', '967': 'YE', '968': 'OM',
    '971': 'AE', '972': 'IL', '973': 'BH', '974': 'QA', '975': 'BT',
    '976': 'MN', '977': 'NP', '992': 'TJ', '993': 'TM', '994': 'AZ',
    '995': 'GE', '996': 'KG', '998': 'UZ',
  };

  function isoToFlag(iso) {
    return iso.replace(/./g, (c) => String.fromCodePoint(127397 + c.charCodeAt(0)));
  }

  function detectCountry(phone) {
    const raw = String(phone || '').trim();
    let rest;
    if (raw.startsWith('+')) rest = raw.slice(1);
    else if (raw.startsWith('00')) rest = raw.slice(2);
    else return null;
    const digits = rest.replace(/\D/g, '');
    for (let len = 4; len >= 1; len--) {
      const iso = DIAL_CODES[digits.slice(0, len)];
      if (iso) return { iso, flag: isoToFlag(iso) };
    }
    return null;
  }

  // Flagga + ISO för listan/formuläret; 🌍 för okänd landskod; '' för inhemskt.
  function countryInfo(phone) {
    const c = detectCountry(phone);
    if (c) return c.flag + ' ' + c.iso;
    const raw = String(phone || '').trim();
    return (raw.startsWith('+') || raw.startsWith('00')) ? '🌍' : '';
  }

  // Bara flaggan (för den kompakta kortvyn).
  function countryFlag(phone) {
    const c = detectCountry(phone);
    if (c) return c.flag;
    const raw = String(phone || '').trim();
    return (raw.startsWith('+') || raw.startsWith('00')) ? '🌍' : '';
  }

  // ---- Add-form ------------------------------------------------------------

  let pendingArrival = null; // sätts när man börjar skriva telefon
  let pendingEst = null;     // vald est. väntetid (minuter) i add-formuläret

  // Returnerar ett varningsmeddelande om numret varken är 10 siffror
  // (vanligt svenskt mobilnummer) eller börjar med landskod, annars null.
  function phoneIssue(value) {
    const v = String(value || '').trim();
    if (v === '') return null;
    if (v.startsWith('+') || v.startsWith('00')) return null;
    const digits = v.replace(/\D/g, '');
    if (digits.length === 10) return null;
    return `Ovanligt nummer: ${digits.length} siffror. Förväntar 10 siffror eller landskod (t.ex. +46).`;
  }

  function updatePhoneWarning() {
    const phone = $('#f-phone');
    const warn = $('#phoneWarn');
    const issue = phoneIssue(phone.value);
    warn.textContent = issue || '';
    warn.hidden = !issue;
    phone.classList.toggle('warn', !!issue);
    const country = $('#phoneCountry');
    if (country) {
      const tag = countryInfo(phone.value);
      country.textContent = tag;
      country.hidden = !tag;
    }
  }

  function resetForm() {
    ['f-phone', 'f-name', 'f-pax', 'f-comment'].forEach((id) => {
      document.getElementById(id).value = '';
    });
    document.getElementById('f-shadow').checked = false;
    document.getElementById('f-bridge').checked = false;
    pendingArrival = null;
    pendingEst = null;
    document.querySelectorAll('#estChips .est-chip').forEach((c) => c.classList.remove('selected'));
    $('#f-arrival').textContent = '–';
    updatePhoneWarning();
  }

  function initForm() {
    const phone = $('#f-phone');
    // Ankomsttid fylls i automatiskt så fort man börjar skriva telefonnummer
    phone.addEventListener('input', () => {
      if (pendingArrival == null && phone.value.trim() !== '') {
        pendingArrival = Date.now();
        $('#f-arrival').textContent = fmtTime(pendingArrival);
      }
      if (phone.value.trim() === '') {
        pendingArrival = null;
        $('#f-arrival').textContent = '–';
      }
      updatePhoneWarning();
    });

    // Kvarts-knappar för estimerad väntetid (toggla val).
    $('#estChips').addEventListener('click', (e) => {
      const chip = e.target.closest('.est-chip');
      if (!chip) return;
      const min = Number(chip.dataset.min);
      pendingEst = pendingEst === min ? null : min;
      document.querySelectorAll('#estChips .est-chip').forEach((c) =>
        c.classList.toggle('selected', Number(c.dataset.min) === pendingEst));
    });

    $('#addForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const data = {
        phone: $('#f-phone').value.trim(),
        name: $('#f-name').value.trim(),
        pax: $('#f-pax').value.trim(),
        comment: $('#f-comment').value.trim(),
        est: pendingEst == null ? '' : pendingEst,
        shadow: $('#f-shadow').checked,
        bridge: $('#f-bridge').checked,
        arrival: pendingArrival || Date.now(),
      };
      const hasAny = data.phone || data.name || data.pax || data.comment ||
        data.est || data.shadow || data.bridge;
      if (!hasAny) { toast('Fyll i minst ett fält'); return; }
      addParty(data);
      resetForm();
      $('#f-phone').focus();
    });
  }

  // ---- Kö-interaktioner (event-delegation) --------------------------------

  function initQueueEvents() {
    const body = $('#queueBody');

    body.addEventListener('click', (e) => {
      const actEl = e.target.closest('[data-act]');
      if (!actEl) return;
      const tr = e.target.closest('tr');
      const id = tr && tr.dataset.id;
      const act = actEl.dataset.act;
      if (act === 'toggle-card') {
        toggleCard(tr, id);
      } else if (act === 'copy') {
        const p = byId(id);
        if (p) copyPhone(p.phone);
      } else if (act === 'edit-phone') {
        startPhoneEdit(tr, id);
      } else if (act === 'called') {
        toggleCalled(id);
      } else if (act === 'done') {
        setStatus(id, 'done');
      } else if (act === 'left') {
        const p = byId(id);
        const who = p && (p.name || p.phone) ? ` – ${p.name || p.phone}` : '';
        if (confirm(`Markera som "Gick utan bord"?${who}`)) setStatus(id, 'left');
      }
    });

    body.addEventListener('input', (e) => {
      const el = e.target.closest('[data-f]');
      if (!el) return;
      const tr = e.target.closest('tr');
      const id = tr && tr.dataset.id;
      const field = el.dataset.f;
      const value = el.type === 'checkbox' ? el.checked : el.value;
      updateField(id, field, value);
      if (field === 'table') { applyRowStates(); }
      if (field === 'pax') { renderCounters(); updatePaxCounts(); }
      if (field === 'est') { updateElapsed(); }
      if (field === 'shadow' || field === 'bridge') { /* enbart spara */ }
    });

    initSwipe(body);
  }

  // Redigera telefonnumret i efterhand (pennan). Byter ut numret mot ett
  // fält; Enter/blur sparar, Escape avbryter.
  function startPhoneEdit(tr, id) {
    const p = byId(id);
    if (!p) return;
    const td = tr.querySelector('.col-phone');
    if (!td) return;
    td.innerHTML = `<input class="cell phone-input" type="tel" inputmode="tel" value="${escapeAttr(p.phone)}" />`;
    const input = td.querySelector('input');
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    let settled = false;
    const commit = () => {
      if (settled) return; settled = true;
      updateField(id, 'phone', input.value.trim());
      renderQueue();
    };
    const cancel = () => {
      if (settled) return; settled = true;
      renderQueue();
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    });
  }

  // Swipa en rad åt vänster för att markera bordet som klart.
  // touch-action: pan-y i CSS gör att vertikal scroll funkar som vanligt
  // medan horisontella drag hamnar här.
  const SWIPE_THRESHOLD = 100; // px innan klart-läge nås
  let sw = null;

  function initSwipe(body) {
    body.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const tr = e.target.closest('tr');
      if (!tr || !tr.dataset.id) return;
      sw = { tr, id: tr.dataset.id, startX: e.clientX, startY: e.clientY, dx: 0, dragging: false, pointerId: e.pointerId };
    });

    const onMove = (e) => {
      if (!sw || e.pointerId !== sw.pointerId) return;
      const dx = e.clientX - sw.startX;
      const dy = e.clientY - sw.startY;
      if (!sw.dragging) {
        if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) {
          sw.dragging = true;
          sw.tr.classList.add('swiping');
          try { sw.tr.setPointerCapture(sw.pointerId); } catch (_) {}
          const a = document.activeElement;
          if (a && sw.tr.contains(a) && a.blur) a.blur();
        } else if (Math.abs(dy) > 10) {
          sw = null; return;
        } else { return; }
      }
      sw.dx = Math.min(0, dx); // bara vänster
      sw.tr.style.transform = `translateX(${Math.max(sw.dx, -window.innerWidth)}px)`;
      sw.tr.classList.toggle('will-complete', sw.dx < -SWIPE_THRESHOLD);
    };

    const onUp = () => {
      if (!sw) return;
      const { tr, id, dx, dragging, pointerId } = sw;
      try { tr.releasePointerCapture(pointerId); } catch (_) {}
      sw = null;
      tr.classList.remove('swiping', 'will-complete');
      tr.style.transform = '';
      if (dragging && dx < -SWIPE_THRESHOLD) setStatus(id, 'done');
    };

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
  }

  // ---- Historik -----------------------------------------------------------

  function statusLabel(s) {
    return s === 'done' ? 'Klart' : s === 'left' ? 'Gick utan bord' : 'I kö';
  }

  function renderHistory() {
    const hist = parties
      .filter((p) => p.status === 'done' || p.status === 'left')
      .sort((a, b) => (b.statusTime || 0) - (a.statusTime || 0));
    const box = $('#historyBody');
    if (hist.length === 0) {
      box.innerHTML = '<p class="empty-state">Ingen historik ännu.</p>';
      return;
    }
    box.innerHTML = `
      <table class="hist-table">
        <thead><tr>
          <th>Status</th><th>Telefon</th><th>Namn</th><th>PAX</th>
          <th>Bord</th><th>S/B</th><th>Ankomst</th><th>Klar/lämnade</th><th>Väntat</th><th></th>
        </tr></thead>
        <tbody>
          ${hist.map((p) => `
            <tr class="hist-${p.status}">
              <td>${statusLabel(p.status)}</td>
              <td>${escapeHtml(p.phone) || '–'}</td>
              <td>${escapeHtml(p.name) || '–'}</td>
              <td>${p.pax ?? '–'}</td>
              <td>${escapeHtml(p.table) || '–'}</td>
              <td>${p.shadow ? 'S' : ''}${p.bridge ? 'B' : ''}${!p.shadow && !p.bridge ? '–' : ''}</td>
              <td>${fmtTime(p.arrival)}</td>
              <td>${fmtTime(p.statusTime)}</td>
              <td>${fmtDuration((p.statusTime || p.arrival) - p.arrival)}</td>
              <td><button class="btn btn-restore" data-act="restore" data-id="${p.id}" title="Återför till kön">↩︎ Till kö</button></td>
            </tr>`).join('')}
        </tbody>
      </table>`;
  }

  // ---- Summering ----------------------------------------------------------

  function maxConcurrent(list, weightFn) {
    // Maximal samtidig kö (överlapp av [ankomst, slut]). weightFn anger hur
    // mycket varje sällskap väger – 1 för antal sällskap, pax för personer.
    const weight = weightFn || (() => 1);
    const events = [];
    list.forEach((p) => {
      const end = p.statusTime || Date.now();
      const val = weight(p);
      events.push([p.arrival, val]);
      events.push([end, -val]);
    });
    events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let cur = 0, max = 0;
    events.forEach(([, delta]) => { cur += delta; if (cur > max) max = cur; });
    return max;
  }

  function computeStats() {
    const today = todayKey();
    const list = parties.filter((p) => p.day === today);
    const totalParties = list.length;
    const totalPax = list.reduce((s, p) => s + (Number(p.pax) || 0), 0);
    const left = list.filter((p) => p.status === 'left');
    const done = list.filter((p) => p.status === 'done');
    const withPax = list.filter((p) => Number(p.pax) > 0);
    const avgPax = withPax.length ? totalPax / withPax.length : 0;

    const waits = done.map((p) => (p.statusTime || p.arrival) - p.arrival).filter((m) => m > 0);
    const avgWait = waits.length ? waits.reduce((a, b) => a + b, 0) / waits.length : 0;

    // Nationaliteter: landskod -> land, annars svensk (inhemskt/utan nummer).
    const nationalities = {};
    list.forEach((p) => {
      const c = detectCountry(p.phone);
      const iso = c ? c.iso : 'SE';
      nationalities[iso] = (nationalities[iso] || 0) + 1;
    });
    const seCount = nationalities['SE'] || 0;

    return {
      totalParties,
      totalPax,
      avgPax,
      avgWaitMs: avgWait,
      maxConcurrent: maxConcurrent(list),
      maxConcurrentPax: maxConcurrent(list, (p) => Number(p.pax) || 0),
      shadow: list.filter((p) => p.shadow).length,
      bridge: list.filter((p) => p.bridge).length,
      left: left.length,
      done: done.length,
      stillWaiting: list.filter((p) => p.status === 'waiting').length,
      nationalities,
      nationalityCount: Object.keys(nationalities).length,
      swedishPct: totalParties ? Math.round((seCount / totalParties) * 100) : 0,
    };
  }

  function renderSummary() {
    const s = computeStats();
    const rows = [
      ['Totalt antal sällskap', s.totalParties],
      ['Totalt antal personer', s.totalPax],
      ['Snittstorlek på sällskap', s.avgPax ? s.avgPax.toFixed(1) : '–'],
      ['Genomsnittlig väntetid (avklarade)', s.avgWaitMs ? fmtDuration(s.avgWaitMs) : '–'],
      ['Längsta kö (sällskap)', s.maxConcurrent],
      ['Flest antal personer i kö samtidigt', s.maxConcurrentPax],
      ['Skugga', s.shadow],
      ['Brygga', s.bridge],
      ['Gick utan bord', s.left],
      ['Avklarade', s.done],
      ['Kvar i kö nu', s.stillWaiting],
      ['Antal nationaliteter', s.nationalityCount],
      ['Andel svenskar', s.swedishPct + ' %'],
    ];
    const natChips = Object.keys(s.nationalities)
      .sort((a, b) => s.nationalities[b] - s.nationalities[a])
      .map((iso) => `<span class="nat-chip">${isoToFlag(iso)} ${iso} · ${s.nationalities[iso]}</span>`)
      .join('');
    $('#summaryBody').innerHTML = `
      <table class="stats-table">
        <tbody>
          ${rows.map(([k, v]) => `<tr><td class="stat-key">${k}</td><td class="stat-val">${v}</td></tr>`).join('')}
        </tbody>
      </table>
      ${natChips ? `<div class="nat-block"><div class="nat-title">Nationaliteter</div><div class="nat-list">${natChips}</div></div>` : ''}`;
  }

  // ---- Export -------------------------------------------------------------

  function download(filename, text, mime) {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportJson() {
    const today = todayKey();
    const list = parties.filter((p) => p.day === today);
    const payload = { exported: new Date().toISOString(), day: today, stats: computeStats(), parties: list };
    download(`vantelista-${today}.json`, JSON.stringify(payload, null, 2), 'application/json');
    toast('JSON exporterad');
  }

  function csvCell(v) {
    const s = v == null ? '' : String(v);
    return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  // Tvinga kalkylprogram (Excel/Numbers) att behålla värdet som text, så att
  // inledande nollor i t.ex. telefonnummer inte försvinner.
  function csvText(v) {
    const s = v == null ? '' : String(v);
    return s === '' ? '' : '="' + s.replace(/"/g, '""') + '"';
  }

  function exportCsv() {
    const today = todayKey();
    const list = parties.filter((p) => p.day === today);
    const headers = ['status', 'telefon', 'namn', 'pax', 'kommentar', 'bord', 'skugga', 'brygga', 'est_min', 'ankomst', 'status_tid', 'vantat_min'];
    const lines = [headers.join(';')];
    list.forEach((p) => {
      const waitMin = Math.round(((p.statusTime || Date.now()) - p.arrival) / 60000);
      lines.push([
        statusLabel(p.status), csvText(p.phone), p.name, p.pax ?? '', p.comment,
        p.table, p.shadow ? 'ja' : '', p.bridge ? 'ja' : '', p.est ?? '',
        new Date(p.arrival).toISOString(), p.statusTime ? new Date(p.statusTime).toISOString() : '',
        waitMin,
      ].map(csvCell).join(';'));
    });
    download(`vantelista-${today}.csv`, '﻿' + lines.join('\n'), 'text/csv');
    toast('CSV exporterad');
  }

  async function clearDay() {
    const today = todayKey();
    const list = parties.filter((p) => p.day === today);
    if (!confirm(`Rensa dagens ${list.length} poster? Exportera först om du vill behålla en backup.`)) return;
    await DB.removeMany(list.map((p) => p.id));
    parties = parties.filter((p) => p.day !== today);
    writeLocalSnapshot();
    renderQueue();
    renderSummary();
    toast('Dagen rensad');
  }

  // ---- Modaler ------------------------------------------------------------

  // Sätt sticky-offset för tabellhuvudet till topbarens faktiska höjd,
  // så att översta raden aldrig hamnar gömd bakom topbaren (den radbryts
  // och blir olika hög beroende på fönsterbredd).
  function syncTopbarHeight() {
    const bar = document.querySelector('.topbar');
    if (!bar) return;
    document.documentElement.style.setProperty('--topbar-h', bar.offsetHeight + 'px');
  }

  // Håll skärmen vaken under pågående service (släpps automatiskt om man
  // växlar bort; återtas vid visibilitychange).
  let wakeLock = null;
  async function requestWakeLock() {
    if (!('wakeLock' in navigator) || document.hidden) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener && wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch (e) { /* kräver ibland en användargest – återförsök sker vid interaktion */ }
  }

  // ---- Inställningar: tema + täthet (sparas mellan sessioner) -------------
  const SETTINGS_KEY = 'vantelista-settings';
  let settings = (() => {
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; }
    catch (e) { return {}; }
  })();

  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) {}
  }

  function applySettings() {
    document.documentElement.classList.toggle('dark', settings.theme === 'dark');
    document.documentElement.classList.toggle('compact', settings.density === 'compact');
    const t = $('#btnTheme');
    if (t) t.textContent = settings.theme === 'dark' ? '☀️' : '🌙';
    const d = $('#btnDensity');
    if (d) d.textContent = settings.density === 'compact' ? '≡ Normal' : '≣ Kompakt';
  }

  function toggleTheme() {
    settings.theme = settings.theme === 'dark' ? 'light' : 'dark';
    saveSettings(); applySettings();
  }
  function toggleDensity() {
    settings.density = settings.density === 'compact' ? 'comfortable' : 'compact';
    saveSettings(); applySettings();
  }

  // ---- PAX-snabbfilter -----------------------------------------------------
  let paxFilter = null; // null | '1-3' | '4-5' | '6' | '6+' (6+ = 7 eller fler)

  function paxMatches(p) {
    if (!paxFilter) return true;
    const n = Number(p.pax) || 0;
    if (paxFilter === '1-3') return n >= 1 && n <= 3;
    if (paxFilter === '4-5') return n >= 4 && n <= 5;
    if (paxFilter === '6') return n === 6;
    if (paxFilter === '6+') return n >= 7;
    return true;
  }

  function setPaxFilter(val) {
    paxFilter = val === 'all' ? null : val;
    document.querySelectorAll('#paxChips .pax-chip').forEach((c) =>
      c.classList.toggle('selected', c.dataset.pax === (paxFilter || 'all')));
    renderQueue();
  }

  function updatePaxCounts() {
    const counts = { '1-3': 0, '4-5': 0, '6': 0, '6+': 0 };
    waiting().forEach((p) => {
      const n = Number(p.pax) || 0;
      if (n >= 1 && n <= 3) counts['1-3']++;
      else if (n >= 4 && n <= 5) counts['4-5']++;
      else if (n === 6) counts['6']++;
      else if (n >= 7) counts['6+']++;
    });
    Object.keys(counts).forEach((k) => {
      const el = document.querySelector(`[data-pax-count="${k}"]`);
      if (el) el.textContent = counts[k];
    });
  }

  function openModal(id) { document.getElementById(id).hidden = false; }
  function closeModal(el) { el.hidden = true; }

  function initModals() {
    $('#btnHistory').addEventListener('click', () => { renderHistory(); openModal('historyModal'); });
    $('#btnSummary').addEventListener('click', () => { renderSummary(); openModal('summaryModal'); });
    $('#historyBody').addEventListener('click', (e) => {
      const b = e.target.closest('[data-act="restore"]');
      if (b) restoreToQueue(b.dataset.id);
    });
    document.querySelectorAll('[data-close]').forEach((b) =>
      b.addEventListener('click', (e) => closeModal(e.target.closest('.modal'))));
    document.querySelectorAll('.modal').forEach((m) =>
      m.addEventListener('click', (e) => { if (e.target === m) closeModal(m); }));
  }

  // ---- Escaping -----------------------------------------------------------

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  }
  function escapeAttr(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  // ---- Init ---------------------------------------------------------------

  async function init() {
    initForm();
    initQueueEvents();
    initModals();

    applySettings();
    $('#btnTheme').addEventListener('click', toggleTheme);
    $('#btnDensity').addEventListener('click', toggleDensity);
    $('#paxChips').addEventListener('click', (e) => {
      const c = e.target.closest('.pax-chip');
      if (c) setPaxFilter(c.dataset.pax);
    });
    $('#btnSave').addEventListener('click', saveAll);
    $('#btnExportJson').addEventListener('click', exportJson);
    $('#btnExportCsv').addEventListener('click', exportCsv);
    $('#btnClearDay').addEventListener('click', clearDay);

    // Läs båda lagren och slå ihop – återhämtar sig om något lager är
    // tomt, gammalt eller delvis skrivet.
    try {
      const fromIdb = await DB.getAll();
      const snap = readLocalSnapshot();
      parties = mergeSources(fromIdb, snap ? snap.parties : []);
      DB.putAll(parties).catch((e) => console.error(e)); // synka tillbaka
      writeLocalSnapshot();
    } catch (e) {
      console.error('Kunde inte läsa IndexedDB, faller tillbaka på localStorage', e);
      const snap = readLocalSnapshot();
      parties = snap && snap.parties ? snap.parties : [];
    }
    renderQueue();

    // Håll tabellhuvudets sticky-offset i synk med topbarens höjd.
    syncTopbarHeight();
    window.addEventListener('resize', syncTopbarHeight);

    // Live-uppdatering av väntetider och klocka varje sekund.
    updateClock();
    setInterval(() => { updateElapsed(); updateClock(); }, 1000);

    // Registrera service worker för offline/PWA. När en ny version tar över
    // laddas sidan om en gång automatiskt så att senaste koden visas.
    if ('serviceWorker' in navigator) {
      let reloading = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloading) return;
        reloading = true;
        flushAll(); // spara synkront precis innan omladdning, för säkerhets skull
        window.location.reload();
      });
      navigator.serviceWorker.register('sw.js')
        .then((reg) => reg.update && reg.update())
        .catch((e) => console.warn('SW-registrering misslyckades', e));
    }

    // Be webbläsaren behålla lagringen permanent – minskar risken att iOS
    // rensar data efter en tids inaktivitet.
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persisted()
        .then((already) => { if (!already) return navigator.storage.persist(); })
        .catch(() => {});
    }

    // Spara vid bakgrund/nedstängning. pagehide + visibilitychange är
    // tillförlitliga på iOS, till skillnad från beforeunload.
    window.addEventListener('pagehide', flushAll);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) flushAll();
      else requestWakeLock();
    });

    // Håll skärmen vaken. Återförsök vid första interaktion ifall en gest krävs.
    requestWakeLock();
    document.addEventListener('pointerdown', function once() {
      requestWakeLock();
      document.removeEventListener('pointerdown', once);
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
