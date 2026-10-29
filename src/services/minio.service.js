const { Client } = require('minio');
const fs = require('fs/promises');
const path = require('path');
const { HttpError } = require('../utils/http-error');

/**
 * Serviço dedicado ao MinIO.
 *
 * Regras do projeto:
 *   - AccessKey/SecretKey vêm EXCLUSIVAMENTE de variáveis de ambiente.
 *   - O navegador nunca fala com o MinIO: o front envia multipart para a
 *     API e a API grava no bucket.
 *   - A chave do objeto nunca é o nome original do arquivo.
 */

const config = {
  storageMode: String(process.env.MEDIA_STORAGE || 'minio').toLowerCase(),
  endPoint: process.env.MINIO_ENDPOINT || 'minio.ensuo.com.br',
  port: Number(process.env.MINIO_PORT || 443),
  useSSL: String(process.env.MINIO_USE_SSL ?? 'true').toLowerCase() !== 'false',
  bucket: process.env.MINIO_BUCKET || 'empreendimentos',
  publicBaseUrl: (process.env.MINIO_PUBLIC_BASE_URL || 'https://minio.ensuo.com.br').replace(/\/+$/, ''),
  prefixo: (process.env.MINIO_PREFIXO_IMOVEIS || 'imoveis').replace(/^\/+|\/+$/g, '')
};

const localRoot = path.join(__dirname, '..', '..', 'uploads', 'minio-local', config.bucket);

function usandoArmazenamentoLocal() {
  return config.storageMode === 'local';
}

let clienteCache = null;

function credenciaisConfiguradas() {
  return usandoArmazenamentoLocal() || !!(process.env.MINIO_ACCESS_KEY && process.env.MINIO_SECRET_KEY);
}

function obterCliente() {
  if (!credenciaisConfiguradas()) {
    throw new HttpError(
      503,
      'Armazenamento de mídias indisponível: MINIO_ACCESS_KEY/MINIO_SECRET_KEY não configuradas no ambiente da API.'
    );
  }

  if (clienteCache) return clienteCache;

  clienteCache = new Client({
    endPoint: config.endPoint,
    port: config.port,
    useSSL: config.useSSL,
    accessKey: process.env.MINIO_ACCESS_KEY,
    secretKey: process.env.MINIO_SECRET_KEY
  });

  return clienteCache;
}

/**
 * imoveis/{imovelId}/{mediaId}/original.ext
 * imoveis/{imovelId}/{mediaId}/large.webp
 * imoveis/{imovelId}/{mediaId}/thumb.webp
 */
function montarObjectKey(imovelId, mediaId, nomeArquivo) {
  const seguro = String(nomeArquivo).replace(/[^a-zA-Z0-9._-]/g, '');
  return `${config.prefixo}/${imovelId}/${mediaId}/${seguro}`;
}

function montarUrlPublica(objectKey) {
  if (!objectKey) return null;

  const caminho = objectKey.split('/').map(encodeURIComponent).join('/');

  if (usandoArmazenamentoLocal()) {
    const apiUrl = (process.env.PUBLIC_API_URL || 'http://localhost:4000').replace(/\/+$/, '');
    return `${apiUrl}/uploads/minio-local/${encodeURIComponent(config.bucket)}/${caminho}`;
  }

  return `${config.publicBaseUrl}/${config.bucket}/${caminho}`;
}

async function enviarObjeto(objectKey, buffer, contentType, metadados = {}) {
  if (usandoArmazenamentoLocal()) {
    const destino = path.join(localRoot, ...objectKey.split('/'));
    await fs.mkdir(path.dirname(destino), { recursive: true });
    await fs.writeFile(destino, buffer);
    return { objectKey, url: montarUrlPublica(objectKey), tamanho: buffer.length, contentType };
  }

  const cliente = obterCliente();

  await cliente.putObject(config.bucket, objectKey, buffer, buffer.length, {
    'Content-Type': contentType,
    'Cache-Control': 'public, max-age=31536000, immutable',
    ...metadados
  });

  return {
    objectKey,
    url: montarUrlPublica(objectKey),
    tamanho: buffer.length,
    contentType
  };
}

/**
 * Remoção best-effort de objeto órfão (upload OK, banco falhou).
 * Nunca lança: o erro original do chamador é mais importante, mas a falha
 * de limpeza é registrada para não sumir silenciosamente.
 */
async function removerObjetoSilencioso(objectKey) {
  if (!objectKey) return false;

  try {
    if (usandoArmazenamentoLocal()) {
      await fs.rm(path.join(localRoot, ...objectKey.split('/')), { force: true });
      return true;
    }
    await obterCliente().removeObject(config.bucket, objectKey);
    return true;
  } catch (error) {
    console.error(
      `[minio] Falha ao remover objeto órfão "${objectKey}". Remova manualmente. Causa:`,
      error.message
    );
    return false;
  }
}

async function removerObjetos(objectKeys = []) {
  const chaves = objectKeys.filter(Boolean);
  if (!chaves.length) return { removidos: 0, falhas: [] };

  const cliente = usandoArmazenamentoLocal() ? null : obterCliente();
  const falhas = [];
  let removidos = 0;

  for (const chave of chaves) {
    try {
      if (usandoArmazenamentoLocal()) {
        await fs.rm(path.join(localRoot, ...chave.split('/')), { force: true });
      } else {
        await cliente.removeObject(config.bucket, chave);
      }
      removidos += 1;
    } catch (error) {
      falhas.push({ objectKey: chave, erro: error.message });
    }
  }

  return { removidos, falhas };
}

/** Verificação de conectividade — não cria nem altera bucket/políticas. */
async function testarConexao() {
  if (usandoArmazenamentoLocal()) {
    await fs.mkdir(localRoot, { recursive: true });
    await fs.access(localRoot);
    return { ok: true, bucket: config.bucket, endpoint: 'filesystem-local', useSSL: false, publicBaseUrl: (process.env.PUBLIC_API_URL || 'http://localhost:4000') };
  }

  const cliente = obterCliente();

  const existe = await cliente.bucketExists(config.bucket);

  if (!existe) {
    throw new HttpError(
      503,
      `Bucket "${config.bucket}" não encontrado no MinIO. Verifique MINIO_BUCKET.`
    );
  }

  return {
    ok: true,
    bucket: config.bucket,
    endpoint: config.endPoint,
    useSSL: config.useSSL,
    publicBaseUrl: config.publicBaseUrl
  };
}

function resumoConfiguracao() {
  return {
    endpoint: config.endPoint,
    port: config.port,
    useSSL: config.useSSL,
    bucket: config.bucket,
    publicBaseUrl: config.publicBaseUrl,
    prefixo: config.prefixo,
    storageMode: config.storageMode,
    credenciaisConfiguradas: credenciaisConfiguradas()
  };
}

module.exports = {
  config,
  credenciaisConfiguradas,
  montarObjectKey,
  montarUrlPublica,
  enviarObjeto,
  removerObjetoSilencioso,
  removerObjetos,
  testarConexao,
  resumoConfiguracao
};
