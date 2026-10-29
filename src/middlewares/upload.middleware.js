const multer = require('multer');
const { badRequest } = require('../utils/http-error');

// Whitelist rígida. Nada além disso chega ao MinIO.
const MIMES_PERMITIDOS = ['image/jpeg', 'image/png', 'image/webp'];
const EXTENSOES_PERMITIDAS = ['.jpg', '.jpeg', '.png', '.webp'];

const TAMANHO_MAXIMO_MB = Number(process.env.UPLOAD_IMAGEM_MAX_MB || 15);
const MAXIMO_ARQUIVOS = Number(process.env.UPLOAD_IMAGEM_MAX_ARQUIVOS || 20);

/**
 * Memória, não disco: o arquivo vai direto para o MinIO.
 * Nada de nova pasta local `uploads` para imóveis.
 */
const uploadImagensImovel = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: TAMANHO_MAXIMO_MB * 1024 * 1024,
    files: MAXIMO_ARQUIVOS
  },
  fileFilter: (req, file, cb) => {
    const nome = String(file.originalname || '').toLowerCase();
    const extensao = nome.includes('.') ? `.${nome.split('.').pop()}` : '';

    if (!MIMES_PERMITIDOS.includes(file.mimetype)) {
      return cb(badRequest(`Tipo de arquivo não permitido (${file.mimetype}). Envie JPEG, PNG ou WebP.`));
    }

    if (!EXTENSOES_PERMITIDAS.includes(extensao)) {
      return cb(badRequest(`Extensão não permitida (${extensao || 'sem extensão'}). Envie .jpg, .jpeg, .png ou .webp.`));
    }

    return cb(null, true);
  }
});

module.exports = {
  uploadImagensImovel,
  MIMES_PERMITIDOS,
  EXTENSOES_PERMITIDAS,
  TAMANHO_MAXIMO_MB,
  MAXIMO_ARQUIVOS
};
