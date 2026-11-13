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
