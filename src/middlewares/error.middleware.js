const { HttpError } = require('../utils/http-error');

/**
 * Tratamento central de erros.
 * Regra do projeto: erro NUNCA vira "[]" silencioso — ele é logado no
 * servidor e devolvido com status e mensagem compreensíveis.
 */
// eslint-disable-next-line no-unused-vars
function errorMiddleware(error, req, res, next) {
  if (res.headersSent) {
    return next(error);
  }

  if (error instanceof HttpError) {
    if (error.status >= 500) {
      console.error(`[${req.method} ${req.originalUrl}]`, error);
    }

    return res.status(error.status).json({
      message: error.message,
      detalhes: error.detalhes || undefined
    });
  }

  // Erros conhecidos do multer (upload)
  if (error && error.name === 'MulterError') {
    const mensagens = {
      LIMIT_FILE_SIZE: 'Arquivo maior que o limite permitido.',
      LIMIT_FILE_COUNT: 'Quantidade de arquivos acima do limite permitido.',
      LIMIT_UNEXPECTED_FILE: 'Campo de arquivo inesperado.'
    };

    return res.status(400).json({
      message: mensagens[error.code] || 'Falha no upload do arquivo.',
      codigo: error.code
    });
  }

  // Erros do PostgreSQL que representam entrada inválida do usuário.
  if (error && error.code) {
    const mapaPg = {
      '23505': { status: 409, message: 'Já existe um registro com esses dados.' },
      '23503': { status: 400, message: 'Referência inválida: registro relacionado não encontrado.' },
      '23514': { status: 400, message: 'Valor fora do domínio permitido para o campo.' },
      '22001': { status: 400, message: 'Algum campo excedeu o tamanho máximo permitido.' },
      '22P02': { status: 400, message: 'Formato de identificador inválido.' },
      '42P01': {
        status: 503,
        message: 'Estrutura de banco ausente. Execute os scripts pendentes da pasta sql/ da API.'
      }
    };

    const mapeado = mapaPg[error.code];

    if (mapeado) {
      if (mapeado.status >= 500) {
        console.error(`[${req.method} ${req.originalUrl}]`, error);
      }

      return res.status(mapeado.status).json({
        message: mapeado.message,
        codigo: error.code,
        detalhe: error.detail || undefined
      });
    }
  }

  console.error(`[${req.method} ${req.originalUrl}] Erro não tratado:`, error);

  return res.status(500).json({
    message: 'Erro interno ao processar a requisição.'
  });
}

function notFoundMiddleware(req, res) {
  return res.status(404).json({
    message: `Rota não encontrada: ${req.method} ${req.originalUrl}`
  });
}

module.exports = { errorMiddleware, notFoundMiddleware };
