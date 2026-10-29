const crypto = require('crypto');
const pool = require('../config/db');

const minio = require('./minio.service');
const imagem = require('./imagem.service');
const midiasRepo = require('../repositories/imovel-midias.repository');
const logsRepo = require('../repositories/imovel-logs.repository');
const { badRequest, HttpError } = require('../utils/http-error');
const { limparTexto } = require('../utils/sanitize');

const EXTENSAO_POR_MIME = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp'
};

/**
 * Envia uma imagem para o MinIO e grava a mídia.
 *
 * Ordem intencional:
 *   1. valida o conteúdo binário (não confia no MIME do navegador);
 *   2. sobe original + derivadas;
 *   3. grava no banco.
 * Se (3) falhar, os objetos de (2) são removidos para não deixar órfãos.
 * Se (2) falhar, nada é gravado no banco.
 */
async function enviarImagem({ imovelId, arquivo, usuario, legenda, altText }) {
  if (!arquivo || !arquivo.buffer || !arquivo.buffer.length) {
    throw badRequest('Arquivo de imagem vazio.');
  }

  const validacao = await imagem.validarImagem(arquivo.buffer, arquivo.mimetype);

  if (!validacao.ok) {
    throw badRequest(validacao.mensagem);
  }

  const mediaId = crypto.randomUUID();
  const extensao = EXTENSAO_POR_MIME[arquivo.mimetype] || 'jpg';

  const chaveOriginal = minio.montarObjectKey(imovelId, mediaId, `original.${extensao}`);
  const chaveWeb = minio.montarObjectKey(imovelId, mediaId, 'large.webp');
  const chaveThumb = minio.montarObjectKey(imovelId, mediaId, 'thumb.webp');

  const enviados = [];

  let derivadas = { web: null, thumb: null, indisponivel: true, motivo: null };
  let processamento = 'ORIGINAL_ONLY';
  let processamentoErro = null;

  try {
    const original = await minio.enviarObjeto(
      chaveOriginal,
      arquivo.buffer,
      arquivo.mimetype,
      { 'x-amz-meta-imovel': imovelId }
    );

    enviados.push(chaveOriginal);

    try {
      derivadas = await imagem.gerarDerivadas(arquivo.buffer);
    } catch (error) {
      // Falha de processamento não invalida o upload, mas é registrada.
      processamento = 'ERRO';
      processamentoErro = `Falha ao gerar versões otimizadas: ${error.message}`;
      console.error('[midias] Falha ao gerar derivadas:', error);
    }

    if (derivadas.web && derivadas.thumb) {
      await minio.enviarObjeto(chaveWeb, derivadas.web, 'image/webp', {
        'x-amz-meta-imovel': imovelId
      });
      enviados.push(chaveWeb);

      await minio.enviarObjeto(chaveThumb, derivadas.thumb, 'image/webp', {
        'x-amz-meta-imovel': imovelId
      });
      enviados.push(chaveThumb);

      processamento = 'COMPLETO';
    } else if (derivadas.indisponivel && processamento !== 'ERRO') {
      processamento = 'ORIGINAL_ONLY';
      processamentoErro = derivadas.motivo
        ? `Otimização indisponível neste servidor: ${derivadas.motivo}`
        : 'Otimização de imagem indisponível neste servidor (sharp não carregado).';
    }

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const ordem = await midiasRepo.proximaOrdem(imovelId, client);
      const jaTemCapa = await midiasRepo.existeCapa(imovelId, client);

      const registro = await midiasRepo.inserir(
        {
          id: mediaId,
          imovel_id: imovelId,
          tipo: 'IMAGEM',
          bucket: minio.config.bucket,
          object_key: chaveOriginal,
          object_key_web: processamento === 'COMPLETO' ? chaveWeb : null,
          object_key_thumb: processamento === 'COMPLETO' ? chaveThumb : null,
          url: original.url,
          url_web: processamento === 'COMPLETO' ? minio.montarUrlPublica(chaveWeb) : original.url,
          url_thumb: processamento === 'COMPLETO' ? minio.montarUrlPublica(chaveThumb) : original.url,
          mime_type: arquivo.mimetype,
          extensao,
          tamanho_bytes: arquivo.size || arquivo.buffer.length,
          largura: validacao.largura || null,
          altura: validacao.altura || null,
          processamento,
          processamento_erro: processamentoErro,
          legenda: limparTexto(legenda, 160),
          alt_text: limparTexto(altText, 200),
          ordem,
          capa: !jaTemCapa,
          publica: true,
          created_by: usuario?.id || null
        },
        client
      );

      await logsRepo.registrar(
        {
          imovelId,
          usuario,
          acao: 'MIDIA',
          resumo: `Foto adicionada (${arquivo.originalname}).`
        },
        client
      );

      await client.query('COMMIT');

      return registro;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    // Objeto órfão no MinIO: remove o que subiu antes de propagar o erro.
    for (const chave of enviados) {
      await minio.removerObjetoSilencioso(chave);
    }

    if (error instanceof HttpError) throw error;

    throw new HttpError(
      502,
      `Falha ao enviar a imagem para o armazenamento: ${error.message}`
    );
  }
}

async function removerMidia({ imovelId, mediaId, usuario }) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const midia = await midiasRepo.buscarPorId(imovelId, mediaId, client);

    if (!midia) {
      throw new HttpError(404, 'Mídia não encontrada para este imóvel.');
    }

    await midiasRepo.remover(imovelId, mediaId, client);

    if (midia.capa) {
      await midiasRepo.promoverPrimeiraComoCapa(imovelId, client);
    }

    await logsRepo.registrar(
      { imovelId, usuario, acao: 'MIDIA', resumo: 'Foto removida.' },
      client
    );

    await client.query('COMMIT');

    // Só depois do commit apagamos do MinIO: se o banco recusar, o arquivo continua íntegro.
    const chaves = [midia.object_key, midia.object_key_web, midia.object_key_thumb];
    const resultado = await minio.removerObjetos(chaves);

    if (resultado.falhas.length) {
      console.error(
        '[midias] Objetos não removidos do MinIO após exclusão no banco:',
        resultado.falhas
      );
    }

    return { removida: true, objetosRemovidos: resultado.removidos, falhas: resultado.falhas };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function definirCapa({ imovelId, mediaId, usuario }) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const midia = await midiasRepo.buscarPorId(imovelId, mediaId, client);

    if (!midia) throw new HttpError(404, 'Mídia não encontrada para este imóvel.');

    const atualizada = await midiasRepo.definirCapa(imovelId, mediaId, client);

    await logsRepo.registrar(
      { imovelId, usuario, acao: 'MIDIA', resumo: 'Foto de capa alterada.' },
      client
    );

    await client.query('COMMIT');

    return atualizada;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function reordenar({ imovelId, ordemIds, usuario }) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const midias = await midiasRepo.listar(imovelId, {}, client);
    const idsValidos = new Set(midias.map((midia) => midia.id));

    const filtrados = (ordemIds || []).filter((id) => idsValidos.has(id));

    if (filtrados.length !== idsValidos.size) {
      throw badRequest('A lista de ordenação precisa conter exatamente as mídias do imóvel.');
    }

    const resultado = await midiasRepo.reordenar(imovelId, filtrados, client);

    await logsRepo.registrar(
      { imovelId, usuario, acao: 'MIDIA', resumo: 'Ordem das fotos atualizada.' },
      client
    );

    await client.query('COMMIT');

    return resultado;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Vídeo do YouTube / tour 360: URL externa, não vai para o MinIO. */
async function adicionarMidiaExterna({ imovelId, tipo, url, legenda, usuario }) {
  const tiposValidos = ['VIDEO', 'TOUR_360'];

  if (!tiposValidos.includes(tipo)) {
    throw badRequest(`Tipo de mídia externa inválido. Use: ${tiposValidos.join(', ')}.`);
  }

  let urlNormalizada;

  try {
    urlNormalizada = new URL(String(url));
  } catch (error) {
    throw badRequest('URL inválida.');
  }

  if (urlNormalizada.protocol !== 'https:') {
    throw badRequest('A URL precisa usar HTTPS.');
  }

  if (tipo === 'VIDEO') {
    const hostsYoutube = ['youtube.com', 'www.youtube.com', 'youtu.be', 'm.youtube.com'];

    if (!hostsYoutube.includes(urlNormalizada.hostname)) {
      throw badRequest(
        'Os portais (Grupo OLX, OLX e Chaves na Mão) aceitam apenas vídeos hospedados no YouTube.'
      );
    }
  }

  const ordem = await midiasRepo.proximaOrdem(imovelId);

  return midiasRepo.inserir({
    imovel_id: imovelId,
    tipo,
    bucket: minio.config.bucket,
    object_key: `externo/${tipo.toLowerCase()}/${crypto.randomUUID()}`,
    url: urlNormalizada.toString(),
    url_externa: urlNormalizada.toString(),
    processamento: 'COMPLETO',
    legenda: limparTexto(legenda, 160),
    ordem,
    capa: false,
    publica: true,
    created_by: usuario?.id || null
  });
}

module.exports = {
  enviarImagem,
  removerMidia,
  definirCapa,
  reordenar,
  adicionarMidiaExterna
};
