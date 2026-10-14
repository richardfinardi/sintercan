# Sintercan — histórico em TOS.U_HIST

## Instalação: preservar o BAT e o login que já funcionam

Não usar o arquivo antigo `sintercan_historico_app.py`. Volte ao comando ORIGINAL:
`uvicorn main:app`.

Opção A — `main.py` pronto:

1. Faça backup do `main.py` atual do servidor.
2. Copie `api/main.py` e `api/historico_sintercan_api.py` desta branch para a pasta da API (junto de `conexao.py` e `sc_retiradas_api.py`).
3. Reinicie **com o mesmo BAT**. O `main.py` completo tem só duas linhas adicionadas à sua versão original, logo depois de `app.include_router(sc_retiradas_router)`.

Opção B — manter seu `main.py` exato (recomendado quando já tem mudanças locais):

1. Faça backup do `main.py` atual.
2. Copie `historico_sintercan_api.py` para junto do `main.py`.
3. Logo após `app.include_router(sc_retiradas_router)`, adicione:
   ```python
   from historico_sintercan_api import router as historico_router
   app.include_router(historico_router)
   ```
4. Reinicie com o BAT existente, sem trocas.

Não mexer em `/login`, `/me`, senha, token, `SINTERCAN_SESSION_SECRET` ou configuração do servidor.

## Teste sem tokens

Abra `http://127.0.0.1:8000/docs`. Execute
`GET /PRODUCAO/{codigo_os}/historico?cod_empresa=1` com código interno de uma OS válida.
Sem "Authorize" e sem "Bearer".

Em OS de teste, execute `POST /PRODUCAO/{codigo_os}/observacao`:
```json
{"cod_empresa":1,"usuario":"RICHARD","observacao":"Teste de histórico"}
```
Depois confira com GET. Verifique no CPS que gravou em `TOS.U_HIST`, sem tocar `TOS.OBS`.

Teste a alteração de `TOS.U_ZERAR` primeiro com a chamada usada pelo front antigo (sem `usuario`):
```json
{"cod_empresa":1,"u_zerar":1}
```
A requisição antiga deve retornar 200 e continuar funcionando. Ao não enviar o campo `usuario`, o registro mostra `SISTEMA`. Depois os novos HTMLs enviam `usuario` obtido do login atual.

Somente após validar a API, publique `producao/index.html` e `faturamento/index.html` desta branch.
`index.html` é **idêntico ao da branch main** e não precisa ser alterado.

## Implementação

- Um evento novo vem antes do anterior em `TOS.U_HIST`, em texto puro.
- Observação manual, prioridade, zeramento, previsão `DT_PREVISTA` e `U_DATA_RENEGOCIACAO` (individual e em lote no faturamento).
- Histórico com usuário informado pelo portal, data/hora, valor anterior→novo e justificativa.
- Alteração operacional e registro de histórico na mesma transação; `SELECT ... FOR UPDATE` e idempotência.
- Mantém cache de prioridade e `U_ZERAR` e endpoints antigos, inclusive sem `usuario`.
- `TOS.U_HIST` precisa ser tipo textual (TEXT/VARCHAR), não BYTEA.
- **A API não autentica o nome enviado pelo navegador**, replicando a simplicidade da implementação anterior. Um cliente externo poderia informar o nome de outro usuário, portanto isto não é uma trilha de autoria à prova de fraude.

## Desfazer

Restaure `main.py` do backup, reinicie o BAT original. Nenhuma tabela nova e nenhuma mudança de schema são necessárias.

> Não houve teste real conectado ao CPS nesta sessão; validar leitura e gravação em OS de teste antes de publicar o front.
