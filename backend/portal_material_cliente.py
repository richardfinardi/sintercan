"""Portais compartilháveis do follow-up de Materiais de Cliente da Sintercan.

Integração no main.py existente:
    from portal_material_cliente import router as material_portal_router
    app.include_router(material_portal_router)

Pré-requisitos: FastAPI existente, /login, /me e /carteira_nf na mesma API.
Usuários ativos com U_RS=1 podem criar portais; gestores podem gerenciar todos.
"""
import hashlib
import json
import os
import re
import secrets
import sqlite3
import urllib.error
import urllib.request
from collections import Counter
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from hmac import compare_digest
from pathlib import Path

from fastapi import APIRouter, Header, HTTPException, Query
from fastapi.responses import HTMLResponse, JSONResponse
from pydantic import BaseModel, Field

router = APIRouter(prefix="/material_cliente/portal", tags=["Material de cliente - portais"])

INTERNAL_API = os.environ.get("SINTERCAN_INTERNAL_API", "http://127.0.0.1:8000").rstrip("/")
PUBLIC_API = os.environ.get("SINTERCAN_PUBLIC_API", "https://sintercan.consultoriarf.net").rstrip("/")
DB_PATH = Path(os.environ.get(
    "SINTERCAN_MATERIAL_PORTAL_DB",
    str(Path(__file__).resolve().parent / "dados" / "material_cliente_portais.sqlite3"),
))
ALLOWED_COLS = {
    "cliente", "n_nf", "codigo_interno", "ncm", "qtde",
    "status_material", "status_os", "os_utilizada", "n_pedido",
    "orcamento", "dt_aprovacao", "previsao_entrega", "dias_nf",
}
# Somente os campos que compõem uma coluna autorizada podem chegar ao visitante.
COLUMN_FIELDS = {
    "cliente": ("cliente", "cnpj"),
    "n_nf": ("n_nf", "dt_emissao_nf"),
    "codigo_interno": ("codigo_interno", "item"),
    "ncm": ("ncm", "unidade"),
    "qtde": ("qtde",),
    "status_material": ("status_material",),
    "status_os": ("status_os", "status_os_listam"),
    "os_utilizada": ("os_utilizada", "os"),
    "n_pedido": ("n_pedido", "n_pedido_item"),
    "orcamento": ("orcamento", "descricao_orcamento"),
    "dt_aprovacao": ("dt_aprovacao",),
    "previsao_entrega": ("previsao_entrega",),
    "dias_nf": ("dias_nf",),
}
KEY_FIELDS = ("cnpj", "n_nf", "dt_emissao_nf", "codigo_interno", "item", "ncm", "qtde")
MAX_SELECTED = 12000
NO_CACHE = {"Cache-Control": "no-store, private", "Referrer-Policy": "no-referrer",
            "X-Content-Type-Options": "nosniff"}


class NovoPortal(BaseModel):
    nome: str = Field(min_length=3, max_length=120)
    validade_dias: int = Field(default=7, ge=1, le=365)
    permitir_excel: bool = False
    colunas: list[str] = Field(min_length=1, max_length=13)
    row_keys: dict[str, int] = Field(min_length=1)


class MudarStatus(BaseModel):
    ativo: bool


class LoginPortal(BaseModel):
    usuario: str = Field(min_length=1, max_length=100)
    senha: str = Field(min_length=1, max_length=255)


@contextmanager
def conn():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    cx = sqlite3.connect(str(DB_PATH), timeout=15)
    cx.row_factory = sqlite3.Row
    try:
        cx.execute("PRAGMA busy_timeout = 15000")
        cx.execute("""CREATE TABLE IF NOT EXISTS portais (
            id TEXT PRIMARY KEY, token TEXT NOT NULL, nome TEXT NOT NULL,
            criado_em TEXT NOT NULL, criado_por TEXT NOT NULL,
            validade_ate TEXT NOT NULL, ativo INTEGER NOT NULL DEFAULT 1,
            colunas TEXT NOT NULL, row_keys TEXT NOT NULL, qtd_itens INTEGER NOT NULL,
            permitir_excel INTEGER NOT NULL DEFAULT 0,
            qtd_acessos INTEGER NOT NULL DEFAULT 0, ultimo_acesso TEXT
        )""")
        cx.execute("""CREATE TABLE IF NOT EXISTS sessoes_portal (
            token_hash TEXT PRIMARY KEY, usuario TEXT NOT NULL,
            expira_em TEXT NOT NULL
        )""")
        yield cx
        cx.commit()
    finally:
        cx.close()


def http_json(path: str, headers=None, timeout=35, body=None):
    url = INTERNAL_API + path
    headers = dict(headers or {})
    headers.setdefault("Accept", "application/json")
    data = None
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, headers=headers, data=data)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403, 404):
            raise HTTPException(401 if exc.code == 401 else 403,
                                "Credenciais inválidas, sessão expirada ou acesso não autorizado.") from exc
        raise HTTPException(502, "API interna indisponível.") from exc
    except (urllib.error.URLError, ValueError, TimeoutError) as exc:
        raise HTTPException(502, "Não foi possível consultar a API interna.") from exc


def flag(valor):
    return str(valor if valor is not None else "0").strip().lower() in ("1", "true", "t")


def autorizar_portal(authorization: str | None) -> tuple[str, bool]:
    """Confere sessão criada após senha CPS e permissão U_RS atual no CPS."""
    if not authorization or not re.fullmatch(r"Bearer [A-Za-z0-9_-]{40,128}", authorization):
        raise HTTPException(401, "Informe sua senha CPS para gerenciar os portais.")
    token_hash = hashlib.sha256(authorization[7:].encode("utf-8")).hexdigest()
    with conn() as cx:
        sessao = cx.execute(
            "SELECT usuario, expira_em FROM sessoes_portal WHERE token_hash=?", (token_hash,)
        ).fetchone()
    if not sessao:
        raise HTTPException(401, "Sessão não encontrada. Entre novamente.")
    if datetime.fromisoformat(sessao["expira_em"]) <= now():
        with conn() as cx:
            cx.execute("DELETE FROM sessoes_portal WHERE token_hash=?", (token_hash,))
        raise HTTPException(401, "Sessão expirada. Entre novamente.")

    # A sessão prova quem entrou com a senha, mas a permissão é revalidada
    # no CPS a cada operação. Revogação de U_RS tem efeito imediato.
    usuario = str(sessao["usuario"]).strip().upper()
    atual = http_json("/me", body={"usuario": usuario}, timeout=12)
    if not isinstance(atual, dict) or str(atual.get("nome") or "").strip().upper() != usuario:
        raise HTTPException(403, "Usuário inativo ou não encontrado no CPS.")
    if not flag(atual.get("u_rs")):
        raise HTTPException(403, "Acesso ao módulo RS não autorizado.")
    return usuario, flag(atual.get("u_gestor"))


@router.post("/sessao")
def login_portal(payload: LoginPortal):
    """Autentica com a senha CPS sem exigir U_GESTOR."""
    dados = http_json("/login", body={
        "usuario": payload.usuario.strip(), "senha": payload.senha
    }, timeout=15)
    if not isinstance(dados, dict) or not flag(dados.get("u_rs")):
        raise HTTPException(403, "Somente usuários com acesso ao RS podem gerar links.")
    usuario = str(dados.get("nome") or "").strip().upper()
    if not usuario:
        raise HTTPException(403, "Usuário CPS inválido.")
    token = secrets.token_urlsafe(48)
    token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
    expira_em = iso(now() + timedelta(minutes=30))
    with conn() as cx:
        cx.execute("DELETE FROM sessoes_portal WHERE expira_em <= ?", (iso(now()),))
        cx.execute(
            "INSERT INTO sessoes_portal(token_hash,usuario,expira_em) VALUES(?,?,?)",
            (token_hash, usuario, expira_em),
        )
    return JSONResponse({
        "access_token": token, "expires_in": 1800, "usuario": usuario
    }, headers=NO_CACHE)


def now():
    return datetime.now(timezone.utc)


def iso(value):
    return value.isoformat(timespec="seconds")


def row_key(row):
    values = []
    for field in KEY_FIELDS:
        value = row.get(field)
        if field == "dt_emissao_nf":
            values.append(str(value or "")[:10])
        elif field == "qtde":
            try:
                normalized = str(value or "0").strip().replace(",", ".")
                values.append("%.6f" % float(normalized))
            except (TypeError, ValueError):
                values.append("0.000000")
        elif isinstance(value, float):
            values.append(format(value, ".15g"))
        else:
            values.append(str(value if value is not None else "").strip())
    return json.dumps(values, ensure_ascii=False, separators=(",", ":"))


def source_rows():
    payload = http_json("/carteira_nf", timeout=65)
    if not isinstance(payload, list):
        raise HTTPException(502, "A consulta carteira_nf não retornou uma lista.")
    return [row for row in payload if isinstance(row, dict)]


def extract(rows, keys):
    remaining = Counter({k: int(v) for k, v in keys.items()})
    result = []
    for row in rows:
        key = row_key(row)
        if remaining.get(key, 0) > 0:
            result.append(row)
            remaining[key] -= 1
    return result


def get_portal(portal_id):
    with conn() as cx:
        row = cx.execute("SELECT * FROM portais WHERE id=?", (portal_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Portal não encontrado.")
    return dict(row)


def public_portal(row, include_url=False):
    result = {
        "id": row["id"], "nome": row["nome"], "ativo": bool(row["ativo"]),
        "criado_em": row["criado_em"], "validade_ate": row["validade_ate"],
        "qtd_itens": row["qtd_itens"], "permitir_excel": bool(row["permitir_excel"]),
        "colunas": json.loads(row["colunas"]),
    }
    if include_url:
        result.update({
            "url": PUBLIC_API + "/material_cliente/portal/" + row["id"] + "?token=" + row["token"],
            "criado_por": row["criado_por"], "qtd_acessos": row["qtd_acessos"],
            "ultimo_acesso": row["ultimo_acesso"],
        })
    return result


@router.post("")
def criar_portal(payload: NovoPortal, authorization: str | None = Header(default=None)):
    usuario, _gestor = autorizar_portal(authorization)
    if len(set(payload.colunas)) != len(payload.colunas) or any(col not in ALLOWED_COLS for col in payload.colunas):
        raise HTTPException(422, "Colunas inválidas ou duplicadas.")
    if len(payload.row_keys) > MAX_SELECTED:
        raise HTTPException(422, "Quantidade excessiva de identificadores.")
    keys = payload.row_keys
    if any(not isinstance(k, str) or len(k) > 400 or isinstance(v, bool) or v < 1 or v > MAX_SELECTED
           for k, v in keys.items()):
        raise HTTPException(422, "Identificadores inválidos.")
    total = sum(keys.values())
    if total > MAX_SELECTED:
        raise HTTPException(422, "Limite de 12 mil registros por portal.")
    dados = extract(source_rows(), keys)
    if len(dados) != total:
        raise HTTPException(409, "Alguns registros mudaram. Atualize a aba e gere o portal novamente.")
    # Evita portais criados acidentalmente para diferentes clientes.
    clientes = {str(r.get("cnpj") or r.get("cliente") or "").strip() for r in dados}
    if len(clientes) > 1:
        raise HTTPException(422, "Filtre um único cliente antes de gerar o portal.")
    identificador = secrets.token_urlsafe(10).replace("-", "").replace("_", "")
    token = secrets.token_urlsafe(32)
    agora = now()
    criado = iso(agora)
    vence = iso(agora + timedelta(days=payload.validade_dias))
    with conn() as cx:
        cx.execute("""INSERT INTO portais
            (id,token,nome,criado_em,criado_por,validade_ate,ativo,colunas,row_keys,qtd_itens,permitir_excel)
            VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
            (identificador, token, payload.nome.strip(), criado, usuario, vence, 1,
             json.dumps(payload.colunas, ensure_ascii=False), json.dumps(keys, ensure_ascii=False),
             total, int(payload.permitir_excel)))
    return {"portal": public_portal(get_portal(identificador), include_url=True)}


@router.get("")
def listar_portais(authorization: str | None = Header(default=None)):
    usuario, gestor = autorizar_portal(authorization)
    with conn() as cx:
        # Limpa registros legados que foram apenas DESATIVADOS antes da
        # exclusão definitiva. Seus links já estavam bloqueados.
        cx.execute("DELETE FROM portais WHERE ativo = 0")
        if gestor:
            rows = cx.execute(
                "SELECT * FROM portais WHERE ativo = 1 ORDER BY criado_em DESC LIMIT 500"
            ).fetchall()
        else:
            rows = cx.execute(
                "SELECT * FROM portais WHERE ativo = 1 AND UPPER(criado_por)=? ORDER BY criado_em DESC LIMIT 500",
                (usuario,),
            ).fetchall()
    return JSONResponse(
        [public_portal(dict(row), include_url=True) for row in rows],
        headers=NO_CACHE,
    )


def _excluir_portal_autorizado(portal_id: str, authorization: str | None):
    """Exclui permanentemente portal e token. O link deixa de funcionar de imediato."""
    usuario, gestor = autorizar_portal(authorization)
    with conn() as cx:
        portal = cx.execute(
            "SELECT criado_por FROM portais WHERE id=?", (portal_id,)
        ).fetchone()
        if not portal:
            # Repetição do DELETE após exclusão em outra aba/dispositivo:
            # manter operação idempotente e não deixar o item preso na tela.
            return {"ok": True, "excluido": portal_id, "ja_excluido": True}
        if not gestor and str(portal["criado_por"]).strip().upper() != usuario:
            raise HTTPException(
                403, "Somente quem criou o portal ou um gestor pode excluí-lo."
            )
        resultado = cx.execute("DELETE FROM portais WHERE id=?", (portal_id,))
        if resultado.rowcount != 1:
            raise HTTPException(409, "A exclusão não foi confirmada.")
    return {"ok": True, "excluido": portal_id}


@router.delete("/{portal_id}")
def excluir_portal(portal_id: str, authorization: str | None = Header(default=None)):
    return _excluir_portal_autorizado(portal_id, authorization)


@router.patch("/{portal_id}/status", deprecated=True)
def alterar_status(portal_id: str, payload: MudarStatus, authorization: str | None = Header(default=None)):
    # Compatibilidade: navegadores com frontend antigo ainda chamam PATCH
    # para "desativar". Agora isso exclui o portal, não apenas marca como inativo.
    if payload.ativo:
        raise HTTPException(409, "O portal excluído não pode ser reativado. Gere um novo link.")
    return _excluir_portal_autorizado(portal_id, authorization)


@router.get("/{portal_id}/dados")
def dados_portal(portal_id: str, token: str = Query(min_length=20, max_length=150)):
    row = get_portal(portal_id)
    if not compare_digest(row["token"], token):
        raise HTTPException(403, "Link inválido.")
    if not row["ativo"]:
        raise HTTPException(403, "Este portal foi desativado.")
    if datetime.fromisoformat(row["validade_ate"]) < now():
        raise HTTPException(410, "Este portal expirou.")
    cols = json.loads(row["colunas"])
    keys = json.loads(row["row_keys"])
    dados = extract(source_rows(), keys)
    visible_fields = {field for col in cols for field in COLUMN_FIELDS[col]}
    sanitized = [{key: item.get(key) for key in visible_fields} for item in dados]
    def quantity(item):
        try:
            return float(str(item.get("qtde") or "0").replace(",", "."))
        except ValueError:
            return 0
    nf = {(str(x.get("cnpj")), str(x.get("n_nf")), str(x.get("dt_emissao_nf"))) for x in dados if x.get("n_nf")}
    today = now().date().isoformat()
    overdue = sum(1 for x in dados if str(x.get("previsao_entrega") or "")[:10] < today
                  and str(x.get("previsao_entrega") or "")[:10])
    with conn() as cx:
        cx.execute("UPDATE portais SET qtd_acessos=qtd_acessos+1, ultimo_acesso=? WHERE id=?",
                   (iso(now()), portal_id))
    return JSONResponse({
        "portal": public_portal(row), "dados": sanitized, "atualizado_em": iso(now()),
        "resumo": {"registros": len(dados),
                   "quantidade": sum(quantity(x) for x in dados) if "qtde" in cols else None,
                   "notas": len(nf) if "n_nf" in cols else None,
                   "vencidos": overdue if "previsao_entrega" in cols else None}
    }, headers=NO_CACHE)


CLIENT_HTML = r"""<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer">
<title>Sintercan | Acompanhamento de Materiais de Cliente</title>
<script src="https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js"></script>
<style>
:root{font-family:Inter,Segoe UI,Arial,sans-serif;color:#1e293b;background:#f1f5f9}
*{box-sizing:border-box}body{margin:0}header{background:#101b2b;color:white;padding:15px 3vw;display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:12px}
.brand{display:flex;align-items:center;gap:12px}.badge{background:#fbbf24;color:#111827;padding:9px;border-radius:10px;font-weight:900;letter-spacing:1px}.subtitle{font-size:12px;color:#cbd5e1}
h1{font-size:18px;margin:0 0 3px}main{padding:18px 3vw;max-width:2000px;margin:auto}.actions{display:flex;gap:8px;flex-wrap:wrap}
button{border:0;cursor:pointer;border-radius:9px;padding:10px 14px;font-weight:750;background:#fbbf24;color:#111827}button.secondary{background:#334155;color:white}
.panel{background:white;border:1px solid #e2e8f0;border-radius:15px;box-shadow:0 4px 15px #14243b0a;margin-bottom:14px;overflow:hidden}
.details{padding:16px;display:flex;flex-wrap:wrap;justify-content:space-between;gap:10px}.sub{font-size:11px;color:#64748b}
#title{margin:4px 0;font-size:21px}#kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:14px}
.card{background:white;padding:15px;border-radius:13px;border:1px solid #e2e8f0}.card b{display:block;font-size:22px;color:#b45309}.card small{font-size:11px;color:#64748b;text-transform:uppercase;font-weight:750}
.toolbar{padding:11px 14px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:10px;background:#f8fafc}
input{min-width:230px;max-width:100%;width:360px;padding:10px 12px;border-radius:9px;border:1px solid #cbd5e1;font:inherit;font-size:13px}
.table-scroll{overflow:auto;max-height:68vh}table{width:100%;border-collapse:separate;border-spacing:0;white-space:nowrap;font-size:12px}
th{position:sticky;top:0;background:#1e293b;color:white;padding:11px 12px;text-align:left;cursor:pointer;z-index:2}td{padding:11px 12px;border-bottom:1px solid #e2e8f0;vertical-align:top;white-space:normal;min-width:105px}
tbody tr:nth-child(even){background:#f8fafc}tbody tr:hover{background:#fffbeb}.muted{color:#64748b;font-size:10px;margin-top:4px}.strong{font-weight:750}
#notice{padding:50px;text-align:center;color:#64748b}footer{text-align:center;color:#94a3b8;font-size:11px;padding:10px}
@media(max-width:750px){#kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.card b{font-size:18px}main{padding:12px}.details{padding:13px}}
</style></head><body>
<header><div class="brand"><div class="badge">SC</div><div><h1>SINTERCAN</h1><div class="subtitle">Portal do Cliente | Follow-up de Materiais</div></div></div>
<div class="actions"><button class="secondary" id="excel" style="display:none">Exportar Excel</button><button id="refresh">Atualizar</button></div></header>
<main><section class="panel details"><div><div class="sub">ACOMPANHAMENTO COMPARTILHADO</div><h2 id="title">Materiais de Cliente</h2><div class="sub" id="expiry"></div></div><div class="sub" id="updated"></div></section>
<section id="kpis"></section><section class="panel"><div class="toolbar"><input id="search" type="search" placeholder="Pesquisar nos registros compartilhados"><strong id="count" style="font-size:12px;align-self:center"></strong></div>
<div id="notice">Carregando informações...</div><div class="table-scroll" id="tablebox" style="display:none"><table><thead id="head"></thead><tbody id="body"></tbody></table></div></section>
<footer>SINTERCAN | Informações disponibilizadas exclusivamente por link autorizado.</footer></main>
<script>
(function(){
"use strict";
var labels={cliente:"Cliente / CNPJ",n_nf:"NF / Emissão",codigo_interno:"Código / Item",ncm:"NCM / Un.",qtde:"Quantidade",status_material:"Status material",status_os:"Status OS / Lista",os_utilizada:"OS utilizada / OS",n_pedido:"Pedido",orcamento:"Orçamento / Descrição",dt_aprovacao:"Aprovação",previsao_entrega:"Previsão entrega",dias_nf:"Dias NF"};
var sub={cliente:"cnpj",n_nf:"dt_emissao_nf",codigo_interno:"item",ncm:"unidade",status_os:"status_os_listam",os_utilizada:"os",n_pedido:"n_pedido_item",orcamento:"descricao_orcamento"};
var dates={dt_aprovacao:1,previsao_entrega:1,dt_emissao_nf:1};
var columns=[],rows=[],filtered=[],meta={},sortCol="",sortAsc=true;
var $=function(id){return document.getElementById(id)};
var esc=function(v){return String(v===null||v===undefined?"":v).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]})};
function fmtDate(v){if(!v)return "-";var s=String(v).slice(0,10),p=s.split("-");return p.length===3&&p[0].length===4?p[2]+"/"+p[1]+"/"+p[0]:esc(s)}
function fmt(v,key){if(v===null||v===undefined||v==="")return "-";if(dates[key])return fmtDate(v);if(key==="qtde"||key==="dias_nf"){var n=Number(v);return Number.isFinite(n)?n.toLocaleString("pt-BR",{maximumFractionDigits:2}):esc(v)}return esc(v)}
function cell(row,key){var v=fmt(row[key],key),alt=sub[key],second=alt?fmt(row[alt],alt):"";if(second==="-")second="";return "<div class='strong'>"+v+"</div>"+(second?"<div class='muted'>"+second+"</div>":"")}
function render(){var q=$("search").value.toLocaleLowerCase("pt-BR").trim();filtered=rows.filter(function(r){return !q||columns.some(function(k){return String(r[k]||"").toLocaleLowerCase("pt-BR").includes(q)||String(r[sub[k]]||"").toLocaleLowerCase("pt-BR").includes(q)})});if(sortCol){filtered.sort(function(a,b){var x=a[sortCol],y=b[sortCol],n=(sortCol==="qtde"||sortCol==="dias_nf");var cmp=n?(Number(x||0)-Number(y||0)):String(x||"").localeCompare(String(y||""),"pt-BR",{numeric:true,sensitivity:"base"});return cmp*(sortAsc?1:-1)})}
$("count").textContent=filtered.length.toLocaleString("pt-BR")+" registros";
$("head").innerHTML="<tr>"+columns.map(function(k){return "<th data-sort='"+esc(k)+"'>"+esc(labels[k]||k)+(sortCol===k?(sortAsc?" ▲":" ▼"):"")+"</th>"}).join("")+"</tr>";
$("body").innerHTML=filtered.length?filtered.map(function(r){return "<tr>"+columns.map(function(k){return "<td>"+cell(r,k)+"</td>"}).join("")+"</tr>"}).join(""):"<tr><td colspan='"+columns.length+"' style='padding:35px;text-align:center'>Nenhum registro encontrado.</td></tr>";
$("head").querySelectorAll("[data-sort]").forEach(function(th){th.addEventListener("click",function(){var key=th.getAttribute("data-sort");sortAsc=sortCol===key?!sortAsc:true;sortCol=key;render()})})}
function drawKpis(summary){var cards=[["Materiais / registros",summary.registros],["Quantidade",summary.quantidade],["Notas fiscais",summary.notas],["Prazo vencido",summary.vencidos]].filter(function(x){return x[1]!==null&&x[1]!==undefined});$("kpis").innerHTML=cards.map(function(x){return "<div class='card'><small>"+x[0]+"</small><b>"+Number(x[1]).toLocaleString("pt-BR",{maximumFractionDigits:2})+"</b></div>"}).join("")}
async function load(){var p=new URLSearchParams(location.search),id=location.pathname.split("/").pop(),token=p.get("token");if(!token||!id){$("notice").textContent="Link incompleto.";return}$("refresh").disabled=true;try{var r=await fetch("/material_cliente/portal/"+encodeURIComponent(id)+"/dados?token="+encodeURIComponent(token),{cache:"no-store"}),d=await r.json().catch(function(){return {}});if(!r.ok)throw new Error(d.detail||"Erro HTTP "+r.status);meta=d.portal||{};rows=Array.isArray(d.dados)?d.dados:[];columns=Array.isArray(meta.colunas)?meta.colunas:[];$("title").textContent=meta.nome||"Materiais de Cliente";$("expiry").textContent="Disponível até "+new Date(meta.validade_ate).toLocaleString("pt-BR");$("updated").textContent="Atualizado em "+new Date(d.atualizado_em).toLocaleString("pt-BR");$("excel").style.display=meta.permitir_excel?"":"none";$("notice").style.display="none";$("tablebox").style.display="";drawKpis(d.resumo||{});render()}catch(err){$("tablebox").style.display="none";$("notice").style.display="block";$("notice").textContent=err.message||"Portal indisponível."}finally{$("refresh").disabled=false}}
function excel(){if(!meta.permitir_excel||!window.XLSX)return alert("Não foi possível carregar o gerador de Excel.");var data=filtered.map(function(r){var line={};columns.forEach(function(k){line[labels[k]||k]=(r[k]===null||r[k]===undefined?"":r[k])+(sub[k]&&r[sub[k]]?" | "+r[sub[k]]:"")});return line});var book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.json_to_sheet(data),"MATERIAIS");XLSX.writeFile(book,"SINTERCAN_MATERIAIS.xlsx")}
$("refresh").addEventListener("click",load);$("excel").addEventListener("click",excel);$("search").addEventListener("input",render);load();
})();
</script></body></html>"""


@router.get("/{portal_id}", response_class=HTMLResponse)
def pagina_portal(portal_id: str):
    # Apenas o HTML público; os registros são filtrados e validados em /dados.
    return HTMLResponse(CLIENT_HTML, headers=NO_CACHE)
