// Material de Cliente (follow-up) — dados independentes da carteira /rs e /pedido.
const MATERIAL_CLIENTE_API_URL = 'https://sintercan.consultoriarf.net/carteira_nf';
const MATERIAL_CLIENTE_CACHE_KEY = 'material_cliente_data_v1';
const MATERIAL_CLIENTE_FILTER_KEY = 'sintercan_rs_material_cliente_filters_v1';
let materialClienteData = [];
let filteredMaterialClienteData = [];
let materialClienteDataReady = false;
let materialClienteLoadStarted = false;
let isRefreshingMaterialClienteData = false;
let materialClienteCacheSavedAt = null;
let materialClienteLastSourceMode = 'loading';
let materialClienteLastApiSyncAtMs = 0;
let materialClienteFiltersRestored = false;
let materialClienteSortColumn = 'dias_nf';
let materialClienteSortAsc = false;
let materialClienteRenderLimit = 120;
const MATERIAL_CLIENTE_FILTER_IDS = ['materialFilterCliente', 'materialFilterMaterial', 'materialFilterOs', 'materialFilterOsLista', 'materialFilterDe', 'materialFilterAte'];
const materialClienteCollator = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });

function materialClienteNumber(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    const raw = String(value ?? '').trim();
    if (!raw) return 0;
    const sanitized = raw.includes(',') ? raw.replace(/\./g, '').replace(',', '.') : raw;
    const number = Number(sanitized);
    return Number.isFinite(number) ? number : 0;
}

function materialClienteFormatNumber(value, maxDecimals = 2) {
    return materialClienteNumber(value).toLocaleString('pt-BR', { maximumFractionDigits: maxDecimals });
}

function materialClienteDateKey(value) {
    const d = parseDate(value);
    if (!d) return '';
    const pad = n => String(n).padStart(2, '0');
    return String(d.getFullYear()) + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

function materialClienteIsOverdue(item) {
    const due = materialClienteDateKey(item.previsao_entrega);
    return !!due && due < materialClienteDateKey(new Date());
}

function materialClienteBadge(status) {
    const value = String(status ?? '').trim();
    if (!value) return '<span class="text-slate-400">-</span>';
    const normalized = normalizeSearchText(value);
    let cls = 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300 border-slate-200 dark:border-slate-700';
    if (normalized.includes('produc') || normalized.includes('andamento')) cls = 'bg-amber-50 text-amber-800 dark:bg-amber-500/10 dark:text-amber-300 border-amber-200 dark:border-amber-500/20';
    else if (normalized.includes('conclu') || normalized.includes('finaliz') || normalized.includes('entreg')) cls = 'bg-emerald-50 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300 border-emerald-200 dark:border-emerald-500/20';
    else if (normalized.includes('atras') || normalized.includes('paralis') || normalized.includes('cancel')) cls = 'bg-rose-50 text-rose-800 dark:bg-rose-500/10 dark:text-rose-300 border-rose-200 dark:border-rose-500/20';
    else if (normalized.includes('aguard') || normalized.includes('pendente')) cls = 'bg-sky-50 text-sky-800 dark:bg-sky-500/10 dark:text-sky-300 border-sky-200 dark:border-sky-500/20';
    return '<span class="inline-block rounded-md px-2 py-0.5 border text-[10px] font-semibold whitespace-nowrap ' + cls + '">' + escapeHtml(value) + '</span>';
}

async function readMaterialClienteCache() {
    const db = await openRsCacheDb();
    try {
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(RS_STORE_NAME, 'readonly');
            const request = tx.objectStore(RS_STORE_NAME).get(MATERIAL_CLIENTE_CACHE_KEY);
            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => reject(request.error || new Error('Erro ao ler cache de Material de Cliente'));
        });
    } finally {
        db.close();
    }
}

async function writeMaterialClienteCache(data, savedAt) {
    const db = await openRsCacheDb();
    try {
        await new Promise((resolve, reject) => {
            const tx = db.transaction(RS_STORE_NAME, 'readwrite');
            tx.objectStore(RS_STORE_NAME).put({ key: MATERIAL_CLIENTE_CACHE_KEY, data, savedAt });
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error || new Error('Erro ao salvar cache de Material de Cliente'));
            tx.onabort = () => reject(tx.error || new Error('Gravação do cache interrompida'));
        });
    } finally {
        db.close();
    }
}

function materialClientePopulateSelect(id, field) {
    const select = document.getElementById(id);
    if (!select) return;
    const old = select.value;
    const options = [...new Set(materialClienteData.map(item => String(item[field] ?? '').trim()).filter(Boolean))].sort(materialClienteCollator.compare);
    select.replaceChildren(new Option('Todos', ''), ...options.map(value => new Option(value, value)));
    if (options.includes(old)) select.value = old;
}

function materialClienteSetupOptions() {
    materialClientePopulateSelect('materialFilterCliente', 'cliente');
    materialClientePopulateSelect('materialFilterMaterial', 'status_material');
    materialClientePopulateSelect('materialFilterOs', 'status_os');
    materialClientePopulateSelect('materialFilterOsLista', 'status_os_listam');
}

function materialClienteRestoreFilters() {
    if (materialClienteFiltersRestored) return;
    materialClienteFiltersRestored = true;
    try {
        const saved = JSON.parse(localStorage.getItem(MATERIAL_CLIENTE_FILTER_KEY) || '{}');
        MATERIAL_CLIENTE_FILTER_IDS.forEach(id => {
            const input = document.getElementById(id);
            if (!input || typeof saved[id] !== 'string') return;
            if (input.tagName === 'SELECT' && !Array.from(input.options).some(opt => opt.value === saved[id])) return;
            input.value = saved[id];
        });
    } catch (_) {}
}

function materialClienteSaveFilters() {
    try {
        const values = {};
        MATERIAL_CLIENTE_FILTER_IDS.forEach(id => { values[id] = document.getElementById(id)?.value || ''; });
        localStorage.setItem(MATERIAL_CLIENTE_FILTER_KEY, JSON.stringify(values));
    } catch (_) {}
}

function resetMaterialClienteFilters() {
    document.getElementById('filterGlobal').value = '';
    MATERIAL_CLIENTE_FILTER_IDS.forEach(id => {
        const input = document.getElementById(id);
        if (input) input.value = '';
    });
    materialClienteFiltersRestored = true;
    try { localStorage.removeItem(MATERIAL_CLIENTE_FILTER_KEY); } catch (_) {}
    applyMaterialClienteFilters();
}

function materialClienteSortData() {
    const key = materialClienteSortColumn;
    const numeric = key === 'qtde' || key === 'dias_nf' || key === 'n_nf';
    const date = ['dt_emissao_nf', 'dt_aprovacao', 'previsao_entrega'].includes(key);
    const multiplier = materialClienteSortAsc ? 1 : -1;
    filteredMaterialClienteData.sort((a, b) => {
        let va = a[key], vb = b[key];
        const blankA = va === null || va === undefined || va === '';
        const blankB = vb === null || vb === undefined || vb === '';
        if (blankA !== blankB) return blankA ? 1 : -1;
        let result;
        if (date) result = (parseDate(va)?.getTime() || 0) - (parseDate(vb)?.getTime() || 0);
        else if (numeric) result = materialClienteNumber(va) - materialClienteNumber(vb);
        else result = materialClienteCollator.compare(String(va ?? ''), String(vb ?? ''));
        return result * multiplier || materialClienteCollator.compare(String(a.cliente ?? ''), String(b.cliente ?? ''));
    });
}

function sortMaterialCliente(key) {
    if (materialClienteSortColumn === key) materialClienteSortAsc = !materialClienteSortAsc;
    else {
        materialClienteSortColumn = key;
        materialClienteSortAsc = key === 'dias_nf' || key === 'qtde' || key === 'previsao_entrega' ? false : true;
    }
    materialClienteSortData();
    materialClienteRenderLimit = 120;
    renderMaterialClienteView();
}

function applyMaterialClienteFilters() {
    if (!materialClienteDataReady) return;
    const search = document.getElementById('filterGlobal')?.value.trim() || '';
    const cliente = document.getElementById('materialFilterCliente')?.value || '';
    const material = document.getElementById('materialFilterMaterial')?.value || '';
    const os = document.getElementById('materialFilterOs')?.value || '';
    const osLista = document.getElementById('materialFilterOsLista')?.value || '';
    const dataDe = document.getElementById('materialFilterDe')?.value || '';
    const dataAte = document.getElementById('materialFilterAte')?.value || '';
    filteredMaterialClienteData = materialClienteData.filter(item => {
        if (search && !matchesGlobalSearch(item, search)) return false;
        if (cliente && String(item.cliente ?? '') !== cliente) return false;
        if (material && String(item.status_material ?? '') !== material) return false;
        if (os && String(item.status_os ?? '') !== os) return false;
        if (osLista && String(item.status_os_listam ?? '') !== osLista) return false;
        const due = materialClienteDateKey(item.previsao_entrega);
        if (dataDe && (!due || due < dataDe)) return false;
        if (dataAte && (!due || due > dataAte)) return false;
        return true;
    });
    materialClienteRenderLimit = 120;
    materialClienteSortData();
    materialClienteSaveFilters();
    if (activeTab === 'MaterialCliente') renderMaterialClienteView();
}

function renderMaterialClienteView() {
    if (!materialClienteDataReady) return;
    const data = filteredMaterialClienteData;
    const tbody = document.getElementById('materialClienteTableBody');
    if (!tbody) return;
    const sum = data.reduce((acc, row) => acc + materialClienteNumber(row.qtde), 0);
    const notaCount = new Set(data.filter(row => row.n_nf != null && row.n_nf !== '').map(row => String(row.cnpj || row.cliente || '') + '|' + String(row.n_nf) + '|' + String(row.dt_emissao_nf || ''))).size;
    const overdue = data.filter(materialClienteIsOverdue).length;
    const ages = data.map(row => row.dias_nf).filter(value => value !== null && value !== undefined && value !== '').map(materialClienteNumber);
    const average = ages.length ? Math.round(ages.reduce((a, b) => a + b, 0) / ages.length) : 0;
    const setText = (id, value) => { const element = document.getElementById(id); if (element) element.textContent = value; };
    setText('materialKpiRegistros', data.length.toLocaleString('pt-BR'));
    setText('materialKpiQuantidade', materialClienteFormatNumber(sum));
    setText('materialKpiNotas', notaCount.toLocaleString('pt-BR'));
    setText('materialKpiVencidos', overdue.toLocaleString('pt-BR'));
    setText('materialKpiDias', ages.length ? average.toLocaleString('pt-BR') : '-');
    setText('materialTotalRegistros', data.length.toLocaleString('pt-BR'));
    setText('materialExibindoRegistros', Math.min(materialClienteRenderLimit, data.length).toLocaleString('pt-BR'));
    document.getElementById('materialLoadMore')?.classList.toggle('hidden', data.length <= materialClienteRenderLimit);
    document.querySelectorAll('[data-material-sort]').forEach(btn => {
        const indicator = btn.querySelector('.mat-sort-indicator');
        if (indicator) indicator.textContent = btn.dataset.materialSort === materialClienteSortColumn ? (materialClienteSortAsc ? ' ▲' : ' ▼') : '';
    });
    if (!data.length) {
        tbody.innerHTML = '<tr><td colspan="13" class="p-8 text-center text-slate-500 dark:text-slate-400">Nenhum material encontrado para os filtros selecionados.</td></tr>';
        return;
    }
    const fragment = document.createDocumentFragment();
    data.slice(0, materialClienteRenderLimit).forEach(row => {
        const overdueRow = materialClienteIsOverdue(row);
        const days = row.dias_nf === null || row.dias_nf === undefined ? '' : materialClienteFormatNumber(row.dias_nf, 0);
        const tr = document.createElement('tr');
        tr.className = 'hover:bg-amber-50/60 dark:hover:bg-slate-800/60 border-b border-slate-200 dark:border-slate-800 align-top';
        const cellClass = 'px-3 py-2.5 border-r border-slate-100 dark:border-slate-800/70';
        const muted = 'text-[10px] text-slate-500 dark:text-slate-400 mt-1';
        const norm = val => escapeHtml(String(val ?? '') || '-');
        tr.innerHTML =
            '<td class="' + cellClass + '"><div class="font-semibold text-slate-900 dark:text-slate-100">' + norm(row.cliente) + '</div><div class="' + muted + '">CNPJ ' + norm(row.cnpj) + '</div></td>' +
            '<td class="' + cellClass + ' whitespace-nowrap"><div class="font-semibold">' + norm(row.n_nf) + '</div><div class="' + muted + '">' + norm(formatDateBR(row.dt_emissao_nf)) + '</div></td>' +
            '<td class="' + cellClass + '"><div class="font-mono font-bold text-amber-700 dark:text-amber-400">' + norm(row.codigo_interno) + '</div><div class="' + muted + ' max-w-[260px] break-words" title="' + norm(row.item) + '">' + norm(row.item) + '</div></td>' +
            '<td class="' + cellClass + ' whitespace-nowrap"><div>' + norm(row.ncm) + '</div><div class="' + muted + '">UN: ' + norm(row.unidade) + '</div></td>' +
            '<td class="' + cellClass + ' text-right font-semibold font-mono whitespace-nowrap">' + materialClienteFormatNumber(row.qtde) + '</td>' +
            '<td class="' + cellClass + '">' + materialClienteBadge(row.status_material) + '</td>' +
            '<td class="' + cellClass + '">' + materialClienteBadge(row.status_os) + '<div class="' + muted + '">Lista: ' + norm(row.status_os_listam) + '</div></td>' +
            '<td class="' + cellClass + '"><div class="font-medium">' + norm(row.os_utilizada) + '</div><div class="' + muted + ' break-words max-w-[240px]">' + norm(row.os) + '</div></td>' +
            '<td class="' + cellClass + ' whitespace-nowrap">' + norm(row.n_pedido) + '</td>' +
            '<td class="' + cellClass + ' whitespace-nowrap">' + norm(row.orcamento) + '</td>' +
            '<td class="' + cellClass + ' whitespace-nowrap">' + norm(formatDateBR(row.dt_aprovacao)) + '</td>' +
            '<td class="' + cellClass + ' whitespace-nowrap ' + (overdueRow ? 'font-bold text-rose-700 dark:text-rose-400' : '') + '">' + norm(formatDateBR(row.previsao_entrega)) + '</td>' +
            '<td class="' + cellClass + ' text-right font-bold font-mono whitespace-nowrap ' + (materialClienteNumber(row.dias_nf) > 365 ? 'text-rose-600 dark:text-rose-400' : 'text-slate-800 dark:text-slate-200') + '">' + (days || '-') + '</td>';
        fragment.appendChild(tr);
    });
    tbody.replaceChildren(fragment);
}

function loadMoreMaterialCliente() {
    materialClienteRenderLimit += 120;
    renderMaterialClienteView();
}

function applyMaterialClienteDataset(data, source = 'api', savedAt = null) {
    materialClienteData = Array.isArray(data) ? data.filter(item => item && typeof item === 'object' && !Array.isArray(item)) : [];
    materialClienteDataReady = true;
    materialClienteCacheSavedAt = savedAt || materialClienteCacheSavedAt;
    materialClienteLastSourceMode = source === 'cache' ? 'cache' : 'api';
    materialClienteSetupOptions();
    materialClienteRestoreFilters();
    applyMaterialClienteFilters();
    if (activeTab === 'MaterialCliente') {
        updateDataStatus(materialClienteLastSourceMode, materialClienteCacheSavedAt);
        setLoadingOverlay(false);
    }
}

async function refreshMaterialClienteData(manual = false, quiet = false) {
    if (isRefreshingMaterialClienteData) return;
    materialClienteLoadStarted = true;
    isRefreshingMaterialClienteData = true;
    setRefreshButtonBusy(true);
    if ((manual || !materialClienteDataReady) && activeTab === 'MaterialCliente') {
        setLoadingOverlay(true, manual ? 'Atualizando Material de Cliente...' : 'Carregando Material de Cliente...', 'Consultando /carteira_nf.', false);
    } else if (activeTab === 'MaterialCliente') {
        updateDataStatus('updating', materialClienteCacheSavedAt);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);
    try {
        const response = await fetch(MATERIAL_CLIENTE_API_URL, { method: 'GET', cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error('API /carteira_nf respondeu HTTP ' + response.status);
        const payload = await response.json();
        if (!Array.isArray(payload)) throw new Error('A API /carteira_nf não retornou uma lista JSON.');
        const savedAt = new Date().toISOString();
        materialClienteLastApiSyncAtMs = Date.now();
        applyMaterialClienteDataset(payload, 'api', savedAt);
        try { await writeMaterialClienteCache(payload, savedAt); }
        catch (cacheError) { console.warn('Cache de Material de Cliente indisponível:', cacheError); }
        if (activeTab === 'MaterialCliente' && manual) showDataToast('Material de Cliente atualizado.', 'success');
    } catch (error) {
        console.error('Falha em /carteira_nf:', error);
        if (activeTab === 'MaterialCliente') {
            if (materialClienteDataReady) {
                updateDataStatus('cache', materialClienteCacheSavedAt, 'Falha na sincronização, mantendo dados anteriores.');
                setLoadingOverlay(false);
                if (!quiet) showDataToast('Falha na API /carteira_nf. Dados anteriores mantidos.', 'warning');
            } else {
                updateDataStatus('error', null, error.message);
                setLoadingOverlay(true, 'Material de Cliente indisponível', 'Não foi possível acessar /carteira_nf e não existe cache local.', true);
            }
        }
    } finally {
        clearTimeout(timeout);
        isRefreshingMaterialClienteData = false;
        setRefreshButtonBusy(isRefreshingData || isRefreshingPedidoData);
    }
}

async function loadMaterialClienteData() {
    if (materialClienteLoadStarted) return;
    materialClienteLoadStarted = true;
    if (activeTab === 'MaterialCliente') {
        updateDataStatus('loading');
        setLoadingOverlay(true, 'Carregando Material de Cliente...', 'Verificando cache local.', false);
    }
    let cached = null;
    try { cached = await readMaterialClienteCache(); }
    catch (error) { console.warn('Sem cache de Material de Cliente:', error); }
    if (cached && Array.isArray(cached.data)) {
        materialClienteLastApiSyncAtMs = cached.savedAt ? (new Date(cached.savedAt).getTime() || 0) : 0;
        applyMaterialClienteDataset(cached.data, 'cache', cached.savedAt || null);
        refreshMaterialClienteData(false, true);
    } else {
        await refreshMaterialClienteData(false);
    }
}

function exportMaterialClienteExcel() {
    if (!filteredMaterialClienteData.length) {
        showDataToast('Não há materiais para exportar.', 'warning');
        return;
    }
    if (!window.XLSX) {
        showDataToast('Biblioteca Excel não carregada. Atualize a página.', 'error');
        return;
    }
    const rows = filteredMaterialClienteData.map(row => ({
        'Cliente': row.cliente ?? '',
        'CNPJ': row.cnpj ?? '',
        'Nº NF': row.n_nf ?? '',
        'Emissão NF': formatDateBR(row.dt_emissao_nf),
        'Código Interno': row.codigo_interno ?? '',
        'Item': row.item ?? '',
        'NCM': row.ncm ?? '',
        'Unidade': row.unidade ?? '',
        'Quantidade': materialClienteNumber(row.qtde),
        'Status Material': row.status_material ?? '',
        'Status OS': row.status_os ?? '',
        'Status OS Lista': row.status_os_listam ?? '',
        'OS Utilizada': row.os_utilizada ?? '',
        'OS': row.os ?? '',
        'Nº Pedido': row.n_pedido ?? '',
        'Orçamento': row.orcamento ?? '',
        'Aprovação': formatDateBR(row.dt_aprovacao),
        'Previsão Entrega': formatDateBR(row.previsao_entrega),
        'Dias NF': row.dias_nf == null ? '' : materialClienteNumber(row.dias_nf)
    }));
    const worksheet = window.XLSX.utils.json_to_sheet(rows);
    worksheet['!cols'] = Object.keys(rows[0]).map(key => ({ wch: Math.max(12, Math.min(32, key.length + 7)) }));
    const workbook = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(workbook, worksheet, 'Material Cliente');
    window.XLSX.writeFile(workbook, 'Material_Cliente_follow-up_' + materialClienteDateKey(new Date()) + '.xlsx');
}



// MATERIAL CLIENTE PERSONALIZAÇÃO V1.6.7
// Preferências exclusivamente locais: filtros, colunas, larguras, ordenação e linhas.
const MATERIAL_LAYOUT_KEY = 'sintercan_rs_material_layout_v2';
const MATERIAL_COLUMN_FILTER_KEY = 'sintercan_rs_material_column_filters_v2';
const MATERIAL_SORT_KEY = 'sintercan_rs_material_sort_v2';
const MATERIAL_PANEL_KEY = 'sintercan_rs_material_panel_collapsed_v2';

const materialCols = [
    { key:'cliente',          title:'Cliente / CNPJ',        width:225 },
    { key:'n_nf',             title:'NF / Emissão',          width:125 },
    { key:'codigo_interno',   title:'Código / Item',        width:245 },
    { key:'ncm',              title:'NCM / Un.',             width:110 },
    { key:'qtde',             title:'Qtde',                  width:85 },
    { key:'status_material',  title:'Status material',       width:165 },
    { key:'status_os',        title:'Status OS / Lista',     width:185 },
    { key:'os_utilizada',     title:'OS utilizada / OS',     width:235 },
    { key:'n_pedido',         title:'Pedido',                width:135 },
    { key:'orcamento',        title:'Orçamento',             width:145 },
    { key:'dt_aprovacao',     title:'Aprovação',             width:120 },
    { key:'previsao_entrega', title:'Previsão entrega',      width:135 },
    { key:'dias_nf',          title:'Dias NF',               width:90 }
];
const materialColsByKey = Object.fromEntries(materialCols.map(col => [col.key, col]));
let materialColumnOrder = materialCols.map(col => col.key);
let materialColumnHidden = new Set();
let materialColumnWidths = {};
let materialColumnSelections = {};
let materialFilterColumn = null;
let materialFilterWorking = null;
let materialFilterOptions = [];
let materialColumnDrag = null;
let materialResizeState = null;
let materialPreferencesLoaded = false;

function materialReadLocal(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
    } catch (_) { return fallback; }
}

function materialWriteLocal(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); }
    catch (error) { console.warn('Preferência local não gravada:', error); }
}

function materialLoadPreferences() {
    if (materialPreferencesLoaded) return;
    materialPreferencesLoaded = true;
    const layout = materialReadLocal(MATERIAL_LAYOUT_KEY, {});
    if (Array.isArray(layout.order)) {
        const valid = [...new Set(layout.order.filter(key => !!materialColsByKey[key]))];
        materialColumnOrder = [...valid, ...materialCols.map(c => c.key).filter(k => !valid.includes(k))];
    }
    if (Array.isArray(layout.hidden)) {
        const hidden = layout.hidden.filter(key => !!materialColsByKey[key]);
        if (hidden.length < materialCols.length) materialColumnHidden = new Set(hidden);
    }
    if (layout.widths && typeof layout.widths === 'object') {
        Object.entries(layout.widths).forEach(([key, width]) => {
            if (materialColsByKey[key] && Number.isFinite(Number(width))) {
                materialColumnWidths[key] = Math.max(75, Math.min(650, Math.round(Number(width))));
            }
        });
    }
    const savedFilters = materialReadLocal(MATERIAL_COLUMN_FILTER_KEY, {});
    if (savedFilters && typeof savedFilters === 'object') {
        for (const [key, values] of Object.entries(savedFilters)) {
            if (materialColsByKey[key] && Array.isArray(values)) {
                materialColumnSelections[key] = new Set(values.map(v => String(v)));
            }
        }
    }
    const sort = materialReadLocal(MATERIAL_SORT_KEY, {});
    if (sort && materialColsByKey[sort.key]) {
        materialClienteSortColumn = sort.key;
        materialClienteSortAsc = sort.asc === true;
    }
}

function materialSaveLayout() {
    materialWriteLocal(MATERIAL_LAYOUT_KEY, {
        order: materialColumnOrder,
        hidden: [...materialColumnHidden],
        widths: materialColumnWidths
    });
}
function materialSaveColumnFilters() {
    const serialized = {};
    Object.entries(materialColumnSelections).forEach(([key, selected]) => {
        if (selected instanceof Set) serialized[key] = [...selected];
    });
    materialWriteLocal(MATERIAL_COLUMN_FILTER_KEY, serialized);
}
function materialSaveSort() {
    materialWriteLocal(MATERIAL_SORT_KEY, {key:materialClienteSortColumn, asc:materialClienteSortAsc});
}

function materialColumnValue(row, key) {
    const raw = row[key];
    if (key === 'cliente') return String(row.cliente ?? '') + (row.cnpj ? ' | ' + row.cnpj : '');
    if (key === 'n_nf') return String(row.n_nf ?? '') + (row.dt_emissao_nf ? ' | ' + formatDateBR(row.dt_emissao_nf) : '');
    if (key === 'codigo_interno') return String(row.codigo_interno ?? '') + (row.item ? ' | ' + row.item : '');
    if (key === 'ncm') return String(row.ncm ?? '') + (row.unidade ? ' | ' + row.unidade : '');
    if (key === 'status_os') return String(row.status_os ?? '') + (row.status_os_listam ? ' | ' + row.status_os_listam : '');
    if (key === 'os_utilizada') return String(row.os_utilizada ?? '') + (row.os ? ' | ' + row.os : '');
    if (key === 'dt_aprovacao' || key === 'previsao_entrega') return raw ? formatDateBR(raw) : '(Vazio)';
    if (key === 'qtde' || key === 'dias_nf') return raw == null || raw === '' ? '(Vazio)' : materialClienteFormatNumber(raw);
    return raw == null || String(raw).trim() === '' ? '(Vazio)' : String(raw).trim();
}

function materialRowMatchesAll(row, excludedColumn = null) {
    const search = document.getElementById('filterGlobal')?.value.trim() || '';
    if (search && !matchesGlobalSearch(row, search)) return false;
    const equals = [
        ['materialFilterCliente', 'cliente'],
        ['materialFilterMaterial', 'status_material'],
        ['materialFilterOs', 'status_os'],
        ['materialFilterOsLista', 'status_os_listam']
    ];
    for (const [id, field] of equals) {
        const selected = document.getElementById(id)?.value || '';
        if (selected && String(row[field] ?? '') !== selected) return false;
    }
    const de = document.getElementById('materialFilterDe')?.value || '';
    const ate = document.getElementById('materialFilterAte')?.value || '';
    const due = materialClienteDateKey(row.previsao_entrega);
    if (de && (!due || due < de)) return false;
    if (ate && (!due || due > ate)) return false;
    for (const [key, selected] of Object.entries(materialColumnSelections)) {
        if (key === excludedColumn || !(selected instanceof Set)) continue;
        if (!selected.has(materialColumnValue(row, key))) return false;
    }
    return true;
}

function applyMaterialClienteFilters() {
    if (!materialClienteDataReady) return;
    materialLoadPreferences();
    filteredMaterialClienteData = materialClienteData.filter(row => materialRowMatchesAll(row));
    materialClienteRenderLimit = 120;
    materialClienteSortData();
    materialClienteSaveFilters();
    if (activeTab === 'MaterialCliente') renderMaterialClienteView();
}

function materialClienteSortData() {
    const key = materialClienteSortColumn;
    const numeric = key === 'qtde' || key === 'dias_nf' || key === 'n_nf';
    const date = ['dt_emissao_nf','dt_aprovacao','previsao_entrega'].includes(key);
    const mult = materialClienteSortAsc ? 1 : -1;
    filteredMaterialClienteData.sort((a,b) => {
        const va = a[key], vb = b[key];
        const blankA = va === null || va === undefined || va === '';
        const blankB = vb === null || vb === undefined || vb === '';
        if (blankA !== blankB) return blankA ? 1 : -1;
        let cmp = date ? (parseDate(va)?.getTime() || 0) - (parseDate(vb)?.getTime() || 0) :
                  numeric ? materialClienteNumber(va)-materialClienteNumber(vb) :
                  materialClienteCollator.compare(String(va ?? ''),String(vb ?? ''));
        return cmp*mult || materialClienteCollator.compare(String(a.cliente??''),String(b.cliente??''));
    });
}

function sortMaterialCliente(key) {
    if (!materialColsByKey[key]) return;
    if (materialClienteSortColumn === key) materialClienteSortAsc = !materialClienteSortAsc;
    else {
        materialClienteSortColumn = key;
        materialClienteSortAsc = !(key === 'dias_nf' || key === 'qtde' || key === 'previsao_entrega');
    }
    materialSaveSort();
    materialClienteSortData();
    materialClienteRenderLimit = 120;
    renderMaterialClienteView();
}

function materialVisibleColumns() {
    return materialColumnOrder.filter(key=>!materialColumnHidden.has(key)).map(key=>materialColsByKey[key]);
}

function materialColumnDragStart(event, key) {
    if (materialResizeState) {event.preventDefault();return;}
    materialColumnDrag=key;
    event.dataTransfer.effectAllowed='move';
    event.dataTransfer.setData('text/plain',key);
}
function materialColumnDragOver(event) {
    if (!materialColumnDrag) return;
    event.preventDefault();
    event.dataTransfer.dropEffect='move';
}
function materialColumnDrop(event,key) {
    event.preventDefault();
    const from=materialColumnDrag;
    materialColumnDrag=null;
    if(!from || from===key) return;
    const arr=materialColumnOrder.filter(k=>k!==from);
    arr.splice(arr.indexOf(key),0,from);
    materialColumnOrder=arr;
    materialSaveLayout();
    renderMaterialClienteView();
    materialRenderLayoutModal();
}
function materialResizeStart(event,key) {
    if(event.button!==0)return;
    event.preventDefault();
    event.stopPropagation();
    const start=event.clientX;
    materialResizeState={key,start,width:materialColumnWidths[key] || materialColsByKey[key].width};
    document.body.style.cursor='col-resize';
    document.body.style.userSelect='none';
    document.addEventListener('pointermove',materialResizeMove);
    document.addEventListener('pointerup',materialResizeEnd,{once:true});
}
function materialResizeMove(event) {
    if(!materialResizeState)return;
    const {key,start,width}=materialResizeState;
    materialColumnWidths[key]=Math.min(650,Math.max(75,Math.round(width+event.clientX-start)));
    const col=document.querySelector('#materialClienteColgroup col[data-material-col="'+key+'"]');
    if(col)col.style.width=materialColumnWidths[key]+'px';
    const visible=materialVisibleColumns();
    const table=document.getElementById('materialClienteTable');
    if(table)table.style.width=(visible.reduce((sum,c)=>sum+(materialColumnWidths[c.key]||c.width),0))+'px';
}
function materialResizeEnd() {
    document.removeEventListener('pointermove',materialResizeMove);
    if(materialResizeState) materialSaveLayout();
    materialResizeState=null;
    document.body.style.cursor='';
    document.body.style.userSelect='';
}

function materialClientCell(row,key) {
    const n = v=>escapeHtml(String(v ?? '') || '-');
    const muted='text-[10px] text-slate-500 dark:text-slate-400 mt-1 break-words';
    switch(key) {
        case 'cliente': return '<div class="font-semibold text-slate-900 dark:text-white break-words">'+n(row.cliente)+'</div><div class="'+muted+'">CNPJ '+n(row.cnpj)+'</div>';
        case 'n_nf':return '<div class="font-semibold">'+n(row.n_nf)+'</div><div class="'+muted+'">'+n(formatDateBR(row.dt_emissao_nf))+'</div>';
        case 'codigo_interno':return '<div class="font-mono font-bold text-amber-700 dark:text-amber-400 break-all">'+n(row.codigo_interno)+'</div><div class="'+muted+'">'+n(row.item)+'</div>';
        case 'ncm':return '<div>'+n(row.ncm)+'</div><div class="'+muted+'">Un.: '+n(row.unidade)+'</div>';
        case 'qtde':return '<div class="font-semibold text-right font-mono">'+materialClienteFormatNumber(row.qtde)+'</div>';
        case 'status_material':return materialClienteBadge(row.status_material);
        case 'status_os':return materialClienteBadge(row.status_os)+'<div class="'+muted+'">Lista: '+n(row.status_os_listam)+'</div>';
        case 'os_utilizada':return '<div class="font-semibold break-words">'+n(row.os_utilizada)+'</div><div class="'+muted+'">'+n(row.os)+'</div>';
        case 'n_pedido':return '<span class="break-all">'+n(row.n_pedido)+'</span>';
        case 'orcamento':return '<span class="break-words">'+n(row.orcamento)+'</span>';
        case 'dt_aprovacao':return '<span class="whitespace-nowrap">'+n(formatDateBR(row.dt_aprovacao))+'</span>';
        case 'previsao_entrega':return '<span class="whitespace-nowrap '+(materialClienteIsOverdue(row)?'font-extrabold text-rose-700 dark:text-rose-400':'')+'">'+n(formatDateBR(row.previsao_entrega))+'</span>';
        case 'dias_nf':return '<div class="text-right font-bold font-mono '+(materialClienteNumber(row.dias_nf)>365?'text-rose-700 dark:text-rose-400':'')+'">'+(row.dias_nf==null?'-':materialClienteFormatNumber(row.dias_nf,0))+'</div>';
        default:return n(row[key]);
    }
}

function materialRenderTableHeader() {
    const table=document.getElementById('materialClienteTable');
    const head=document.getElementById('materialClienteHeadRow');
    const group=document.getElementById('materialClienteColgroup');
    if(!table||!head||!group)return;
    const visible=materialVisibleColumns();
    table.style.tableLayout='fixed';
    table.style.width=(visible.reduce((sum,c)=>sum+(materialColumnWidths[c.key]||c.width),0))+'px';
    group.innerHTML=visible.map(col=>'<col data-material-col="'+col.key+'" style="width:'+(materialColumnWidths[col.key]||col.width)+'px">').join('');
    head.replaceChildren();
    visible.forEach(col=>{
        const th=document.createElement('th');
        th.draggable=false;
        th.className='relative px-2 py-2 border-r border-slate-300 dark:border-slate-700 bg-slate-200 dark:bg-slate-800 align-middle select-none';
        th.title='Arraste o título para mudar a posição da coluna';
        th.innerHTML='<div class="flex items-center justify-between gap-1">'+
            '<span draggable="true" data-material-drag="'+col.key+'" class="flex-shrink-0 cursor-grab active:cursor-grabbing text-slate-500 dark:text-slate-400 hover:text-amber-600 text-base px-0.5 touch-none" title="Arraste para mudar a posição da coluna" aria-label="Arrastar coluna '+escapeHtml(col.title)+'">⠿</span>'+
            '<button type="button" data-material-sort="'+col.key+'" class="text-left truncate flex-1 min-w-0 hover:text-amber-600 dark:hover:text-amber-400 font-bold" title="Ordenar '+escapeHtml(col.title)+'">'+escapeHtml(col.title)+'<span class="mat-sort-indicator"></span></button>'+
            '<button type="button" data-material-filter="'+col.key+'" class="material-col-filter flex-shrink-0 rounded p-1 hover:bg-white/60 dark:hover:bg-slate-700 '+(materialColumnSelections[col.key] instanceof Set?'bg-amber-400 text-slate-950':'text-slate-500 dark:text-slate-400')+'" title="Filtrar esta coluna" aria-label="Filtrar '+escapeHtml(col.title)+'">'+
            '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M7 12h10m-7 5h4"/></svg></button></div>'+
            '<span data-material-resize="'+col.key+'" class="absolute -right-1.5 top-0 bottom-0 w-3 z-20 cursor-col-resize hover:bg-amber-400/60 touch-none" title="Arraste para ajustar largura"></span>';
        th.querySelector('[data-material-sort]').addEventListener('click',()=>sortMaterialCliente(col.key));
        th.querySelector('[data-material-filter]').addEventListener('click',event=>materialOpenColumnFilter(event,col.key));
        th.querySelector('[data-material-resize]').addEventListener('pointerdown',event=>materialResizeStart(event,col.key));
        th.querySelector('[data-material-drag]').addEventListener('dragstart',event=>materialColumnDragStart(event,col.key));
        th.addEventListener('dragover',materialColumnDragOver);
        th.addEventListener('drop',event=>materialColumnDrop(event,col.key));
        th.querySelector('[data-material-drag]').addEventListener('dragend',()=>{materialColumnDrag=null;});
        head.appendChild(th);
    });
    const index = head.querySelector('[data-material-sort="'+materialClienteSortColumn+'"] .mat-sort-indicator');
    if(index)index.textContent=materialClienteSortAsc?' ▲':' ▼';
}

function renderMaterialClienteView() {
    if (!materialClienteDataReady) return;
    materialLoadPreferences();
    const data = filteredMaterialClienteData;
    const tbody = document.getElementById('materialClienteTableBody');
    if (!tbody) return;
    const amount = data.reduce((sum,row)=>sum+materialClienteNumber(row.qtde),0);
    const invoices = new Set(data.filter(r=>r.n_nf!=null&&r.n_nf!=='').map(r=>String(r.cnpj||r.cliente||'')+'|'+String(r.n_nf)+'|'+String(r.dt_emissao_nf||''))).size;
    const overdue=data.filter(materialClienteIsOverdue).length;
    const ages=data.filter(r=>r.dias_nf!==null&&r.dias_nf!==undefined&&r.dias_nf!=='').map(r=>materialClienteNumber(r.dias_nf));
    const kpis={
        materialKpiRegistros:data.length.toLocaleString('pt-BR'),
        materialKpiQuantidade:materialClienteFormatNumber(amount),
        materialKpiNotas:invoices.toLocaleString('pt-BR'),
        materialKpiVencidos:overdue.toLocaleString('pt-BR'),
        materialKpiDias:ages.length?Math.round(ages.reduce((a,b)=>a+b,0)/ages.length).toLocaleString('pt-BR'):'-',
        materialTotalRegistros:data.length.toLocaleString('pt-BR'),
        materialExibindoRegistros:Math.min(materialClienteRenderLimit,data.length).toLocaleString('pt-BR')
    };
    Object.entries(kpis).forEach(([id,value])=>{
        const el=document.getElementById(id);
        if(el)el.textContent=value;
    });
    document.getElementById('materialLoadMore')?.classList.toggle('hidden', data.length<=materialClienteRenderLimit);
    const filteredBadge=document.getElementById('materialActiveColumnFilters');
    const activeCount=Object.keys(materialColumnSelections).filter(key=>materialColumnSelections[key] instanceof Set).length;
    if(filteredBadge) {
        filteredBadge.textContent=activeCount?(activeCount+' filtros de coluna ativos'):'Arraste o ícone ⠿ para mover colunas';
        filteredBadge.classList.toggle('text-amber-600',activeCount>0);
    }
    materialRenderTableHeader();
    const visible=materialVisibleColumns();
    if (!data.length) {
        tbody.innerHTML='<tr><td colspan="'+visible.length+'" class="p-8 text-center text-slate-500 dark:text-slate-400">Nenhum material encontrado para os filtros selecionados.</td></tr>';
        return;
    }
    const fragment=document.createDocumentFragment();
    data.slice(0,materialClienteRenderLimit).forEach(row=>{
        const tr=document.createElement('tr');
        tr.className='hover:bg-amber-50/60 dark:hover:bg-slate-800/60 border-b border-slate-200 dark:border-slate-800 align-top';
        visible.forEach(col=>{
            const td=document.createElement('td');
            td.className='px-2.5 py-2.5 border-r border-slate-100 dark:border-slate-800/70 break-words overflow-hidden';
            td.innerHTML=materialClientCell(row,col.key);
            tr.appendChild(td);
        });
        fragment.appendChild(tr);
    });
    tbody.replaceChildren(fragment);
}

function materialColumnFilterPopover() {
    let popup=document.getElementById('materialColumnFilterPopup');
    if(popup)return popup;
    popup=document.createElement('div');
    popup.id='materialColumnFilterPopup';
    popup.className='fixed hidden z-[180] w-[305px] max-w-[calc(100vw-16px)] rounded-xl bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 shadow-2xl p-3 text-slate-800 dark:text-slate-100';
    popup.innerHTML='<div class="flex items-center justify-between gap-2 mb-2"><strong id="materialColumnFilterTitle" class="text-xs font-extrabold"></strong><button id="materialColumnFilterClose" title="Fechar" class="text-slate-500 hover:text-rose-500 p-1">✕</button></div>'+
        '<input id="materialColumnFilterSearch" type="search" placeholder="Buscar opções..." class="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-2.5 py-2 text-xs outline-none focus:border-amber-500 mb-2">'+
        '<div class="flex items-center justify-between gap-1 mb-2"><button id="materialColumnAll" class="rounded border border-slate-200 dark:border-slate-700 px-2 py-1.5 text-[11px]">Selecionar todos</button><button id="materialColumnNone" class="rounded border border-slate-200 dark:border-slate-700 px-2 py-1.5 text-[11px]">Desmarcar</button><span id="materialColumnFilterCount" class="text-[10px] text-slate-500"></span></div>'+
        '<div id="materialColumnFilterOptions" class="overflow-y-auto max-h-[240px] border-t border-b border-slate-200 dark:border-slate-800 py-1 text-xs"></div>'+
        '<div class="mt-3 flex gap-2"><button id="materialColumnFilterClear" class="flex-1 rounded-lg border border-slate-300 dark:border-slate-700 px-2 py-2 text-xs">Limpar filtro</button><button id="materialColumnFilterApply" class="flex-1 rounded-lg bg-amber-500 text-slate-950 font-bold px-2 py-2 text-xs">Aplicar</button></div>';
    document.body.appendChild(popup);
    popup.querySelector('#materialColumnFilterClose').addEventListener('click',materialCloseColumnFilter);
    popup.querySelector('#materialColumnFilterSearch').addEventListener('input',materialRenderColumnFilterOptions);
    popup.querySelector('#materialColumnAll').addEventListener('click',()=>{materialFilterWorking=null;materialRenderColumnFilterOptions();});
    popup.querySelector('#materialColumnNone').addEventListener('click',()=>{materialFilterWorking=new Set();materialRenderColumnFilterOptions();});
    popup.querySelector('#materialColumnFilterClear').addEventListener('click',()=>{
        delete materialColumnSelections[materialFilterColumn];
        materialSaveColumnFilters();materialCloseColumnFilter();applyMaterialClienteFilters();
    });
    popup.querySelector('#materialColumnFilterApply').addEventListener('click',()=>{
        if(materialFilterWorking===null || materialFilterWorking.size===materialFilterOptions.length)
            delete materialColumnSelections[materialFilterColumn];
        else materialColumnSelections[materialFilterColumn]=new Set(materialFilterWorking);
        materialSaveColumnFilters();materialCloseColumnFilter();applyMaterialClienteFilters();
    });
    popup.querySelector('#materialColumnFilterOptions').addEventListener('change',event=>{
        const checkbox=event.target.closest('input[data-material-option]');
        if(!checkbox)return;
        const index=Number(checkbox.dataset.materialOption);
        const value=materialFilterOptions[index];
        if(value===undefined)return;
        if(materialFilterWorking===null)materialFilterWorking=new Set(materialFilterOptions);
        if(checkbox.checked)materialFilterWorking.add(value);
        else materialFilterWorking.delete(value);
        popup.querySelector('#materialColumnFilterCount').textContent=materialFilterWorking.size+'/'+materialFilterOptions.length;
    });
    return popup;
}

function materialOpenColumnFilter(event,key) {
    event.preventDefault();event.stopPropagation();
    if(materialFilterColumn===key && !materialColumnFilterPopover().classList.contains('hidden')){
        materialCloseColumnFilter();return;
    }
    materialFilterColumn=key;
    // Opções respeitam os outros filtros, mas incluem sempre valores já selecionados.
    const options=materialClienteData.filter(row=>materialRowMatchesAll(row,key)).map(row=>materialColumnValue(row,key));
    const selected=materialColumnSelections[key];
    materialFilterOptions=[...new Set([...options,...(selected instanceof Set?[...selected]:[])])].sort(materialClienteCollator.compare);
    materialFilterWorking=selected instanceof Set?new Set(selected):null;
    const popover=materialColumnFilterPopover();
    popover.querySelector('#materialColumnFilterTitle').textContent=materialColsByKey[key].title;
    popover.querySelector('#materialColumnFilterSearch').value='';
    const rect=event.currentTarget.getBoundingClientRect();
    const popupWidth=305,popupHeight=420;
    popover.style.left=Math.max(8,Math.min(rect.left,window.innerWidth-popupWidth-8))+'px';
    popover.style.top=(rect.bottom+popupHeight+8<window.innerHeight?rect.bottom+5:Math.max(8,rect.top-popupHeight))+'px';
    popover.classList.remove('hidden');
    materialRenderColumnFilterOptions();
    popover.querySelector('#materialColumnFilterSearch').focus();
}

function materialRenderColumnFilterOptions() {
    const popup=materialColumnFilterPopover();
    if(!materialFilterColumn)return;
    const search=normalizeSearchText(popup.querySelector('#materialColumnFilterSearch').value||'');
    const entries=materialFilterOptions.map((value,index)=>({value,index})).filter(x=>!search || normalizeSearchText(x.value).includes(search));
    const shown=entries.slice(0,350);
    const options=popup.querySelector('#materialColumnFilterOptions');
    if(!shown.length)options.innerHTML='<p class="px-2 py-3 text-slate-500">Nenhuma opção encontrada.</p>';
    else options.innerHTML=shown.map(({value,index})=>
        '<label class="flex items-start gap-2 px-2 py-1.5 cursor-pointer rounded hover:bg-slate-100 dark:hover:bg-slate-800">'+
        '<input type="checkbox" data-material-option="'+index+'" '+(materialFilterWorking===null||materialFilterWorking.has(value)?'checked':'')+' class="mt-0.5 accent-amber-500 flex-shrink-0">'+
        '<span class="break-words min-w-0" title="'+escapeHtml(value)+'">'+escapeHtml(value)+'</span></label>'
    ).join('');
    const count=materialFilterWorking===null?materialFilterOptions.length:materialFilterWorking.size;
    popup.querySelector('#materialColumnFilterCount').textContent=count+'/'+materialFilterOptions.length;
    if(entries.length>shown.length)options.insertAdjacentHTML('beforeend','<p class="text-[10px] px-2 py-2 text-slate-500">Exibindo '+shown.length+' de '+entries.length+'. Use a busca para refinar.</p>');
}

function materialCloseColumnFilter() {
    document.getElementById('materialColumnFilterPopup')?.classList.add('hidden');
    materialFilterColumn=null;
    materialFilterWorking=null;
}

function resetMaterialClienteFilters() {
    const global=document.getElementById('filterGlobal');
    if(global)global.value='';
    MATERIAL_CLIENTE_FILTER_IDS.forEach(id=>{const e=document.getElementById(id);if(e)e.value='';});
    materialColumnSelections={};
    materialSaveColumnFilters();
    materialClienteFiltersRestored=true;
    try{localStorage.removeItem(MATERIAL_CLIENTE_FILTER_KEY);}catch(_){}
    materialCloseColumnFilter();
    applyMaterialClienteFilters();
}

function materialToggleFilters(force = null) {
    const section=document.getElementById('filterSection');
    if(!section)return;
    // force representa "mostrar filtros": force true abre, false fecha
    const hidden=force===null?!section.classList.contains('hidden'):!force;
    section.classList.toggle('hidden',hidden);
    const btn=document.getElementById('materialToggleFiltersBtn');
    if(btn)btn.innerHTML=hidden?
       '<span aria-hidden="true">⚑</span> Mostrar filtros':
       '<span aria-hidden="true">⚑</span> Recolher filtros';
    if(btn)btn.setAttribute('aria-expanded',hidden?'false':'true');
    try{localStorage.setItem(MATERIAL_PANEL_KEY,hidden?'1':'0');}catch(_){}
    materialCloseColumnFilter();
}
function materialApplyFilterVisibility() {
    const section=document.getElementById('filterSection');
    if(!section)return;
    if(activeTab==='MaterialCliente') {
        const hidden=localStorage.getItem(MATERIAL_PANEL_KEY)==='1';
        section.classList.toggle('hidden',hidden);
        const btn=document.getElementById('materialToggleFiltersBtn');
        if(btn)btn.textContent=hidden?'Mostrar filtros':'Recolher filtros';
        if(btn)btn.setAttribute('aria-expanded',hidden?'false':'true');
    } else {
        section.classList.remove('hidden');
    }
    materialCloseColumnFilter();
}

function materialRenderLayoutModal() {
    const body=document.getElementById('materialLayoutOptions');
    if(!body)return;
    body.innerHTML='';
    materialColumnOrder.forEach((key,index)=>{
        const col=materialColsByKey[key];
        const row=document.createElement('div');
        row.className='flex items-center gap-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-2 py-2 text-xs';
        row.draggable=true;
        row.innerHTML='<span class="cursor-grab text-slate-400" title="Arrastar coluna">⠿</span>'+
            '<label class="flex-1 flex items-center gap-2 min-w-0 cursor-pointer"><input type="checkbox" class="accent-amber-500" '+(materialColumnHidden.has(key)?'':'checked')+'><span class="font-semibold truncate">'+escapeHtml(col.title)+'</span></label>'+
            '<span class="text-[10px] text-slate-500">'+(materialColumnWidths[key]||col.width)+'px</span>'+
            '<button type="button" data-mat-col-up title="Mover para esquerda" class="rounded border border-slate-300 dark:border-slate-700 px-2 py-1">↑</button>'+
            '<button type="button" data-mat-col-down title="Mover para direita" class="rounded border border-slate-300 dark:border-slate-700 px-2 py-1">↓</button>';
        row.querySelector('input').addEventListener('change',e=>{
            if(!e.target.checked && materialVisibleColumns().length===1){
                e.target.checked=true;showDataToast('Mantenha pelo menos uma coluna visível.','warning');return;
            }
            if(e.target.checked)materialColumnHidden.delete(key);
            else materialColumnHidden.add(key);
            materialSaveLayout();renderMaterialClienteView();
        });
        const move=direction=>{
            const to=index+direction;
            if(to<0||to>=materialColumnOrder.length)return;
            [materialColumnOrder[index],materialColumnOrder[to]]=[materialColumnOrder[to],materialColumnOrder[index]];
            materialSaveLayout();renderMaterialClienteView();materialRenderLayoutModal();
        };
        row.querySelector('[data-mat-col-up]').addEventListener('click',()=>move(-1));
        row.querySelector('[data-mat-col-down]').addEventListener('click',()=>move(1));
        row.addEventListener('dragstart',event=>{materialColumnDrag=key;event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain',key);});
        row.addEventListener('dragover',event=>{event.preventDefault();});
        row.addEventListener('drop',event=>materialColumnDrop(event,key));
        row.addEventListener('dragend',()=>{materialColumnDrag=null;});
        body.appendChild(row);
    });
}

function materialOpenLayoutModal(){
    materialLoadPreferences();
    materialRenderLayoutModal();
    const modal=document.getElementById('materialLayoutModal');
    modal?.classList.remove('hidden');
    modal?.classList.add('flex');
}
function materialCloseLayoutModal(){
    const modal=document.getElementById('materialLayoutModal');
    modal?.classList.add('hidden');
    modal?.classList.remove('flex');
}
function materialResetLayout(){
    materialColumnOrder=materialCols.map(c=>c.key);
    materialColumnHidden=new Set();
    materialColumnWidths={};
    materialSaveLayout();
    renderMaterialClienteView();
    materialRenderLayoutModal();
    showDataToast('Colunas restauradas neste terminal.','success');
}
document.addEventListener('click',event=>{
    const popup=document.getElementById('materialColumnFilterPopup');
    if(popup && !popup.classList.contains('hidden') && !popup.contains(event.target) && !event.target.closest('[data-material-filter]'))
        materialCloseColumnFilter();
});
document.addEventListener('keydown',event=>{
    if(event.key==='Escape'){materialCloseColumnFilter();materialCloseLayoutModal();}
});
document.addEventListener('scroll',event=>{
    if(event.target.closest?.('#materialClienteTableScroll')) materialCloseColumnFilter();
},true);
document.addEventListener('DOMContentLoaded',()=>{
    materialLoadPreferences();
    materialApplyFilterVisibility();

});
