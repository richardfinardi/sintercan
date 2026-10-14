# Sintercan — Histórico da OS (TOS.U_HIST)

> Integração preparada em branch de homologação. **Não foi aplicada ao servidor CPS.**
> `TOS.OBS` não é alterado por nenhum comando desta implementação.

## Ativação no servidor Windows

1. Copiar `api/historico_sintercan_api.py` e `api/sintercan_historico_app.py` para a MESMA pasta de `main.py`, `conexao.py` e `sc_retiradas_api.py`. Não substituir nem remover `main.py`.
2. Gerar segredo aleatório com:
   `python -c "import secrets; print(secrets.token_urlsafe(48))"`
3. Definir a variável de ambiente `SINTERCAN_SESSION_SECRET` com esse valor (mínimo 32 caracteres). Não registrar segredo em GitHub. Em BAT, usar `set "SINTERCAN_SESSION_SECRET=<SEGREDO_PRIVADO>"` apenas no servidor ou configurar no ambiente do Windows.
4. No BAT de inicialização, **trocar somente** `uvicorn main:app` por `uvicorn sintercan_historico_app:app`, preservando host, porta e Cloudflared.
5. Subir a API, testar `POST /auth/token` com credenciais CPS e verificar `GET /PRODUCAO/{codigo_os}/historico?cod_empresa=1` com o token Bearer. Verificar o tipo real de `TOS.U_HIST`: os comandos foram feitos para PostgreSQL TEXT/VARCHAR. Um VARCHAR limitado pode estourar e a API fará rollback, nunca truncamento.
6. **Só depois** publicar/mesclar os três HTMLs do GitHub: `index.html`, `producao/index.html`, `faturamento/index.html`. Sair do portal e entrar novamente para obter o token de autenticação.

## O que foi implementado

- `POST /auth/token`: valida senha em CSENHA e emite token HMAC com 12 horas de validade.
- `GET /PRODUCAO/{codigo_os}/historico`: consulta `TOS.U_HIST`.
- `POST /PRODUCAO/{codigo_os}/observacao`: escreve nova observação em texto puro.
- PATCHs existentes de prazo, prioridade, zeramento e renegociação registram **anterior → novo**, usuário autenticado, data/hora, justificativa, ID de requisição.
- `SELECT ... FOR UPDATE`, atualização da OS e histórico na mesma transação, concatenação no banco, controle de repetição com `X-Idempotency-Key`.
- Interface da produção: histórico em cartões, evento recente destacado em verde, observações registradas sem recarregar.
- Renegociação em lote no faturamento gera histórico por OS alterada, diferenciando empresas.
- As demais consultas e funcionalidades do `main.py` original permanecem.

## Limitações e verificação

- O fluxo de Kanban/aprovação não existe nas telas de Produção da Sintercan abrangidas por este patch; portanto não foram criadas aprovações fictícias.
- `TOS.U_HIST` não pode ser `BYTEA` sem conversão definida; a API interrompe com erro em vez de corromper os bytes.
- O histórico antigo em `TOS.U_HIST` fica preservado. `TOS.OBS` não é lido nem modificado pela implementação.
- Verificar que a query do faturamento retorna `cod_empresa` ou `empresa` (`EMP1`/`EMP2`) para diferenciar as OS de empresas diferentes.
- O pacote foi compilado sintaticamente e o JavaScript validado; falta teste conectado ao banco CPS, que não está acessível nesta sessão.
