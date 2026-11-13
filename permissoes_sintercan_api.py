"""Gerenciador de acessos Sintercan baseado em CSENHA (empresa 1).

Integração no main.py existente:
    from permissoes_sintercan_api import criar_router_permissoes
    app.include_router(criar_router_permissoes(get_conn))

get_conn deve retornar conexão DB-API PostgreSQL/psycopg2.
Configure SINTERCAN_ACCESS_SECRET_KEY (aleatória com pelo menos 32 caracteres)
no ambiente da API. Não reutilize senha de usuário nem publique a chave.
O login administrativo é separado do login atual do portal: exige a senha
CPS novamente, e TODAS as rotas conferem U_GESTOR no banco.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import secrets
import threading
import time
from collections import defaultdict, deque
from datetime import datetime, timezone
from typing import Callable

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

logger = logging.getLogger("sintercan.permissoes")
EMPRESA = 1
CAMPOS = (
    "U_PRODUCAO", "U_ESTOQUE_PA", "U_ESTOQUE_MP",
    "U_FATURAMENTO", "U_QUALIDADE", "U_FINANCEIRO",
    "U_RS", "U_COMPRAS", "U_CUSTOS", "U_PRODUCAO_VALOR", "U_GESTOR",
)
_TENTATIVAS = defaultdict(deque)
_TRAVA = threading.Lock()


class Credenciais(BaseModel):
    usuario: str = Field(min_length=1, max_length=120)
    senha: str = Field(min_length=1, max_length=200)


class Permissoes(BaseModel):
    u_producao: int = Field(ge=0, le=1)
    u_estoque_pa: int = Field(ge=0, le=1)
    u_estoque_mp: int = Field(ge=0, le=1)
    u_faturamento: int = Field(ge=0, le=1)
    u_qualidade: int = Field(ge=0, le=1)
    u_financeiro: int = Field(ge=0, le=1)
    u_rs: int = Field(ge=0, le=1)
    u_compras: int = Field(ge=0, le=1)
    u_custos: int = Field(ge=0, le=1)
    u_producao_valor: int = Field(ge=0, le=1)
    u_gestor: int = Field(ge=0, le=1)


def _secret() -> bytes:
    key = os.getenv("SINTERCAN_ACCESS_SECRET_KEY", "").encode("utf-8")
    if len(key) < 32:
        raise HTTPException(
            503, "Administração de acessos não configurada na API. "
                 "Defina SINTERCAN_ACCESS_SECRET_KEY com 32+ caracteres."
        )
    return key


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _gerar_token(usuario: str) -> str:
    corpo = _b64(json.dumps(
        {"usuario": usuario, "exp": int(time.time()) + 1800, "escopo": "permissoes"},
        separators=(",", ":"), ensure_ascii=False
    ).encode("utf-8"))
    assinatura = _b64(hmac.new(_secret(), corpo.encode(), hashlib.sha256).digest())
    return corpo + "." + assinatura


def _ler_token(token: str) -> str:
    try:
        corpo, assinatura = token.split(".", 1)
        correto = _b64(hmac.new(_secret(), corpo.encode(), hashlib.sha256).digest())
        if not hmac.compare_digest(assinatura, correto):
            raise ValueError("assinatura inválida")
        dados = json.loads(_unb64(corpo))
        if dados.get("escopo") != "permissoes" or int(dados.get("exp", 0)) < time.time():
            raise ValueError("token expirado ou sem permissão")
        return str(dados["usuario"]).strip().upper()
    except (ValueError, KeyError, TypeError, UnicodeError) as exc:
        raise HTTPException(401, "Sessão administrativa inválida ou expirada.") from exc


def _validar_senha_grv(informada: str, gravada) -> bool:
    """Compatibilidade com legados CPS (MD5 / senha direta).
    Adapte somente esta função se a autenticação existente no main.py
    aplicar uma regra diferente. Não altere/normalize a senha informada.
    """
    if gravada is None:
        return False
    if isinstance(gravada, memoryview):
        gravada = gravada.tobytes()
    if isinstance(gravada, bytes):
        try:
            gravada = gravada.decode("utf-8")
        except UnicodeDecodeError:
            gravada = gravada.hex()
    gravada = str(gravada).strip()
    candidatas = {informada}
    for codificacao in ("utf-8", "cp1252"):
        for texto in {informada, informada.upper(), informada.lower()}:
            try:
                candidatas.add(hashlib.md5(texto.encode(codificacao)).hexdigest())
            except UnicodeEncodeError:
                pass
    return any(hmac.compare_digest(valor.casefold(), gravada.casefold())
               for valor in candidatas)


def _flag(valor) -> int:
    return 1 if valor is True or str(valor).strip().lower() in ("1", "true", "t") else 0


def _registro(colunas, valores):
    return dict(zip(colunas, valores))


def _rate_limit(request: Request):
    # Limite simples; em múltiplos processos, configure rate-limit no proxy também.
    ip = request.client.host if request.client else "desconhecido"
    agora = time.monotonic()
    with _TRAVA:
        fila = _TENTATIVAS[ip]
        while fila and agora - fila[0] > 300:
            fila.popleft()
        if len(fila) >= 10:
            raise HTTPException(429, "Muitas tentativas. Tente novamente em alguns minutos.")
        fila.append(agora)


def criar_router_permissoes(get_conn: Callable) -> APIRouter:
    router = APIRouter(prefix="/permissoes", tags=["Permissões Sintercan"])

    def consultar_usuario(nome: str):
        conn = get_conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT NOME, SENHA, COALESCE(U_GESTOR,0) FROM CSENHA "
                    "WHERE COD_EMPRESA=%s AND COALESCE(INATIVO,0)=0 "
                    "AND UPPER(TRIM(NOME))=%s LIMIT 1",
                    (EMPRESA, nome.strip().upper())
                )
                return cur.fetchone()
        finally:
            conn.close()

    def exigir_gestor(request: Request):
        auth = request.headers.get("authorization", "")
        if not auth.lower().startswith("bearer "):
            raise HTTPException(401, "Autenticação administrativa necessária.")
        nome = _ler_token(auth[7:].strip())
        row = consultar_usuario(nome)
        if not row or not _flag(row[2]):
            raise HTTPException(403, "Acesso restrito aos gestores ativos.")
        return nome

    @router.post("/login")
    def login_admin(pedido: Credenciais, request: Request):
        _rate_limit(request)
        nome = pedido.usuario.strip().upper()
        row = consultar_usuario(nome)
        # Nunca diferenciar usuário inexistente de senha incorreta.
        if not row or not _validar_senha_grv(pedido.senha, row[1]):
            raise HTTPException(401, "Usuário ou senha inválidos.")
        if not _flag(row[2]):
            raise HTTPException(403, "Somente gestores podem gerenciar acessos.")
        return JSONResponse(
            {"access_token": _gerar_token(str(row[0])), "expires_in": 1800},
            headers={"Cache-Control": "no-store"}
        )

    @router.get("/usuarios")
    def listar_usuarios(gestor: str = Depends(exigir_gestor)):
        conn = get_conn()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT NOME, " + ", ".join("COALESCE(" + campo + ",0)" for campo in CAMPOS) +
                    " FROM CSENHA WHERE COD_EMPRESA=%s AND COALESCE(INATIVO,0)=0 ORDER BY NOME",
                    (EMPRESA,)
                )
                linhas = cur.fetchall()
            usuarios = [
                {"usuario": str(linha[0]).strip(),
                 **{campo.lower(): _flag(linha[i + 1]) for i, campo in enumerate(CAMPOS)}}
                for linha in linhas
            ]
            return JSONResponse({"usuarios": usuarios}, headers={"Cache-Control": "no-store"})
        finally:
            conn.close()

    @router.patch("/usuarios/{usuario}")
    def editar_usuario(usuario: str, alteracoes: Permissoes, gestor: str = Depends(exigir_gestor)):
        nome = usuario.strip().upper()
        payload = alteracoes.model_dump() if hasattr(alteracoes, "model_dump") else alteracoes.dict()
        conn = get_conn()
        try:
            with conn.cursor() as cur:
                # Trava todas as linhas ativas: duas alterações simultâneas nunca
                # podem retirar a permissão do último gestor.
                cur.execute(
                    "SELECT NOME, COALESCE(U_GESTOR,0) FROM CSENHA "
                    "WHERE COD_EMPRESA=%s AND COALESCE(INATIVO,0)=0 FOR UPDATE",
                    (EMPRESA,)
                )
                ativos = [(str(x[0]).strip().upper(), _flag(x[1])) for x in cur.fetchall()]
                if not any(n == gestor and g for n, g in ativos):
                    raise HTTPException(403, "Seu acesso de gestor foi revogado.")
                alvo = next((g for n, g in ativos if n == nome), None)
                if alvo is None:
                    raise HTTPException(404, "Usuário ativo não encontrado.")
                if alvo == 1 and payload["u_gestor"] == 0 and sum(g for _, g in ativos) <= 1:
                    raise HTTPException(409, "Não é permitido desativar o último gestor.")
                cur.execute(
                    "UPDATE CSENHA SET " +
                    ", ".join(campo + "=%s" for campo in CAMPOS) +
                    " WHERE COD_EMPRESA=%s AND COALESCE(INATIVO,0)=0 "
                    "AND UPPER(TRIM(NOME))=%s",
                    tuple(payload[campo.lower()] for campo in CAMPOS) + (EMPRESA, nome)
                )
                if cur.rowcount != 1:
                    raise HTTPException(409, "Não foi possível atualizar um único usuário.")
            conn.commit()
            logger.warning("Permissões CSENHA alteradas: gestor=%s usuário=%s", gestor, nome)
            return JSONResponse({"ok": True, "usuario": nome},
                                headers={"Cache-Control": "no-store"})
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    return router
