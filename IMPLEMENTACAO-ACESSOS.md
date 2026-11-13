# Sintercan — Gerenciamento de acessos CSENHA

Implementação isolada para revisão antes de publicar. Não é necessário
alterar a tela atual de login do portal para entrar no gerenciamento:
o gestor faz uma **segunda autenticação** na tela administrativa,
cuja sessão temporária não é salva no localStorage.

## Campos controlados (CSENHA, empresa 1, INATIVO = 0)

- `U_PRODUCAO`: Controle Semanal de Produção
- `U_ESTOQUE_PA`: Estoque de Produto Acabado
- `U_ESTOQUE_MP`: Estoque de Matéria-Prima
- `U_FATURAMENTO`: Faturamento
- `U_QUALIDADE`: Qualidade
- `U_FINANCEIRO`: Financeiro
- `U_RS`: RS
- `U_COMPRAS`: Compras (campo legado; aba removida do portal)
- `U_CUSTOS`: Custos
- `U_PRODUCAO_VALOR`: Produção com valores
- `U_GESTOR`: concede acesso total a todos os módulos e ao gerenciador

## Ativação na API (servidor Windows)

1. Copie `permissoes_sintercan_api.py` para a **mesma pasta de `main.py`**
   da API Sintercan (não é uma query automática `.sql`).
2. No `main.py` existente, **sem substituir seu conteúdo**, acrescente:

   ```python
   from permissoes_sintercan_api import criar_router_permissoes
   # após criar a instância FastAPI "app", e após definir/importar "get_conn":
   app.include_router(criar_router_permissoes(get_conn))
   ```

   `get_conn()` deve devolver uma conexão PostgreSQL DB-API com
   `.cursor()`, `.commit()`, `.rollback()` e `.close()`.
   Se sua função de conexão tem outro nome, use-a no lugar de `get_conn`.
3. Crie `SINTERCAN_ACCESS_SECRET_KEY` no **ambiente privado da API**
   com pelo menos 32 caracteres aleatórios. Gere, por exemplo, em Python:

   ```python
   import secrets
   print(secrets.token_urlsafe(48))
   ```

   Reinicie o processo Python **após** configurar a variável. **Não** salve
   a chave em repositório ou página HTML.
4. Garanta que CORS da API permita a origem `https://consultoriarf.net`
   e o header `Authorization` (além de `Content-Type`).
5. Reinicie a API e confira `/docs`:
   - `POST /permissoes/login`
   - `GET /permissoes/usuarios`
   - `PATCH /permissoes/usuarios/{usuario}`
6. **Importante:** faça `POST /login` e `POST /me` existentes
   retornarem `u_gestor` da CSENHA para o menu exibir o botão
   Gerenciar acessos. O backend administrativo **não** confia nesse campo
   vindo do navegador; sempre verifica o banco e a senha na autenticação.

## Checklist de homologação

- Login e listagem funcionam para gestor ativo, falham para usuário comum.
- A lista exibe somente usuários ativos `COD_EMPRESA=1`.
- Mudanças de `U_*` são persistidas em CSENHA e refletidas após
  atualização de login/sessão.
- O último gestor não pode retirar a própria permissão.
- A aba Compras não volta a aparecer no menu por causa de `U_COMPRAS`.
- O endpoint recusa alteração sem token válido, com sessão expirada ou
  após `U_GESTOR` ser desmarcado.
- A produção mantém a regra atual de liberar o cartão com
  `U_PRODUCAO=1` ou `U_PRODUCAO_VALOR=1`; gestores veem tudo.

## Observações de segurança

A tela controla permissões administrativas, mas não substitui o controle
de autorização em **todos os endpoints de dados** da API antiga.
Essa proteção deve continuar sendo feita pelo backend de cada módulo.
O verificador de senha no módulo reproduz a compatibilidade histórica CPS
(senha simples/MD5, incluindo texto CP1252 e BYTEA com digest MD5).
Se a versão efetiva do seu `/login` aplicar um algoritmo diferente,
alinhe a função `_validar_senha_grv` antes de publicar.
