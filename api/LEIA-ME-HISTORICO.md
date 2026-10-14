# Sintercan — Histórico da OS (TOS.U_HIST)

> Integração preparada em branch de homologação. **Não foi aplicada ao servidor CPS.**
> `TOS.OBS` não é alterado por nenhum comando desta implementação.

## Ativação no servidor Windows

**Não é necessário gerar senha, configurar chave ou adicionar variável no BAT.** A API cria internamente sua própria chave ao iniciar.

1. Copie `api/historico_sintercan_api.py` e `api/sintercan_historico_app.py` para a MESMA pasta de `main.py`, `conexao.py` e `sc_retiradas_api.py`. Não substitua o `main.py`.
2. No BAT de inicialização, troque somente `uvicorn main:app` por `uvicorn sintercan_historico_app:app`, mantendo os demais parâmetros e o Cloudflared.
3. Reinicie a API e teste uma OS: login normal, histórico, nova observação, alteração de prazo, prioridade, zeramento e renegociação do campo `TOS.U_DATA_RENEGOCIACAO`.
4. **Só após testar a API**, publique/mescle os HTMLs do GitHub: `index.html`, `producao/index.html` e `faturamento/index.html`. Faça login novamente no portal.

Nota: ao reiniciar a API, as sessões antigas expiram e é necessário fazer login novamente. A implementação pressupõe uma única instância de API, como o BAT existente.

## O que foi implementado

- Login pelo portal: valida senha em CSENHA e identifica o usuário; a chave de sessão é automática, sem configuração manual.
- `GET /PRODUCAO/{codigo_os}/historico`: consulta `TOS.U_HIST`.
- `POST /PRODUCAO/{codigo_os}/observacao`: escreve nova observação em texto puro.
- PATCHs existentes de prazo, prioridade, zeramento e renegociação registram **anterior → novo**, usuário autenticado, data/hora, justificativa, ID de requisição.
- `SELECT ... FOR UPDATE`, atualização da OS e histórico na mesma transação, concatenação no banco, controle de repetição com `X-Idempotency-Key`.
- Interface da produção: histórico em cartões, evento recente destacado em verde, observações registradas sem recarregar.
- Alterações em `TOS.U_DATA_RENEGOCIACAO` (inclusive renegociação em lote no faturamento) geram histórico por OS alterada, diferenciando empresas.
- As demais consultas e funcionalidades do `main.py` original permanecem.

## Limitações e verificação

- O fluxo de Kanban/aprovação não existe nas telas de Produção da Sintercan abrangidas por este patch; portanto não foram criadas aprovações fictícias.
- `TOS.U_HIST` não pode ser `BYTEA` sem conversão definida; a API interrompe com erro em vez de corromper os bytes.
- O histórico antigo em `TOS.U_HIST` fica preservado. `TOS.OBS` não é lido nem modificado pela implementação.
- Verificar que a query do faturamento retorna `cod_empresa` ou `empresa` (`EMP1`/`EMP2`) para diferenciar as OS de empresas diferentes.
- O pacote foi compilado sintaticamente e o JavaScript validado; falta teste conectado ao banco CPS, que não está acessível nesta sessão.
