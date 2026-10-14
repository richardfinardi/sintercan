from email.message import EmailMessage
import hashlib
import json
import smtplib
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Optional

from fastapi import Body, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import pandas as pd
from pydantic import BaseModel, Field
from sqlalchemy import text

from conexao import engine
from email_config import (
    SMTP_FROM,
    SMTP_FROM_NAME,
    SMTP_PASSWORD,
    SMTP_PORT,
    SMTP_SERVER,
    SMTP_USER,
)

app = FastAPI()

from sc_retiradas_api import router as sc_retiradas_router
app.include_router(sc_retiradas_router)

# Historico TOS.U_HIST: rotas adicionais; preserva login, cache e demais endpoints.
# Carregar ANTES das rotas PATCH originais; nao muda o comando uvicorn main:app.
from historico_sintercan_api import router as historico_router
app.include_router(historico_router)

# Configuração de CORS com permissão explícita para o header do Ngrok e GitHub Pages
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*", "ngrok-skip-browser-warning"],
)


# ==========================================
# MODELOS DE VALIDAÇÃO (PYDANTIC)
# ==========================================

class UpdatePrazoRequest(BaseModel):
    nova_data: str  # Espera formato YYYY-MM-DD
    justificativa: str


class UpdateRenegociacaoFaturamentoRequest(BaseModel):
    u_data_renegociacao: Optional[str] = None  # Espera formato YYYY-MM-DD ou None
    U_JUST_ALT_DT_REN: str                     # Justificativa contendo o usuario


class UpdatePrioridadeRequest(BaseModel):
    cod_empresa: int
    prioridade: int


class UpdateZerarRequest(BaseModel):
    cod_empresa: int = Field(ge=1)
    u_zerar: int = Field(ge=0, le=1)


class LoginRequest(BaseModel):
    usuario: str
    senha: str


class CheckUserRequest(BaseModel):
    usuario: str


# ==========================================
# FUNÇÕES AUXILIARES E AUTENTICAÇÃO
# ==========================================

def ler_sql(caminho: str) -> str:
    """Lê um arquivo SQL tratando possíveis problemas de encodings comuns."""
    try:
        with open(caminho, "r", encoding="utf-8") as arquivo:
            return arquivo.read()
    except UnicodeDecodeError:
        with open(caminho, "r", encoding="cp1252") as arquivo:
            return arquivo.read()


def md5_variantes(texto: str, usuario: str = "") -> set:
    """
    Gera um conjunto de hashes MD5 cobrindo as variacoes mais comuns
    de sistemas legados em PostgreSQL / SQL Server / Delphi / C# / PHP.
    """
    limpo = texto.strip()
    usuario_limpo = usuario.strip()

    textos_base = [
        limpo,
        limpo.upper(),
        limpo.lower(),
    ]

    if usuario_limpo:
        textos_base.extend([
            f"{usuario_limpo.upper()}{limpo}",
            f"{limpo}{usuario_limpo.upper()}",
            f"{usuario_limpo.lower()}{limpo}",
            f"{limpo}{usuario_limpo.lower()}",
        ])

    hashes = set()

    for t in textos_base:
        # 1. Padrao UTF-8
        h_utf8 = hashlib.md5(t.encode('utf-8')).hexdigest().upper()
        hashes.add(h_utf8)

        # 2. Windows-1252 / CP1252
        try:
            h_cp1252 = hashlib.md5(t.encode('cp1252')).hexdigest().upper()
            hashes.add(h_cp1252)
        except UnicodeEncodeError:
            pass

        # 3. UTF-16LE
        try:
            h_utf16 = hashlib.md5(t.encode('utf-16le')).hexdigest().upper()
            hashes.add(h_utf16)
        except UnicodeEncodeError:
            pass

        # 4. MD5 Duplo
        hashes.add(hashlib.md5(h_utf8.lower().encode('utf-8')).hexdigest().upper())

    return hashes


def executar_query_e_limpar(sql_str: str) -> list:
    """
    Executa a query SQL usando text() e trata dicionários imutáveis (immutabledict)
    e tipos complexos para serem compatíveis com o JSON do FastAPI.
    """
    with engine.connect() as conn:
        df = pd.read_sql(text(sql_str), conn)

    records = df.to_dict(orient="records")

    def sanitizar(obj):
        if isinstance(obj, dict):
            return {k: sanitizar(v) for k, v in obj.items()}
        elif isinstance(obj, list):
            return [sanitizar(v) for v in obj]
        elif hasattr(obj, "_mapping"):  # Trata immutabledict e similares do SQLAlchemy
            return {k: sanitizar(v) for k, v in dict(obj).items()}
        elif pd.isna(obj):  # Trata NaN / NaT do Pandas
            return None
        return obj

    return [sanitizar(row) for row in records]


# ==========================================
# CACHE DE PRODUÇÃO
# ==========================================

PRODUCAO_CACHE_DIR = Path("cache")
PRODUCAO_CACHE_FILE = PRODUCAO_CACHE_DIR / "producao.json"
PRODUCAO_CACHE_INTERVAL_SECONDS = 300  # 5 minutos

_producao_cache = []
_producao_cache_lock = threading.Lock()
_producao_refresh_lock = threading.Lock()
# Evita que um snapshot iniciado antes do PATCH sobrescreva a marcacao recem-gravada.
# Chave: (empresa, codigo_os); valor: (u_zerar, instante da confirmacao no banco).
_producao_zerar_updates = {}
_producao_cache_meta = {
    "ultima_atualizacao": None,
    "ultima_tentativa": None,
    "duracao_segundos": None,
    "registros": 0,
    "atualizando": False,
    "ultimo_erro": None,
}


def _salvar_cache_producao_em_disco(dados: list) -> None:
    PRODUCAO_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    arquivo_temp = PRODUCAO_CACHE_FILE.with_suffix(".tmp")

    with open(arquivo_temp, "w", encoding="utf-8") as arquivo:
        json.dump(dados, arquivo, ensure_ascii=False, separators=(",", ":"), default=str)

    arquivo_temp.replace(PRODUCAO_CACHE_FILE)


def _carregar_cache_producao_do_disco() -> bool:
    global _producao_cache

    if not PRODUCAO_CACHE_FILE.exists():
        return False

    try:
        with open(PRODUCAO_CACHE_FILE, "r", encoding="utf-8") as arquivo:
            dados = json.load(arquivo)

        if not isinstance(dados, list):
            return False

        with _producao_cache_lock:
            _producao_cache = dados
            _producao_cache_meta["registros"] = len(dados)
            _producao_cache_meta["ultima_atualizacao"] = datetime.fromtimestamp(
                PRODUCAO_CACHE_FILE.stat().st_mtime
            ).isoformat(timespec="seconds")

        return True
    except Exception as exc:
        _producao_cache_meta["ultimo_erro"] = f"Erro ao carregar cache: {exc}"
        return False


def _executar_snapshot_producao() -> list:
    sql = ler_sql("sql/PRODUCAO.sql")
    return executar_query_e_limpar(sql)


def _atualizar_cache_producao() -> bool:
    global _producao_cache

    if not _producao_refresh_lock.acquire(blocking=False):
        return False

    inicio = time.perf_counter()
    inicio_snapshot = time.monotonic()
    _producao_cache_meta["atualizando"] = True
    _producao_cache_meta["ultima_tentativa"] = datetime.now().isoformat(timespec="seconds")
    _producao_cache_meta["ultimo_erro"] = None

    try:
        dados = _executar_snapshot_producao()
        agora = datetime.now().isoformat(timespec="seconds")
        duracao = round(time.perf_counter() - inicio, 2)

        with _producao_cache_lock:
            # PATCH confirmado enquanto a SQL consultava o banco tem prioridade
            # sobre uma fotografia possivelmente anterior a gravacao do campo.
            for item in dados:
                chave = (str(item.get("cod_empresa")), str(item.get("codigo_os")))
                alteracao = _producao_zerar_updates.get(chave)
                if alteracao is not None and alteracao[1] >= inicio_snapshot:
                    item["u_zerar"] = alteracao[0]

            # Os PATCH anteriores ao inicio desta consulta ja constam no CPS.
            for chave, (_, instante) in list(_producao_zerar_updates.items()):
                if instante < inicio_snapshot:
                    del _producao_zerar_updates[chave]

            _producao_cache = dados
            _producao_cache_meta["ultima_atualizacao"] = agora
            _producao_cache_meta["duracao_segundos"] = duracao
            _producao_cache_meta["registros"] = len(dados)
            # Memoria e arquivo permanecem consistentes ate sob PATCH concorrente.
            _salvar_cache_producao_em_disco(dados)
        return True

    except Exception as exc:
        _producao_cache_meta["ultimo_erro"] = str(exc)
        return False

    finally:
        _producao_cache_meta["atualizando"] = False
        _producao_refresh_lock.release()


def _loop_cache_producao() -> None:
    while True:
        _atualizar_cache_producao()
        time.sleep(PRODUCAO_CACHE_INTERVAL_SECONDS)


def _iniciar_cache_producao() -> None:
    _carregar_cache_producao_do_disco()

    thread = threading.Thread(
        target=_loop_cache_producao,
        name="cache-producao",
        daemon=True,
    )
    thread.start()


def _atualizar_prioridade_no_cache(cod_empresa: int, codigo_os: int, prioridade: int) -> None:
    alterou = False

    with _producao_cache_lock:
        for item in _producao_cache:
            if (
                str(item.get("cod_empresa")) == str(cod_empresa)
                and str(item.get("codigo_os")) == str(codigo_os)
            ):
                item["prioridade"] = prioridade
                alterou = True

        if alterou:
            try:
                _salvar_cache_producao_em_disco(_producao_cache)
            except Exception:
                pass


_iniciar_cache_producao()


# ==========================================
# ROTAS DE AUTENTICAÇÃO
# ==========================================

@app.post("/login")
def login(payload: LoginRequest):
    try:
        usuario_upper = payload.usuario.strip().upper()
        senha_limpa = payload.senha.strip()
        hashes_validos = md5_variantes(senha_limpa, usuario=usuario_upper)

        sql = text("""
            SELECT TRIM(nome) as nome,
                   TRIM(senha) as senha,
                   COALESCE(u_producao::text, '0') as u_producao,
                   COALESCE(u_producao_valor::text, '0') as u_producao_valor,
                   COALESCE(u_estoque_pa::text, '0') as u_estoque_pa,
                   COALESCE(u_estoque_mp::text, '0') as u_estoque_mp,
                   COALESCE(u_faturamento::text, '0') as u_faturamento,
                   COALESCE(u_qualidade::text, '0') as u_qualidade,
                   COALESCE(u_financeiro::text, '0') as u_financeiro,
                   COALESCE(u_rs::text, '0') as u_rs,
                   COALESCE(u_compras::text, '0') as u_compras,
                   COALESCE(u_custos::text, '0') as u_custos
            FROM csenha
            WHERE UPPER(TRIM(nome)) = :usuario
              AND (inativo = 0 OR inativo IS NULL)
              AND (cod_empresa = 1 OR cod_empresa = '1')
        """)

        with engine.connect() as conn:
            results = conn.execute(sql, {"usuario": usuario_upper}).mappings().fetchall()

        if not results:
            raise HTTPException(status_code=401, detail="Usuário ou senha inválidos.")

        # Valida contra cada linha encontrada (para lidar com duplicados ou hashes)
        for row in results:
            dict_row = dict(row)
            senha_banco = str(dict_row.get("senha", "")).strip().upper()

            if senha_banco in hashes_validos or senha_banco == senha_limpa.upper() or senha_banco == senha_limpa:
                return dict_row

        raise HTTPException(status_code=401, detail="Usuário ou senha inválidos.")

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/me")
def check_user_permissions(payload: CheckUserRequest):
    try:
        sql = text("""
            SELECT TRIM(nome) as nome,
                   COALESCE(u_producao::text, '0') as u_producao,
                   COALESCE(u_producao_valor::text, '0') as u_producao_valor,
                   COALESCE(u_estoque_pa::text, '0') as u_estoque_pa,
                   COALESCE(u_estoque_mp::text, '0') as u_estoque_mp,
                   COALESCE(u_faturamento::text, '0') as u_faturamento,
                   COALESCE(u_qualidade::text, '0') as u_qualidade,
                   COALESCE(u_financeiro::text, '0') as u_financeiro,
                   COALESCE(u_rs::text, '0') as u_rs,
                   COALESCE(u_compras::text, '0') as u_compras,
                   COALESCE(u_custos::text, '0') as u_custos
            FROM csenha
            WHERE UPPER(TRIM(nome)) = :usuario
              AND (inativo = 0 OR inativo IS NULL)
              AND (cod_empresa = 1 OR cod_empresa = '1')
        """)

        with engine.connect() as conn:
            result = conn.execute(
                sql,
                {"usuario": payload.usuario.strip().upper()}
            ).mappings().first()

        if not result:
            raise HTTPException(status_code=404, detail="Usuário não encontrado.")

        return dict(result)

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ==========================================
# ROTAS CONSULTA DE DADOS (GET)
# ==========================================

@app.get("/")
def home():
    return {"status": "ok"}


@app.get("/teste")
def teste():
    try:
        sql = ler_sql("sql/teste.sql")
        return executar_query_e_limpar(sql)
    except Exception as e:
        return {"status": "erro", "mensagem": str(e)}


@app.get("/prod_concluir")
def prod_concluir():
    try:
        sql = ler_sql("sql/PRODUCAO_CONCLUIR.sql")
        return executar_query_e_limpar(sql)
    except Exception as e:
        return {"status": "erro", "mensagem": str(e)}


@app.get("/faturamento")
def faturamento():
    try:
        sql = ler_sql("sql/FAT.sql")
        return executar_query_e_limpar(sql)
    except Exception as e:
        return {"status": "erro", "mensagem": str(e)}


@app.get("/user")
def usuarios():
    try:
        sql = ler_sql("sql/USER.sql")
        return executar_query_e_limpar(sql)
    except Exception as e:
        return {"status": "erro", "mensagem": str(e)}


@app.get("/carteira")
def carteira():
    try:
        sql = ler_sql("sql/CARTEIRA.sql")
        return executar_query_e_limpar(sql)
    except Exception as e:
        return {"status": "erro", "mensagem": str(e)}


@app.get("/rs")
def rs():
    try:
        sql = ler_sql("sql/RS.sql")
        return executar_query_e_limpar(sql)
    except Exception as e:
        return {"status": "erro", "mensagem": str(e)}


@app.get("/estoque")
def estoque():
    try:
        sql = ler_sql("sql/ESTOQUE.sql")
        return executar_query_e_limpar(sql)
    except Exception as e:
        return {"status": "erro", "mensagem": str(e)}

@app.get("/pedido")
def estoque():
    try:
        sql = ler_sql("sql/PEDIDO.sql")
        return executar_query_e_limpar(sql)
    except Exception as e:
        return {"status": "erro", "mensagem": str(e)}


@app.get("/estoque_sc")
def estoque_sc():
    try:
        sql = ler_sql("sql/ESTOQUE_SC.sql")
        return executar_query_e_limpar(sql)
    except Exception as e:
        return {"status": "erro", "mensagem": str(e)}


@app.get("/estoque_sc_orc")
def estoque_sc_orc():
    try:
        sql = ler_sql("sql/SC_ORC.sql")
        return executar_query_e_limpar(sql)
    except Exception as e:
        return {"status": "erro", "mensagem": str(e)}


@app.get("/cart_15")
def cart_15():
    try:
        sql = ler_sql("sql/CART_15.sql")
        return executar_query_e_limpar(sql)
    except Exception as e:
        return {"status": "erro", "mensagem": str(e)}

@app.get("/PRODUCAO/{codigo_os}/percentual-aux")
def percentual_os_aux(codigo_os: int, cod_empresa: int = 1):
    try:
        sql_str = ler_sql("sql/percentual_os.sql")

        with engine.connect() as conn:
            df = pd.read_sql(
                text(sql_str),
                conn,
                params={
                    "codigo_os": codigo_os,
                    "cod_empresa": cod_empresa,
                }
            )

        records = df.to_dict(orient="records")

        def sanitizar(obj):
            if isinstance(obj, dict):
                return {k: sanitizar(v) for k, v in obj.items()}
            elif isinstance(obj, list):
                return [sanitizar(v) for v in obj]
            elif hasattr(obj, "_mapping"):
                return {k: sanitizar(v) for k, v in dict(obj).items()}
            elif pd.isna(obj):
                return None
            return obj

        return [sanitizar(row) for row in records]

    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Erro ao consultar percentual das OS auxiliares: {str(e)}"
        )


@app.get("/PRODUCAO/{codigo_os}/processos")
def processos_produtivos_os(codigo_os: int, cod_empresa: int = 1):
    """Retorna os processos de todas as sub-OS, com evolução individual."""
    try:
        sql_str = ler_sql("sql/PROCESSOS_OS.sql")
        with engine.connect() as conn:
            linhas = conn.execute(
                text(sql_str),
                {"codigo_os": codigo_os, "cod_empresa": cod_empresa},
            ).mappings().all()
        return [dict(linha) for linha in linhas]
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Erro ao consultar processos produtivos da OS: {str(e)}",
        )


@app.get("/PRODUCAO")
def producao():
    with _producao_cache_lock:
        if _producao_cache:
            return list(_producao_cache)

    if not _producao_cache_meta["atualizando"]:
        threading.Thread(
            target=_atualizar_cache_producao,
            name="cache-producao-manual",
            daemon=True,
        ).start()

    raise HTTPException(
        status_code=503,
        detail="Cache de produção ainda está sendo carregado. Tente novamente em alguns segundos."
    )


@app.get("/PRODUCAO/cache-status")
def producao_cache_status():
    with _producao_cache_lock:
        return dict(_producao_cache_meta)


@app.post("/PRODUCAO/atualizar-cache")
def producao_atualizar_cache():
    if _producao_cache_meta["atualizando"]:
        return {
            "status": "ok",
            "mensagem": "Atualização já está em andamento."
        }

    threading.Thread(
        target=_atualizar_cache_producao,
        name="cache-producao-manual",
        daemon=True,
    ).start()

    return {
        "status": "ok",
        "mensagem": "Atualização do cache iniciada em segundo plano."
    }


# ==========================================
# ROTAS DE ALTERAÇÃO / PATCH
# ==========================================

@app.patch("/PRODUCAO/{n_os}/alterar-prazo")
def alterar_prazo_os(n_os: str, payload: UpdatePrazoRequest):
    if not payload.justificativa.strip():
        raise HTTPException(
            status_code=400,
            detail="A justificativa é obrigatória para registrar a alteração."
        )

    try:
        sql_update = text("""
            UPDATE TOS
            SET DT_PREVISTA = :nova_data,
                U_JUSTIFICATIVA_ALT_DT = :justificativa
            WHERE N_OS = :n_os
        """)

        with engine.begin() as conn:
            result = conn.execute(
                sql_update,
                {
                    "nova_data": payload.nova_data,
                    "justificativa": payload.justificativa,
                    "n_os": str(n_os).strip(),
                },
            )

            if result.rowcount == 0:
                raise HTTPException(
                    status_code=404,
                    detail=f"OS '{n_os}' não encontrada na tabela TOS."
                )

        return {
            "status": "ok",
            "mensagem": "Data prevista e justificativa atualizadas com sucesso!",
            "n_os": n_os,
            "nova_data": payload.nova_data,
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Erro ao atualizar o banco de dados: {str(e)}"
        )


@app.patch("/PRODUCAO/{codigo_os}/alterar-prioridade")
def alterar_prioridade_os(codigo_os: int, payload: UpdatePrioridadeRequest):
    """
    Altera a prioridade da OS.

    Regra:
    - 0 = prioridade máxima
    - 5 = neutra / padrão
    - 9 = prioridade mínima
    """
    if payload.prioridade < 0 or payload.prioridade > 9:
        raise HTTPException(
            status_code=400,
            detail="A prioridade deve ser um número inteiro entre 0 e 9."
        )

    try:
        sql_update = text("""
            UPDATE TOS
            SET PRIORIDADE = :prioridade
            WHERE COD_EMPRESA = :cod_empresa
              AND CODIGO = :codigo_os
        """)

        with engine.begin() as conn:
            result = conn.execute(
                sql_update,
                {
                    "prioridade": payload.prioridade,
                    "cod_empresa": payload.cod_empresa,
                    "codigo_os": codigo_os,
                },
            )

            if result.rowcount == 0:
                raise HTTPException(
                    status_code=404,
                    detail=(
                        f"OS código '{codigo_os}' da empresa "
                        f"'{payload.cod_empresa}' não encontrada na tabela TOS."
                    )
                )

        _atualizar_prioridade_no_cache(
            payload.cod_empresa,
            codigo_os,
            payload.prioridade
        )

        return {
            "status": "ok",
            "mensagem": "Prioridade atualizada com sucesso!",
            "cod_empresa": payload.cod_empresa,
            "codigo_os": codigo_os,
            "prioridade": payload.prioridade,
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Erro ao atualizar a prioridade da OS: {str(e)}"
        )


@app.patch("/faturamento/{n_os}/alterar-renegociacao")
def alterar_renegociacao_faturamento(n_os: str, payload: UpdateRenegociacaoFaturamentoRequest):
    if not payload.U_JUST_ALT_DT_REN.strip():
        raise HTTPException(
            status_code=400,
            detail="A justificativa é obrigatória para registrar a alteração."
        )

    try:
        sql_update = text("""
            UPDATE TOS
            SET U_DATA_RENEGOCIACAO = :nova_data,
                U_JUSTIFICATIVA = :justificativa
            WHERE N_OS = :n_os
        """)

        with engine.begin() as conn:
            result = conn.execute(
                sql_update,
                {
                    "nova_data": payload.u_data_renegociacao if payload.u_data_renegociacao else None,
                    "justificativa": payload.U_JUST_ALT_DT_REN,
                    "n_os": str(n_os).strip(),
                },
            )

            if result.rowcount == 0:
                raise HTTPException(
                    status_code=404,
                    detail=f"OS '{n_os}' não encontrada na tabela TOS."
                )

        return {
            "status": "ok",
            "mensagem": "Data previsto/permitido para faturar e justificativa atualizadas com sucesso!",
            "n_os": n_os,
            "nova_data": payload.u_data_renegociacao,
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Erro ao atualizar o banco de dados: {str(e)}"
        )


# ==========================================
# ROTAS DE E-MAIL
# ==========================================

@app.post("/enviar_email")
def enviar_email(body: dict = Body(...)):
    try:
        to = body.get("to", [])
        cc = body.get("cc", [])
        bcc = body.get("bcc", [])

        if isinstance(to, str):
            to = [x.strip() for x in to.split(",") if x.strip()]

        if isinstance(cc, str):
            cc = [x.strip() for x in cc.split(",") if x.strip()]

        if isinstance(bcc, str):
            bcc = [x.strip() for x in bcc.split(",") if x.strip()]

        assunto = body.get("subject", "")
        html = body.get("html", "")

        msg = EmailMessage()
        msg["Subject"] = assunto
        msg["From"] = f"{SMTP_FROM_NAME} <{SMTP_FROM}>"

        if to:
            msg["To"] = ", ".join(to)
        if cc:
            msg["Cc"] = ", ".join(cc)

        msg.set_content("HTML Email")
        msg.add_alternative(html, subtype="html")

        with smtplib.SMTP(SMTP_SERVER, SMTP_PORT) as smtp:
            smtp.starttls()
            smtp.login(SMTP_USER, SMTP_PASSWORD)
            smtp.send_message(
                msg,
                to_addrs=to + cc + bcc
            )

        return {
            "status": "ok",
            "enviados": len(to) + len(cc) + len(bcc)
        }

    except Exception as e:
        return {
            "status": "erro",
            "mensagem": str(e)
        }


@app.get("/teste_email")
def teste_email():
    try:
        msg = EmailMessage()
        msg["Subject"] = "Teste SMTP"
        msg["From"] = f"{SMTP_FROM_NAME} <{SMTP_FROM}>"
        msg["To"] = "richard@consultoriarf.net"

        msg.set_content("Teste SMTP")
        msg.add_alternative("""
<html>
<body>
<h2>Teste SMTP</h2>
<p>Se você recebeu este e-mail, o envio pelo Python está funcionando.</p>
</body>
</html>
""", subtype="html")

        with smtplib.SMTP(SMTP_SERVER, SMTP_PORT) as smtp:
            smtp.starttls()
            smtp.login(SMTP_USER, SMTP_PASSWORD)
            smtp.send_message(msg)

        return {"status": "ok"}

    except Exception as e:
        return {
            "status": "erro",
            "mensagem": str(e)
        }

# ==========================================
# PRODUCAO - MARCACAO U_ZERAR NO CPS
# ==========================================
@app.patch("/PRODUCAO/{codigo_os}/alterar-zerar")
def alterar_zerar_os(codigo_os: int, payload: UpdateZerarRequest):
    """Grava somente TOS.U_ZERAR (0/1). O preco permanece intacto no CPS.

    A tela de producao usa esta marcacao para apresentar R$ 0,00 e deduzir
    o valor dos totais; nenhuma coluna de preco/orcamento e atualizada aqui.
    """
    try:
        with engine.begin() as conn:
            resultado = conn.execute(
                text("""
                    UPDATE TOS
                       SET U_ZERAR = :u_zerar
                     WHERE COD_EMPRESA = :cod_empresa
                       AND CODIGO = :codigo_os
                """),
                {
                    "u_zerar": payload.u_zerar,
                    "cod_empresa": payload.cod_empresa,
                    "codigo_os": codigo_os,
                },
            )
            if resultado.rowcount == 0:
                raise HTTPException(
                    status_code=404,
                    detail=f"OS codigo {codigo_os} da empresa {payload.cod_empresa} nao encontrada.",
                )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Erro ao atualizar U_ZERAR da OS: {exc}",
        )

    # O banco confirmou a alteracao: atualiza TODOS os cartoes/linhas da OS
    # no cache da API imediatamente, sem aguardar o refresh de 5 minutos.
    with _producao_cache_lock:
        chave = (str(payload.cod_empresa), str(codigo_os))
        _producao_zerar_updates[chave] = (int(payload.u_zerar), time.monotonic())

        mudou = False
        for item in _producao_cache:
            if (
                str(item.get("cod_empresa")) == chave[0]
                and str(item.get("codigo_os")) == chave[1]
            ):
                item["u_zerar"] = int(payload.u_zerar)
                mudou = True

        if mudou:
            try:
                _salvar_cache_producao_em_disco(_producao_cache)
            except Exception as exc:
                # A transacao ja foi confirmada no CPS. Erro no cache em disco
                # nao deve informar falha da gravacao no banco.
                print(f"Falha ao persistir cache de producao apos U_ZERAR: {exc}")

    return {
        "status": "ok",
        "mensagem": "Zeramento da OS atualizado no CPS.",
        "cod_empresa": payload.cod_empresa,
        "codigo_os": codigo_os,
        "u_zerar": int(payload.u_zerar),
    }