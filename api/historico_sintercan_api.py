"""Histórico operacional Sintercan (PostgreSQL) -- somente TOS.U_HIST.

Instalação: salvar ao lado de main.py e iniciar uvicorn sintercan_historico_app:app.
Mantém o login já existente do portal Sintercan (/login), sem tokens adicionais.
O nome do usuário é recebido dos dados da sessão atual do portal.
"""
from __future__ import annotations

import re
import unicodedata
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import text
from conexao import engine

router = APIRouter(tags=["Histórico de OS"])


class ObservacaoRequest(BaseModel):
    usuario: str = Field(min_length=1, max_length=100)
    cod_empresa: int = Field(ge=1)
    observacao: str = Field(min_length=1, max_length=5000)


class PrazoRequest(BaseModel):
    usuario: str = Field(min_length=1, max_length=100)
    cod_empresa: int = Field(default=1, ge=1)
    nova_data: str
    justificativa: str


class PrioridadeRequest(BaseModel):
    usuario: str = Field(min_length=1, max_length=100)
    cod_empresa: int = Field(ge=1)
    prioridade: int = Field(ge=0, le=9)


class ZerarRequest(BaseModel):
    usuario: str = Field(min_length=1, max_length=100)
    cod_empresa: int = Field(ge=1)
    u_zerar: int = Field(ge=0, le=1)


class RenegociacaoRequest(BaseModel):
    usuario: str = Field(min_length=1, max_length=100)
    cod_empresa: int = Field(default=1, ge=1)
    u_data_renegociacao: Optional[str] = None
    U_JUST_ALT_DT_REN: str


def _get_user(nome: str) -> dict:
    """Identifica o usuário do login que já existe no portal, sem token extra.

    O nome é informado pela sessão do navegador e conferido em CSENHA.
    Atenção: sem autenticação adicional no backend, esse nome é declaratório.
    """
    nome = str(nome or "").strip().upper()
    if not nome:
        raise HTTPException(status_code=422, detail="Usuário da sessão não informado.")
    with engine.connect() as conn:
        user = conn.execute(text("""
            SELECT TRIM(nome) AS nome,
                   COALESCE(u_producao::text, '0') AS u_producao,
                   COALESCE(u_producao_valor::text, '0') AS u_producao_valor,
                   COALESCE(u_faturamento::text, '0') AS u_faturamento
              FROM CSENHA
             WHERE UPPER(TRIM(nome)) = :nome
               AND (inativo = 0 OR inativo IS NULL)
               AND (cod_empresa = 1 OR cod_empresa = '1')
        """), {"nome": nome}).mappings().first()
    if not user:
        raise HTTPException(status_code=403, detail="Usuário do CPS não encontrado ou inativo.")
    return dict(user)


def _permission(user: dict, *keys: str) -> None:
    if not any(str(user.get(key)) == "1" for key in keys):
        raise HTTPException(status_code=403, detail="Permissão insuficiente para esta operação.")


def _sanitize(value: object) -> str:
    val = unicodedata.normalize("NFC", str(value if value is not None else ""))
    val = val.replace("\r\n", "\n").replace("\r", "\n").replace("\t", " ")
    val = "".join(c for c in val if c == "\n" or (ord(c) >= 32 and ord(c) != 127))
    val = re.sub(r"\n{4,}", "\n\n\n", val).strip()
    # Não permitir forjar outro cartão de histórico com o conteúdo de uma observação.
    val = re.sub(r"(?im)^\s*===\s*(HISTORICO|FIM)\b", "— \\1", val)
    return val


def _request_key(value: Optional[str]) -> str:
    if not value:
        return str(uuid.uuid4())
    try:
        return str(uuid.UUID(str(value)))
    except (ValueError, AttributeError):
        raise HTTPException(status_code=400, detail="X-Idempotency-Key inválida (UUID esperado).")


def _now() -> str:
    try:
        zone = ZoneInfo("America/Sao_Paulo")
    except ZoneInfoNotFoundError:
        zone = timezone(timedelta(hours=-3))
    return datetime.now(zone).strftime("%d/%m/%Y %H:%M:%S")


def _event(user: dict, operation: str, changes=(), note: Optional[str] = None, key: Optional[str] = None) -> str:
    rows = [f"=== HISTORICO | {_now()} | {_sanitize(user['nome'])} | {_sanitize(operation).upper()} ==="]
    for field, before, after in changes:
        rows.append(f"{_sanitize(field)}: {_sanitize(before) or '—'} → {_sanitize(after) or '—'}")
    if note:
        rows.append("Observação: " + _sanitize(note))
    if key:
        rows.append("Requisição: " + _sanitize(key))
    return "\n".join([*rows, "=== FIM ==="])


def _history_value(row: dict) -> str:
    v = row.get("u_hist")
    if isinstance(v, (bytes, bytearray, memoryview)):
        raise HTTPException(status_code=409, detail="TOS.U_HIST é binário; exige conversão de codificação configurada.")
    return v or ""


def _lock(conn, cod_empresa: int, *, codigo_os: Optional[int] = None, n_os: Optional[str] = None) -> dict:
    if codigo_os is not None:
        where, params = "COD_EMPRESA=:empresa AND CODIGO=:codigo", {"empresa": cod_empresa, "codigo": codigo_os}
    else:
        where, params = "COD_EMPRESA=:empresa AND N_OS=:n_os", {"empresa": cod_empresa, "n_os": n_os}
    rows = conn.execute(text("""
       SELECT COD_EMPRESA, CODIGO, N_OS, U_HIST, PRIORIDADE,
              DT_PREVISTA, U_DATA_RENEGOCIACAO, U_ZERAR
         FROM TOS WHERE """ + where + " FOR UPDATE"), params).mappings().all()
    if not rows:
        raise HTTPException(status_code=404, detail="OS não encontrada.")
    if len(rows) > 1:
        raise HTTPException(status_code=409, detail="Identificador de OS ambíguo. Verifique empresa e número.")
    row = dict(rows[0])
    _history_value(row)
    return row


def _duplicate(row: dict, key: str) -> bool:
    return f"Requisição: {key}" in _history_value(row)


def _append(conn, row: dict, event: str) -> str:
    """Operação atômica executada com o row lock e alteração de OS na MESMA transação."""
    params = {"empresa": row["cod_empresa"], "codigo": row["codigo"], "evento": event}
    conn.execute(text("""
       UPDATE TOS SET U_HIST = :evento ||
           CASE WHEN U_HIST IS NULL OR U_HIST::text = '' THEN ''
                ELSE E'\n\n' || U_HIST::text END
        WHERE COD_EMPRESA=:empresa AND CODIGO=:codigo
    """), params)
    return conn.execute(text("""
       SELECT U_HIST FROM TOS WHERE COD_EMPRESA=:empresa AND CODIGO=:codigo
    """), params).scalar() or ""


def _unchanged(row: dict, key: str, **other) -> dict:
    return {"status": "ok", "alterou": False, "cod_empresa": row["cod_empresa"],
            "codigo_os": row["codigo"], "historico": _history_value(row),
            "requisicao": key, **other}


@router.get("/PRODUCAO/{codigo_os}/historico")
def obter_historico(codigo_os: int, cod_empresa: int = 1):
    with engine.connect() as conn:
        row = conn.execute(text("""
            SELECT COD_EMPRESA, CODIGO, N_OS, U_HIST FROM TOS
            WHERE COD_EMPRESA=:empresa AND CODIGO=:codigo
        """), {"empresa": cod_empresa, "codigo": codigo_os}).mappings().first()
    if not row:
        raise HTTPException(status_code=404, detail="OS não encontrada.")
    row = dict(row)
    return {"status": "ok", "cod_empresa": row["cod_empresa"], "codigo_os": row["codigo"],
            "n_os": row["n_os"], "historico": _history_value(row)}


@router.post("/PRODUCAO/{codigo_os}/observacao")
def salvar_observacao(
    codigo_os: int, body: ObservacaoRequest,
    key_header: Optional[str] = Header(None, alias="X-Idempotency-Key"),
):
    user = _get_user(body.usuario)
    _permission(user, "u_producao", "u_producao_valor", "u_faturamento")
    note = _sanitize(body.observacao)
    if not note:
        raise HTTPException(status_code=422, detail="Informe uma observação.")
    key = _request_key(key_header)
    with engine.begin() as conn:
        row = _lock(conn, body.cod_empresa, codigo_os=codigo_os)
        if _duplicate(row, key):
            return _unchanged(row, key)
        hist = _append(conn, row, _event(user, "OBSERVAÇÃO", note=note, key=key))
    return {"status": "ok", "alterou": True, "cod_empresa": body.cod_empresa,
            "codigo_os": codigo_os, "historico": hist, "requisicao": key}


@router.patch("/PRODUCAO/{n_os}/alterar-prazo")
def alterar_prazo(
    n_os: str, body: PrazoRequest,
    key_header: Optional[str] = Header(None, alias="X-Idempotency-Key"),
):
    user = _get_user(body.usuario)
    _permission(user, "u_producao", "u_producao_valor")
    note = _sanitize(body.justificativa)
    if not note:
        raise HTTPException(status_code=400, detail="Justificativa obrigatória.")
    try:
        nova = date.fromisoformat(body.nova_data)
    except ValueError:
        raise HTTPException(status_code=400, detail="Data inválida: use AAAA-MM-DD.")
    key = _request_key(key_header)
    with engine.begin() as conn:
        row = _lock(conn, body.cod_empresa, n_os=n_os.strip())
        antes = str(row["dt_prevista"] or "")[:10]
        if _duplicate(row, key) or antes == str(nova):
            return _unchanged(row, key, n_os=n_os, nova_data=antes)
        conn.execute(text("""
           UPDATE TOS SET DT_PREVISTA=:data, U_JUSTIFICATIVA_ALT_DT=:nota
            WHERE COD_EMPRESA=:empresa AND CODIGO=:codigo
        """), {"data": nova, "nota": note, "empresa":row["cod_empresa"], "codigo":row["codigo"]})
        hist = _append(conn, row, _event(user, "ALTERAÇÃO DA PREVISÃO DE ENTREGA",
                                         [("Previsão de entrega", antes, str(nova))], note, key))
    return {"status":"ok", "alterou": True, "n_os":n_os, "nova_data":str(nova),
            "codigo_os":row["codigo"], "cod_empresa":row["cod_empresa"], "historico":hist}


def _update_priority_cache(cod_empresa: int, codigo_os: int, prioridade: int) -> None:
    try:
        import main  # Só depois de a aplicação já ter inicializado; evita importação circular.
        if hasattr(main, "_atualizar_prioridade_no_cache"):
            main._atualizar_prioridade_no_cache(cod_empresa, codigo_os, prioridade)
    except Exception as exc:
        print("Aviso: cache de prioridade não sincronizado:", exc)


def _update_zero_cache(cod_empresa: int, codigo_os: int, zerar: int) -> None:
    try:
        import main
        with main._producao_cache_lock:
            key = (str(cod_empresa), str(codigo_os))
            if hasattr(main, "_producao_zerar_updates"):
                main._producao_zerar_updates[key] = (int(zerar), time.monotonic())
            rows = main._producao_cache
            for row in rows:
                if str(row.get("cod_empresa")) == key[0] and str(row.get("codigo_os")) == key[1]:
                    row["u_zerar"] = int(zerar)
            main._salvar_cache_producao_em_disco(rows)
    except Exception as exc:
        print("Aviso: cache do zeramento não sincronizado:", exc)


@router.patch("/PRODUCAO/{codigo_os}/alterar-prioridade")
def alterar_prioridade(
    codigo_os: int, body: PrioridadeRequest,
    key_header: Optional[str] = Header(None, alias="X-Idempotency-Key"),
):
    user = _get_user(body.usuario)
    _permission(user, "u_producao", "u_producao_valor")
    key = _request_key(key_header)
    with engine.begin() as conn:
        row = _lock(conn, body.cod_empresa, codigo_os=codigo_os)
        antes = int(row["prioridade"] if row["prioridade"] is not None else 5)
        if _duplicate(row, key) or antes == body.prioridade:
            return _unchanged(row, key, prioridade=antes)
        conn.execute(text("""
           UPDATE TOS SET PRIORIDADE=:novo WHERE COD_EMPRESA=:empresa AND CODIGO=:codigo
        """), {"novo":body.prioridade,"empresa":body.cod_empresa,"codigo":codigo_os})
        hist = _append(conn, row, _event(user, "ALTERAÇÃO DE PRIORIDADE",
                                         [("Prioridade", antes, body.prioridade)], key=key))
    _update_priority_cache(body.cod_empresa, codigo_os, body.prioridade)
    return {"status":"ok","alterou":True,"cod_empresa":body.cod_empresa,
            "codigo_os":codigo_os,"prioridade":body.prioridade,"historico":hist}


@router.patch("/PRODUCAO/{codigo_os}/alterar-zerar")
def alterar_zerar(
    codigo_os: int, body: ZerarRequest,
    key_header: Optional[str] = Header(None, alias="X-Idempotency-Key"),
):
    user = _get_user(body.usuario)
    _permission(user, "u_producao", "u_producao_valor")
    key = _request_key(key_header)
    with engine.begin() as conn:
        row = _lock(conn, body.cod_empresa, codigo_os=codigo_os)
        antes = int(row["u_zerar"] or 0)
        if _duplicate(row, key) or antes == body.u_zerar:
            return _unchanged(row, key, u_zerar=antes)
        conn.execute(text("""
           UPDATE TOS SET U_ZERAR=:novo WHERE COD_EMPRESA=:empresa AND CODIGO=:codigo
        """), {"novo":body.u_zerar,"empresa":body.cod_empresa,"codigo":codigo_os})
        hist = _append(conn, row, _event(user, "ALTERAÇÃO DO ZERAMENTO NA APLICAÇÃO",
                          [("Zerar na aplicação", "Sim" if antes else "Não",
                            "Sim" if body.u_zerar else "Não")], key=key))
    _update_zero_cache(body.cod_empresa, codigo_os, body.u_zerar)
    return {"status":"ok","alterou":True,"cod_empresa":body.cod_empresa,
            "codigo_os":codigo_os,"u_zerar":body.u_zerar,"historico":hist}


@router.patch("/faturamento/{n_os}/alterar-renegociacao")
def alterar_renegociacao(
    n_os: str, body: RenegociacaoRequest,
    key_header: Optional[str] = Header(None, alias="X-Idempotency-Key"),
):
    user = _get_user(body.usuario)
    _permission(user, "u_faturamento")
    note = _sanitize(body.U_JUST_ALT_DT_REN)
    if not note:
        raise HTTPException(status_code=400, detail="Justificativa obrigatória.")
    try:
        nova = date.fromisoformat(body.u_data_renegociacao) if body.u_data_renegociacao else None
    except ValueError:
        raise HTTPException(status_code=400, detail="Data inválida: use AAAA-MM-DD.")
    key = _request_key(key_header)
    with engine.begin() as conn:
        row = _lock(conn, body.cod_empresa, n_os=n_os.strip())
        antes = str(row["u_data_renegociacao"] or "")[:10] or None
        if _duplicate(row, key) or antes == (str(nova) if nova else None):
            return _unchanged(row, key, n_os=n_os, nova_data=antes)
        conn.execute(text("""
           UPDATE TOS SET U_DATA_RENEGOCIACAO=:nova, U_JUSTIFICATIVA=:nota
            WHERE COD_EMPRESA=:empresa AND CODIGO=:codigo
        """), {"nova":nova,"nota":note,"empresa":row["cod_empresa"],"codigo":row["codigo"]})
        hist = _append(conn, row, _event(user, "ALTERAÇÃO DA DATA DE RENEGOCIAÇÃO",
                              [("Renegociação", antes or "—", str(nova) if nova else "—")], note, key))
    return {"status":"ok","alterou":True,"n_os":n_os,
            "cod_empresa":row["cod_empresa"],"codigo_os":row["codigo"],
            "nova_data":str(nova) if nova else None,"historico":hist}