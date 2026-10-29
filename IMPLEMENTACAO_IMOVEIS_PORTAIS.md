# Implementação — Domínio de Imóveis, MinIO e Portais Imobiliários

Data: **2026-08-16**
Projetos alterados: `gold-leste` (Angular 18) e `gold-leste-api` (Node/Express/PostgreSQL).

---

## ⚠️ AÇÃO NECESSÁRIA ANTES DE USAR

```text
ATENÇÃO:
O arquivo sql/20260816_imoveis_portais.sql NÃO foi executado.
Execute manualmente após revisar.

Rollback (APAGA DADOS): sql/20260816_imoveis_portais_rollback.sql — também NÃO executado.
```

Nada foi executado no banco. Nenhum `INSERT`, `UPDATE`, `ALTER`, migration, seed ou `psql`.
Nenhum serviço da VPS foi reiniciado, nenhum deploy foi feito, nenhuma configuração de
Nginx, PM2, Docker, DNS, firewall ou MinIO foi alterada.

Enquanto o script não for executado, os endpoints novos respondem **503** com a mensagem
`Estrutura de banco ausente. Execute o script sql/20260816_imoveis_portais.sql.` — de
propósito, para o erro ser visível em vez de silencioso.

---

## 1. O que foi criado

### Back-end (`gold-leste-api`)
- Domínio completo de **imóveis** (independente de venda), com escopo por perfil aplicado em SQL.
- **Mídias no MinIO**: upload multipart → API → bucket, com original + derivadas WebP.
- **Arquitetura de adapters de portais** com registry extensível.
- **Feeds XML públicos** protegidos por token, nos formatos oficiais de cada portal.
- **Camada de entrada de leads** (site público e webhooks de portais), com idempotência.
- **Logs de sincronização** sanitizados (nunca gravam token/senha).
- **Auditoria** de alterações relevantes do imóvel.
- Middleware central de erro, rate limiting e validação de entrada.

### Front-end (`gold-leste`)
- Módulo **Imóveis**: carteira, cadastro em 8 etapas, detalhe, vitrine de oportunidades.
- **Central de integrações** (portais + leads recebidos).
- **Área pública**: landing comercial (`/solucoes`) e página do imóvel (`/imovel/:slug`).
- Home do corretor com **oportunidades como protagonista**, sem remover o dashboard atual.
- Seção de **gestão da carteira** no dashboard para admin/gerente.

---

## 2. Arquivos principais

### API — novos

```text
sql/20260816_imoveis_portais.sql            <- EXECUTAR MANUALMENTE
sql/20260816_imoveis_portais_rollback.sql   <- rollback (apaga dados)

src/utils/http-error.js
src/utils/async-handler.js
src/utils/sanitize.js
src/utils/slug.js
src/utils/pagination.js
src/utils/xml.js
src/utils/crypto.js

src/middlewares/error.middleware.js
src/middlewares/rate-limit.middleware.js
src/middlewares/upload.middleware.js

src/validators/imovel.constants.js
src/validators/imovel.validator.js

src/repositories/imoveis.repository.js
src/repositories/imovel-midias.repository.js
src/repositories/imovel-logs.repository.js
src/repositories/portais.repository.js
src/repositories/portal-leads.repository.js

src/services/minio.service.js
src/services/imagem.service.js
src/services/imoveis.service.js
src/services/imovel-midias.service.js
src/services/imovel-score.service.js
src/services/portais.service.js
src/services/portal-lead-ingress.service.js

src/integrations/portals/portal-adapter.js
src/integrations/portals/registry.js
src/integrations/portals/grupo-olx/index.js
src/integrations/portals/grupo-olx/vrsync.mapper.js
src/integrations/portals/olx/index.js
src/integrations/portals/olx/olx-xml.mapper.js
src/integrations/portals/chaves-na-mao/index.js
src/integrations/portals/chaves-na-mao/cnm-xml.mapper.js
src/integrations/portals/imovelweb/index.js

src/routes/imoveis.routes.js
src/routes/imoveis-dashboard.routes.js
src/routes/integracoes.routes.js
src/routes/public.routes.js
src/routes/feeds.routes.js

scripts/validar-feeds-exemplo.js
.env.example
```

### API — alterados

| Arquivo | Alteração |
|---|---|
| `src/server.js` | Registro dos novos routers, `trust proxy` (necessário para o rate limit atrás do Nginx), limite do body JSON e middleware central de erro no fim da cadeia. **Nenhuma rota existente foi tocada.** |
| `package.json` | Dependências `minio`, `sharp`, `express-rate-limit`; script `validar:feeds`. |

Rotas legadas (`/auth`, `/filiais`, `/usuarios`, `/vendas`, `/contas-receber`, `/dashboard`)
continuam registradas na mesma ordem e com o mesmo comportamento.

### Front — novos

```text
src/assets/scss/gold-imoveis.scss                     (design system dos módulos novos)

src/app/core/services/imoveis.service.ts
src/app/core/services/imoveis-dashboard.service.ts
src/app/core/services/oportunidades.service.ts
src/app/core/services/portal-integrations.service.ts
src/app/core/services/public-site.service.ts

src/app/pages/project/imoveis/
  imoveis.module.ts | imoveis-routing.module.ts
  shared/imoveis-shared.module.ts
  imoveis-list/ | imovel-form/ | imovel-details/ | oportunidades/
  components/property-card/ | property-filters/ | property-gallery/
             property-upload/ | portal-status/
  pipes/safe-url.pipe.ts

src/app/pages/project/integracoes/
  integracoes.module.ts | integracoes-routing.module.ts
  portais/ | leads-portais/

src/app/pages/public/
  public.module.ts | public-property.module.ts
  public-layout/ | landing/ | property-public/
  pipes/safe-public-url.pipe.ts
```

### Front — alterados

| Arquivo | Alteração |
|---|---|
| `app-routing.module.ts` | Rotas públicas `/solucoes`, `/plataforma`, `/imovel` **antes** da rota `''`. A raiz continua sendo o dashboard autenticado com `AuthGuard`. |
| `app.module.ts` | Declara `PublicLayoutComponent` (mesmo padrão do `AuthlayoutComponent`). |
| `pages/pages-routing.module.ts` | Rotas lazy `imoveis` e `integracoes`. Rota `jm` do `ProjectModule` intacta. |
| `pages/dashboards/dashboards.module.ts` | Importa `ImoveisSharedModule` (para o card de imóvel na home). |
| `pages/dashboard-gold-leste/*` | **Adicionadas** seções de oportunidades e de gestão da carteira. Todo o conteúdo financeiro/comercial existente foi preservado. |
| `layouts/sidebar/menu.ts` | Novo grupo `IMÓVEIS`. Todos os itens anteriores mantidos com os mesmos links e perfis. |
| `core/helpers/error.interceptor.ts` | Passa a propagar o erro original **apenas** para as rotas novas (`/imoveis`, `/integracoes`, `/public`, `/dashboard/imoveis`) e não desloga em 401 de rota pública. Módulos legados recebem exatamente o mesmo formato de antes. |
| `angular.json` | Adiciona `src/assets/scss/gold-imoveis.scss` aos estilos globais (build e test). |

---

## 3. Banco de dados

Script: **`sql/20260816_imoveis_portais.sql`** (não executado).

Tabelas criadas:

| Tabela | Função |
|---|---|
| `imoveis` | Carteira principal. Soft delete via `deleted_at`. |
| `caracteristicas` | Catálogo de características (novas não exigem `ALTER TABLE`). |
| `imovel_caracteristicas` | Vínculo imóvel ↔ característica. |
| `imovel_midias` | Fotos/vídeos/tours. Chaves do MinIO e URLs públicas. |
| `imovel_visibilidades` | Corretores/filiais autorizados quando a visibilidade é restrita. |
| `imovel_favoritos` | Favoritos por corretor. |
| `imovel_logs` | Auditoria (criação, preço, status, ativação, mídia, publicação). |
| `portais` | Catálogo de canais + status de implementação. |
| `portal_integracoes` | Configuração por portal, token do feed e credenciais cifradas. |
| `imovel_portais` | Publicação por imóvel/portal, com erros de validação. |
| `portal_sync_logs` | Histórico de sincronizações (payload sanitizado). |
| `portal_leads` | Leads do site e dos portais, com UTMs e idempotência. |
| `demo_solicitacoes` | Formulário comercial da landing page. |
| `imoveis_codigo_seq` | Sequência do código `GL000001`. |

Pontos de atenção da modelagem:

- **Tipos de FK**: `usuarios.id`, `filiais.id` e `vendas.id` são `UUID` — confirmado no código
  (`scripts/migrate-ajustes-cliente.js` usa `UUID REFERENCES usuarios(id)` e
  `vendas.routes.js` faz `id = ANY($1::uuid[])`). O script tem um **bloco de pré-voo** que
  aborta com mensagem clara se algum desses tipos não for `uuid`.
- **Empreendimentos, unidades e clientes vivem na API legada** (`jmapi.ensuo.com.br`) e não
  existem neste banco. Por isso são referenciados por campos textuais
  (`empreendimento_legado_id`, `unidade_legado_id`, `proprietario_legado_id`) **sem foreign key**.
- A FK para `vendas` só é criada se a tabela existir neste banco.
- Índices parciais (`WHERE deleted_at IS NULL`) para código e slug: o soft delete não bloqueia reuso.
- Índice único parcial garante **uma capa por imóvel**.
- Índice único `(portal_slug, external_lead_id)` garante a **idempotência dos webhooks**.

---

## 4. Variáveis de ambiente

Novas (todas em `.env.example`, com **placeholders**, sem valores reais):

```text
PUBLIC_API_URL                # URL pública da API — monta a URL dos feeds
TRUST_PROXY_HOPS              # nº de proxies (Nginx) à frente — necessário para o rate limit
JSON_BODY_LIMIT

MINIO_ENDPOINT=minio.ensuo.com.br
MINIO_PORT=443
MINIO_USE_SSL=true
MINIO_BUCKET=empreendimentos
MINIO_PUBLIC_BASE_URL=https://minio.ensuo.com.br
MINIO_PREFIXO_IMOVEIS=imoveis
MINIO_ACCESS_KEY             # <- somente no .env/variáveis da VPS
MINIO_SECRET_KEY             # <- somente no .env/variáveis da VPS

INTEGRACOES_CRYPTO_KEY       # AES-256-GCM p/ credenciais de portais: openssl rand -hex 32

IMAGEM_LARGURA_WEB=1920
IMAGEM_LARGURA_THUMB=480
IMAGEM_QUALIDADE_WEB=82
IMAGEM_QUALIDADE_THUMB=72

UPLOAD_IMAGEM_MAX_MB=15
UPLOAD_IMAGEM_MAX_ARQUIVOS=20

RATE_LIMIT_FORM_PUBLICO=10
RATE_LIMIT_LEITURA_PUBLICA=120
RATE_LIMIT_FEED=30
RATE_LIMIT_WEBHOOK_LEADS=120
RATE_LIMIT_UPLOAD=60

IMOVEL_CODIGO_PREFIXO=GL
LEAD_IP_SALT                 # sal do hash de IP dos leads (nunca guardamos IP puro)
OPORTUNIDADE_DIAS_NOVIDADE=45
```

Nenhuma credencial foi versionada nem embutida no código. `MINIO_ACCESS_KEY`,
`MINIO_SECRET_KEY` e `INTEGRACOES_CRYPTO_KEY` vêm **exclusivamente** do ambiente da VPS.

`INTEGRACOES_CRYPTO_KEY` é obrigatória apenas para salvar credenciais de portal.
Trocar essa chave torna ilegíveis as credenciais já gravadas.

---

## 5. MinIO

- **Bucket**: `empreendimentos`
- **Endpoint**: `https://minio.ensuo.com.br` (porta 443, SSL)
- **Estrutura dos objetos**:

```text
imoveis/{imovelId}/{mediaId}/original.{jpg|png|webp}
imoveis/{imovelId}/{mediaId}/large.webp     (1920px, qualidade 82)
imoveis/{imovelId}/{mediaId}/thumb.webp     (480px,  qualidade 72)
```

O nome original do arquivo **nunca** é usado como chave. O `mediaId` é um UUID gerado na API.

Regras aplicadas:

- Whitelist de MIME (`image/jpeg`, `image/png`, `image/webp`) **e** de extensão.
- O conteúdo binário é validado com `sharp` (ou pela assinatura do arquivo, como fallback) —
  o MIME enviado pelo navegador não é aceito sozinho.
- Limite de 15 MB por arquivo e 20 arquivos por requisição (configuráveis).
- Se o upload subir e o banco falhar, os objetos já enviados são **removidos** (limpeza de órfãos).
- Se o upload falhar, **nada** é gravado no banco.
- A exclusão remove do banco primeiro (commit) e só então do MinIO; falhas de remoção são logadas.
- Nenhuma política de bucket foi alterada. Nenhum upload antigo (`uploads/comprovantes`) foi migrado.
- O navegador **nunca** fala com o MinIO — sem AccessKey/SecretKey no Angular.

**`sharp`**: se não carregar no servidor, a mídia é gravada apenas com o original e marcada
como `ORIGINAL_ONLY`, com o motivo visível no painel. Não há sucesso falso.

---

## 6. Portais — status real de cada integração

| Portal | Status | O que está pronto | O que falta |
|---|---|---|---|
| **ZAP Imóveis / Viva Real (Grupo OLX)** | **Implementado** | Feed XML no formato oficial **VRSync** (Header, Listing, Details, Location, ContactInfo, Media), validação com as regras oficiais (Title 10–100, Description ≥50, mínimo 5 fotos, `displayAddress` coerente, `PropertyType`/`TransactionType`/`Features` mapeados). | Cadastrar a URL do feed junto ao Grupo OLX (Canal Pro). Não há API pública de publicação unitária nem de importação de leads documentada — por isso essas operações aparecem como não suportadas. |
| **Chaves na Mão** | **Implementado** | Feed XML no formato oficial (`<Document>/<imoveis>/<imovel>`), tags obrigatórias presentes mesmo quando vazias, `fotos_imovel/foto/url`, datas em `AAAA-MM-DD HH:MM:SS`, tipos residenciais com a grafia exata da tabela do portal. | Enviar a URL do feed para o atendimento do portal. Tipos **comerciais** exigem informar a grafia exata na configuração (`config.tipos`) — não foram adivinhados. |
| **OLX** | **Parcial** | Feed XML no formato oficial de importação de imóveis (`CodigoImovel`, `SubTipoImovel`, `CEP`, `Observacao`, preços, áreas, `Fotos/Foto/URLArquivo`, `Videos`), com categorias oficiais (1020/1040/1060/1080/1100/1120). | Publicação via **API autoupload** (`PUT https://apps.olx.com.br/autoupload/import`) exige OAuth com escopo `autoupload` em nome do cliente. Sem credenciais, o adapter devolve `PENDING_CONFIGURATION` — **não simula publicação**. A tabela exata de `SubTipoImovel` por subcategoria é fornecida pelo portal; o mapeamento default é ajustável em Configuração. |
| **Imovelweb** | **Aguardando especificação** | Adapter, tela de configuração, catálogo e persistência prontos. | **Não foi localizada documentação oficial pública** de feed/API do portal. O adapter retorna `PENDING_SPECIFICATION` e recusa validar imóveis. Para ativar: obter a especificação, criar `integrations/portals/imovelweb/imovelweb.mapper.js` no mesmo padrão e trocar `statusImplementacao`/`capacidades`. |

Fontes oficiais consultadas em 2026-08-16:
`https://developers.grupozap.com/feeds/xml-formats/`,
`https://developers.grupozap.com/feeds/vrsync/elements/{header,listing,details}.html`,
`https://developers.olx.com.br/anuncio/home.html`,
`https://developers.olx.com.br/anuncio/xml/real_estate/home.html`,
`https://developers.olx.com.br/anuncio/api/import.html`,
`https://tecnologiacnm.github.io/cnm-xml-documentation/`.

Nenhum endpoint, token, webhook, campo XML ou comportamento foi inventado.

### Como um imóvel entra (ou não) no feed

1. O gestor habilita o imóvel no portal (aba **Portais** do cadastro ou detalhe do imóvel).
2. Ao habilitar, o adapter **valida** com as regras oficiais e grava as pendências.
3. Na geração do feed, cada imóvel é validado de novo:
   - válido → entra no XML, `status = PUBLICADO`;
   - inválido → **fica fora do feed**, `status = INVALIDO`, com os erros por campo visíveis no painel.
4. Imóveis vendidos, alugados, suspensos, inativos ou não habilitados nunca entram.
5. Cada geração registra um `portal_sync_logs` com o total de anúncios e os rejeitados.

---

## 7. Rotas criadas

### API

```text
GET    /imoveis                                # carteira paginada + filtros
GET    /imoveis/contadores
GET    /imoveis/oportunidades                  # vitrine do corretor
GET    /imoveis/metadados
GET    /imoveis/caracteristicas
GET    /imoveis/:id
POST   /imoveis
PUT    /imoveis/:id
PATCH  /imoveis/:id
PATCH  /imoveis/:id/status
DELETE /imoveis/:id                            # soft delete (inativação)
POST   /imoveis/:id/favorito
GET    /imoveis/:id/historico

GET    /imoveis/:id/midias
POST   /imoveis/:id/midias                     # multipart -> MinIO
POST   /imoveis/:id/midias/externa             # vídeo YouTube / tour 360
PUT    /imoveis/:id/midias/ordem
PATCH  /imoveis/:id/midias/:mediaId
PATCH  /imoveis/:id/midias/:mediaId/capa
DELETE /imoveis/:id/midias/:mediaId

GET    /imoveis/:id/portais
POST   /imoveis/:id/portais/:portalId/validar
PATCH  /imoveis/:id/portais/:portalId

GET    /dashboard/imoveis                      # indicadores de gestão (admin/gerente)

GET    /integracoes/portais
GET    /integracoes/portais/catalogo
GET    /integracoes/portais/:id
PUT    /integracoes/portais/:id                # admin
POST   /integracoes/portais/:id/testar
GET    /integracoes/portais/:id/logs
GET    /integracoes/leads
GET    /integracoes/leads/resumo
POST   /integracoes/leads/:id/atendimento
GET    /integracoes/armazenamento              # diagnóstico MinIO/sharp (sem segredos)

GET    /public/imoveis                         # busca pública
GET    /public/imoveis/:slug                   # página pública
POST   /public/imoveis/:slug/interesse         # lead do site
POST   /public/demo                            # formulário comercial
POST   /public/leads/:portalSlug/:token        # webhook de leads de portal
GET    /public/feeds/:portalSlug/:token.xml    # feed do portal
```

### Front

```text
/imoveis                     Carteira
/imoveis/oportunidades       Vitrine do corretor
/imoveis/novo                Cadastro em etapas
/imoveis/:id                 Detalhe
/imoveis/:id/editar          Edição

/integracoes/portais         Central de integrações
/integracoes/leads           Leads recebidos

/solucoes                    Landing comercial (pública)
/plataforma                  Redireciona para /solucoes
/imovel/:slug                Página pública do imóvel
```

---

## 8. Segurança dos endpoints novos

- JWT obrigatório em tudo, exceto `/public/*` e `/public/feeds/*`.
- **Escopo por perfil aplicado em SQL** (`imoveis.repository.js → clausulaEscopo`):
  - `admin` vê tudo;
  - `gerente` vê o que é seu, da sua filial e dos seus corretores;
  - `corretor` respeita `visibilidade` (`TODOS`, `FILIAL`, `SELECIONADOS`, `GERENCIA`, `PRIVADO`).
  Trocar o ID na URL **não** dá acesso: a cláusula entra no `WHERE` da consulta.
- Escrita usa `podeEditar()` além do escopo de leitura.
- Configuração de portal: `admin` altera; `gerente` visualiza e testa; corretor não acessa.
- Validação de UUID em todos os parâmetros de rota.
- Paginação com teto rígido (`pageSize` máximo 100).
- Upload com whitelist de MIME + extensão + validação binária + limite de tamanho.
- Rate limiting em formulários públicos, leitura pública, feeds, webhooks e uploads.
- Honeypot nos dois formulários públicos.
- IP de lead guardado apenas como **hash com sal** — nunca em claro.
- Credenciais de portal cifradas em AES-256-GCM; a API devolve **apenas máscaras** (`abc***xyz`).
- Logs passam por `sanitizarPayload()` — chaves sensíveis viram `[REDACTED]`.
- Nunca são retornados: `MINIO_SECRET_KEY`, `MINIO_ACCESS_KEY`, senha, `JWT_SECRET`,
  tokens de portais, refresh tokens ou configuração confidencial.
- A página pública não expõe valor mínimo, comissão, observações internas nem dados do
  proprietário; o endereço completo só aparece se `exibirEnderecoCompleto` estiver ligado.
- Iframes de mapa passam por pipe que só aceita origem OpenStreetMap.

---

## 9. Score de oportunidade e qualidade do anúncio

Ambos em `src/services/imovel-score.service.js`, com pesos em constantes no topo do arquivo.

**Qualidade (0–100)** — soma dos critérios atendidos / soma dos pesos:

| Critério | Peso |
|---|---|
| Título ≥ 20 caracteres | 8 |
| Descrição ≥ 200 caracteres | 12 |
| Foto de capa definida | 14 |
| Pelo menos 5 fotos (mínimo do Grupo OLX) | 16 |
| Pelo menos 10 fotos | 6 |
| Cidade, UF e bairro preenchidos | 12 |
| Valor compatível com a finalidade | 14 |
| Área útil ou total informada | 8 |
| Dormitórios (ou tipo sem dormitório) | 5 |
| Pelo menos 3 características | 5 |

**Oportunidade** — soma explícita de parcelas (máx. ~100):
marcação manual (25) + exclusivo (12) + destaque (8) + lançamento (8) +
comissão (até 15, saturando em 6%) + novidade (até 12, decaindo em 45 dias) +
leads (até 10) + visualizações (até 5) + qualidade (até 10) + prioridade manual (até 20).

`prioridade_manual` (0–100) é definida por admin/gerente e permite subir um imóvel na vitrine.
O detalhamento das parcelas é retornado pela função, facilitando depuração e ajuste.

---

## 10. Leads

- **Site público** → `POST /public/imoveis/:slug/interesse`: grava imóvel, `origem = SITE`,
  página, data, UTMs (`utm_source/medium/campaign/content/term`), referer, hash do IP e user agent.
- **Portais** → `POST /public/leads/:portalSlug/:token`: idempotente por
  `(portal_slug, external_lead_id)`; um retry de webhook **não** gera lead duplicado.
- Responsável definido na entrada: corretor do imóvel → captador → gerente → fila.
- O modelo registra `recebido_em`, `atribuido_em` e `primeiro_atendimento_em`, base para
  rodízio/SLA sem mudar o schema.

### Integração com o CRM legado — situação honesta

O CRM de Leads do front usa a API legada `jmapi.ensuo.com.br`. **Não há contrato de ingestão
documentado** nesse backend, então o encaminhamento automático **não foi implementado** —
implementá-lo às cegas seria uma integração fictícia.

O que existe hoje: o lead é persistido na base nova com rastreabilidade completa, fica
visível em `/integracoes/leads` e no detalhe do imóvel, com `encaminhado_crm_em = NULL`.
`PortalLeadIngressService` é o ponto único de extensão para, no futuro, encaminhar ao CRM
atual, a uma fila ou a um webhook interno.

Na vitrine, o botão "Atendimento" leva o corretor à tela de leads existente com o imóvel
como parâmetro (`/leads?imovel=GL000123&imovelId=...`) — sem alterar o módulo legado.

---

## 11. Landing na raiz do domínio (quando você quiser)

Hoje `/` continua sendo o dashboard autenticado. Para promover a landing à raiz:

1. Em `src/app/app-routing.module.ts`, troque:
   ```ts
   { path: 'solucoes', component: PublicLayoutComponent, loadChildren: ... }
   ```
   por `path: ''` **e** mova o painel para um prefixo, por exemplo:
   ```ts
   { path: 'painel', component: LayoutComponent, loadChildren: ..., canActivate: [AuthGuard] }
   ```
2. Atualize os links do menu (`layouts/sidebar/menu.ts`) e os `router.navigate(['/'])`.
3. Ajuste o `returnUrl` do `AuthGuard` e o redirecionamento pós-login.

Isso muda a URL de todos os usuários atuais — por isso **não** foi feito automaticamente.

### ⚠️ HashLocationStrategy e SEO

A aplicação usa `HashLocationStrategy` (`app.module.ts`), então as URLs saem como
`https://seu-dominio/#/imovel/apartamento-2-dormitorios-...-gl000123`.

Consequências reais:

- Os links **funcionam** e o compartilhamento foi implementado respeitando isso
  (`LocationStrategy.prepareExternalUrl`).
- Porém **crawlers e prévias de redes sociais ignoram o fragmento** `#`: todas as páginas
  de imóvel são vistas como o mesmo documento, e as tags Open Graph aplicadas em runtime
  não são lidas por robôs que não executam JavaScript.

Para SEO real da página do imóvel são necessários dois passos de infraestrutura
(fora do escopo desta tarefa, pois mexem em rota de todos os usuários e no Nginx):

1. Trocar para `PathLocationStrategy` e configurar no Nginx
   `try_files $uri $uri/ /index.html;`.
2. Adotar SSR/prerender para que `title`, `description` e Open Graph cheguem prontos ao crawler.

As tags (`Title`, `Meta`, Open Graph, Twitter Card e `canonical`) **já estão implementadas**
em `property-public.component.ts` e passam a valer integralmente assim que (1) e (2) forem feitos.

---

## 12. Validações executadas

### Front-end — `npm run build`

```text
npx ng build --configuration development   -> exit 0
npx ng build                               -> exit 0 (produção)

Lazy chunks gerados:
  project-imoveis-imoveis-module          165,40 kB
  project-integracoes-integracoes-module   48,67 kB
  pages-public-public-property-module      35,51 kB
  pages-public-public-module               30,64 kB
```

Sem erros de compilação. Os avisos `NG8107` e de CommonJS que aparecem no log são
**pré-existentes**, em componentes legados (`contas-contabeis`, `propostas`, `proposta`,
`visao-geral`) e em dependências (`canvg`, `html2canvas`, `file-saver`) — nenhum deles
vem dos arquivos criados aqui.

### API — análise estática

```text
node --check em todos os arquivos de src/ e scripts/   -> OK
Carregamento (require) de todos os routers e services  -> OK
```

### API — validação funcional offline dos feeds

```bash
npm run validar:feeds
```

Monta um imóvel fictício em memória (sem banco, sem MinIO, sem chamar portal) e roda
`validateProperty` + `generateFeed` de cada adapter, verificando a boa formação do XML
com uma pilha de tags:

```text
Grupo OLX (ZAP/Viva Real)  validateProperty ok=true   XML bem formado (66 elementos)
OLX                        validateProperty ok=true   XML bem formado (39 elementos)
Chaves na Mão              validateProperty ok=true   XML bem formado (55 elementos)
Imovelweb                  validateProperty ok=false  (esperado: aguardando especificação)

Concluído sem falhas.
```

### O que NÃO foi possível testar

| Item | Motivo |
|---|---|
| Qualquer endpoint que leia ou grave em `imoveis`, `imovel_midias`, `portais`, `portal_leads` etc. | As tabelas só existem depois que **você** executar `sql/20260816_imoveis_portais.sql`. |
| Upload real para o MinIO | Exige `MINIO_ACCESS_KEY`/`MINIO_SECRET_KEY` do ambiente da VPS. |
| Publicação via API da OLX | Exige OAuth com escopo `autoupload` do cliente + homologação. |
| Consumo real dos feeds pelos portais | Depende de cadastrar a URL junto a cada portal. |
| Recebimento real de leads de portal | Depende do portal disponibilizar/apontar o webhook. |

Nenhum teste tocou o banco de produção. Nenhum `POST/PUT/PATCH/DELETE` foi disparado
contra a API em produção.

---

## 13. Pendências externas (dependem de você)

1. **Executar** `sql/20260816_imoveis_portais.sql` (revisar antes).
2. Definir `MINIO_ACCESS_KEY` e `MINIO_SECRET_KEY` no `.env` da VPS.
3. Gerar e definir `INTEGRACOES_CRYPTO_KEY` (`openssl rand -hex 32`).
4. Conferir `PUBLIC_API_URL` e `TRUST_PROXY_HOPS` (nº de proxies à frente da API).
5. Instalar as novas dependências na VPS: `npm install` (`minio`, `sharp`, `express-rate-limit`).
6. Em **Integrações > Portais**: preencher contato, habilitar a integração, gerar o token do
   feed e enviar a URL a cada portal:
   - Grupo OLX → Canal Pro;
   - Chaves na Mão → `atendimento@chavesnamao.com.br` (com responsável e CNPJ/CPF);
   - OLX → suporte de integração;
   - Imovelweb → solicitar a especificação oficial.
7. Para publicação via API da OLX: obter `client_id`, `client_secret` e `access_token`
   (escopo `autoupload`) e concluir a homologação.
8. Para o Chaves na Mão com imóveis **comerciais**: informar em Configuração a grafia exata
   dos tipos conforme a tabela do portal.
9. Decidir sobre `PathLocationStrategy` + SSR se o SEO da página de imóvel for prioridade.

---

## 14. O que NÃO foi feito (de propósito)

- Nenhuma alteração no banco de dados.
- Nenhum reinício de PM2/Node/Nginx/Docker, deploy ou mudança de VPS/DNS/firewall.
- Nenhuma alteração em configuração ou política do MinIO.
- Nenhuma migração dos uploads antigos (`uploads/comprovantes`).
- Nenhuma remoção ou migração dos módulos que usam `jmapi.ensuo.com.br`.
- Nenhuma refatoração global dos módulos existentes.
- Nenhum protocolo de portal inventado.
- Nenhuma prova social fictícia na landing (sem números de clientes, depoimentos,
  logos, cases ou preços inventados) — a estrutura visual está pronta para receber
  dados reais quando existirem.
