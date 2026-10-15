# Sintercan — Histórico TOS.U_HIST (instalação sem substituir API)

**Os arquivos do servidor e o login em produção NÃO foram alterados remotamente.** A aplicação web de produção e faturamento desta branch também NÃO foi publicada.

## Instalação segura (1 comando)

Baixe o pacote `SINTERCAN_HISTORICO_IMPLANTACAO_SEGURA.zip` disponibilizado no chat. Coloque `historico_sintercan_api.py` e `instalar_historico.py` na mesma pasta do `main.py` **atual e funcionando**. Execute nesse diretório:

```cmd
python instalar_historico.py
```

O instalador verifica a sintaxe, rotas já existentes, U_LIBFAT, campos no CPS e tipo textual de U_HIST; se alguma checagem falhar, **não modifica o main.py**. Depois faz backup do main atual e acrescenta apenas uma importação protegida do módulo. Reinicie usando o **BAT ORIGINAL**, sem trocar `uvicorn main:app`.

**Não mudar** login, senhas, tokens, Cloudflare, CORS, SQL, cache, local do banco ou porta.

## Validação antes de publicar o frontend

1. Confirme o GET `http://127.0.0.1:8000/PRODUCAO/10338/historico?cod_empresa=1` com um código de OS existente. Sem token.
2. Teste no navegador atual o U_ZERAR e U_LIBFAT em uma OS de teste; confirme que os totais continuam corretos.
3. Teste o `POST /PRODUCAO/{codigo_os}/observacao` numa OS de teste com JSON `{"cod_empresa":1,"usuario":"RICHARD","observacao":"Teste de histórico"}`, e verifique o registro no GET.
4. Somente depois, publique `producao/index.html` e `faturamento/index.html` desta branch. `index.html` permanece idêntico ao original.

O histórico registra observações, zeramento U_ZERAR, liberação U_LIBFAT, prioridade, previsão DT_PREVISTA e data U_DATA_RENEGOCIACAO (individual ou em lote), com anterior→novo, data/hora, usuário declarado pelo portal e justificativa. Novos registros vêm antes dos antigos em **TOS.U_HIST**. Nenhum acesso a TOS.OBS.

> O usuário enviado pelo navegador não é uma comprovação inviolável de identidade. A escolha mantém o login e a simplicidade atuais, sem autenticação adicional.

## Reversão

Feche a API, restaure `main.py.BACKUP_HIST_YYYYMMDD_HHMMSS` para `main.py` e reinicie o BAT original. Nenhum DDL no CPS.

## Observação de testes

O módulo e o instalador passaram em testes sintáticos e simulações de rotas e banco. Ainda falta a validação ao vivo com o banco CPS, que deve preceder a publicação da interface.

## CORREÇÃO BYTEA — 14/10/2026

O CPS usa `TOS.U_HIST` como `bytea`. O erro anterior 409 ("é binário") era uma limitação do módulo anterior, não um problema com seu banco.

**API já instalada:** copie somente a versão nova de `historico_sintercan_api.py` para a pasta do `main.py` e reinicie a API com o BAT original. **Não rode o instalador outra vez**, não altere o `main.py`, CORS, Cloudflare, login, SQL, ou o tipo da coluna.

A versão nova decodifica `memoryview`/`bytes` para exibir, gera eventos em ANSI `cp1252` e faz concatenação direta `bytea || bytea`, mantendo todos os bytes antigos de `U_HIST`. O módulo não lê nem altera `TOS.OBS`.
