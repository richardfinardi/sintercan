(function () {
  'use strict';

  // Fonte única: o mesmo endpoint que alimenta o modelo CONTAS A PAGAR.
  // Não somar consultas separadas (pagas + abertas): isso duplicaria lançamentos.
  const API = 'https://sintercan.consultoriarf.net';
  const ENDPOINT = API + '/contas_pagar';
  const CACHE_DB = 'sintercan_financeiro_cache_v2';
  const CACHE_STORE = 'snapshots';
  const FILTER_KEY = 'sintercan_financeiro_filters_v2';
  const CACHE_VERSION = 2;
  const REFRESH_MS = 5 * 60 * 1000;
  const REQUEST_MS = 120000;
  const moneyFmt = new Intl.NumberFormat('pt-BR', {style: 'currency', currency: 'BRL'});
  const dateFmt = new Intl.DateTimeFormat('pt-BR', {day: '2-digit', month: '2-digit', year: 'numeric'});
  const amountFmt = new Intl.NumberFormat('pt-BR', {minimumFractionDigits: 2, maximumFractionDigits: 2});
  const countFmt = new Intl.NumberFormat('pt-BR');

  const FILTERS = {supplier: 'Fornecedor', plan: 'Plano de contas', account: 'Conta', type: 'Tipo', status: 'Situação'};
  const state = {
    user: null, rows: [], fetchedAt: 0, cached: false, loading: false,
    selected: {supplier: [], plan: [], account: [], type: [], status: []},
    period: 'geral', from: '', to: '', search: '',
    page: 1, pageSize: 50, sort: 'dateKey', sortDirection: 1,
    openPicker: '', invalidDates: 0, missingDates: 0, missingSuppliers: 0,
    unknownStatus: 0, sourceFields: [], lastError: ''
  };

  function el(id) { return document.getElementById(id); }
  function clean(v) { return String(v === null || v === undefined ? '' : v).trim(); }
  function key(v) { return clean(v).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
  function esc(v) { return clean(v).replace(/[&<>"']/g, function (c) { return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]; }); }
  function brl(v) { return Number.isFinite(v) ? moneyFmt.format(v) : '—'; }
  function pc(v) { return Number.isFinite(v) ? amountFmt.format(v) + '%' : '—'; }
  function nfmt(v) { return countFmt.format(v); }
  function field(obj, names) {
    if (!obj || typeof obj !== 'object') return undefined;
    for (const name of names) if (Object.prototype.hasOwnProperty.call(obj, name) && obj[name] !== null && obj[name] !== '') return obj[name];
    const dict = Object.create(null);
    for (const prop of Object.keys(obj)) dict[key(prop)] = obj[prop];
    for (const name of names) {
      const found = dict[key(name)];
      if (found !== undefined && found !== null && found !== '') return found;
    }
    return undefined;
  }

  function numberStrict(input) {
    if (typeof input === 'number') return Number.isFinite(input) ? input : null;
    if (input === null || input === undefined || clean(input) === '') return null;
    let s = clean(input).replace(/R\$/ig, '').replace(/\s/g, '').replace(/\u00a0/g, '');
    if (/^\(.*\)$/.test(s)) s = '-' + s.slice(1, -1);
    if (s.includes(',') && s.includes('.')) {
      s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
    } else if (s.includes(',')) {
      s = s.replace(',', '.');
    } else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) {
      s = s.replace(/\./g, '');
    }
    if (!/^[+-]?\d+(\.\d+)?$/.test(s)) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }

  function pad(v) { return String(v).padStart(2, '0'); }
  function ymd(y, m, d) {
    const z = new Date(y, m - 1, d);
    return z.getFullYear() === y && z.getMonth() === m - 1 && z.getDate() === d
      ? String(y) + '-' + pad(m) + '-' + pad(d) : null;
  }
  function toDateKey(value) {
    if (value === undefined || value === null || value === '') return '';
    if (typeof value === 'number') {
      if (value >= 10000101 && value <= 99991231 && Number.isInteger(value)) return toDateKey(String(value));
      if (value > 20000 && value < 100000) {
        const dt = new Date(Date.UTC(1899, 11, 30) + Math.floor(value) * 86400000);
        return ymd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
      }
      if (value > 946684800000 && value < 4102444800000) return localDateKey(new Date(value));
      return null;
    }
    const v = clean(value);
    let x = /^(\d{4})-(\d\d?)-(\d\d?)(?:[T\s].*)?$/.exec(v);
    if (x) return ymd(+x[1], +x[2], +x[3]);
    x = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s.*)?$/.exec(v);
    if (x) return ymd(+x[3] < 100 ? 2000 + (+x[3]) : +x[3], +x[2], +x[1]);
    x = /^(\d{4})(\d\d)(\d\d)$/.exec(v);
    if (x) return ymd(+x[1], +x[2], +x[3]);
    return null; // Data desconhecida não vira "hoje" nem 01/01/1970.
  }
  function localDateKey(d) { return ymd(d.getFullYear(), d.getMonth() + 1, d.getDate()); }
  function dateDisplay(value) {
    if (!value) return 'Sem vencimento';
    const parts = value.split('-');
    return parts[2] + '/' + parts[1] + '/' + parts[0];
  }
  function statusOf(v) {
    if (typeof v === 'boolean') return v ? 'PAGO' : 'ABERTO';
    if (v === 1 || v === 0) return v === 1 ? 'PAGO' : 'ABERTO';
    const x = key(v);
    if (['1', 's', 'sim', 'true', 'pago', 'paga', 'pagos', 'pagas', 'quitado', 'quitada', 'liquidado', 'liquidada', 'baixado', 'baixada', 'efetivado', 'efetivada'].includes(x)) return 'PAGO';
    if (['0', 'n', 'nao', 'false', 'aberto', 'aberta', 'apagar', 'pendente', 'naopago', 'naopaga', 'naopagos', 'naopagas', 'naoquitado', 'naoquitada', 'vencido', 'vencida', 'emaberto'].includes(x)) return 'ABERTO';
    return 'DESCONHECIDO'; // Não presumir "não pago" quando a situação for ambígua.
  }
  function normalizedRow(raw) {
    const supplier = field(raw, ['Fornecedor', 'fornecedor', 'nome_fornecedor', 'razao_social', 'nome_fantasia']);
    const plan = field(raw, ['Plano de contas', 'plano_contas', 'plano de contas', 'descricao_plano_contas', 'nome_plano_contas', 'conta_contabil']);
    const due = field(raw, ['Vencimento', 'dt_vencimento', 'data_vencimento', 'vencimento_parcela']);
    const val = field(raw, ['Valor', 'valor', 'vl_valor', 'valor_parcela', 'vl_parcela', 'valor_plano_contas', 'vl_total', 'valor_total']);
    const paid = field(raw, ['Pago', 'pago', 'status_pagamento', 'situacao_pagamento', 'liquidado', 'quitado']);
    const account = field(raw, ['Conta', 'conta', 'numero_conta', 'n_conta', 'conta_bancaria', 'cod_plano_contas_contabil']);
    const type = field(raw, ['tp', 'tipo', 'tp_doc', 'tipo_documento', 'tipo_conta']);
    const dateKey = toDateKey(due);
    return {
      supplier: clean(supplier) || 'Não informado',
      plan: clean(plan) || 'Não informado',
      dateKey: dateKey === null ? '' : dateKey,
      badDate: dateKey === null,
      missingDate: due === undefined || due === null || due === '',
      value: numberStrict(val),
      status: statusOf(paid),
      account: clean(account) || 'Não informado',
      type: clean(type) || 'Não informado',
      document: clean(field(raw, ['Documento', 'documento', 'n_documento', 'n_nf', 'num_doc', 'nf'])),
      paidOriginal: clean(paid),
      search: '',
    };
  }

  function unpack(payload) {
    let p = payload;
    for (let depth = 0; depth < 6; depth++) {
      if (Array.isArray(p)) return {list: p, envelope: payload};
      if (!p || typeof p !== 'object') break;
      if (p.status === 'error' || p.status === 'erro' || p.success === false) throw new Error(clean(p.message || p.error || p.detail) || 'A API retornou erro.');
      let nextObject = null;
      for (const name of ['contas_pagar', 'dados', 'data', 'rows', 'results', 'result', 'registros', 'items', 'itens']) {
        const arr = field(p, [name]);
        if (Array.isArray(arr)) {
          if (arr.length && Array.isArray(arr[0])) {
            const names = field(p, ['columns', 'colunas', 'fields', 'campos']);
            if (!Array.isArray(names)) throw new Error('Linhas da API não têm nomes das colunas.');
            const mapped = arr.map(function (row) {
              const obj = {};
              names.forEach(function (col, i) { obj[typeof col === 'string' ? col : col.name || col.field || String(i)] = row[i]; });
              return obj;
            });
            return {list: mapped, envelope: payload};
          }
          return {list: arr, envelope: payload};
        }
        if (arr && typeof arr === 'object') { nextObject = arr; break; }
      }
      if (nextObject) { p = nextObject; continue; }
      const nested = Object.values(p).filter(Array.isArray);
      if (nested.length === 1) return {list: nested[0], envelope: payload};
      break;
    }
    throw new Error('O endpoint não retornou uma lista de contas reconhecível. Nenhum total foi substituído.');
  }
  function completeness(envelope, rowsCount) {
    if (!envelope || Array.isArray(envelope)) return;
    const more = field(envelope, ['tem_mais', 'has_more', 'hasNext', 'has_next', 'more']);
    if (more === true || more === 'true' || more === 1) throw new Error('A API retornou apenas parte das contas. É necessário paginação antes de calcular os totais.');
    const expected = numberStrict(field(envelope, ['total_registros', 'total_linhas', 'total_rows', 'total_count']));
    if (expected !== null && expected > rowsCount) throw new Error('Resposta incompleta: ' + nfmt(rowsCount) + ' linhas de ' + nfmt(expected) + ' registros.');
  }
  function normalizePayload(payload) {
    const extracted = unpack(payload);
    const original = extracted.list;
    completeness(extracted.envelope, original.length);
    if (original.some(function (x) { return !x || typeof x !== 'object' || Array.isArray(x); })) throw new Error('A API retornou registros que não são objetos.');
    const valid = original.map(normalizedRow);
    const missingAmounts = valid.reduce(function (s, r) { return s + (r.value === null ? 1 : 0); }, 0);
    if (missingAmounts) throw new Error(nfmt(missingAmounts) + ' registro(s) sem valor monetário reconhecível. Para evitar totais incorretos, a atualização foi bloqueada. Campos disponíveis: ' + (original.length ? Object.keys(original[0]).join(', ') : '(nenhum)') + '.');
    const badDates = valid.filter(function (r) { return r.badDate && !r.missingDate; }).length;
    if (badDates) throw new Error(nfmt(badDates) + ' registro(s) com data de vencimento inválida. A atualização foi bloqueada.');
    const sourceFields = original.length ? Object.keys(original[0]) : [];
    // Um lançamento corresponde a UMA linha recebida. Nunca desduplicar por fornecedor/data/valor.
    valid.forEach(function (r) {
      r.search = key([r.supplier, r.plan, r.account, r.type, r.document, r.paidOriginal].join(' '));
    });
    return {rows: valid, sourceFields: sourceFields};
  }
  function diagnostics(rows) {
    state.unknownStatus = rows.filter(function (r) { return r.status === 'DESCONHECIDO'; }).length;
    state.missingDates = rows.filter(function (r) { return r.missingDate; }).length;
    state.missingSuppliers = rows.filter(function (r) { return r.supplier === 'Não informado'; }).length;
  }

  function showError(msg) {
    state.lastError = msg;
    el('errorBanner').textContent = msg;
    el('errorBanner').hidden = false;
  }
  function clearError() {
    state.lastError = '';
    el('errorBanner').hidden = true;
  }
  function showWarnings() {
    const arr = [];
    if (state.unknownStatus) arr.push(nfmt(state.unknownStatus) + ' lançamento(s) com situação de pagamento não reconhecida. Não entram como pago nem a pagar; continuam no total. Confira a coluna Pago.');
    if (state.missingDates) arr.push(nfmt(state.missingDates) + ' lançamento(s) sem vencimento. Só aparecem na visão Geral sem filtro de data.');
    if (state.missingSuppliers) arr.push(nfmt(state.missingSuppliers) + ' lançamento(s) sem fornecedor.');
    if (state.rows.length === 0) arr.push('A API retornou zero lançamentos. Verifique o SQL antes de considerar esse resultado conclusivo.');
    el('warningBanner').textContent = arr.join(' ');
    el('warningBanner').hidden = !arr.length;
  }

  function openDb() {
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) { reject(new Error('IndexedDB indisponível')); return; }
      const request = indexedDB.open(CACHE_DB, 1);
      request.onupgradeneeded = function () { if (!request.result.objectStoreNames.contains(CACHE_STORE)) request.result.createObjectStore(CACHE_STORE); };
      request.onerror = function () { reject(request.error); };
      request.onsuccess = function () { resolve(request.result); };
    });
  }
  async function readCache() {
    const db = await openDb();
    return new Promise(function (resolve, reject) {
      const tx = db.transaction(CACHE_STORE, 'readonly');
      const req = tx.objectStore(CACHE_STORE).get(key(state.user.nome));
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
      tx.oncomplete = function () { db.close(); };
    });
  }
  async function saveCache(snapshot) {
    const db = await openDb();
    return new Promise(function (resolve, reject) {
      const tx = db.transaction(CACHE_STORE, 'readwrite');
      tx.objectStore(CACHE_STORE).put(snapshot, key(state.user.nome));
      tx.oncomplete = function () { db.close(); resolve(); };
      tx.onerror = function () { db.close(); reject(tx.error); };
    });
  }
  async function clearCache() {
    const db = await openDb();
    return new Promise(function (resolve, reject) {
      const tx = db.transaction(CACHE_STORE, 'readwrite');
      tx.objectStore(CACHE_STORE).delete(key(state.user.nome));
      tx.oncomplete = function () { db.close(); resolve(); };
      tx.onerror = function () { db.close(); reject(tx.error); };
    });
  }

  async function fetchTimed(url, options, ms) {
    const controller = new AbortController();
    const timeout = setTimeout(function () { controller.abort(); }, ms);
    try { return await fetch(url, Object.assign({}, options, {signal: controller.signal})); }
    finally { clearTimeout(timeout); }
  }
  async function verifySession() {
    let user = null;
    try { user = JSON.parse(localStorage.getItem('sintercan_user') || 'null'); } catch (_) {}
    if (!user || !user.nome || Number(user.u_financeiro) !== 1) {
      location.replace('../');
      return false;
    }
    const response = await fetchTimed(API + '/me', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({usuario: user.nome}), cache: 'no-store'
    }, 18000);
    if (!response.ok) throw new Error('Não foi possível validar o acesso ao financeiro (HTTP ' + response.status + ').');
    const fresh = await response.json();
    if (!fresh || !fresh.nome || Number(fresh.u_financeiro) !== 1) {
      try { await clearCache(); } catch (_) {}
      location.replace('../');
      return false;
    }
    if (state.user && key(state.user.nome) !== key(fresh.nome)) throw new Error('Usuário da sessão mudou. Entre novamente.');
    state.user = fresh;
    localStorage.setItem('sintercan_user', JSON.stringify(fresh));
    el('userName').textContent = fresh.nome;
    return true;
  }

  function todayKey() { return localDateKey(new Date()); }
  function rangeForPeriod(period) {
    const t = new Date();
    const start = new Date(t.getFullYear(), t.getMonth(), t.getDate());
    if (period === 'semana' || period === 'proxima-semana') {
      const offset = (start.getDay() + 6) % 7;
      start.setDate(start.getDate() - offset + (period === 'proxima-semana' ? 7 : 0));
      const end = new Date(start); end.setDate(start.getDate() + 6);
      return [localDateKey(start), localDateKey(end)];
    }
    if (period === 'mes' || period === 'proximo-mes') {
      const next = period === 'proximo-mes' ? 1 : 0;
      const first = new Date(t.getFullYear(), t.getMonth() + next, 1);
      const last = new Date(t.getFullYear(), t.getMonth() + next + 1, 0);
      return [localDateKey(first), localDateKey(last)];
    }
    return ['', ''];
  }
  function compareDateValue(date, from, to) {
    if (!date) return !from && !to;
    return (!from || date >= from) && (!to || date <= to);
  }
  function isOverdue(r) { return r.status === 'ABERTO' && r.dateKey && r.dateKey < todayKey(); }
  function visibleRows() {
    const periodRange = rangeForPeriod(state.period);
    const start = state.from || periodRange[0];
    const end = state.to || periodRange[1];
    const now = todayKey();
    const search = key(state.search);
    const sel = state.selected;
    return state.rows.filter(function (r) {
      if (state.period === 'vencidas' && !(r.status === 'ABERTO' && r.dateKey && r.dateKey < now)) return false;
      if (!compareDateValue(r.dateKey, start, end)) return false;
      for (const prop of Object.keys(FILTERS)) if (sel[prop].length && !sel[prop].includes(r[prop])) return false;
      if (search && !r.search.includes(search)) return false;
      return true;
    });
  }
  function sumValue(rows) { return rows.reduce(function (acc, row) { return acc + row.value; }, 0); }
  function byValue(rows, fieldName) {
    const map = new Map();
    rows.forEach(function (r) { map.set(r[fieldName], (map.get(r[fieldName]) || 0) + r.value); });
    return Array.from(map, function (x) { return {name: x[0], amount: x[1]}; }).sort(function (a, b) { return b.amount - a.amount || a.name.localeCompare(b.name, 'pt-BR'); });
  }
  function metrics(rows) {
    let paid = 0, open = 0, overdue = 0, next = 0, countPaid = 0, countOpen = 0, countOverdue = 0;
    const today = todayKey();
    const d = new Date();
    d.setDate(d.getDate() + 30);
    const end = localDateKey(d);
    rows.forEach(function (r) {
      if (r.status === 'PAGO') { paid += r.value; countPaid++; }
      if (r.status === 'ABERTO') {
        open += r.value; countOpen++;
        if (r.dateKey && r.dateKey < today) { overdue += r.value; countOverdue++; }
        if (r.dateKey && r.dateKey >= today && r.dateKey <= end) next += r.value;
      }
    });
    return {total: sumValue(rows), paid: paid, open: open, overdue: overdue, next: next, countPaid: countPaid, countOpen: countOpen, countOverdue: countOverdue};
  }

  function persistFilters() {
    try {
      localStorage.setItem(FILTER_KEY + ':' + key(state.user.nome), JSON.stringify({
        selected: state.selected, period: state.period, from: state.from, to: state.to,
        search: state.search, pageSize: state.pageSize
      }));
    } catch (_) {}
  }
  function restoreFilters() {
    try {
      const saved = JSON.parse(localStorage.getItem(FILTER_KEY + ':' + key(state.user.nome)) || 'null');
      if (!saved) return;
      for (const prop of Object.keys(FILTERS)) if (saved.selected && Array.isArray(saved.selected[prop])) state.selected[prop] = saved.selected[prop].filter(function (v) { return typeof v === 'string'; });
      if (['geral', 'semana', 'proxima-semana', 'mes', 'proximo-mes', 'vencidas'].includes(saved.period)) state.period = saved.period;
      if (/^\d{4}-\d\d-\d\d$/.test(saved.from || '')) state.from = saved.from;
      if (/^\d{4}-\d\d-\d\d$/.test(saved.to || '')) state.to = saved.to;
      state.search = clean(saved.search);
      if ([25, 50, 100].includes(Number(saved.pageSize))) state.pageSize = Number(saved.pageSize);
    } catch (_) {}
  }
  function updateControls() {
    el('dateFrom').value = state.from;
    el('dateTo').value = state.to;
    el('searchInput').value = state.search;
    el('pageSize').value = String(state.pageSize);
    document.querySelectorAll('.period').forEach(function (btn) {
      btn.classList.toggle('active', btn.dataset.period === state.period);
      btn.setAttribute('aria-pressed', String(btn.dataset.period === state.period));
    });
  }
  function updatePickerLabels() {
    Object.keys(FILTERS).forEach(function (prop) {
      const values = state.selected[prop];
      el('label-' + prop).textContent = values.length ? values.length === 1 ? values[0] : values.length + ' selecionados' : prop === 'status' ? 'Todas' : 'Todos';
    });
  }
  function filterOptions(prop) {
    const set = new Set(state.rows.map(function (r) { return r[prop]; }).filter(Boolean));
    return Array.from(set).sort(function (a, b) { return a.localeCompare(b, 'pt-BR', {numeric: true}); });
  }
  function renderPicker(prop, search) {
    const menu = el('menu-' + prop);
    const options = filterOptions(prop);
    const q = key(search);
    const visible = q ? options.filter(function (x) { return key(x).includes(q); }) : options;
    let html = '<input type="search" class="menu-search" aria-label="Buscar ' + esc(FILTERS[prop]) + '" placeholder="Pesquisar..." value="' + esc(search) + '">';
    html += '<div class="picker-tools"><button type="button" class="text-btn" data-all="' + prop + '">Selecionar todos</button><button type="button" class="text-btn" data-clear="' + prop + '">Limpar</button></div>';
    html += '<div class="picker-choices">' + (visible.length ? visible.map(function (val) {
      return '<label class="picker-choice"><input type="checkbox" data-pick="' + esc(prop) + '" value="' + esc(val) + '"' +
        (state.selected[prop].includes(val) ? ' checked' : '') + '><span>' + esc(val) + '</span></label>';
    }).join('') : '<div class="empty">Nenhuma opção</div>') + '</div>';
    menu.innerHTML = html;
    const searchBox = menu.querySelector('.menu-search');
    searchBox.addEventListener('input', function () {
      const txt = searchBox.value;
      const old = menu.querySelector('.picker-choices');
      const matching = filterOptions(prop).filter(function (x) { return key(x).includes(key(txt)); });
      old.innerHTML = matching.length ? matching.map(function (val) {
        return '<label class="picker-choice"><input type="checkbox" data-pick="' + esc(prop) + '" value="' + esc(val) + '"' +
          (state.selected[prop].includes(val) ? ' checked' : '') + '><span>' + esc(val) + '</span></label>';
      }).join('') : '<div class="empty">Nenhuma opção</div>';
    });
    menu.querySelector('[data-all]').addEventListener('click', function () {
      // Sem restrição = todas as opções (mesmo as que não estão visíveis na pesquisa).
      state.selected[prop] = [];
      renderPicker(prop, searchBox.value);
      filterChanged();
    });
    menu.querySelector('[data-clear]').addEventListener('click', function () {
      state.selected[prop] = []; renderPicker(prop, searchBox.value); filterChanged();
    });
    menu.onchange = function onChange(e) {
      if (e.target && e.target.matches('input[data-pick="' + prop + '"]')) {
        const val = e.target.value, arr = new Set(state.selected[prop]);
        e.target.checked ? arr.add(val) : arr.delete(val);
        state.selected[prop] = Array.from(arr);
        filterChanged();
      }
    };
  }
  function closePickers() {
    state.openPicker = '';
    Object.keys(FILTERS).forEach(function (prop) {
      el('menu-' + prop).hidden = true;
      document.querySelector('[data-open="' + prop + '"]').setAttribute('aria-expanded', 'false');
    });
  }
  function openPicker(prop) {
    if (state.openPicker === prop) { closePickers(); return; }
    closePickers();
    state.openPicker = prop;
    renderPicker(prop, '');
    const menu = el('menu-' + prop);
    menu.hidden = false;
    document.querySelector('[data-open="' + prop + '"]').setAttribute('aria-expanded', 'true');
    menu.style.left = ''; menu.style.right = ''; menu.style.top = ''; menu.style.bottom = '';
    if (menu.getBoundingClientRect().right > window.innerWidth - 10) {menu.style.left = 'auto'; menu.style.right = '0';}
    const pos = menu.getBoundingClientRect();
    if (pos.bottom > window.innerHeight - 10 && pos.top > window.innerHeight / 2) { menu.style.top = 'auto'; menu.style.bottom = 'calc(100% + 7px)'; }
    menu.querySelector('.menu-search').focus();
  }
  function filterChanged() {
    state.page = 1;
    updatePickerLabels(); persistFilters(); render();
  }

  function renderBars(containerId, groups, prop, total) {
    const dest = el(containerId), max = Math.max(0.01, ...groups.slice(0, 12).map(function (x) { return Math.abs(x.amount); }));
    if (!groups.length) { dest.innerHTML = '<div class="empty">Sem lançamentos para os filtros selecionados.</div>'; return; }
    dest.innerHTML = groups.slice(0, 12).map(function (item) {
      const width = Math.max(1, Math.abs(item.amount) / max * 100);
      const title = item.name + ': ' + brl(item.amount) + ' (' + pc(total ? item.amount / total * 100 : NaN) + ')';
      return '<div class="bar-item" title="' + esc(title) + '"><button type="button" class="bar-name" data-group="' + esc(prop) + '" data-value="' + esc(item.name) + '" title="Filtrar ' + esc(item.name) + '">' + esc(item.name) + '</button>' +
        '<div class="bar-track"><div class="bar-fill" style="width:' + width.toFixed(2) + '%"></div></div>' +
        '<div class="bar-value">' + esc(brl(item.amount)) + '</div></div>';
    }).join('');
  }
  function renderTable(rows, total) {
    const ordered = rows.slice();
    const order = state.sortDirection;
    ordered.sort(function (a, b) {
      let cmp;
      if (state.sort === 'value') cmp = a.value - b.value;
      else cmp = clean(a[state.sort]).localeCompare(clean(b[state.sort]), 'pt-BR', {numeric: true});
      return cmp * order;
    });
    const pages = Math.max(1, Math.ceil(rows.length / state.pageSize));
    state.page = Math.min(state.page, pages);
    const first = (state.page - 1) * state.pageSize;
    const part = ordered.slice(first, first + state.pageSize);
    el('detailBody').innerHTML = part.length ? part.map(function (r) {
      const situation = r.status === 'PAGO' ? 'Pago' : r.status === 'ABERTO' ? 'Não pago' : 'Não identificado';
      const klass = r.status === 'PAGO' ? 'paid' : r.status === 'ABERTO' ? 'open' : 'unknown';
      const overdue = isOverdue(r) ? ' · Vencida' : '';
      const ratio = total ? (r.value / total * 100) : NaN;
      return '<tr><td title="' + esc(r.supplier) + '">' + esc(r.supplier) + '</td>' +
        '<td title="' + esc(r.plan) + '">' + esc(r.plan) + '</td><td>' + esc(dateDisplay(r.dateKey)) + '</td>' +
        '<td class="num">' + esc(brl(r.value)) + '</td><td class="num">' + esc(pc(ratio)) + '</td>' +
        '<td title="' + esc(r.account) + '">' + esc(r.account) + '</td>' +
        '<td><span class="badge ' + klass + '" title="Origem: ' + esc(r.paidOriginal) + '">' + esc(situation + overdue) + '</span></td>' +
        '<td title="' + esc(r.type) + '">' + esc(r.type) + '</td></tr>';
    }).join('') : '<tr><td colspan="8" class="empty">Nenhuma conta encontrada para estes filtros.</td></tr>';
    el('tableTotal').textContent = brl(total);
    el('tablePct').textContent = total ? '100%' : '—';
    el('pageInfo').textContent = 'Página ' + nfmt(state.page) + ' de ' + nfmt(pages);
    el('tableFooterStatus').textContent = rows.length
      ? 'Exibindo ' + nfmt(first + 1) + '–' + nfmt(Math.min(first + state.pageSize, rows.length)) + ' de ' + nfmt(rows.length) + ' contas.'
      : 'Nenhum registro.';
    el('prevBtn').disabled = state.page <= 1;
    el('nextBtn').disabled = state.page >= pages;
  }
  function render() {
    updateControls(); updatePickerLabels();
    if (state.from && state.to && state.from > state.to) {
      el('warningBanner').hidden = false;
      el('warningBanner').textContent = 'Período inválido: a data inicial é maior que a data final. Os totais não serão calculados até corrigir o filtro.';
      ['kpiTotal', 'kpiOpen', 'kpiPaid', 'kpiOverdue', 'kpiNext', 'tableTotal'].forEach(function (id) { el(id).textContent = '—'; });
      ['kpiRows', 'kpiOpenRows', 'kpiPaidRows', 'kpiOverdueRows', 'tableSummary', 'tableFooterStatus'].forEach(function (id) { el(id).textContent = 'Corrija o período'; });
      ['bySupplier', 'byPlan', 'byType'].forEach(function (id) { el(id).innerHTML = '<div class="empty">Filtro de período inválido.</div>'; });
      el('detailBody').innerHTML = '<tr><td colspan="8" class="empty">Corrija a data inicial ou final para consultar as contas.</td></tr>';
      el('tablePct').textContent = '—'; el('pageInfo').textContent = '—';
      el('exportBtn').disabled = true; el('nextBtn').disabled = true; el('prevBtn').disabled = true;
      return;
    }
    showWarnings();
    const rows = visibleRows();
    const m = metrics(rows);
    el('kpiTotal').textContent = brl(m.total);
    el('kpiRows').textContent = nfmt(rows.length) + ' lançamentos';
    el('kpiOpen').textContent = brl(m.open);
    el('kpiOpenRows').textContent = nfmt(m.countOpen) + ' lançamentos não pagos';
    el('kpiPaid').textContent = brl(m.paid);
    el('kpiPaidRows').textContent = nfmt(m.countPaid) + ' lançamentos pagos';
    el('kpiOverdue').textContent = brl(m.overdue);
    el('kpiOverdueRows').textContent = nfmt(m.countOverdue) + ' vencidas';
    el('kpiNext').textContent = brl(m.next);
    el('tableSummary').textContent = nfmt(rows.length) + ' lançamentos · Total ' + brl(m.total);
    renderBars('bySupplier', byValue(rows, 'supplier'), 'supplier', m.total);
    renderBars('byPlan', byValue(rows, 'plan'), 'plan', m.total);
    renderBars('byType', byValue(rows, 'type'), 'type', m.total);
    renderTable(rows, m.total);
    el('exportBtn').disabled = !rows.length;
  }
  function useSnapshot(snapshot, isCache) {
    if (!snapshot || snapshot.version !== CACHE_VERSION || !Array.isArray(snapshot.rows)) return;
    state.rows = snapshot.rows;
    state.fetchedAt = snapshot.fetchedAt;
    state.cached = isCache;
    state.sourceFields = snapshot.sourceFields || [];
    diagnostics(state.rows);
    el('syncStatus').textContent = (isCache ? 'Cache: ' : 'Atualizado: ') + new Date(snapshot.fetchedAt).toLocaleString('pt-BR');
    showWarnings(); render();
  }
  async function refresh() {
    if (state.loading || !state.user || document.hidden) return;
    state.loading = true;
    el('refreshBtn').disabled = true;
    el('syncStatus').textContent = 'Atualizando contas...';
    try {
      const permitted = await verifySession();
      if (!permitted) return;
      const response = await fetchTimed(ENDPOINT, {method: 'GET', cache: 'no-store', headers: {'Accept': 'application/json'}}, REQUEST_MS);
      if (!response.ok) throw new Error('Endpoint /contas_pagar retornou HTTP ' + response.status + '.');
      const contentType = response.headers.get('content-type') || '';
      if (contentType && !contentType.toLowerCase().includes('json')) throw new Error('O endpoint retornou conteúdo que não é JSON.');
      const payload = await response.json();
      const normalized = normalizePayload(payload); // Transação: somente trocar os dados após validar TODOS.
      const snapshot = {version: CACHE_VERSION, fetchedAt: Date.now(), rows: normalized.rows, sourceFields: normalized.sourceFields};
      useSnapshot(snapshot, false);
      clearError();
      saveCache(snapshot).catch(function () { /* Cache opcional: jamais bloquear dados válidos. */ });
    } catch (err) {
      const msg = err && err.name === 'AbortError' ? 'Tempo excedido ao consultar /contas_pagar.' : clean(err.message || err);
      showError('Falha na atualização: ' + msg + (state.fetchedAt ? ' O último conjunto completo foi mantido.' : ' Nenhum total foi calculado com dados incompletos.'));
      el('syncStatus').textContent = state.fetchedAt ? 'Últimos dados: ' + new Date(state.fetchedAt).toLocaleString('pt-BR') : 'Sem dados válidos';
    } finally {
      state.loading = false; el('refreshBtn').disabled = false;
    }
  }

  function safeExcelString(v) {
    const s = clean(v);
    // Prevenir fórmula involuntária ao abrir CSV no Excel.
    return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
  }
  function exportRows() {
    const rows = visibleRows();
    if (!rows.length) return;
    const total = sumValue(rows);
    const data = rows.map(function (r) {
      return {
        'Fornecedor': safeExcelString(r.supplier),
        'Plano de contas': safeExcelString(r.plan),
        'Vencimento': r.dateKey ? dateDisplay(r.dateKey) : '',
        'Valor': r.value,
        '% do total filtrado': total ? r.value / total * 100 : null,
        'Conta': safeExcelString(r.account),
        'Pago': r.status === 'PAGO' ? 'Sim' : r.status === 'ABERTO' ? 'Não' : 'Não identificado',
        'Tipo': safeExcelString(r.type), 'Documento': safeExcelString(r.document),
        'Vencida': isOverdue(r) ? 'Sim' : 'Não'
      };
    });
    const stamp = todayKey().replace(/-/g, '');
    if (window.XLSX && XLSX.utils && XLSX.writeFile) {
      const ws = XLSX.utils.json_to_sheet(data);
      ws['!cols'] = [{wch: 34}, {wch: 29}, {wch: 15}, {wch: 19}, {wch: 21}, {wch: 22}, {wch: 18}, {wch: 18}, {wch: 19}, {wch: 12}];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Contas a pagar');
      XLSX.writeFile(wb, 'Sintercan_Contas_Pagar_' + stamp + '.xlsx');
      return;
    }
    // Exportação também funciona quando o CDN do Excel está fora do ar.
    const columns = Object.keys(data[0]);
    const text = [columns.join(';')].concat(data.map(function (x) {
      return columns.map(function (col) {
        const s = typeof x[col] === 'number' ? String(x[col]).replace('.', ',') : clean(x[col]);
        return '"' + s.replace(/"/g, '""') + '"';
      }).join(';');
    })).join('\r\n');
    const blob = new Blob(['\ufeff', text], {type: 'text/csv;charset=utf-8'});
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = 'Sintercan_Contas_Pagar_' + stamp + '.csv';
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function bind() {
    el('themeBtn').addEventListener('click', function () {
      const dark = document.documentElement.classList.toggle('dark');
      localStorage.setItem('theme', dark ? 'dark' : 'light');
    });
    el('refreshBtn').addEventListener('click', function () { refresh(); });
    el('exportBtn').addEventListener('click', exportRows);
    el('clearBtn').addEventListener('click', function () {
      state.selected = {supplier: [], plan: [], account: [], type: [], status: []};
      state.from = ''; state.to = ''; state.search = ''; state.period = 'geral';
      closePickers(); filterChanged();
    });
    document.querySelectorAll('.period').forEach(function (btn) {
      btn.addEventListener('click', function () { state.period = btn.dataset.period; state.from = ''; state.to = ''; filterChanged(); });
    });
    el('dateFrom').addEventListener('change', function () { state.from = this.value; state.period = 'geral'; filterChanged(); });
    el('dateTo').addEventListener('change', function () { state.to = this.value; state.period = 'geral'; filterChanged(); });
    let searchTimer;
    el('searchInput').addEventListener('input', function () {
      const val = this.value; clearTimeout(searchTimer);
      searchTimer = setTimeout(function () { state.search = val; filterChanged(); }, 200);
    });
    el('pageSize').addEventListener('change', function () { state.pageSize = Number(this.value); filterChanged(); });
    el('prevBtn').addEventListener('click', function () { if (state.page > 1) { state.page--; render(); } });
    el('nextBtn').addEventListener('click', function () { state.page++; render(); });
    document.querySelectorAll('[data-open]').forEach(function (btn) {
      btn.addEventListener('click', function (event) { event.stopPropagation(); openPicker(btn.dataset.open); });
    });
    document.addEventListener('click', function (event) {
      if (state.openPicker && !event.target.closest('.picker')) closePickers();
    });
    document.addEventListener('keydown', function (event) { if (event.key === 'Escape') closePickers(); });
    document.querySelectorAll('[data-sort]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const column = btn.dataset.sort;
        state.sortDirection = state.sort === column ? -state.sortDirection : column === 'value' ? -1 : 1;
        state.sort = column; state.page = 1; render();
      });
    });
    ['bySupplier', 'byPlan', 'byType'].forEach(function (id) {
      el(id).addEventListener('click', function (e) {
        const btn = e.target.closest('[data-group]');
        if (!btn) return;
        state.selected[btn.dataset.group] = [btn.dataset.value];
        filterChanged();
      });
    });
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && Date.now() - state.fetchedAt > REFRESH_MS && state.user) refresh();
    });
    setInterval(function () {
      if (state.user && !document.hidden && Date.now() - state.fetchedAt >= REFRESH_MS) refresh();
    }, REFRESH_MS);
  }

  async function init() {
    const preferDark = localStorage.getItem('theme') === 'dark' ||
      (!localStorage.getItem('theme') && matchMedia('(prefers-color-scheme:dark)').matches);
    document.documentElement.classList.toggle('dark', preferDark);
    bind();
    try {
      if (!await verifySession()) return;
      el('startup').hidden = true;
      el('app').hidden = false;
      el('refreshBtn').disabled = false;
      restoreFilters(); updateControls();
      try {
        const cache = await readCache();
        if (cache && cache.version === CACHE_VERSION && cache.fetchedAt && Date.now() - cache.fetchedAt < 7 * 86400000) useSnapshot(cache, true);
      } catch (_) { /* Cache local não é requisito para abrir. */ }
      await refresh();
    } catch (err) {
      // Falha da validação NÃO libera nem o cache financeiro.
      el('app').hidden = true;
      el('startup').hidden = false;
      el('startup').textContent = 'Acesso não validado: ' + clean(err.message || err) + '. Retorne ao portal e tente novamente.';
    }
  }

  // Exposição dos transformadores apenas para testes locais, sem dados reais.
  if (window.location && new URLSearchParams(window.location.search).has('teste_financeiro')) {
    window.__financeiroTest = {numberStrict: numberStrict, toDateKey: toDateKey, statusOf: statusOf, normalizePayload: normalizePayload, rangeForPeriod: rangeForPeriod};
  }
  init();
}());
