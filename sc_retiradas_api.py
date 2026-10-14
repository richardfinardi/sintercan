"""Rotas independentes para sincronizar retiradas do SC entre funcionários.
Instale este arquivo na mesma pasta do main.py da API Sintercan e inclua:
    from sc_retiradas_api import router as sc_retiradas_router
    app.include_router(sc_retiradas_router)
Não escreve no ERP: persiste exclusivamente em cache/sc_retiradas.json.
"""
import json
import os
import threading
from datetime import datetime, timezone
from pathlib import Path
from tempfile import NamedTemporaryFile

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

router = APIRouter(prefix="/sc", tags=["SC - retiradas"])
_ARQUIVO = Path(__file__).resolve().parent / "cache" / "sc_retiradas.json"
_LOCK = threading.RLock()


class AlterarRetirada(BaseModel):
    id: str = Field(min_length=1, max_length=2048)
    retirado: bool
    usuario: str = Field(default="", max_length=150)


def _ler():
    if not _ARQUIVO.exists():
        return {}
    try:
        with _ARQUIVO.open("r", encoding="utf-8") as f:
            dados = json.load(f)
        if not isinstance(dados, dict):
            raise ValueError("Arquivo de retiradas não é um objeto JSON.")
        return dados
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        raise HTTPException(status_code=500, detail=f"Não foi possível ler o controle de retiradas: {exc}")


def _gravar(dados):
    _ARQUIVO.parent.mkdir(parents=True, exist_ok=True)
    temporario = None
    try:
        with NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=_ARQUIVO.parent,
            prefix=".sc_retiradas_", suffix=".tmp", delete=False,
        ) as arquivo:
            temporario = Path(arquivo.name)
            json.dump(dados, arquivo, ensure_ascii=False, indent=2)
            arquivo.flush()
            os.fsync(arquivo.fileno())
        os.replace(temporario, _ARQUIVO)
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Falha ao gravar retiradas: {exc}")
    finally:
        if temporario and temporario.exists():
            temporario.unlink(missing_ok=True)


@router.get("/retiradas")
def listar_retiradas():
    with _LOCK:
        return JSONResponse(
            {"retiradas": _ler()},
            headers={"Cache-Control": "no-store"},
        )


@router.post("/retiradas")
def alterar_retirada(pedido: AlterarRetirada):
    with _LOCK:
        dados = _ler()
        if pedido.retirado:
            dados[pedido.id] = {
                "em": datetime.now(timezone.utc).isoformat(),
                "usuario": pedido.usuario.strip(),
            }
        else:
            dados.pop(pedido.id, None)
        _gravar(dados)
        return JSONResponse(
            {"ok": True, "id": pedido.id, "retirado": pedido.retirado,
             "registro": dados.get(pedido.id)},
            headers={"Cache-Control": "no-store"},
        )
