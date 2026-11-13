// Sintercan - Portal do Cliente para Materiais de Cliente (follow-up).
// Reutiliza a seleção filtrada da aba e a autenticação CPS para usuários do RS.
(function () {
    "use strict";

    const API = "https://sintercan.consultoriarf.net";
    const PORTALS = API + "/material_cliente/portal";
    const SOURCE_KEY_FIELDS = ["cnpj", "n_nf", "dt_emissao_nf", "codigo_interno", "item", "ncm", "qtde"];
    const KEY_LIMIT = 12000;
    let adminToken = null;
    let pendingAction = null;
    let selectedSnapshot = [];
    let busy = false;

    const esc = value => String(value ?? "").replace(/[&<>"']/g, char =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
    const $ = id => document.getElementById(id);

    function user() {
        try { return JSON.parse(localStorage.getItem("sintercan_user") || "{}"); }
        catch (_) { return {}; }
    }

    function stableKey(row) {
        return JSON.stringify(SOURCE_KEY_FIELDS.map(key => {
            const val = row[key];
            if (key === "dt_emissao_nf") return String(val || "").slice(0, 10);
            if (key === "qtde") {
                const n = Number(String(val ?? "0").replace(",", "."));
                return Number.isFinite(n) ? n.toFixed(6) : "0.000000";
            }
            return String(val ?? "").trim();
        }));
    }

    function keyCounts(rows) {
        const result = {};
        rows.forEach(row => {
            const key = stableKey(row);
            result[key] = (result[key] || 0) + 1;
        });
        return result;
    }

    function show(id, visible) {
        const modal = $(id);
        if (!modal) return;
        modal.classList.toggle("hidden", !visible);
        modal.classList.toggle("flex", !!visible);
    }

    function error(id, text) {
        const box = $(id);
        if (!box) return;
        box.textContent = text || "";
        box.classList.toggle("hidden", !text);
    }

    function dt(value) {
        if (!value) return "-";
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString("pt-BR");
    }

    async function request(url, options = {}, authenticated = true) {
        const headers = Object.assign({ "Content-Type": "application/json" },
            authenticated && adminToken ? { "Authorization": "Bearer " + adminToken } : {},
            options.headers || {});
        let response;
        try {
            response = await fetch(url, Object.assign({ cache: "no-store" }, options, { headers }));
        } catch (e) {
            throw new Error("Não foi possível comunicar com a API Sintercan.");
        }
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            if (response.status === 401 || response.status === 403) adminToken = null;
            throw new Error(data.detail || ("Erro HTTP " + response.status));
        }
        return data;
    }

    function inject() {
        if ($("materialPortalCreate")) return;

        const target = document.createElement("div");
        target.id = "materialPortalRoot";
        target.innerHTML = [
            '<div id="materialPortalCreate" class="hidden fixed inset-0 z-[180] bg-slate-950/70 backdrop-blur-sm items-center justify-center p-3" role="dialog" aria-modal="true">',
            ' <div class="bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 w-full max-w-3xl max-h-[92vh] rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700 overflow-hidden flex flex-col">',
            '  <div class="px-5 py-4 bg-slate-900 text-white flex justify-between items-center gap-2"><div><h2 class="font-black text-base">Gerar Portal do Cliente</h2><p class="text-xs text-slate-300 mt-1">Compartilhe apenas os materiais filtrados de um cliente.</p></div><button type="button" data-close="materialPortalCreate" class="text-white text-xl px-3" aria-label="Fechar">&times;</button></div>',
            '  <div class="overflow-y-auto p-5 space-y-4 text-xs">',
            '   <div class="grid sm:grid-cols-[1fr_155px] gap-3"><label class="block"><strong class="block mb-1">Nome do portal</strong><input id="materialPortalName" maxlength="120" class="w-full border border-slate-300 rounded-lg px-3 py-2.5 text-slate-900 dark:text-slate-900" placeholder="Cliente - Materiais" /></label>',
            '   <label class="block"><strong class="block mb-1">Validade</strong><select id="materialPortalValidity" class="w-full border border-slate-300 rounded-lg px-3 py-2.5 text-slate-900"><option value="7">7 dias</option><option value="15">15 dias</option><option value="30" selected>30 dias</option><option value="60">60 dias</option><option value="90">90 dias</option></select></label></div>',
            '   <div class="bg-amber-50 border border-amber-200 text-amber-900 rounded-xl px-4 py-3 flex flex-wrap gap-3 justify-between items-center"><div><strong id="materialPortalCount" class="text-xl block">0</strong><span>registros da seleção atual</span></div><span id="materialPortalClient" class="font-bold break-words"></span></div>',
            '   <label class="flex gap-2 items-center font-semibold"><input id="materialPortalExcel" type="checkbox" class="accent-amber-500 w-4 h-4">Permitir exportação para Excel ao cliente</label>',
            '   <div class="flex gap-3 justify-between items-center"><div><strong class="block">Colunas liberadas para o cliente</strong><span class="text-slate-500 dark:text-slate-400">Padrão: colunas atualmente visíveis na tabela.</span></div><div class="shrink-0 flex gap-2"><button type="button" id="materialPortalSelectAll" class="text-amber-700 dark:text-amber-300 font-bold">Todas</button><button type="button" id="materialPortalSelectNone" class="font-bold">Nenhuma</button></div></div>',
            '   <div id="materialPortalColumns" class="grid grid-cols-1 sm:grid-cols-2 gap-1.5 p-3 border rounded-xl bg-slate-50 dark:bg-slate-950 max-h-[250px] overflow-auto"></div>',
            '   <div id="materialPortalCreateError" class="hidden p-3 rounded-lg bg-rose-50 text-rose-700 border border-rose-200 font-semibold" role="alert"></div>',
            '   <div id="materialPortalResult" class="hidden p-4 rounded-xl bg-emerald-50 border border-emerald-200 text-slate-800"><strong class="text-emerald-800">Portal criado</strong><p class="text-xs my-2">Este link abre apenas os registros e colunas selecionados.</p><input id="materialPortalUrl" readonly class="w-full border rounded-lg px-3 py-2 bg-white text-xs text-slate-700"><div class="flex gap-2 mt-2"><button type="button" id="materialPortalCopy" class="rounded-lg bg-emerald-700 text-white px-3 py-2 font-bold">Copiar link</button><button type="button" id="materialPortalOpen" class="rounded-lg bg-slate-800 text-white px-3 py-2 font-bold">Abrir</button></div></div>',
            '  </div><div class="bg-slate-50 dark:bg-slate-950 border-t dark:border-slate-800 px-5 py-3 flex justify-between gap-3"><button type="button" id="materialPortalManagerShortcut" class="font-bold text-xs text-slate-700 dark:text-slate-200">Gerenciar portais</button><button type="button" id="materialPortalSubmit" class="rounded-lg bg-amber-500 hover:bg-amber-400 px-4 py-2.5 text-slate-950 font-black text-xs">Gerar link</button></div>',
            ' </div></div>',
            '<div id="materialPortalManager" class="hidden fixed inset-0 z-[181] bg-slate-950/70 backdrop-blur-sm items-center justify-center p-3" role="dialog" aria-modal="true">',
            ' <div class="w-full max-w-4xl bg-white border border-slate-200 rounded-2xl shadow-xl overflow-hidden flex flex-col max-h-[90vh]" style="color:#0f172a;background-color:#fff">',
            '  <div class="bg-slate-900 px-5 py-4 text-white flex items-center justify-between"><div><h2 class="text-base font-black" style="color:#fff">Portais de Materiais</h2><p class="text-xs" style="color:#cbd5e1">Links compartilhados, validade e ativação</p></div><button type="button" data-close="materialPortalManager" class="text-white text-xl px-3" aria-label="Fechar">&times;</button></div>',
            '  <div id="materialPortalManagerMessage" class="hidden mx-5 mt-4 p-3 rounded-lg text-xs font-semibold" role="status" aria-live="polite"></div>',
            '  <div id="materialPortalManagerList" class="overflow-y-auto p-5 space-y-2 text-xs min-h-[180px]">Carregando...</div>',
            '  <div class="border-t px-5 py-3 flex justify-end"><button type="button" id="materialPortalManagerRefresh" class="bg-amber-500 rounded-lg px-4 py-2 text-xs font-black text-slate-950">Atualizar lista</button></div>',
            ' </div></div>',
            '<div id="materialPortalLogin" class="hidden fixed inset-0 z-[190] bg-slate-950/85 backdrop-blur-sm items-center justify-center p-3" role="dialog" aria-modal="true">',
            ' <form id="materialPortalLoginForm" class="bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 w-full max-w-sm p-6 rounded-2xl shadow-2xl space-y-4"><div class="flex justify-between items-center"><h2 class="font-black text-base">Confirmação CPS</h2><button type="button" data-close="materialPortalLogin" class="font-bold text-xl">&times;</button></div><p class="text-xs text-slate-500 dark:text-slate-400">Para gerar ou gerenciar links externos, confirme sua senha de acesso ao RS.</p>',
            ' <label class="block text-xs font-bold">Usuário <input id="materialPortalUsername" readonly class="mt-1 block w-full border rounded-lg p-2.5 bg-slate-100 text-slate-900"></label><label class="block text-xs font-bold">Senha CPS<input id="materialPortalPassword" type="password" required autocomplete="current-password" class="mt-1 block w-full border rounded-lg p-2.5 text-slate-900"></label>',
            ' <div id="materialPortalLoginError" class="hidden p-2.5 text-xs text-rose-700 bg-rose-50 rounded-lg"></div><button id="materialPortalLoginSubmit" type="submit" class="w-full rounded-lg px-4 py-3 bg-amber-500 text-slate-950 font-black text-xs">Confirmar acesso</button>',
            ' </form></div>'
        ].join("");
        document.body.appendChild(target);
        target.querySelectorAll("[data-close]").forEach(button => button.addEventListener("click", () => show(button.dataset.close, false)));
        ["materialPortalCreate", "materialPortalManager"].forEach(id =>
            $(id).addEventListener("click", e => { if (e.target === $(id)) show(id, false); }));
        $("materialPortalSelectAll").addEventListener("click", () =>
            target.querySelectorAll(".portal-col").forEach(input => input.checked = true));
        $("materialPortalSelectNone").addEventListener("click", () =>
            target.querySelectorAll(".portal-col").forEach(input => input.checked = false));
        $("materialPortalSubmit").addEventListener("click", create);
        $("materialPortalManagerShortcut").addEventListener("click", openManager);
        $("materialPortalManagerRefresh").addEventListener("click", loadManager);
        $("materialPortalLoginForm").addEventListener("submit", login);
        $("materialPortalCopy").addEventListener("click", () => copy($("materialPortalUrl").value));
        $("materialPortalOpen").addEventListener("click", () => {
            if ($("materialPortalUrl").value) window.open($("materialPortalUrl").value, "_blank", "noopener,noreferrer");
        });
        document.addEventListener("keydown", event => {
            if (event.key === "Escape") {
                ["materialPortalLogin", "materialPortalCreate", "materialPortalManager"].forEach(id => show(id, false));
            }
        });
    }

    async function copy(text) {
        try {
            await navigator.clipboard.writeText(text);
        } catch (_) {
            const el = document.createElement("textarea");
            el.value = text;
            document.body.appendChild(el);
            el.select();
            document.execCommand("copy");
            el.remove();
        }
    }

    function authenticateThen(action) {
        if (adminToken) return action();
        pendingAction = action;
        $("materialPortalUsername").value = String(user().nome || "").trim().toUpperCase();
        $("materialPortalPassword").value = "";
        error("materialPortalLoginError", "");
        show("materialPortalLogin", true);
        $("materialPortalPassword").focus();
    }

    async function login(event) {
        event.preventDefault();
        if (busy) return;
        busy = true;
        const button = $("materialPortalLoginSubmit");
        button.disabled = true;
        error("materialPortalLoginError", "");
        try {
            const result = await request(API + "/material_cliente/portal/sessao", {
                method: "POST",
                body: JSON.stringify({
                    usuario: $("materialPortalUsername").value,
                    senha: $("materialPortalPassword").value
                })
            }, false);
            if (!result.access_token) throw new Error("A API não retornou uma sessão de acesso.");
            adminToken = result.access_token;
            $("materialPortalPassword").value = "";
            show("materialPortalLogin", false);
            const callback = pendingAction;
            pendingAction = null;
            if (callback) await callback();
        } catch (e) {
            error("materialPortalLoginError", e.message);
        } finally {
            button.disabled = false;
            busy = false;
        }
    }

    function openCreate() {
        inject();
        if (!materialClienteDataReady) return alert("Carregue os dados de Materiais de Cliente antes de gerar o portal.");
        selectedSnapshot = [...filteredMaterialClienteData];
        if (!selectedSnapshot.length) return alert("Não há materiais na seleção atual.");
        if (selectedSnapshot.length > KEY_LIMIT) return alert("Limite de 12.000 registros por portal.");
        const clients = [...new Set(selectedSnapshot.map(row => String(row.cnpj || row.cliente || "").trim()).filter(Boolean))];
        if (clients.length !== 1) return alert("Selecione apenas um cliente nos filtros antes de gerar o link. Isso evita compartilhar dados de outros clientes.");
        $("materialPortalClient").textContent = String(selectedSnapshot[0].cliente || clients[0]);
        $("materialPortalName").value = String(selectedSnapshot[0].cliente || clients[0]) + " - Materiais";
        $("materialPortalCount").textContent = selectedSnapshot.length.toLocaleString("pt-BR");
        $("materialPortalValidity").value = "30";
        $("materialPortalExcel").checked = false;
        $("materialPortalResult").classList.add("hidden");
        error("materialPortalCreateError", "");
        const visible = new Set(materialVisibleColumns().map(col => col.key));
        $("materialPortalColumns").innerHTML = materialCols.map(col =>
            '<label class="flex items-center gap-2 p-2 rounded-lg hover:bg-white dark:hover:bg-slate-800 cursor-pointer">' +
            '<input type="checkbox" class="portal-col accent-amber-500 w-4 h-4" value="' + esc(col.key) + '"' +
            (visible.has(col.key) ? " checked" : "") + '><span class="font-semibold text-[11px]">' +
            esc(col.title) + '</span></label>').join("");
        show("materialPortalManager", false);
        show("materialPortalCreate", true);
    }

    function create() {
        if (busy) return;
        if (!selectedSnapshot.length) return error("materialPortalCreateError", "Não há registros selecionados.");
        const nome = $("materialPortalName").value.trim();
        const colunas = [...document.querySelectorAll("#materialPortalColumns .portal-col:checked")].map(input => input.value);
        if (nome.length < 3) return error("materialPortalCreateError", "Informe um nome para o portal.");
        if (!colunas.length) return error("materialPortalCreateError", "Selecione pelo menos uma coluna.");
        authenticateThen(async () => {
            const btn = $("materialPortalSubmit");
            btn.disabled = true;
            btn.textContent = "Gerando...";
            error("materialPortalCreateError", "");
            try {
                const result = await request(PORTALS, {
                    method: "POST",
                    body: JSON.stringify({
                        nome, colunas, validade_dias: Number($("materialPortalValidity").value),
                        permitir_excel: $("materialPortalExcel").checked,
                        row_keys: keyCounts(selectedSnapshot)
                    })
                });
                $("materialPortalUrl").value = result.portal?.url || "";
                $("materialPortalResult").classList.remove("hidden");
            } catch (e) {
                error("materialPortalCreateError", e.message);
                if (!adminToken) pendingAction = () => create();
            } finally {
                btn.disabled = false;
                btn.textContent = "Gerar link";
            }
        });
    }

    function openManager() {
        inject();
        authenticateThen(async () => {
            show("materialPortalCreate", false);
            show("materialPortalManager", true);
            await loadManager();
        });
    }

    function managerMessage(message, isError = false) {
        const box = $("materialPortalManagerMessage");
        box.textContent = message || "";
        box.className = message
            ? "mx-5 mt-4 p-3 rounded-lg text-xs font-semibold border " +
              (isError ? "bg-rose-50 text-rose-800 border-rose-200" : "bg-emerald-50 text-emerald-800 border-emerald-200")
            : "hidden mx-5 mt-4 p-3 rounded-lg text-xs font-semibold";
    }

    async function loadManager() {
        const box = $("materialPortalManagerList");
        box.textContent = "Consultando portais...";
        try {
            const list = await request(PORTALS);
            if (!Array.isArray(list) || !list.length) {
                box.textContent = "Nenhum portal de materiais criado.";
                return;
            }
            box.innerHTML = list.map(p => {
                const url = encodeURIComponent(p.url || "");
                return '<article class="border border-slate-200 dark:border-slate-700 rounded-xl p-3 flex flex-col md:flex-row md:justify-between gap-2 items-start md:items-center">' +
                    '<div class="min-w-0"><div class="flex flex-wrap items-center gap-2"><strong class="text-xs break-words" style="color:#0f172a">' + esc(p.nome) +
                    '</strong><span class="px-2 py-0.5 rounded-full text-[10px] font-black ' +
                    (p.ativo ? "bg-emerald-100 text-emerald-800" : "bg-rose-100 text-rose-700") + '">' +
                    (p.ativo ? "ATIVO" : "DESATIVADO") + '</span></div><p class="text-[10px] text-slate-500 dark:text-slate-400 mt-1">' +
                    Number(p.qtd_itens || 0).toLocaleString("pt-BR") + " itens · Vence " + esc(dt(p.validade_ate)) +
                    " · " + Number(p.qtd_acessos || 0) + ' acessos</p></div><div class="flex flex-wrap gap-1.5 shrink-0">' +
                    '<button type="button" data-portal-copy="' + url + '" class="bg-slate-100 text-slate-800 rounded-lg px-3 py-2 text-[11px] font-bold">Copiar</button>' +
                    '<button type="button" data-portal-open="' + url + '" class="bg-slate-100 text-slate-800 rounded-lg px-3 py-2 text-[11px] font-bold">Abrir</button>' +
                    '<button type="button" data-portal-id="' + esc(p.id) + '" data-portal-active="' + (p.ativo ? "0" : "1") +
                    '" class="' + (p.ativo ? "bg-rose-50 text-rose-700" : "bg-emerald-50 text-emerald-700") +
                    ' rounded-lg px-3 py-2 text-[11px] font-bold">' + (p.ativo ? "Desativar" : "Reativar") + '</button></div></article>';
            }).join("");
            box.querySelectorAll("[data-portal-copy]").forEach(btn =>
                btn.addEventListener("click", () => copy(decodeURIComponent(btn.dataset.portalCopy))));
            box.querySelectorAll("[data-portal-open]").forEach(btn =>
                btn.addEventListener("click", () => window.open(decodeURIComponent(btn.dataset.portalOpen), "_blank", "noopener,noreferrer")));
            box.querySelectorAll("[data-portal-id]").forEach(btn =>
                btn.addEventListener("click", () => changeStatus(btn.dataset.portalId, btn.dataset.portalActive === "1", btn)));
        } catch (e) {
            box.innerHTML = '<p class="text-rose-700 font-bold">' + esc(e.message) + "</p>";
            if (!adminToken) pendingAction = loadManager;
        }
    }

    async function changeStatus(id, ativo, button) {
        const action = ativo ? "reativar" : "desativar";
        const original = ativo ? "Reativar" : "Desativar";

        // Confirmação dentro do próprio modal: navegadores podem bloquear
        // window.confirm(), fazendo o primeiro clique parecer que não funciona.
        if (button.dataset.confirmReady !== "1") {
            document.querySelectorAll("#materialPortalManagerList [data-portal-id]").forEach(btn => {
                btn.dataset.confirmReady = "";
                btn.textContent = btn.dataset.portalActive === "1" ? "Reativar" : "Desativar";
            });
            button.dataset.confirmReady = "1";
            button.textContent = ativo ? "Confirmar reativação" : "Confirmar desativação";
            managerMessage("Clique novamente em ‘" + button.textContent + "’ para " + action + " este link.");
            setTimeout(() => {
                if (button.isConnected && button.dataset.confirmReady === "1") {
                    button.dataset.confirmReady = "";
                    button.textContent = original;
                    managerMessage("");
                }
            }, 10000);
            return;
        }

        button.disabled = true;
        button.dataset.confirmReady = "";
        button.textContent = ativo ? "Reativando..." : "Desativando...";
        managerMessage("");
        try {
            const result = await request(PORTALS + "/" + encodeURIComponent(id) + "/status", {
                method: "PATCH", body: JSON.stringify({ ativo })
            });
            if (!result?.portal || result.portal.ativo !== ativo) {
                throw new Error("A API não confirmou a alteração do portal.");
            }
            await loadManager();
            managerMessage(ativo ? "Portal reativado com sucesso." : "Portal desativado. O link não poderá mais consultar os dados.");
        } catch (e) {
            managerMessage("Falha ao " + action + " o portal: " + (e.message || String(e)), true);
            button.disabled = false;
            button.textContent = original;
        }
    }

    async function init() {
        const ready = await window.__SINTERCAN_AUTH_READY__;
        if (!ready || Number(user().u_rs) !== 1) return;
        inject();
        const toolbar = $("materialClearFiltersBtn")?.parentElement;
        if (!toolbar || $("materialPortalCreateBtn")) return;
        const btn = document.createElement("button");
        btn.id = "materialPortalCreateBtn";
        btn.type = "button";
        btn.className = "px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 font-black border border-amber-500 shadow-sm";
        btn.textContent = "Portal Cliente";
        btn.title = "Gerar link de acompanhamento dos materiais filtrados";
        btn.addEventListener("click", openCreate);
        toolbar.prepend(btn);
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
    else init();
})();
