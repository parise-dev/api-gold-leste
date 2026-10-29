/**
 * Erro de aplicação com status HTTP.
 * Usado pelo middleware central (middlewares/error.middleware.js) para
 * devolver o código correto sem engolir a causa real.
 */
class HttpError extends Error {
  constructor(status, message, detalhes = null) {
    super(message);

    this.name = 'HttpError';
    this.status = status;
    this.detalhes = detalhes;
    this.expose = true;
  }
}

function badRequest(message, detalhes) {
  return new HttpError(400, message, detalhes);
}

function unauthorized(message = 'Usuário não autenticado') {
  return new HttpError(401, message);
}

function forbidden(message = 'Você não tem permissão para acessar este recurso') {
  return new HttpError(403, message);
}

function notFound(message = 'Registro não encontrado') {
  return new HttpError(404, message);
}

function conflict(message, detalhes) {
  return new HttpError(409, message, detalhes);
}

function unprocessable(message, detalhes) {
  return new HttpError(422, message, detalhes);
}

module.exports = {
  HttpError,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  unprocessable
};
