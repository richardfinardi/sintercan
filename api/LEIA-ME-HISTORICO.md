# Sintercan — Histórico da OS (TOS.U_HIST)

> Integração na branch de homologação; não instalada/publicada automaticamente.
> Sem tocar no campo TOS.OBS.

## Instalação, mesmo fluxo que já existe no portal

1. Coloque `historico_sintercan_api.py` e `sintercan_historico_app.py` ao lado do `main.py` e `conexao.py` da API Sintercan. Não substitua o `main.py`.
2. No BAT atual, mude somente `uvicorn main:app` para `uvicorn sintercan_historico_app:app`. Mantenha parâmetros/porta/túnel existentes.
3. Reinicie a API. Abra `http://127.0.0.1:8000/docs`; na seção **Histórico de OS**, execute **GET /PRODUCAO/{codigo_os}/historico** preenchendo código interno e empresa. Deve retornar o campo `TOS.U_HIST` sem nenhum token.
4. Para testar **POST /PRODUCAO/{codigo_os}/observacao**, use `{"cod_empresa":1,"usuario":"RICHARD","observacao":"Teste de histórico"}`. Releia o GET e confira o texto gravado.
5. Depois de confirmar, publique/mescle `index.html`, `producao/index.html` e `faturamento/index.html` da branch. O login do portal continua usando `POST /login`.

**Não há geração de chave, login extra, auth/token, Authorize, Bearer ou alterações no BAT além do módulo do Uvicorn.**

## Funcionalidades

- `TOS.U_HIST`: histórico em texto puro, novo evento primeiro, preserva conteúdo antigo.
- Observação manual com usuário, data/hora; prazo, prioridade, zeramento e renegociação gravam anterior → novo.
- `TOS.U_DATA_RENEGOCIACAO` na tela de faturamento, inclusive atualização em lote por OS.
- Gravação e histórico na mesma transação, bloqueio de linha e idempotência de requisição.
- Nome do usuário vem do login **já existente** do portal (`sintercan_user.nome`), enviado à API no campo `usuario` e conferido contra `CSENHA` e permissões.
- As demais rotas do `main.py` permanecem.

## Observação técnica

Sem autenticação de requisições na API, o campo `usuario` é informado pelo navegador e pode ser forjado por alguém com acesso técnico às rotas. Isso segue a decisão de não introduzir autenticação adicional e não deve ser descrito como identificação inviolável. Nenhum usuário novo é criado.

O banco deve ter `TOS.U_HIST` em tipo textual PostgreSQL (TEXT/VARCHAR); caso seja binário, a API impede alterações para não corromper os dados.
