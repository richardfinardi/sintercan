# Gerenciador de acessos da Sintercan

O portal contém a nova página `gerenciar-acessos.html` e o link para gestores
na página inicial. Os endpoints foram integrados ao `main.py` completo, fornecido
separadamente ao administrador do servidor.

## Aplicação na API Windows

1. Faça backup do `main.py` atual da API Sintercan.
2. Substitua-o pelo arquivo `main_sintercan_atualizado.py` recebido pelo
   administrador, renomeando para `main.py` na mesma pasta.
3. Reinicie a API/Uvicorn.
4. Verifique em `https://sintercan.consultoriarf.net/docs` os endpoints:
   - `POST /permissoes/login`
   - `GET /permissoes/usuarios`
   - `PATCH /permissoes/usuarios/{usuario}`
5. Entre novamente no portal `https://consultoriarf.net/sintercan/`:
   agora `/login` e `/me` retornam `u_gestor`.
   O atalho **Gerenciar acessos** aparece apenas quando `u_gestor=1`.
6. Ao abrir o atalho, informe novamente a senha CPS. O gerenciador tem
   sessão temporária de 30 minutos, gerada e validada no próprio servidor,
   sem nova variável de ambiente ou serviço adicional.

## Regras

- Listar somente usuários ativos em CSENHA da empresa 1.
- Consultar, marcar e desmarcar U_PRODUCAO, U_ESTOQUE_PA, U_ESTOQUE_MP,
  U_FATURAMENTO, U_QUALIDADE, U_FINANCEIRO, U_RS, U_COMPRAS, U_CUSTOS,
  U_PRODUCAO_VALOR e U_GESTOR.
- U_GESTOR concede acesso total ao menu do portal, independente das demais flags.
- A aba Compras não é reinstalada. U_COMPRAS é mantido na matriz por
  compatibilidade com o cadastro do CPS.
- Backend exige senha válida e U_GESTOR ativo no banco na autenticação,
  GET e PATCH; impedir a remoção do último gestor.
- Mudanças de acesso afetam os menus na próxima autenticação ou
  atualização da sessão.
- Os endpoints dos outros módulos continuam com a autorização que já existia;
  esconder links não substitui autorização de dados no backend.

## Observação

O `main.py` original não é parte do repositório público do portal e não
foi publicado no GitHub. A substituição no Windows ainda precisa ser feita
por quem administra esse servidor. O frontend só fica funcional após essa
etapa.