/* eslint-disable no-console */
/**
 * Importador assistido da listagem completa do Kenlo Imob.
 *
 * O navegador autenticado envia somente os dados visiveis nos cards do painel
 * para este servidor local. A primeira etapa apenas confere; a segunda grava
 * exclusivamente referencias que ainda nao existem no banco.
 *
 * Uso:
 *   node scripts/importar-kenlo-painel.js
 */

const crypto = require('crypto');
const http = require('http');
const { URLSearchParams } = require('url');

const pool = require('../src/config/db');
const imoveisService = require('../src/services/imoveis.service');
const { normalizarImovel } = require('../src/validators/imovel.validator');

const HOST = '127.0.0.1';
const PORT = Number(process.env.KENLO_IMPORT_PORT || 48765);
const MAX_BODY = 4 * 1024 * 1024;

let captura = null;

function escaparHtml(valor) {
  return String(valor ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function pagina(conteudo) {
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Importacao Kenlo</title><style>
body{font-family:Arial,sans-serif;background:#f4f1eb;color:#191919;margin:0;padding:40px}.box{max-width:980px;margin:auto;background:#fff;border-radius:18px;padding:30px;box-shadow:0 14px 45px #0002}h1{margin-top:0}textarea{width:100%;height:280px;box-sizing:border-box;padding:14px;border:1px solid #bbb;border-radius:10px}button{border:0;border-radius:9px;background:#b7863e;color:#fff;font-weight:700;padding:13px 22px;cursor:pointer}.danger{background:#181818}.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:22px 0}.stat{background:#f7f2e9;border:1px solid #e6d7c1;border-radius:12px;padding:16px}.stat strong{display:block;font-size:26px}.ok{color:#087a3e}.erro{color:#a12121}code{word-break:break-word}</style></head>
<body><main class="box">${conteudo}</main></body></html>`;
}

function responder(res, status, conteudo) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(pagina(conteudo));
}

function lerBody(req) {
  return new Promise((resolve, reject) => {
    let texto = '';
    req.setEncoding('utf8');
    req.on('data', (parte) => {
      texto += parte;
      if (texto.length > MAX_BODY) reject(new Error('Payload maior que o limite de 4 MB.'));
    });
    req.on('end', () => resolve(texto));
    req.on('error', reject);
  });
}

function referencia(item) {
  return String(item?.referencia || '').trim().toUpperCase();
}

function validarCaptura(valor) {
  if (!Array.isArray(valor)) throw new Error('A captura precisa ser uma lista JSON.');
  if (valor.length !== 613) throw new Error(`Esperados 613 imoveis; recebidos ${valor.length}.`);

  const refs = valor.map(referencia);
  if (refs.some((ref) => !/^[A-Z]{2,3}\d{4,5}$/.test(ref))) {
    throw new Error('A captura possui uma ou mais referencias invalidas.');
  }
  if (new Set(refs).size !== refs.length) throw new Error('A captura possui referencias duplicadas.');

  return valor.map((item) => ({
    referencia: referencia(item),
    status: String(item.status || '').trim(),
    resumo: Array.isArray(item.resumo) ? item.resumo.map((parte) => String(parte || '').trim()).filter(Boolean) : [],
    foto: /^https:\/\//i.test(String(item.foto || '')) ? String(item.foto) : null
  }));
}

function temRotulo(item, rotulo) {
  return item.resumo.some((parte) => parte.toLocaleLowerCase('pt-BR') === rotulo.toLocaleLowerCase('pt-BR'));
}

function valorDepois(item, rotulo) {
  const indice = item.resumo.findIndex((parte) => parte.toLocaleLowerCase('pt-BR') === rotulo.toLocaleLowerCase('pt-BR'));
  if (indice < 0) return null;
  const texto = String(item.resumo[indice + 1] || '').replace(/R\$\s*/i, '').replace(/\./g, '').replace(',', '.');
  const numero = Number(texto);
  return Number.isFinite(numero) && numero > 0 ? numero : null;
}

function semAcentos(valor) {
  return String(valor || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
}

function tipoDoImovel(cabecalho, ref) {
  const nome = semAcentos(String(cabecalho || '').split(' - ')[0]);
  const tipos = [
    ['APARTAMENTO GARDEN', 'APARTAMENTO_GARDEN'],
    ['APARTAMENTO DUPLEX', 'APARTAMENTO_DUPLEX'],
    ['APARTAMENTO TRIPLEX', 'APARTAMENTO_TRIPLEX'],
    ['APARTAMENTO', 'APARTAMENTO'], ['SOBRADO', 'SOBRADO'], ['STUDIO', 'STUDIO'],
    ['CASA', 'CASA'], ['TERRENO', 'TERRENO'], ['CHACARA', 'CHACARA'],
    ['GALPAO', 'GALPAO'], ['SALAO', 'SALAO'], ['SALA', 'SALA'], ['PONTO', 'PONTO'],
    ['AREA', 'AREA'], ['LOJA', 'LOJA'], ['PREDIO', 'PREDIO']
  ];
  const encontrado = tipos.find(([rotulo]) => nome === rotulo);
  if (encontrado) return encontrado[1];
  const prefixo = (ref.match(/^[A-Z]+/) || [''])[0];
  return {
    AP: 'APARTAMENTO', GD: 'APARTAMENTO_GARDEN', AD: 'APARTAMENTO_DUPLEX',
    CA: 'CASA', SO: 'SOBRADO', ST: 'STUDIO', CH: 'CHACARA', SL: 'SALAO',
    SA: 'SALA', GA: 'GALPAO', TE: 'TERRENO', AR: 'AREA', PT: 'PONTO'
  }[prefixo] || 'OUTRO';
}

function decomporCabecalho(cabecalho) {
  const texto = String(cabecalho || '').trim();
  const match = texto.match(/^(.+?)\s+-\s+(.+?)\s+-\s+(Residencial|Comercial)\s*,\s*(.+)$/i);
  if (!match) return { tituloBase: texto || 'Imovel importado do Kenlo' };

  const [, tipoLabel, bairro, uso, restante] = match;
  const partes = restante.split(/\s+-\s+/);
  const enderecoCompleto = partes.shift() || '';
  const empreendimento = partes.join(' - ') || null;
  const numeroMatch = enderecoCompleto.match(/,\s*n[ºo°]?\s*([^,]+)(?:,\s*(.*))?$/i);
  const logradouro = numeroMatch ? enderecoCompleto.slice(0, numeroMatch.index).trim() : enderecoCompleto;
  const numero = numeroMatch ? numeroMatch[1].trim() : null;
  const complemento = numeroMatch?.[2]?.trim() || null;

  return {
    tipoLabel,
    bairro,
    uso,
    logradouro: logradouro || null,
    numero,
    complemento,
    empreendimento,
    tituloBase: [tipoLabel, bairro, empreendimento].filter(Boolean).join(' em ')
  };
}

function atributos(item) {
  const texto = item.resumo.join(' ');
  const numero = (regexp) => {
    const match = texto.match(regexp);
    return match ? Number(String(match[1]).replace(',', '.')) : null;
  };
  const area = numero(/([\d.,]+)\s*m²\s*área/i);
  const areaConstruida = /m²\s*área\s*construída/i.test(texto) ? area : null;
  const areaTerreno = /m²\s*área\s*terreno/i.test(texto) ? area : null;
  const areaUtil = !areaConstruida && !areaTerreno ? area : null;
  return {
    dormitorios: numero(/(\d+)\s*dorm/i) || 0,
    suites: numero(/(\d+)\s*suítes?/i) || 0,
    vagas: numero(/(\d+)\s*vagas?/i) || 0,
    areaUtil,
    areaConstruida,
    areaTerreno,
    areaTotal: area
  };
}

function statusLocal(status) {
  return {
    ATIVO: 'DISPONIVEL', SUSPENSO: 'SUSPENSO', CANCELADO: 'INATIVO',
    VENDIDO: 'VENDIDO', LOCADO: 'ALUGADO'
  }[semAcentos(status)] || 'INATIVO';
}

function mapear(item) {
  const cabecalho = item.resumo[0] || `Imovel ${item.referencia}`;
  const endereco = decomporCabecalho(cabecalho);
  const detalhes = atributos(item);
  const venda = temRotulo(item, 'Venda');
  const locacao = temRotulo(item, 'Locação');
  const finalidade = venda && locacao ? 'VENDA_LOCACAO' : locacao ? 'LOCACAO' : 'VENDA';
  const status = statusLocal(item.status);

  return normalizarImovel({
    titulo: (endereco.tituloBase || cabecalho).slice(0, 160),
    referenciaExterna: item.referencia,
    descricao: null,
    descricaoResumida: null,
    finalidade,
    tipo: tipoDoImovel(cabecalho, item.referencia),
    subtipo: endereco.tipoLabel || null,
    situacao: 'USADO',
    status,
    origemCarteira: 'TERCEIRO',
    visibilidade: 'TODOS',
    ativo: status === 'DISPONIVEL',
    destaque: false,
    oportunidade: false,
    exclusivo: false,
    lancamento: false,
    publicarSite: false,
    valorVenda: valorDepois(item, 'Venda'),
    valorLocacao: valorDepois(item, 'Locação'),
    valorCondominio: valorDepois(item, 'Condomínio'),
    valorIptu: valorDepois(item, 'IPTU'),
    iptuPeriodo: 'ANUAL',
    dormitorios: Math.max(detalhes.dormitorios, detalhes.suites),
    suites: detalhes.suites,
    vagas: detalhes.vagas,
    areaUtil: detalhes.areaUtil,
    areaTotal: detalhes.areaTotal,
    areaConstruida: detalhes.areaConstruida,
    areaTerreno: detalhes.areaTerreno,
    logradouro: endereco.logradouro,
    numero: endereco.numero,
    complemento: endereco.complemento,
    bairro: endereco.bairro,
    cidade: null,
    uf: null,
    empreendimentoNome: endereco.empreendimento,
    unidadeIdentificacao: item.referencia,
    proprietarioNome: 'Nao informado - importacao Kenlo',
    dadosKenlo: { midiaOrigem: 'Kenlo Imob', statusCadastro: item.status },
    observacoesInternas: `Importado da listagem completa do Kenlo. Status original: ${item.status}. Dados detalhados pendentes de revisao.`,
    exibirEnderecoCompleto: false
  }, { parcial: false });
}

async function administrador() {
  const result = await pool.query(
    `SELECT id, nome, perfil FROM usuarios
     WHERE perfil = 'admin' AND COALESCE(ativo, TRUE) = TRUE
     ORDER BY created_at ASC LIMIT 1`
  );
  if (!result.rows[0]) throw new Error('Nenhum administrador ativo encontrado.');
  return result.rows[0];
}

async function referenciasExistentes(refs) {
  const result = await pool.query(
    `SELECT UPPER(referencia_externa) AS referencia
     FROM imoveis
     WHERE deleted_at IS NULL AND UPPER(referencia_externa) = ANY($1::text[])`,
    [refs]
  );
  return new Set(result.rows.map((row) => row.referencia));
}

async function salvarCapa(imovelId, item, usuarioId) {
  if (!item.foto) return 0;
  const objectKey = `kenlo/${item.referencia.toLowerCase()}/imagem/${crypto.createHash('sha1').update(item.foto).digest('hex')}`;
  await pool.query(
    `INSERT INTO imovel_midias
      (imovel_id, tipo, bucket, object_key, url, url_web, url_thumb, mime_type,
       extensao, processamento, legenda, alt_text, ordem, capa, publica, created_by)
     VALUES ($1, 'IMAGEM', 'external-kenlo', $2, $3, $3, $3, 'image/jpeg',
             'jpg', 'COMPLETO', $4, $4, 0, TRUE, FALSE, $5)
     ON CONFLICT DO NOTHING`,
    [imovelId, objectKey, item.foto, `Foto do imovel ${item.referencia}`, usuarioId]
  );
  await imoveisService.recalcularScores(imovelId);
  return 1;
}

function resumoStatus(itens) {
  return itens.reduce((acc, item) => {
    acc[item.status] = (acc[item.status] || 0) + 1;
    return acc;
  }, {});
}

async function conferir(itens) {
  const existentes = await referenciasExistentes(itens.map(referencia));
  const ausentes = itens.filter((item) => !existentes.has(item.referencia));
  return { existentes, ausentes, statuses: resumoStatus(ausentes) };
}

async function aplicar(itens) {
  const usuario = await administrador();
  const conferencia = await conferir(itens);
  const resultado = { criados: 0, ignorados: itens.length - conferencia.ausentes.length, fotos: 0, erros: [] };

  for (const item of conferencia.ausentes) {
    try {
      const dados = mapear(item);
      const id = await imoveisService.criar({ dados, caracteristicas: [], usuario });
      resultado.fotos += await salvarCapa(id, item, usuario.id);
      resultado.criados += 1;
    } catch (error) {
      resultado.erros.push({ referencia: item.referencia, erro: error.message, detalhes: error.detalhes || null });
      console.error(`[${item.referencia}]`, error.message, error.detalhes || '');
    }
  }

  const final = await conferir(itens);
  return { ...resultado, aindaAusentes: final.ausentes.map(referencia) };
}

async function rota(req, res) {
  if (req.method === 'GET' && req.url === '/') {
    responder(res, 200, `<h1>Importar carteira completa do Kenlo</h1>
      <p>Cole abaixo a captura gerada na sessao autenticada. Esta etapa apenas confere os dados.</p>
      <form method="post" action="/preview"><textarea id="payload" name="payload" required></textarea><p><button type="submit">Conferir importacao</button></p></form>`);
    return;
  }

  if (req.method === 'POST' && req.url === '/preview') {
    const body = await lerBody(req);
    const params = new URLSearchParams(body);
    captura = validarCaptura(JSON.parse(params.get('payload') || 'null'));
    const conferencia = await conferir(captura);
    const stats = Object.entries(conferencia.statuses).map(([status, total]) => `<li>${escaparHtml(status)}: <strong>${total}</strong></li>`).join('');
    responder(res, 200, `<h1>Conferencia concluida</h1>
      <div class="stats"><div class="stat"><strong>613</strong>no Kenlo</div><div class="stat"><strong>${conferencia.existentes.size}</strong>ja existentes</div><div class="stat"><strong>${conferencia.ausentes.length}</strong>ausentes</div></div>
      <p>Ausentes por status:</p><ul>${stats}</ul>
      <p>Nenhum dado foi gravado. Os novos registros ficarao <strong>fora do site publico</strong>.</p>
      <form method="post" action="/apply"><button class="danger" type="submit">Importar somente os ausentes</button></form>`);
    return;
  }

  if (req.method === 'POST' && req.url === '/apply') {
    if (!captura) throw new Error('Capture e confira a listagem antes de importar.');
    const resultado = await aplicar(captura);
    const erros = resultado.erros.length
      ? `<h2 class="erro">Erros</h2><pre>${escaparHtml(JSON.stringify(resultado.erros, null, 2))}</pre>`
      : '<p class="ok"><strong>Importacao sem erros.</strong></p>';
    responder(res, resultado.erros.length ? 500 : 200, `<h1>Importacao concluida</h1>
      <div class="stats"><div class="stat"><strong>${resultado.criados}</strong>criados</div><div class="stat"><strong>${resultado.ignorados}</strong>ja existentes</div><div class="stat"><strong>${resultado.fotos}</strong>capas</div><div class="stat"><strong>${resultado.aindaAusentes.length}</strong>ainda ausentes</div></div>${erros}`);
    return;
  }

  responder(res, 404, '<h1>Pagina nao encontrada</h1>');
}

const server = http.createServer((req, res) => {
  rota(req, res).catch((error) => {
    console.error(error);
    responder(res, 500, `<h1 class="erro">Falha</h1><p>${escaparHtml(error.message)}</p>`);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Importador Kenlo aguardando em http://${HOST}:${PORT}`);
});

async function encerrar() {
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}

process.on('SIGINT', encerrar);
process.on('SIGTERM', encerrar);
