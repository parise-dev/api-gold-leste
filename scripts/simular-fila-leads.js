/**
 * Verificação da REGRA da fila de leads — roda sem banco.
 *
 * Reproduz a semântica implementada em src/repositories/lead-queue.repository.js
 * e confere os cenários exigidos na especificação (rodízio, saída, volta ao
 * fim, perda de heartbeat, desativação, leads simultâneos, fila vazia).
 *
 * Uso:  npm run testar:fila
 *
 * Semântica reproduzida:
 *   - `ordem` = nextval(seq) monotônico
 *   - fila = corretores elegíveis ORDER BY ordem ASC
 *   - receber lead   -> ordem = nextval  (vai para o fim)
 *   - reentrar online -> ordem = nextval (vai para o fim)
 *   - offline/inativo -> fora da consulta
 */

let seq = 0;
const nextval = () => ++seq;

const TIMEOUT_MS = 120000;

const corretores = new Map(); // id -> { nome, ordem, naFila, ativo, ultimaAtividade }

function heartbeat(id, agora) {
  const c = corretores.get(id);
  const estavaOnline =
    c.ultimaAtividade !== null && agora - c.ultimaAtividade <= TIMEOUT_MS;

  if (!estavaOnline || !c.naFila) c.ordem = nextval();

  c.naFila = true;
  c.ultimaAtividade = agora;
}

function logout(id) {
  const c = corretores.get(id);
  c.naFila = false;
  c.ultimaAtividade = null;
}

function fila(agora) {
  return [...corretores.entries()]
    .filter(([, c]) =>
      c.naFila && c.ativo && c.ultimaAtividade !== null && agora - c.ultimaAtividade <= TIMEOUT_MS)
    .sort((a, b) => a[1].ordem - b[1].ordem)
    .map(([, c]) => c.nome);
}

function distribuir(agora) {
  const proximos = [...corretores.entries()]
    .filter(([, c]) =>
      c.naFila && c.ativo && c.ultimaAtividade !== null && agora - c.ultimaAtividade <= TIMEOUT_MS)
    .sort((a, b) => a[1].ordem - b[1].ordem);

  if (!proximos.length) return null;

  const [, escolhido] = proximos[0];
  escolhido.ordem = nextval();

  return escolhido.nome;
}

function criar(id, nome) {
  corretores.set(id, { nome, ordem: nextval(), naFila: true, ativo: true, ultimaAtividade: null });
}

// ---------------------------------------------------------------------
let falhas = 0;
const t = 1000;

function conferir(rotulo, obtido, esperado) {
  const ok = JSON.stringify(obtido) === JSON.stringify(esperado);
  if (!ok) falhas++;
  console.log(`${ok ? 'OK  ' : 'FALHA'}  ${rotulo}\n        obtido:   ${JSON.stringify(obtido)}\n        esperado: ${JSON.stringify(esperado)}`);
}

// --- Cenário do enunciado -------------------------------------------
criar('j', 'João'); criar('m', 'Maria'); criar('c', 'Carlos'); criar('a', 'Ana');
['j', 'm', 'c', 'a'].forEach((id) => heartbeat(id, t));

conferir('fila inicial', fila(t), ['João', 'Maria', 'Carlos', 'Ana']);

conferir('Lead A -> João', distribuir(t), 'João');
conferir('fila após João receber', fila(t), ['Maria', 'Carlos', 'Ana', 'João']);

conferir('Lead B -> Maria', distribuir(t), 'Maria');
conferir('fila após Maria receber', fila(t), ['Carlos', 'Ana', 'João', 'Maria']);

// --- Maria fica offline ---------------------------------------------
logout('m');
conferir('Maria offline sai da fila', fila(t), ['Carlos', 'Ana', 'João']);

// --- Maria volta: precisa ir para o FIM ------------------------------
heartbeat('m', t);
conferir('Maria volta para o fim', fila(t), ['Carlos', 'Ana', 'João', 'Maria']);

// --- Segundo cenário do enunciado ------------------------------------
corretores.clear(); seq = 0;
criar('j', 'João'); criar('m', 'Maria'); criar('c', 'Carlos');
['j', 'm', 'c'].forEach((id) => heartbeat(id, t));

conferir('cenário 2 — inicial', fila(t), ['João', 'Maria', 'Carlos']);
distribuir(t);
conferir('cenário 2 — após Lead A', fila(t), ['Maria', 'Carlos', 'João']);
distribuir(t);
conferir('cenário 2 — após Lead B', fila(t), ['Carlos', 'João', 'Maria']);

logout('c');
conferir('cenário 2 — Carlos logout', fila(t), ['João', 'Maria']);

conferir('cenário 2 — Lead C vai para João', distribuir(t), 'João');
conferir('cenário 2 — após Lead C', fila(t), ['Maria', 'João']);

heartbeat('c', t);
conferir('cenário 2 — Carlos volta ao fim', fila(t), ['Maria', 'João', 'Carlos']);

// --- Perda de heartbeat ----------------------------------------------
corretores.clear(); seq = 0;
criar('j', 'João'); criar('m', 'Maria');
heartbeat('j', t); heartbeat('m', t);

const depois = t + TIMEOUT_MS + 1;
heartbeat('j', depois); // João continua batendo; Maria não

conferir('heartbeat perdido derruba Maria', fila(depois), ['João']);

heartbeat('m', depois);
conferir('Maria volta ao fim após perder heartbeat', fila(depois), ['João', 'Maria']);

// --- Corretor desativado ---------------------------------------------
corretores.get('m').ativo = false;
conferir('corretor inativo sai da fila', fila(depois), ['João']);

// --- Nenhum corretor online -------------------------------------------
logout('j');
conferir('nenhum online -> sem distribuição', distribuir(depois), null);
conferir('fila vazia', fila(depois), []);

// --- Dois leads "simultâneos" (serializados pelo lock) ----------------
corretores.clear(); seq = 0;
criar('j', 'João'); criar('m', 'Maria'); criar('c', 'Carlos');
['j', 'm', 'c'].forEach((id) => heartbeat(id, t));

const a = distribuir(t);
const b = distribuir(t);
conferir('leads simultâneos vão para corretores diferentes', [a, b], ['João', 'Maria']);

console.log(falhas === 0 ? '\nTODOS OS CENÁRIOS PASSARAM' : `\n${falhas} CENÁRIO(S) FALHARAM`);
process.exit(falhas === 0 ? 0 : 1);
