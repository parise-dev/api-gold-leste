/**
 * Validação offline dos geradores de feed dos portais.
 *
 * NÃO acessa banco, NÃO acessa MinIO, NÃO chama nenhum portal.
 * Monta um imóvel fictício em memória e roda validate + generateFeed de
 * cada adapter, imprimindo o XML resultante.
 *
 * Uso:  node scripts/validar-feeds-exemplo.js
 *       node scripts/validar-feeds-exemplo.js --xml   (imprime o XML completo)
 */

const { listarAdapters } = require('../src/integrations/portals/registry');

const imovel = {
  id: '11111111-1111-4111-8111-111111111111',
  codigo: 'GL000123',
  referencia_externa: 'REF-123',
  slug: 'apartamento-2-dormitorios-vila-matilde-sao-paulo-sp-gl000123',
  titulo: 'Apartamento 2 dormitórios com suíte na Vila Matilde',
  descricao:
    'Apartamento reformado com 2 dormitórios, sendo 1 suíte, sala ampla com varanda, ' +
    'cozinha planejada e 1 vaga coberta. Condomínio com portaria 24h, piscina e salão de festas. ' +
    'Próximo ao metrô, comércio e escolas. Aceita financiamento bancário e FGTS.',
  descricao_resumida: 'Apartamento reformado, 2 dormitórios, 1 suíte e 1 vaga.',
  finalidade: 'VENDA',
  tipo: 'APARTAMENTO',
  situacao: 'USADO',
  status: 'DISPONIVEL',
  destaque: true,
  lancamento: false,
  exibir_endereco_completo: false,
  valor_venda: 560000,
  valor_locacao: null,
  valor_condominio: 620,
  valor_iptu: 1800,
  iptu_periodo: 'ANUAL',
  dormitorios: 2,
  suites: 1,
  banheiros: 2,
  vagas: 1,
  area_util: 68,
  area_total: 78,
  andar: 5,
  total_andares: 12,
  ano_construcao: 2012,
  mobiliado: false,
  elevador: true,
  pet_friendly: true,
  cep: '03510-000',
  logradouro: 'Rua Exemplo',
  numero: '250',
  complemento: 'Apto 52',
  bairro: 'Vila Matilde',
  cidade: 'São Paulo',
  uf: 'SP',
  latitude: -23.5325,
  longitude: -46.5158,
  updated_at: new Date()
};

const midias = Array.from({ length: 6 }, (_, indice) => ({
  id: `midia-${indice}`,
  tipo: 'IMAGEM',
  publica: true,
  capa: indice === 0,
  ordem: indice,
  legenda: indice === 0 ? 'Sala de estar' : `Ambiente ${indice + 1}`,
  url: `https://minio.ensuo.com.br/empreendimentos/imoveis/${imovel.id}/midia-${indice}/original.jpg`,
  url_web: `https://minio.ensuo.com.br/empreendimentos/imoveis/${imovel.id}/midia-${indice}/large.webp`,
  updated_at: new Date(),
  created_at: new Date()
}));

midias.push({
  id: 'video-1',
  tipo: 'VIDEO',
  publica: true,
  capa: false,
  ordem: 99,
  url_externa: 'https://www.youtube.com/watch?v=exemplo123',
  url: 'https://www.youtube.com/watch?v=exemplo123'
});

const caracteristicas = [
  { slug: 'piscina', label: 'Piscina', grupo: 'LAZER' },
  { slug: 'academia', label: 'Academia', grupo: 'LAZER' },
  { slug: 'portaria-24h', label: 'Portaria 24h', grupo: 'SEGURANCA' },
  { slug: 'varanda', label: 'Varanda', grupo: 'IMOVEL' },
  { slug: 'cozinha-planejada', label: 'Cozinha planejada', grupo: 'IMOVEL' }
];

const integracao = {
  contato_nome: 'Gold Leste Imóveis',
  contato_email: 'contato@gold-leste.online',
  contato_telefone: '11-3000-0000',
  contato_site: 'https://gold-leste.online',
  contato_cidade: 'São Paulo',
  contato_uf: 'SP',
  contato_bairro: 'Tatuapé',
  contato_endereco: 'Av. Exemplo, 1000',
  contato_cep: '03072-000',
  feed_habilitado: true,
  feed_token: 'a'.repeat(48),
  config: {}
};

/**
 * Verificação de boa formação com pilha de tags.
 * Ignora declaração, comentários e o conteúdo de blocos CDATA.
 */
function verificarBoaFormacao(xml) {
  const semCdata = xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, 'CDATA');
  const semDeclaracao = semCdata.replace(/<\?[\s\S]*?\?>/g, '').replace(/<!--[\s\S]*?-->/g, '');

  const pilha = [];
  let total = 0;

  const regex = /<(\/?)([A-Za-z_][\w.:-]*)([^>]*?)(\/?)>/g;
  let match;

  while ((match = regex.exec(semDeclaracao)) !== null) {
    const [, fechamento, nome, , autoFechada] = match;

    if (fechamento) {
      const aberta = pilha.pop();

      if (aberta !== nome) {
        return { ok: false, mensagem: `</${nome}> não corresponde a <${aberta || 'nada'}>.` };
      }

      continue;
    }

    total += 1;

    if (!autoFechada) pilha.push(nome);
  }

  if (pilha.length) {
    return { ok: false, mensagem: `tags não fechadas: ${pilha.join(', ')}.` };
  }

  return { ok: true, totalTags: total };
}

async function main() {
  const mostrarXml = process.argv.includes('--xml');
  let falhas = 0;

  for (const adapter of listarAdapters()) {
    console.log('\n' + '='.repeat(70));
    console.log(`${adapter.nome}  [${adapter.slug}]  status=${adapter.statusImplementacao}`);
    console.log('='.repeat(70));

    const contexto = { imovel, midias, caracteristicas, integracao, tipoPublicacao: 'STANDARD' };

    const validacao = adapter.validateProperty(contexto);

    console.log(`validateProperty -> ok=${validacao.ok}`);

    for (const erro of validacao.erros || []) {
      console.log(`  ERRO   [${erro.campo}] ${erro.mensagem}`);
    }

    for (const aviso of validacao.avisos || []) {
      console.log(`  AVISO  [${aviso.campo}] ${aviso.mensagem}`);
    }

    if (!adapter.capacidades().feed) {
      console.log('generateFeed -> não suportado por este adapter (esperado).');
      continue;
    }

    if (!validacao.ok) {
      console.log('generateFeed -> pulado: imóvel de exemplo não passou na validação.');
      falhas += 1;
      continue;
    }

    const feed = await adapter.generateFeed({ integracao, itens: [contexto] });

    const linhas = feed.conteudo.split('\n').length;
    console.log(`generateFeed -> ${feed.conteudo.length} bytes, ${linhas} linhas.`);

    const checagem = verificarBoaFormacao(feed.conteudo);

    if (!checagem.ok) {
      console.log(`  ATENÇÃO: XML mal formado — ${checagem.mensagem}`);
      falhas += 1;
    } else {
      console.log(`  XML bem formado (${checagem.totalTags} elementos).`);
    }

    if (mostrarXml) {
      console.log('\n' + feed.conteudo);
    }
  }

  console.log('\n' + '='.repeat(70));
  console.log(falhas ? `Concluído com ${falhas} ponto(s) de atenção.` : 'Concluído sem falhas.');

  process.exitCode = falhas ? 1 : 0;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
