// =========================================================
// Integração TomTicket — Edge Function separada da "api"
// =========================================================
// Recebe o webhook do TomTicket (chamado criado/atualizado), busca os
// detalhes completos do chamado na API deles e, se um técnico já
// cadastrado como Atendente aqui foi associado, cria o atendimento
// correspondente automaticamente.
//
// Configuração necessária (Project Settings → Edge Functions → Secrets):
//   TOMTICKET_API_TOKEN     — token Bearer da API do TomTicket (Configurações
//                             da Conta → API, no painel do TomTicket)
//   TOMTICKET_WEBHOOK_SECRET— um valor secreto escolhido por você, colocado
//                             na query string da URL configurada no TomTicket
//   TOMTICKET_EMPRESA_ID    — id da empresa (tabela empresas) que recebe
//                             os atendimentos importados
//
// Configuração no TomTicket (Administração → Configurações da Conta →
// Webhook): URL de destino = URL desta function depois de publicada, com
// "?secret=<TOMTICKET_WEBHOOK_SECRET>" no final (ex:
// https://xxx.supabase.co/functions/v1/tomticket-webhook?secret=abc123).
// O campo "Segredo da Aplicação" da tela deles pode ficar com qualquer
// valor — não é usado por essa function (não foi possível confirmar o
// esquema de assinatura real que eles usam nesse campo).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const TOMTICKET_API_TOKEN = Deno.env.get('TOMTICKET_API_TOKEN') || '';
const TOMTICKET_WEBHOOK_SECRET = Deno.env.get('TOMTICKET_WEBHOOK_SECRET') || '';
const TOMTICKET_EMPRESA_ID = Deno.env.get('TOMTICKET_EMPRESA_ID') || '';
const TIPO_TOMTICKET = 'TOMTICKET';

const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function gerarId(): string {
  return 'id-' + crypto.randomUUID().slice(0, 10);
}

// escapa texto vindo de fora (assunto/mensagem do chamado) antes de colocar
// dentro do campo Detalhe (que o app trata como HTML) — evita que um
// conteúdo malicioso vire HTML/script executável na tela de atendimento
function escaparHtml(texto: string): string {
  return String(texto || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Não foi possível reproduzir o esquema de assinatura HMAC que o TomTicket
// usa no header X-Hub-Signature (testado HMAC-SHA1/SHA256/MD5 com a chave em
// texto, hex e base64, em várias ordens — nada bateu com o valor recebido de
// verdade). Em vez disso, a autenticação é feita por um segredo colocado
// direto na query string da "URL de Destino" configurada no TomTicket
// (?secret=...) — só quem sabe essa URL completa consegue chamar a function.
function urlAutorizada(req: Request): boolean {
  if (!TOMTICKET_WEBHOOK_SECRET) return false;
  const url = new URL(req.url);
  return url.searchParams.get('secret') === TOMTICKET_WEBHOOK_SECRET;
}

async function buscarChamadoTomTicket(ticketId: string): Promise<any> {
  const resp = await fetch(`https://api.tomticket.com/v2.0/ticket/detail?ticket_id=${encodeURIComponent(ticketId)}`, {
    headers: { 'Authorization': `Bearer ${TOMTICKET_API_TOKEN}` },
  });
  const json = await resp.json();
  if (!resp.ok || json.error) throw new Error(json.message || `TomTicket respondeu ${resp.status} ao consultar o chamado ${ticketId}`);
  return json.data;
}

async function registrarErro(ticketId: string, motivo: string, payload: any) {
  console.error('[tomticket]', motivo, '— chamado', ticketId);
  await db.from('tomticket_erros').insert({ id: gerarId(), ticket_id: ticketId, motivo, payload });
}

async function garantirTipoTomTicket(): Promise<string> {
  const { data: existente } = await db.from('tipos').select('id').ilike('nome', TIPO_TOMTICKET).maybeSingle();
  if (existente) return existente.id;
  const id = gerarId();
  await db.from('tipos').insert({ id, nome: TIPO_TOMTICKET });
  return id;
}

async function processarChamado(ticketId: string) {
  if (!TOMTICKET_API_TOKEN || !TOMTICKET_EMPRESA_ID) {
    console.error('[tomticket] TOMTICKET_API_TOKEN ou TOMTICKET_EMPRESA_ID não configurados — não é possível processar.');
    return;
  }

  // idempotência: chamado "updated" dispara de novo a cada edição — se
  // esse chamado já virou um atendimento antes, não faz nada
  const { data: jaImportado } = await db.from('atendimentos').select('id').eq('tomticket_id', ticketId).maybeSingle();
  if (jaImportado) return;

  const chamado = await buscarChamadoTomTicket(ticketId);
  const operatorNome = chamado?.operator?.name ? String(chamado.operator.name).trim() : '';
  // sem técnico associado ainda — normal (chamado recém-criado, por
  // exemplo); a gente só age quando esse campo aparecer preenchido
  if (!operatorNome) return;

  const clienteNome = chamado?.customer?.organization?.name ? String(chamado.customer.organization.name).trim() : '';
  const usuarioNome = chamado?.customer?.name ? String(chamado.customer.name).trim() : '';

  const [{ data: clienteEncontrado }, { data: atendenteEncontrado }] = await Promise.all([
    clienteNome
      ? db.from('clientes').select('*').eq('empresa_id', TOMTICKET_EMPRESA_ID).ilike('nome', clienteNome).maybeSingle()
      : Promise.resolve({ data: null }),
    db.from('contas').select('*').eq('perfil', 'ATENDENTE').ilike('nome', operatorNome).maybeSingle(),
  ]);

  if (!clienteEncontrado || !atendenteEncontrado) {
    const partes = [];
    if (!clienteEncontrado) partes.push(`cliente "${clienteNome || '(vazio)'}"`);
    if (!atendenteEncontrado) partes.push(`atendente "${operatorNome}"`);
    await registrarErro(ticketId, `Não encontrei ${partes.join(' e ')} cadastrado(s) no sistema — atendimento não foi criado.`, chamado);
    return;
  }

  await garantirTipoTomTicket(); // garante que o Tipo "TOMTICKET" existe, pra aparecer certo nos filtros/relatórios

  const agora = new Date();
  const data = agora.toISOString().slice(0, 10);
  const mes = `${String(agora.getMonth() + 1).padStart(2, '0')}/${agora.getFullYear()}`;
  const detalhe = `<b>${escaparHtml(chamado.subject || '')}</b><br>${escaparHtml(chamado.message || '')}`
    + `<br><br><i>Importado automaticamente do TomTicket — protocolo ${escaparHtml(String(chamado.protocol ?? ''))}</i>`;

  const { error } = await db.from('atendimentos').insert({
    id: gerarId(), data, mes,
    cliente: clienteEncontrado.nome, usuario: usuarioNome || clienteEncontrado.nome,
    tipo: TIPO_TOMTICKET, modulo: '', submodulo: '',
    atendente: atendenteEncontrado.nome, detalhe,
    hi: '00:00', inter: '00:00', hf: '00:00', qtd: 0, vha: 0, total_ananda: 0, vhr: 0, total_real: 0,
    status: 'PENDENTE', anexo_url: '', anexo_nome: '', solucao: '', data_prevista: '',
    atendente2: '', horas_atendente2: 0, vha2: 0, total_ananda2: 0,
    empresa_id: TOMTICKET_EMPRESA_ID, tomticket_id: ticketId,
  });
  if (error) await registrarErro(ticketId, `Erro ao gravar o atendimento: ${error.message}`, chamado);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  // responde 200 em qualquer método que não seja POST (ex: o TomTicket testa
  // a URL com um GET antes de aceitar salvar a configuração de Webhook) —
  // só a chamada POST de verdade é processada como evento
  if (req.method !== 'POST') return jsonResponse({ ok: true });

  if (!urlAutorizada(req)) {
    console.error('[tomticket] URL sem o ?secret= correto ou TOMTICKET_WEBHOOK_SECRET não configurado — requisição recusada.');
    return jsonResponse({ erro: 'não autorizado' }, 401);
  }

  const corpoTexto = await req.text();

  // o TomTicket manda um POST sem corpo (content-length 0) como checagem de
  // disponibilidade da URL antes de aceitar salvar a configuração — não é um
  // evento de verdade
  if (!corpoTexto) return jsonResponse({ ok: true });

  let evento: any;
  try {
    evento = JSON.parse(corpoTexto);
  } catch {
    return jsonResponse({ ok: true }); // corpo que não é JSON — ignora sem quebrar
  }

  // handshake de validação da própria tela de configuração do Webhook —
  // só confirma o recebimento; o código em si é colado manualmente na
  // tela do TomTicket (campo "Código de Validação")
  if (evento.type === 'account' && evento.action === 'validation') {
    console.log('[tomticket] Código de validação recebido:', evento.id);
    return jsonResponse({ ok: true });
  }

  if (evento.type !== 'ticket' || !['created', 'updated'].includes(evento.action)) {
    return jsonResponse({ ok: true }); // evento que não nos interessa (ex: type "customer")
  }

  try {
    await processarChamado(evento.id);
  } catch (e: any) {
    // devolve 200 mesmo assim — o TomTicket desativa o webhook depois de
    // falhas repetidas, e o erro real já foi registrado em tomticket_erros
    // (ou no log da function, se o erro foi antes de conseguir gravar)
    console.error('[tomticket] Erro ao processar chamado', evento.id, e && e.message);
  }
  return jsonResponse({ ok: true });
});
