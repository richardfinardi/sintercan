# Portal do Cliente - Materiais de Cliente (Follow-up) - Sintercan

Esta implementação replica o fluxo **Portal Cliente** da Carteira PSTEC na aba
**RS > Material de Cliente (follow-up)** da Sintercan.

## Comportamento

- Todos os usuários com acesso ao módulo RS (CSENHA.U_RS=1) veem **Portal Cliente**.
- O link contempla **somente as linhas filtradas naquele momento**, inclusive
  filtros de coluna, busca e período; não depende do cache do navegador do cliente.
- Exige **apenas um cliente** por link para evitar envio cruzado de dados.
- Seleção de colunas, validade (padrão **7 dias**, opções 7, 15, 30, 60 ou 90 dias) e permissão de Excel.
- A janela **Gerenciar portais** permite copiar, abrir e **excluir permanentemente** links.
  Usuários comuns excluem os links que criaram; gestores podem excluir qualquer um.
- O destinatário abre o link diretamente, sem usuário CPS; o token dá acesso
  **somente às linhas/colunas permitidas**.
- Em cada acesso, a API consulta **/carteira_nf** e reaplica a seleção salva;
  alterações de status, previsão e outros campos atualizam no portal.
- Links vencidos deixam de entregar dados; ao excluir um portal seu registro e token
  são removidos do SQLite e o link deixa de funcionar imediatamente.
- A criação exige nova confirmação de senha CPS por **POST /material_cliente/portal/sessao**,
  que valida /login e U_RS=1. A API revalida /me a cada ação e mantém sessão
  temporária de 30 minutos, com token armazenado apenas como hash no SQLite.
- A configuração é gravada em SQLite privado no servidor, não em LocalStorage
  nem no GitHub. Não exige novos pacotes Python.

## Publicação da interface (GitHub Pages)

Publicar estes arquivos no repositório richardfinardi/sintercan:

- rs/index.html: carrega o novo módulo JS;
- rs/material-portal.js: criação e gerenciamento;
- rs/service-worker.js: cache offline atualizado.

O HTML do visitante é servido diretamente no domínio da API, para não abrir
uma exceção de acesso no portal principal consultoriarf.net:

https://sintercan.consultoriarf.net/material_cliente/portal/<id>?token=<segredo>

**Apenas essa URL com token válido deve entregar os dados compartilhados.**
Não tornar a tela /sintercan/rs ou a API /carteira_nf uma tela pública de cliente.

## Instalação na API Windows Sintercan

1. Fazer backup do main.py atual, sem substituí-lo pelo de outra versão.
2. Copiar backend/portal_material_cliente.py para **a mesma pasta do main.py**,
   usando o nome portal_material_cliente.py.
3. No **main.py** atual, incluir após a criação do objeto FastAPI app:

   ~~~python
   from portal_material_cliente import router as material_portal_router
   app.include_router(material_portal_router)
   ~~~

   Se o main.py possui outras importações na inicialização, a importação pode
   ficar junto delas; include_router deve acontecer após app = FastAPI(...).
4. Reiniciar **somente** a API no servidor; o tunnel atual permanece o mesmo.
5. Confirmar no Swagger /docs:
   - POST /material_cliente/portal/sessao
   - POST /material_cliente/portal
   - GET /material_cliente/portal
   - DELETE /material_cliente/portal/{portal_id} (exclusão definitiva)
   - PATCH /material_cliente/portal/{portal_id}/status (compatibilidade: ativo=false exclui)
   - GET /material_cliente/portal/{portal_id}/dados
   - GET /material_cliente/portal/{portal_id} (página do cliente)
6. Entrar em https://consultoriarf.net/sintercan/rs/, abrir Materiais de Cliente,
   filtrar 1 cliente, clicar **Portal Cliente**, gerar um link de teste e abrir em
   uma janela anônima. Não utilizar dados de clientes reais no teste sem autorização.
7. Depois, confirmar que **Excluir** apaga o registro, invalida o link e que
   a validade padrão começa em 7 dias.

## Persistência e configuração

Por padrão, o banco fica em:
<pasta_do_main.py>/dados/material_cliente_portais.sqlite3

O arquivo deve ser incluído no backup da API do cliente. O banco contém
**tokens de acesso**, portanto restringir leitura à conta do serviço Windows.

Variáveis opcionais, caso a API não use porta 8000 ou a pasta padrão:

- SINTERCAN_INTERNAL_API = URL local da API (padrão http://127.0.0.1:8000)
- SINTERCAN_PUBLIC_API = domínio público (padrão https://sintercan.consultoriarf.net)
- SINTERCAN_MATERIAL_PORTAL_DB = caminho completo para o SQLite

A API precisa manter /login, /me e /carteira_nf operacionais.
Nenhum endpoint antigo é alterado pelo módulo.

## Regra de segurança adicional

A proteção do link atua na nova rota /material_cliente/portal. O endpoint
geral /carteira_nf continua com as regras de acesso que já tinha. Para
proteção integral contra consultas diretas, revisar em etapa separada o acesso
ao endpoint geral, preservando o funcionamento da tela interna RS.

## Validação rápida da sintaxe

~~~bash
python -m py_compile backend/portal_material_cliente.py
node --check rs/material-portal.js
~~~
