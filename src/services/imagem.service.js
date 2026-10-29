/**
 * Processamento de imagem (sharp).
 *
 * sharp é uma dependência nativa. Se por algum motivo ela não estiver
 * disponível no ambiente, NÃO fingimos que deu certo: a mídia é gravada
 * apenas com o original e marcada como `ORIGINAL_ONLY`, e a API devolve
 * esse aviso ao painel.
 */

let sharp = null;
let motivoIndisponivel = null;

try {
  // eslint-disable-next-line global-require
  sharp = require('sharp');
} catch (error) {
  motivoIndisponivel = error.message;
  console.warn(
    '[imagem] sharp indisponível. Mídias serão gravadas apenas com o arquivo original. Causa:',
    error.message
  );
}

// Resolução preservada o suficiente para portais imobiliários
// (Grupo OLX recomenda imagens grandes; limite de 7MB por foto).
const LARGURA_WEB = Number(process.env.IMAGEM_LARGURA_WEB || 1920);
const LARGURA_THUMB = Number(process.env.IMAGEM_LARGURA_THUMB || 480);
const QUALIDADE_WEB = Number(process.env.IMAGEM_QUALIDADE_WEB || 82);
const QUALIDADE_THUMB = Number(process.env.IMAGEM_QUALIDADE_THUMB || 72);

function disponivel() {
  return !!sharp;
}

async function lerMetadados(buffer) {
  if (!sharp) return { largura: null, altura: null };

  const meta = await sharp(buffer).metadata();

  return {
    largura: meta.width || null,
    altura: meta.height || null,
    formato: meta.format || null
  };
}

/**
 * Gera as derivadas web/thumb em WebP.
 * `withoutEnlargement` evita "esticar" fotos pequenas.
 */
async function gerarDerivadas(buffer) {
  if (!sharp) {
    return { web: null, thumb: null, indisponivel: true, motivo: motivoIndisponivel };
  }

  const [web, thumb] = await Promise.all([
    sharp(buffer)
      .rotate()
      .resize({ width: LARGURA_WEB, withoutEnlargement: true })
      .webp({ quality: QUALIDADE_WEB })
      .toBuffer(),

    sharp(buffer)
      .rotate()
      .resize({ width: LARGURA_THUMB, withoutEnlargement: true })
      .webp({ quality: QUALIDADE_THUMB })
      .toBuffer()
  ]);

  return { web, thumb, indisponivel: false, motivo: null };
}

/**
 * Confere que o buffer é mesmo uma imagem do formato declarado —
 * o MIME enviado pelo navegador não é confiável sozinho.
 */
async function validarImagem(buffer, mimeDeclarado) {
  if (!sharp) {
    // Sem sharp, checamos ao menos a assinatura binária do arquivo.
    return validarAssinatura(buffer, mimeDeclarado);
  }

  const meta = await sharp(buffer).metadata();

  const formatosEsperados = {
    'image/jpeg': ['jpeg', 'jpg'],
    'image/png': ['png'],
    'image/webp': ['webp']
  };

  const esperados = formatosEsperados[mimeDeclarado] || [];

  if (!meta.format || !esperados.includes(meta.format)) {
    return {
      ok: false,
      mensagem: `Conteúdo do arquivo (${meta.format || 'desconhecido'}) não corresponde ao tipo declarado (${mimeDeclarado}).`
    };
  }

  if (!meta.width || !meta.height) {
    return { ok: false, mensagem: 'Não foi possível ler as dimensões da imagem.' };
  }

  return { ok: true, largura: meta.width, altura: meta.height };
}

function validarAssinatura(buffer, mimeDeclarado) {
  if (!buffer || buffer.length < 12) {
    return { ok: false, mensagem: 'Arquivo vazio ou corrompido.' };
  }

  const assinaturas = {
    'image/jpeg': () => buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff,
    'image/png': () =>
      buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47,
    'image/webp': () =>
      buffer.slice(0, 4).toString('ascii') === 'RIFF' &&
      buffer.slice(8, 12).toString('ascii') === 'WEBP'
  };

  const verificar = assinaturas[mimeDeclarado];

  if (!verificar || !verificar()) {
    return {
      ok: false,
      mensagem: `Conteúdo do arquivo não corresponde ao tipo declarado (${mimeDeclarado}).`
    };
  }

  return { ok: true, largura: null, altura: null };
}

module.exports = {
  disponivel,
  motivoIndisponivel: () => motivoIndisponivel,
  lerMetadados,
  gerarDerivadas,
  validarImagem,
  LARGURA_WEB,
  LARGURA_THUMB
};
