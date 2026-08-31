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
//   TOMTICKET_WEBHOOK_SECRET— o mesmo valor colocado em "Segredo da
//                             Aplicação" na tela de Webhook do TomTicket
//   TOMTICKET_EMPRESA_ID    — id da empresa (tabela empresas) que recebe
//                             os atendimentos importados
//
// Configuração no TomTicket (Administração → Configurações da Conta →
// Webhook): URL de destino = URL desta function depois de publicada,
// Segredo da Aplicação = mesmo valor de TOMTICKET_WEBHOOK_SECRET.

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
  'Access-Control-Allow-Headers': 'content-type, x-hub-signature',
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

// TomTicket assina o corpo com HMAC-SHA1 usando o "Segredo da Aplicação"
// configurado na tela de Webhook, mandado no header X-Hub-Signature no
// formato "sha1=<hex>" — confere isso pra garantir que a chamada veio
// de verdade de lá, e não de qualquer um que descobrisse essa URL
async function assinaturaValida(corpoTexto: string, assinaturaRecebida: string | null): Promise<boolean> {
  if (!TOMTICKET_WEBHOOK_SECRET) return false;
  if (!assinaturaRecebida) return false;
  const chave = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(TOMTICKET_WEBHOOK_SECRET),
    { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']
  );
  const assinaturaBuffer = await crypto.subtle.sign('HMAC', chave, new TextEncoder().encode(corpoTexto));
  const assinaturaHex = Array.from(new Uint8Array(assinaturaBuffer)).map((b) => b.toString(16).padStart(2, '0')).join('');
  return assinaturaRecebida === `sha1=${assinaturaHex}`;
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
  if (req.method !== 'POST') return jsonResponse({ erro: 'método não suportado' }, 405);

  const corpoTexto = await req.text();

  if (!(await assinaturaValida(corpoTexto, req.headers.get('X-Hub-Signature')))) {
    console.error('[tomticket] Assinatura inválida ou TOMTICKET_WEBHOOK_SECRET não configurado — requisição recusada.');
    return jsonResponse({ erro: 'assinatura inválida' }, 401);
  }

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
