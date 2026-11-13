"""Verifica autorização dos portais sem consultar CPS nem a API real."""
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

from fastapi import HTTPException


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "portal_material_cliente", ROOT / "backend" / "portal_material_cliente.py"
)
portal = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(portal)


class PortalPermissoesTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous_db = portal.DB_PATH
        self.previous_http = portal.http_json
        self.previous_source = portal.source_rows
        portal.DB_PATH = Path(self.temp.name) / "portais.sqlite3"
        self.users = {
            "ALICE": {"nome": "ALICE", "u_rs": "1", "u_gestor": "0"},
            "BOB": {"nome": "BOB", "u_rs": "1", "u_gestor": "0"},
            "GESTOR": {"nome": "GESTOR", "u_rs": "1", "u_gestor": "1"},
            "SEMRS": {"nome": "SEMRS", "u_rs": "0", "u_gestor": "0"},
        }
        self.rows = [{"cliente": "Cliente Teste", "cnpj": "123456", "n_nf": "123",
                      "dt_emissao_nf": "2026-11-13", "codigo_interno": "ABC",
                      "item": "1", "ncm": "12345", "qtde": 1}]
        def fake_http(path, headers=None, timeout=35, body=None):
            self.assertIn(path, ("/login", "/me"))
            user = str(body["usuario"]).strip().upper()
            if path == "/login" and body["senha"] != "123":
                raise HTTPException(401, "Senha incorreta")
            if user not in self.users:
                raise HTTPException(401, "Usuário inválido")
            return dict(self.users[user])
        portal.http_json = fake_http
        portal.source_rows = lambda: self.rows

    def tearDown(self):
        portal.DB_PATH = self.previous_db
        portal.http_json = self.previous_http
        portal.source_rows = self.previous_source
        self.temp.cleanup()

    def login(self, usuario):
        resposta = portal.login_portal(portal.LoginPortal(usuario=usuario, senha="123"))
        return "Bearer " + json.loads(resposta.body)["access_token"]

    def create(self, authorization):
        row_keys = {portal.row_key(self.rows[0]): 1}
        return portal.criar_portal(
            portal.NovoPortal(nome="Portal Teste", colunas=["cliente", "qtde"],
                             row_keys=row_keys),
            authorization=authorization,
        )["portal"]

    def test_todos_com_acesso_ao_rs_podem_criar_portal(self):
        alice = self.login("ALICE")
        bob = self.login("BOB")
        self.assertTrue(self.create(alice)["id"])
        self.assertTrue(self.create(bob)["id"])

    def test_usuario_sem_rs_nao_pode_gerar_sessao(self):
        with self.assertRaises(HTTPException) as ex:
            self.login("SEMRS")
        self.assertEqual(ex.exception.status_code, 403)

    def test_usuario_comum_so_gerencia_os_proprios_links(self):
        alice = self.login("ALICE")
        bob = self.login("BOB")
        admin = self.login("GESTOR")
        link = self.create(alice)
        self.assertEqual(len(portal.listar_portais(authorization=alice)), 1)
        self.assertEqual(len(portal.listar_portais(authorization=bob)), 0)
        self.assertEqual(len(portal.listar_portais(authorization=admin)), 1)
        with self.assertRaises(HTTPException) as ex:
            portal.alterar_status(link["id"], portal.MudarStatus(ativo=False), authorization=bob)
        self.assertEqual(ex.exception.status_code, 403)
        self.assertFalse(portal.alterar_status(
            link["id"], portal.MudarStatus(ativo=False), authorization=alice
        )["portal"]["ativo"])
        self.assertTrue(portal.alterar_status(
            link["id"], portal.MudarStatus(ativo=True), authorization=admin
        )["portal"]["ativo"])

    def test_permissao_revogada_bloqueia_sessao_antiga(self):
        alice = self.login("ALICE")
        self.users["ALICE"]["u_rs"] = "0"
        with self.assertRaises(HTTPException) as ex:
            self.create(alice)
        self.assertEqual(ex.exception.status_code, 403)

    def test_token_aleatorio_nao_gera_portal(self):
        with self.assertRaises(HTTPException) as ex:
            self.create("Bearer " + "A" * 64)
        self.assertEqual(ex.exception.status_code, 401)


if __name__ == "__main__":
    unittest.main()
