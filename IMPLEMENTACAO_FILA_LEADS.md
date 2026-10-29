# Gold Leste — Fila de Leads / Próximos Corretores

Distribuição sequencial (round-robin) de leads entre corretores **ativos e
online**, com painel de acompanhamento para TV da imobiliária.

> **Nada foi executado no banco.** O script está em
> `sql/20260830_fila_leads.sql` e precisa ser rodado manualmente.
> Enquanto isso, a API detecta a ausência das estruturas e mantém o
> comportamento anterior — o sistema em produção continua funcionando.

---

## 1. Como instalar

```bash
psql "$DATABASE_URL" -f sql/20260830_fila_leads.sql
```

O script é **aditivo** e transacional:

| Objeto | Ação |
| --- | --- |
| `usuarios.ultima_atividade_em` | coluna nova (nullable) |
| `portal_leads.distribuicao_pendente_desde` | coluna nova (nullable) |
| `portal_leads.distribuicao_tipo` | coluna nova (nullable) |
| `portal_leads.distribuicao_posicao` | coluna nova (nullable) |
| `lead_fila_corretores` | tabela nova |
| `lead_distribuicao_logs` | tabela nova |
| `lead_fila_ordem_seq` | sequência nova |

Nenhuma coluna é removida, renomeada ou alterada de tipo. Nenhum `CHECK`
existente é modificado. Rollback: `sql/20260830_fila_leads_rollback.sql`
(apaga a fila e o histórico — leia o cabeçalho antes).

Depois de rodar, **reinicie a API** para a verificação de schema ser
refeita.

---

## 2. Regra de "usuário online"

Sessão antiga **não** é presença. Um token no `localStorage` sobrevive à
aba fechada, ao notebook suspenso e à queda de internet — um corretor
nessas condições não pode receber lead.

- o frontend envia `POST /fila-leads/presenca` (heartbeat) enquanto o
  usuário está na área autenticada;
- a API grava `usuarios.ultima_atividade_em = NOW()`;
- **online** = `ultima_atividade_em > NOW() - janela`;
- **logout** (`POST /auth/logout` ou `POST /fila-leads/presenca/sair`)
  zera a presença e tira o corretor da fila na hora;
- fechar a aba dispara `pagehide` → saída imediata;
- voltar para a aba dispara um heartbeat extra.

Toda a configuração vive em **um único arquivo**:
`src/config/lead-distribution.config.js` (lido também pelo frontend via
`GET /fila-leads`, campo `configuracao`).

| Variável | Padrão | O que faz |
| --- | --- | --- |
| `FILA_PRESENCA_TIMEOUT_SEGUNDOS` | 120 | tempo sem heartbeat até ficar offline |
| `FILA_HEARTBEAT_INTERVALO_SEGUNDOS` | timeout ÷ 3 | intervalo sugerido ao frontend |
| `FILA_PAINEL_POLL_SEGUNDOS` | 5 | atualização do painel |
| `FILA_MAX_PENDENTES_RODADA` | 25 | leads pendentes escoados por rodada |
| `LEAD_DISTRIBUICAO_ESTRATEGIA` | `FILA` | `FILA` (rodízio) ou `IMOVEL` (comportamento anterior) |

---

## 3. Como a fila é mantida

`lead_fila_corretores.ordem` é um contador monotônico
(`nextval('lead_fila_ordem_seq')`). **Menor `ordem` = próximo a receber.**

- receber lead → `ordem = nextval(...)` → vai para o fim;
- voltar a ficar online → `ordem = nextval(...)` → entra no fim
  (nunca recupera a posição antiga);
- continuar online → posição preservada;
- offline / inativo / perfil fora da fila → some da consulta.

Assim a rotação nunca renumera a tabela inteira e **não depende de
`ORDER BY` em `usuarios`**.

Somente `perfil = 'corretor'` participa (`PERFIS_NA_FILA`). Admin e
gerente não entram no rodízio.

---

## 4. Concorrência

Toda distribuição roda em **uma transação** protegida por
`pg_advisory_xact_lock(918273645)`:

```
BEGIN
  pg_advisory_xact_lock(chave)          -- serializa a distribuição
  SELECT lead FOR UPDATE                -- lead ainda sem responsável?
  SELECT próximo corretor ORDER BY ordem ASC LIMIT 1
  UPDATE portal_leads  SET responsavel_id, atribuido_em, ...
  UPDATE lead_fila_corretores SET ordem = nextval(...)   -- vai para o fim
  INSERT lead_distribuicao_logs                          -- auditoria
COMMIT
```

Dois leads no mesmo instante: o segundo só escolhe corretor depois que o
primeiro já rotacionou a fila. Nunca cai o mesmo corretor duas vezes.

O lead é **gravado antes** (transação própria da ingestão) e distribuído
em seguida. Uma falha na distribuição não perde o lead — ele fica
pendente.

---

## 5. Lead sem corretor disponível

`portal_leads.distribuicao_pendente_desde` marca o momento em que o lead
ficou esperando. Ele é distribuído automaticamente quando:

- um corretor entra online (heartbeat detecta a reentrada);
- há pendências e qualquer corretor bate heartbeat;
- um gestor clica **Distribuir** na tela de leads;
- `POST /fila-leads/pendentes/distribuir`.

Nenhum lead é atribuído a corretor offline.

---

## 6. Distribuição manual

`POST /fila-leads/leads/:id/atribuir` (admin/gerente).

**Não rotaciona a fila automática de propósito:** a decisão manual é uma
exceção pontual e não pode gastar a vez de quem está esperando nem
empurrar o escolhido para o fim. O evento é registrado em
`lead_distribuicao_logs` com `tipo = 'MANUAL'`, o `alterado_por` e a
posição que o corretor ocupava.

---

## 7. Auditoria

`lead_distribuicao_logs` guarda, por evento: lead, corretor (id + nome
desnormalizado), posição ocupada, tipo (`AUTOMATICA` / `MANUAL` /
`REDISTRIBUICAO` / `SEM_CORRETOR`), origem do lead, portal, imóvel,
usuário que fez a alteração manual, quantidade de corretores online e
motivo. **Reorganizar a fila nunca apaga histórico.**

---

## 8. Endpoints

Todos sob `/fila-leads`, autenticados.

| Método | Rota | Perfil | O que faz |
| --- | --- | --- | --- |
| POST | `/presenca` | qualquer | heartbeat; devolve o intervalo sugerido |
| POST | `/presenca/sair` | qualquer | sai da presença/fila |
| GET | `/` | admin, gerente | estado completo do painel |
| GET | `/online` | admin, gerente | apenas os corretores online |
| GET | `/proximo` | admin, gerente | espia o próximo, sem alterar nada |
| GET | `/pendentes` | admin, gerente | leads aguardando corretor |
| GET | `/historico` | admin, gerente | auditoria de distribuição |
| POST | `/leads/:id/distribuir` | admin, gerente | manda para o próximo da fila |
| POST | `/pendentes/distribuir` | admin, gerente | escoa os pendentes |
| POST | `/leads/:id/atribuir` | admin, gerente | atribuição manual |

Alterados: `POST /auth/login` (entra na fila), `POST /auth/logout` (novo).

---

## 9. Painel

`/#/painel/fila-leads` — menu **Imóveis → Fila de Leads** (admin/gerente).

- 1º colocado em card grande, com borda e glow dourados, avatar com anel
  girando e selo "Próximo Lead";
- demais em ranking com posição, avatar, ONLINE, leads recebidos hoje e
  horário do último lead;
- brilho dourado nos quatro cantos e partículas lentas — CSS puro, sem
  biblioteca;
- flash dourado + etiqueta "Lead recebido" quando alguém recebe;
- botão de tela cheia (ou tecla **F**), pensado para TV 1920×1080;
- reconecta sozinho após queda de rede;
- empty state elegante quando ninguém está online.

Atualização por polling leve no intervalo que a API sugere. O projeto não
tem WebSocket e subir essa infraestrutura só para esta tela não se
justifica.

---

## 10. Testar a regra sem banco

```bash
npm run testar:fila
```

Reproduz a semântica da fila e confere os cenários da especificação:
rodízio, saída, volta ao fim, perda de heartbeat, corretor desativado,
leads simultâneos e fila vazia.
