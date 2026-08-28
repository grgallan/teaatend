// =========================================================
// Controle de Atendimentos — Edge Function (Supabase)
// Substitui o Code.gs (Google Apps Script) da versão anterior.
// Mesmo contrato de API: POST { action, ...payload } → { ok, ... }
// =========================================================
// Como implantar: veja o LEIA-ME.md na raiz do projeto.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';
import nodemailer from 'npm:nodemailer@6.9.14';

// URL, chave anônima e chave de serviço já ficam disponíveis automaticamente
// como variáveis de ambiente dentro de toda Edge Function do Supabase.
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
// e-mail automático via Gmail (opcional) — veja o LEIA-ME.md pra gerar a
// "senha de app". Não precisa de domínio próprio, usa sua conta @gmail.com mesmo.
const GMAIL_USER = Deno.env.get('GMAIL_USER');
const GMAIL_APP_PASSWORD = Deno.env.get('GMAIL_APP_PASSWORD');
const gmailTransporter = (GMAIL_USER && GMAIL_APP_PASSWORD)
  ? nodemailer.createTransport({ service: 'gmail', auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD } })
  : null;
// URL pública do site — usada como link de referência nos e-mails e nas notificações push. Troque se mudar.
const URL_APP = Deno.env.get('URL_APP') || 'https://grgallan.github.io/teaatend/';
// notificações push (opcional) — veja o LEIA-ME.md pra gerar essas chaves
const VAPID_PUBLIC_KEY = Deno.env.get('VAPID_PUBLIC_KEY') || '';
const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY') || '';
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') || 'mailto:contato@example.com';
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}
// notificações nativas do app Android (opcional) — veja o LEIA-ME.md pra gerar
// a chave de conta de serviço do Firebase
const FCM_SERVICE_ACCOUNT_JSON = Deno.env.get('FCM_SERVICE_ACCOUNT_JSON') || '';

const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
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

// tira as tags HTML do editor de texto rico (Detalhe/Solução) pra usar em
// e-mail de texto simples — sem isso, uma imagem colada aparece como um
// bloco gigante de texto (o base64 da própria imagem) em vez de sumir
function textoSimples(html: string | null | undefined, limite = 500): string {
  if (!html) return '';
  const semTags = html
    .replace(/<img[^>]*>/gi, '[imagem anexada]')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
  return semTags.length > limite ? semTags.slice(0, limite) + '…' : semTags;
}

function formatarDataHora(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function calcularQtd(hi: string, hf: string, inter?: string): number {
  const paraMin = (hhmm: string) => {
    const [h, m] = String(hhmm || '00:00').split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  };
  let hiMin = paraMin(hi);
  let hfMin = paraMin(hf);
  if (hfMin < hiMin) hfMin += 24 * 60;
  const interMin = paraMin(inter || '00:00');
  const totalMin = Math.max(0, (hfMin - hiMin) - interMin); // nunca fica negativo, mesmo se o intervalo for maior que o próprio período
  return totalMin / 60;
}

// conta ADMIN sempre tem acesso total; conta ATENDENTE marcada com o flag
// "eh_administrador" (Cadastros → Atendentes) passa a ter os mesmos
// privilégios de administrador do sistema, sem deixar de ser atendente
// (continua podendo ser escolhida como atendente nos chamados)
function ehAdminEfetivo(conta: any): boolean {
  return !!conta && (conta.perfil === 'ADMIN' || (conta.perfil === 'ATENDENTE' && !!conta.eh_administrador));
}

/* ---------- conversores linha (snake_case do banco) -> objeto da API (camelCase) ---------- */
function contaParaApi(c: any, comSenha = false, perfisAcessoIds: string[] = []) {
  const base: any = { id: c.id, nome: c.nome, login: c.login, perfil: c.perfil, clienteId: c.cliente_id, email: c.email || '', telefone: c.telefone || '', adminCliente: c.admin_cliente || false, ehAdministrador: c.eh_administrador || false, perfisAcessoIds };
  if (comSenha) base.senha = c.senha;
  return base;
}

// menus válidos pra Perfis de Acesso — precisa bater com os 9 itens de
// menu do app (Atendimentos, Resumo, Cronograma, Construtor de
// Relatórios, Relatórios, Financeiro, Agenda, Vídeos, Cadastros)
const MENUS_PERFIL_ACESSO = ['atendimentos', 'resumo', 'cronograma', 'construtor_relatorios', 'relatorios', 'financeiro', 'agenda', 'videos', 'cadastros'];

function permissaoVaziaPorMenu() {
  const obj: Record<string, any> = {};
  for (const m of MENUS_PERFIL_ACESSO) obj[m] = { visualizar: false, editar: false, excluir: false, inserir: false };
  return obj;
}
function valorParaApi(v: any) {
  return { id: v.id, atendenteId: v.atendente_id, clienteId: v.cliente_id, tipoId: v.tipo_id, real: v.real, ananda: v.ananda };
}
function atendimentoParaApi(a: any) {
  return {
    id: a.id, data: a.data, mes: a.mes, cliente: a.cliente, usuario: a.usuario, tipo: a.tipo,
    modulo: a.modulo, submodulo: a.submodulo, atendente: a.atendente, detalhe: a.detalhe,
    hi: a.hi, inter: a.inter, hf: a.hf, qtd: a.qtd, vha: a.vha, totalAnanda: a.total_ananda,
    vhr: a.vhr, totalReal: a.total_real, status: a.status, anexoUrl: a.anexo_url, anexoNome: a.anexo_nome,
    solucao: a.solucao || '', dataPrevista: a.data_prevista || ''
  };
}
function mensagemParaApi(m: any) {
  return { id: m.id, atendimentoId: m.atendimento_id, autorNome: m.autor_nome, autorPerfil: m.autor_perfil, texto: m.texto, dataHora: formatarDataHora(new Date(m.data_hora)) };
}
function historicoParaApi(h: any) {
  return { id: h.id, atendimentoId: h.atendimento_id, descricao: h.descricao, dataHora: formatarDataHora(new Date(h.data_hora)) };
}
function simplesParaApi(x: any) {
  return { id: x.id, nome: x.nome };
}
function clienteParaApi(c: any) {
  return { id: c.id, nome: c.nome, cnpj: c.cnpj || '', nomeFantasia: c.nome_fantasia || '' };
}

/* ---------- roteador ---------- */
async function rotear(req: any): Promise<any> {
  switch (req.action) {
    case 'login': return acaoLogin(req);
    case 'dados': return acaoDados(req);
    case 'salvarAtendimento': return acaoSalvarAtendimento(req);
    case 'excluirAtendimento': return acaoExcluirAtendimento(req);
    case 'addAtendente': return acaoAddConta(req, 'ATENDENTE');
    case 'addUsuario': return acaoAddConta(req, 'USUARIO');
    case 'atualizarConta': return acaoAtualizarConta(req);
    case 'alterarMinhaSenha': return acaoAlterarMinhaSenha(req);
    case 'salvarInscricaoPush': return acaoSalvarInscricaoPush(req);
    case 'removerInscricaoPush': return acaoRemoverInscricaoPush(req);
    case 'salvarTokenFcm': return acaoSalvarTokenFcm(req);
    case 'removerTokenFcm': return acaoRemoverTokenFcm(req);
    case 'listarRelatoriosSalvos': return acaoListarRelatoriosSalvos(req);
    case 'salvarRelatorio': return acaoSalvarRelatorio(req);
    case 'removerRelatorio': return acaoRemoverRelatorio(req);
    case 'listarLancamentos': return acaoListarLancamentos(req);
    case 'criarLancamento': return acaoCriarLancamento(req);
    case 'atualizarLancamento': return acaoAtualizarLancamento(req);
    case 'baixarLancamento': return acaoBaixarLancamento(req);
    case 'cancelarLancamento': return acaoCancelarLancamento(req);
    case 'removerLancamento': return acaoRemoverLancamento(req);
    case 'importarNotaFiscal': return acaoImportarNotaFiscal(req);
    case 'listarNotasImportadas': return acaoListarNotasImportadas(req);
    case 'removerNotaImportada': return acaoRemoverNotaImportada(req);
    case 'vincularNotaLancamento': return acaoVincularNotaLancamento(req);
    case 'listarAgendamentos': return acaoListarAgendamentos(req);
    case 'criarAgendamento': return acaoCriarAgendamento(req);
    case 'atualizarAgendamento': return acaoAtualizarAgendamento(req);
    case 'removerAgendamento': return acaoRemoverAgendamento(req);
    case 'removerConta': return acaoRemoverConta(req);
    case 'addCliente': return acaoAddCliente(req);
    case 'atualizarCliente': return acaoAtualizarCliente(req);
    case 'removerCliente': return acaoRemoverCliente(req);
    case 'addTipo': return acaoAddSimples('tipos', req);
    case 'removerTipo': return acaoRemoverTipo(req);
    case 'addModulo': return acaoAddSimples('modulos', req);
    case 'removerModulo': return acaoRemoverSimples('modulos', req);
    case 'addSubModulo': return acaoAddSimples('submodulos', req);
    case 'removerSubModulo': return acaoRemoverSimples('submodulos', req);
    case 'addStatus': return acaoAddSimples('status_list', req);
    case 'removerStatus': return acaoRemoverSimples('status_list', req);
    case 'reordenarStatus': return acaoReordenarStatus(req);
    case 'salvarValor': return acaoSalvarValor(req);
    case 'removerValor': return acaoRemoverSimples('valores', req);
    case 'recalcularValores': return acaoRecalcularValores(req);
    case 'listarMensagens': return acaoListarMensagens(req);
    case 'enviarMensagem': return acaoEnviarMensagem(req);
    case 'listarHistorico': return acaoListarHistorico(req);
    case 'listarVinculados': return acaoListarVinculados(req);
    case 'adicionarVinculo': return acaoAdicionarVinculo(req);
    case 'removerVinculo': return acaoRemoverVinculo(req);
    case 'alterarStatusEmMassa': return acaoAlterarStatusEmMassa(req);
    case 'uploadImagem': return acaoUploadImagem(req);
    case 'listarAnexos': return acaoListarAnexos(req);
    case 'adicionarAnexo': return acaoAdicionarAnexo(req);
    case 'removerAnexo': return acaoRemoverAnexo(req);
    case 'listarMovimentacoes': return acaoListarMovimentacoes(req);
    case 'criarMovimentacao': return acaoCriarMovimentacao(req);
    case 'atualizarMovimentacao': return acaoAtualizarMovimentacao(req);
    case 'removerMovimentacao': return acaoRemoverMovimentacao(req);
    case 'listarVideos': return acaoListarVideos(req);
    case 'criarVideo': return acaoCriarVideo(req);
    case 'atualizarVideo': return acaoAtualizarVideo(req);
    case 'removerVideo': return acaoRemoverVideo(req);
    case 'listarComentariosVideo': return acaoListarComentariosVideo(req);
    case 'criarComentarioVideo': return acaoCriarComentarioVideo(req);
    case 'removerComentarioVideo': return acaoRemoverComentarioVideo(req);
    case 'listarVideosDoAtendimento': return acaoListarVideosDoAtendimento(req);
    case 'vincularVideoAtendimento': return acaoVincularVideoAtendimento(req);
    case 'desvincularVideoAtendimento': return acaoDesvincularVideoAtendimento(req);
    case 'listarPerfisAcesso': return acaoListarPerfisAcesso(req);
    case 'salvarPerfilAcesso': return acaoSalvarPerfilAcesso(req);
    case 'removerPerfilAcesso': return acaoRemoverPerfilAcesso(req);
    case 'vincularPerfisConta': return acaoVincularPerfisConta(req);
    default: return { erro: 'ação desconhecida: ' + req.action };
  }
}

/* ---------- login / dados ---------- */
async function acaoLogin(req: any) {
  const login = String(req.login || '').trim().toLowerCase();
  const { data, error } = await db.from('contas').select('*').ilike('login', login).eq('senha', req.senha).maybeSingle();
  if (error || !data) return { ok: false, erro: 'Usuário ou senha inválidos.' };
  const { data: vinculos } = await db.from('conta_perfis_acesso').select('perfil_id').eq('conta_id', data.id);
  return { ok: true, conta: contaParaApi(data, false, (vinculos || []).map((v: any) => v.perfil_id)) };
}

async function acaoDados(req: any) {
  const contaId = req.contaId;
  const [{ data: contas }, { data: clientes }, { data: tipos }, { data: modulos }, { data: submodulos }, { data: statusList }, { data: perfisAcessoRaw }, { data: permissoesRaw }, { data: contaPerfisRaw }] = await Promise.all([
    db.from('contas').select('*'),
    db.from('clientes').select('*').order('nome'),
    db.from('tipos').select('*').order('nome'),
    db.from('modulos').select('*').order('nome'),
    db.from('submodulos').select('*').order('nome'),
    db.from('status_list').select('*').order('ordem').order('nome'),
    db.from('perfis_acesso').select('*').order('nome'),
    db.from('perfil_acesso_permissoes').select('*'),
    db.from('conta_perfis_acesso').select('*'),
  ]);

  const perfisAcesso = (perfisAcessoRaw || []).map((p: any) => {
    const permissoes = permissaoVaziaPorMenu();
    (permissoesRaw || []).filter((pp: any) => pp.perfil_id === p.id).forEach((pp: any) => {
      permissoes[pp.menu] = { visualizar: !!pp.visualizar, editar: !!pp.editar, excluir: !!pp.excluir, inserir: !!pp.inserir };
    });
    return { id: p.id, nome: p.nome, permissoes };
  });
  const perfisIdsPorConta: Record<string, string[]> = {};
  (contaPerfisRaw || []).forEach((v: any) => {
    if (!perfisIdsPorConta[v.conta_id]) perfisIdsPorConta[v.conta_id] = [];
    perfisIdsPorConta[v.conta_id].push(v.perfil_id);
  });

  const contaAtual = (contas || []).find((c: any) => String(c.id) === String(contaId));
  const isAdmin = ehAdminEfetivo(contaAtual);

  let atendimentosQuery = db.from('atendimentos').select('*').order('data', { ascending: false });
  if (contaAtual && contaAtual.perfil === 'USUARIO') {
    // usuário marcado como "administrador do cliente" vê TODOS os
    // atendimentos daquele cliente, não só os que ele mesmo abriu
    if (contaAtual.admin_cliente && contaAtual.cliente_id) {
      const clienteDoUsuario = (clientes || []).find((c: any) => String(c.id) === String(contaAtual.cliente_id));
      if (clienteDoUsuario) {
        atendimentosQuery = atendimentosQuery.eq('cliente', clienteDoUsuario.nome);
      } else {
        atendimentosQuery = atendimentosQuery.eq('usuario', contaAtual.nome);
      }
    } else {
      atendimentosQuery = atendimentosQuery.eq('usuario', contaAtual.nome);
    }
  }
  const { data: atendimentosRaw } = await atendimentosQuery;

  let valores: any[] = [];
  if (isAdmin) {
    const { data } = await db.from('valores').select('*');
    valores = (data || []).map(valorParaApi);
  }

  let atendimentos = (atendimentosRaw || []).map(atendimentoParaApi);
  // Valor Real (cobrado do cliente) é do admin, e também do usuário
  // marcado como "administrador do cliente" (vê o valor cobrado do
  // próprio cliente dele, mas não o valor que o atendente ganha).
  // Valor Atendente (antes chamado "Ananda") o próprio atendente também vê —
  // é o quanto ele ganha, faz sentido pra ele acompanhar no resumo dele.
  if (contaAtual && contaAtual.perfil === 'USUARIO') {
    if (contaAtual.admin_cliente) {
      atendimentos = atendimentos.map((a: any) => ({ ...a, vha: '', totalAnanda: '' }));
    } else {
      atendimentos = atendimentos.map((a: any) => ({ ...a, vha: '', totalAnanda: '', vhr: '', totalReal: '' }));
    }
  } else if (contaAtual && contaAtual.perfil === 'ATENDENTE' && !isAdmin) {
    atendimentos = atendimentos.map((a: any) => ({ ...a, vhr: '', totalReal: '' }));
  }

  return {
    ok: true,
    contas: (contas || []).map((c: any) => contaParaApi(c, false, perfisIdsPorConta[c.id] || [])),
    clientes: (clientes || []).map(clienteParaApi),
    tipos: (tipos || []).map(simplesParaApi),
    modulos: (modulos || []).map(simplesParaApi),
    submodulos: (submodulos || []).map(simplesParaApi),
    statusList: (statusList || []).map(simplesParaApi),
    valores,
    atendimentos,
    perfisAcesso,
  };
}

/* ---------- atendimento ---------- */
async function acaoSalvarAtendimento(req: any) {
  const [rCliente, rTipo] = await Promise.all([
    db.from('clientes').select('*').eq('nome', req.cliente).maybeSingle(),
    db.from('tipos').select('*').eq('nome', req.tipo).maybeSingle(),
  ]);
  const cliente = rCliente.data;
  const tipo = rTipo.data;

  let contaAtendente = null;
  let rAtendenteErro: any = null;
  if (req.atendente) {
    const rAtendente = await db.from('contas').select('*').eq('perfil', 'ATENDENTE').eq('nome', req.atendente).maybeSingle();
    contaAtendente = rAtendente.data;
    rAtendenteErro = rAtendente.error;
  }

  let real = 0, ananda = 0;
  let rValorErro: any = null;
  let valorEncontrado = null;
  if (cliente && tipo && contaAtendente) {
    // sem .maybeSingle() de propósito: se por algum motivo houver mais de uma
    // linha pra essa combinação (não deveria, mas já aconteceu — ver
    // migração de dedup no schema.sql), pega a primeira em vez de quebrar
    const rValor = await db.from('valores').select('*')
      .eq('atendente_id', contaAtendente.id).eq('cliente_id', cliente.id).eq('tipo_id', tipo.id).limit(1);
    valorEncontrado = rValor.data && rValor.data[0] ? rValor.data[0] : null;
    rValorErro = rValor.error;
    if (valorEncontrado) { real = Number(valorEncontrado.real); ananda = Number(valorEncontrado.ananda); }
  }

  // diagnóstico: só loga quando tinha atendente mas não achou valor — ajuda a
  // identificar exatamente qual passo falhou, sem poluir o log em uso normal
  if (req.atendente && (real === 0 && ananda === 0)) {
    console.error('[salvarAtendimento] valor não encontrado — diagnóstico:', JSON.stringify({
      req_cliente: req.cliente, req_tipo: req.tipo, req_atendente: req.atendente,
      cliente_achado: cliente ? { id: cliente.id, nome: cliente.nome } : null,
      cliente_erro: rCliente.error,
      tipo_achado: tipo ? { id: tipo.id, nome: tipo.nome } : null,
      tipo_erro: rTipo.error,
      atendente_achado: contaAtendente ? { id: contaAtendente.id, nome: contaAtendente.nome } : null,
      atendente_erro: rAtendenteErro,
      valor_achado: valorEncontrado,
      valor_erro: rValorErro,
    }));
  }

  const qtd = (req.qtdManual !== undefined && req.qtdManual !== null && req.qtdManual !== '')
    ? Number(req.qtdManual)  // ajuste manual (só o admin tem esse campo no formulário)
    : calcularQtd(req.hi, req.hf, req.inter);
  const partes = String(req.data).split('-');
  const mes = partes.length === 3 ? `${partes[1]}/${partes[0]}` : '';

  let anexoUrl = req.anexoUrlExistente || '';
  let anexoNome = req.anexoNomeExistente || '';
  if (!req.id && req.anexoBase64) {
    // anexo inicial, só existe esse fluxo na criação — depois disso os
    // anexos são geridos pela tabela "anexos" (múltiplos, via ações
    // separadas: listarAnexos/adicionarAnexo/removerAnexo)
    const salvo = await salvarAnexo(req.anexoBase64, req.anexoTipo, req.anexoNome);
    anexoUrl = salvo.url;
    anexoNome = salvo.nome;
  } else if (req.id) {
    // editando: preserva o anexo_url/anexo_nome que já estava gravado —
    // o formulário de edição não manda mais esses campos (usa a lista de
    // múltiplos anexos), então sem isso eles seriam apagados a cada save
    const { data: existenteAnexo } = await db.from('atendimentos').select('anexo_url,anexo_nome').eq('id', req.id).maybeSingle();
    if (existenteAnexo) { anexoUrl = existenteAnexo.anexo_url || ''; anexoNome = existenteAnexo.anexo_nome || ''; }
  }

  const ehNovo = !req.id;
  const statusFinal = ehNovo ? 'PENDENTE' : req.status; // todo chamado novo abre PENDENTE — reforçado aqui, não confia só no front

  const registro = {
    id: req.id || gerarId(),
    data: req.data, mes, cliente: req.cliente, usuario: req.usuario, tipo: req.tipo,
    modulo: req.modulo || '', submodulo: req.submodulo || '',
    atendente: req.atendente || '', detalhe: req.detalhe || '',
    hi: req.hi || '00:00', inter: req.inter || '00:00', hf: req.hf || '00:00',
    qtd, vha: ananda, total_ananda: qtd * ananda, vhr: real, total_real: qtd * real, status: statusFinal,
    anexo_url: anexoUrl, anexo_nome: anexoNome, solucao: req.solucao || '',
    data_prevista: req.dataPrevista || '',
  };

  if (ehNovo) {
    const { error: erroInsert } = await db.from('atendimentos').insert(registro);
    if (erroInsert) return { ok: false, erro: 'Erro ao salvar: ' + erroInsert.message };
    await registrarHistorico(registro.id, `Chamado aberto por ${req.usuario} (status: ${registro.status})`);
    if (anexoUrl) {
      await db.from('anexos').insert({ id: gerarId(), atendimento_id: registro.id, nome: anexoNome, url: anexoUrl });
    }
  } else {
    const { data: existente } = await db.from('atendimentos').select('status').eq('id', req.id).maybeSingle();
    if (existente && existente.status !== registro.status) {
      await registrarHistorico(registro.id, `Status alterado de ${existente.status} para ${registro.status}`);
      await notificarStatusAlterado(registro, existente.status);
    }
    const { error: erroUpdate } = await db.from('atendimentos').update(registro).eq('id', req.id);
    if (erroUpdate) return { ok: false, erro: 'Erro ao salvar: ' + erroUpdate.message };
  }

  if (ehNovo) {
    await enviarEmailsNovoAtendimento(registro);
    await notificarNovoAtendimento(registro);
  }

  return { ok: true };
}

async function acaoExcluirAtendimento(req: any) {
  await db.from('atendimentos').delete().eq('id', req.id);
  return { ok: true };
}

/* ---------- anexos (Supabase Storage no lugar do Google Drive) ---------- */
async function salvarAnexo(base64: string, tipo: string, nomeOriginal: string) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const caminho = `${Date.now()}-${(nomeOriginal || 'anexo').replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  const { error } = await db.storage.from('anexos').upload(caminho, bytes, { contentType: tipo || 'application/octet-stream', upsert: false });
  if (error) throw error;
  const { data } = db.storage.from('anexos').getPublicUrl(caminho);
  return { url: data.publicUrl, nome: nomeOriginal || caminho };
}

// Upload avulso — usado pelas imagens inseridas dentro do texto rico da
// Solução. Só faz o upload e devolve a URL, não fica vinculado a nada.
async function acaoUploadImagem(req: any) {
  try {
    const salvo = await salvarAnexo(req.base64, req.tipo, req.nome);
    return { ok: true, url: salvo.url, nome: salvo.nome };
  } catch (e) {
    return { ok: false, erro: 'Não foi possível enviar a imagem.' };
  }
}

// Múltiplos anexos por atendimento (tabela "anexos", separada da coluna
// única antiga anexo_url/anexo_nome).
async function acaoListarAnexos(req: any) {
  const { data, error } = await db.from('anexos').select('*').eq('atendimento_id', req.atendimentoId).is('movimentacao_id', null).order('criado_em');
  if (error) return { ok: false, erro: error.message };
  return { ok: true, anexos: (data || []).map((a: any) => ({ id: a.id, atendimentoId: a.atendimento_id, nome: a.nome, url: a.url })) };
}

async function acaoAdicionarAnexo(req: any) {
  if (!req.atendimentoId) return { ok: false, erro: 'Atendimento não informado.' };
  try {
    const salvo = await salvarAnexo(req.base64, req.tipo, req.nome);
    const registro = { id: gerarId(), atendimento_id: req.atendimentoId, nome: salvo.nome, url: salvo.url };
    const { error } = await db.from('anexos').insert(registro);
    if (error) return { ok: false, erro: error.message };
    return { ok: true, anexo: { id: registro.id, atendimentoId: req.atendimentoId, nome: registro.nome, url: registro.url } };
  } catch (e) {
    return { ok: false, erro: 'Não foi possível enviar o anexo.' };
  }
}

async function acaoRemoverAnexo(req: any) {
  await db.from('anexos').delete().eq('id', req.id);
  return { ok: true };
}

/* ---------- e-mail (via Gmail — opcional) ---------- */
async function enviarEmailsNovoAtendimento(registro: any) {
  if (!gmailTransporter) { console.log('[email] GMAIL_USER/GMAIL_APP_PASSWORD não configurados — pulando envio de e-mail.'); return; }
  try {
    const { data: contasList } = await db.from('contas').select('*');
    const contas = contasList || [];
    const destinatarios = new Set<string>();

    const contaUsuario = contas.find((c: any) => c.perfil === 'USUARIO' && c.nome === registro.usuario);
    if (contaUsuario && contaUsuario.email) destinatarios.add(contaUsuario.email);

    if (registro.atendente) {
      const contaAtendente = contas.find((c: any) => c.perfil === 'ATENDENTE' && c.nome === registro.atendente);
      if (contaAtendente && contaAtendente.email) destinatarios.add(contaAtendente.email);
    } else {
      contas.filter((c: any) => c.perfil === 'ATENDENTE' && c.email).forEach((c: any) => destinatarios.add(c.email));
    }

    if (destinatarios.size === 0) { console.log('[email] Nenhum destinatário com e-mail cadastrado pra este atendimento — ninguém tem e-mail preenchido em Cadastros.'); return; }

    const assunto = `Novo atendimento aberto — ${registro.cliente} / ${registro.usuario}`;
    const corpo = [
      'Um novo atendimento foi registrado.', '',
      `Cliente: ${registro.cliente}`,
      `Usuário solicitante: ${registro.usuario}`,
      `Atendente: ${registro.atendente || '(a definir — qualquer atendente pode assumir)'}`,
      `Data: ${registro.data}`,
      `Tipo: ${registro.tipo}`,
      registro.modulo ? `Módulo: ${registro.modulo}` : '',
      registro.submodulo ? `Sub módulo: ${registro.submodulo}` : '',
      registro.detalhe ? `Detalhe: ${textoSimples(registro.detalhe)}` : '',
      '', `Acesse o sistema: ${URL_APP}`,
    ].filter(Boolean).join('\n');

    console.log(`[email] Enviando pra: ${[...destinatarios].join(', ')}`);
    await Promise.all([...destinatarios].map(async (email) => {
      try {
        await gmailTransporter!.sendMail({ from: `"Controle de Atendimentos" <${GMAIL_USER}>`, to: email, subject: assunto, text: corpo });
        console.log(`[email] Enviado com sucesso pra ${email}`);
      } catch (erroEnvio: any) {
        console.error(`[email] Erro ao enviar pra ${email}:`, erroEnvio && erroEnvio.message);
      }
    }));
  } catch (_e: any) {
    console.error('[email] Erro inesperado ao montar/enviar e-mails:', _e && _e.message);
  }
}

/* ---------- notificações push (opcional — veja o LEIA-ME.md pra ativar) ---------- */

// manda pra ambos os canais — Web Push (navegador/PWA) e FCM (app Android
// nativo) — cada um só faz alguma coisa se estiver configurado
async function enviarPushParaContas(contaIds: (string | null | undefined)[], titulo: string, corpo: string, urlDestino?: string) {
  const idsUnicos = [...new Set(contaIds.filter((id): id is string => !!id))];
  if (idsUnicos.length === 0) { console.log('[push] Nenhuma conta pra notificar neste evento.'); return; }
  await Promise.all([
    enviarWebPushParaContas(idsUnicos, titulo, corpo, urlDestino),
    enviarFcmParaContas(idsUnicos, titulo, corpo, urlDestino),
  ]);
}

// manda a notificação de verdade pra cada inscrição (aparelho) das contas
// informadas; se uma inscrição estiver morta (410/404 — usuário desinstalou
// o app, trocou de aparelho, etc.), apaga ela sozinho pra não tentar de novo
async function enviarWebPushParaContas(idsUnicos: string[], titulo: string, corpo: string, urlDestino?: string) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) { console.log('[push] Chaves VAPID não configuradas — pulando envio de notificação web.'); return; }
  try {
    const { data: inscricoes, error: erroInscricoes } = await db.from('push_inscricoes').select('*').in('conta_id', idsUnicos);
    if (erroInscricoes) { console.error('[push] Erro ao buscar inscrições:', erroInscricoes.message); return; }
    if (!inscricoes || inscricoes.length === 0) { console.log(`[push] Nenhuma inscrição ativa pras contas ${idsUnicos.join(', ')} — a pessoa ainda não clicou em "🔔 Avisos" nesse aparelho.`); return; }
    console.log(`[push] Enviando pra ${inscricoes.length} inscrição(ões).`);
    const payload = JSON.stringify({ title: titulo, body: corpo, url: urlDestino || URL_APP });
    await Promise.all(inscricoes.map(async (i: any) => {
      try {
        await webpush.sendNotification({ endpoint: i.endpoint, keys: { p256dh: i.p256dh, auth: i.auth } }, payload);
        console.log(`[push] Enviado com sucesso pra inscrição ${i.id}`);
      } catch (e: any) {
        console.error(`[push] Falha ao enviar pra inscrição ${i.id} — status ${e && e.statusCode}: ${e && e.body}`);
        if (e && (e.statusCode === 410 || e.statusCode === 404)) {
          await db.from('push_inscricoes').delete().eq('id', i.id);
          console.log(`[push] Inscrição ${i.id} removida (expirada/inválida).`);
        }
      }
    }));
  } catch (_e: any) {
    console.error('[push] Erro inesperado ao enviar notificações web:', _e && _e.message);
  }
}

/* ---------- notificações nativas do app Android (FCM) ---------- */

let fcmAccessTokenCache: { token: string; expiraEm: number } | null = null;

function base64urlDeBytes(bytes: Uint8Array): string {
  let binario = '';
  for (const b of bytes) binario += String.fromCharCode(b);
  return btoa(binario).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64urlDeJson(obj: any): string {
  return base64urlDeBytes(new TextEncoder().encode(JSON.stringify(obj)));
}
function pemParaArrayBuffer(pem: string): ArrayBuffer {
  const base64 = pem.replace(/-----BEGIN PRIVATE KEY-----/, '').replace(/-----END PRIVATE KEY-----/, '').replace(/\s+/g, '');
  const binario = atob(base64);
  const bytes = new Uint8Array(binario.length);
  for (let i = 0; i < binario.length; i++) bytes[i] = binario.charCodeAt(i);
  return bytes.buffer;
}

// gera (e cacheia até quase expirar) um access token OAuth2 pra chamar a API
// do Firebase Cloud Messaging, assinando um JWT com a chave privada da conta
// de serviço — só com Web Crypto (já vem no Deno), sem lib nenhuma
async function obterAccessTokenFcm(contaServico: any): Promise<string | null> {
  const agora = Math.floor(Date.now() / 1000);
  if (fcmAccessTokenCache && fcmAccessTokenCache.expiraEm > agora + 60) return fcmAccessTokenCache.token;

  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: contaServico.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: agora,
    exp: agora + 3600,
  };
  const semAssinar = `${base64urlDeJson(header)}.${base64urlDeJson(claims)}`;

  try {
    const chavePrivada = await crypto.subtle.importKey(
      'pkcs8', pemParaArrayBuffer(contaServico.private_key),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']
    );
    const assinatura = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', chavePrivada, new TextEncoder().encode(semAssinar));
    const jwt = `${semAssinar}.${base64urlDeBytes(new Uint8Array(assinatura))}`;

    const resp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
    });
    const dados = await resp.json();
    if (!resp.ok || !dados.access_token) { console.error('[push-fcm] Erro ao obter access token:', dados); return null; }
    fcmAccessTokenCache = { token: dados.access_token, expiraEm: agora + (dados.expires_in || 3600) };
    return dados.access_token;
  } catch (e: any) {
    console.error('[push-fcm] Erro inesperado ao gerar access token:', e && e.message);
    return null;
  }
}

async function enviarFcmParaContas(idsUnicos: string[], titulo: string, corpo: string, urlDestino?: string) {
  if (!FCM_SERVICE_ACCOUNT_JSON) { console.log('[push-fcm] Conta de serviço não configurada — pulando envio de notificação nativa (Android).'); return; }
  let contaServico: any;
  try { contaServico = JSON.parse(FCM_SERVICE_ACCOUNT_JSON); } catch { console.error('[push-fcm] FCM_SERVICE_ACCOUNT_JSON não é um JSON válido.'); return; }

  try {
    const { data: tokens, error } = await db.from('push_fcm_tokens').select('*').in('conta_id', idsUnicos);
    if (error) { console.error('[push-fcm] Erro ao buscar tokens:', error.message); return; }
    if (!tokens || tokens.length === 0) { console.log(`[push-fcm] Nenhum aparelho Android registrado pras contas ${idsUnicos.join(', ')}.`); return; }

    const accessToken = await obterAccessTokenFcm(contaServico);
    if (!accessToken) return;

    console.log(`[push-fcm] Enviando pra ${tokens.length} aparelho(s) Android.`);
    await Promise.all(tokens.map(async (t: any) => {
      try {
        const resp = await fetch(`https://fcm.googleapis.com/v1/projects/${contaServico.project_id}/messages:send`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: {
              token: t.token,
              notification: { title: titulo, body: corpo },
              data: { url: urlDestino || URL_APP },
            },
          }),
        });
        if (resp.ok) { console.log(`[push-fcm] Enviado com sucesso pro token ${t.id}`); return; }
        const erroResp = await resp.json().catch(() => ({}));
        console.error(`[push-fcm] Falha ao enviar pro token ${t.id}:`, erroResp);
        const status = erroResp && erroResp.error && erroResp.error.status;
        if (status === 'UNREGISTERED' || status === 'NOT_FOUND' || status === 'INVALID_ARGUMENT') {
          await db.from('push_fcm_tokens').delete().eq('id', t.id);
          console.log(`[push-fcm] Token ${t.id} removido (expirado/inválido).`);
        }
      } catch (e: any) {
        console.error(`[push-fcm] Erro inesperado ao enviar pro token ${t.id}:`, e && e.message);
      }
    }));
  } catch (_e: any) {
    console.error('[push-fcm] Erro inesperado ao enviar notificações nativas:', _e && _e.message);
  }
}

// mesma lógica de destinatário do e-mail de "chamado aberto", mas devolvendo
// os IDs das contas (o push precisa disso, não do e-mail)
async function contasParaNotificarNovoAtendimento(registro: any): Promise<string[]> {
  const { data: contasList } = await db.from('contas').select('id,nome,perfil');
  const contas = contasList || [];
  const ids = new Set<string>();
  const contaUsuario = contas.find((c: any) => c.perfil === 'USUARIO' && c.nome === registro.usuario);
  if (contaUsuario) ids.add(contaUsuario.id);
  if (registro.atendente) {
    const contaAtendente = contas.find((c: any) => c.perfil === 'ATENDENTE' && c.nome === registro.atendente);
    if (contaAtendente) ids.add(contaAtendente.id);
  } else {
    contas.filter((c: any) => c.perfil === 'ATENDENTE').forEach((c: any) => ids.add(c.id));
  }
  return [...ids];
}

async function notificarNovoAtendimento(registro: any) {
  const ids = await contasParaNotificarNovoAtendimento(registro);
  await enviarPushParaContas(ids, 'Novo chamado aberto', `${registro.cliente} — ${registro.usuario}: ${(registro.detalhe || '').replace(/<[^>]*>/g, '').slice(0, 80)}`);
}

async function notificarStatusAlterado(registro: any, statusAnterior: string) {
  const { data: contasList } = await db.from('contas').select('id,nome,perfil');
  const contas = contasList || [];
  const ids = new Set<string>();
  const contaUsuario = contas.find((c: any) => c.perfil === 'USUARIO' && c.nome === registro.usuario);
  if (contaUsuario) ids.add(contaUsuario.id);
  if (registro.atendente) {
    const contaAtendente = contas.find((c: any) => c.perfil === 'ATENDENTE' && c.nome === registro.atendente);
    if (contaAtendente) ids.add(contaAtendente.id);
  }
  await enviarPushParaContas([...ids], 'Status alterado', `${registro.cliente} — de ${statusAnterior} para ${registro.status}`);
}

async function notificarNovaMensagem(atendimentoId: string, autorNome: string, autorPerfil: string, texto: string) {
  const { data: atendimento } = await db.from('atendimentos').select('cliente,usuario,atendente').eq('id', atendimentoId).maybeSingle();
  if (!atendimento) return;
  const { data: contasList } = await db.from('contas').select('id,nome,perfil');
  const contas = contasList || [];
  const ids = new Set<string>();

  if (autorPerfil === 'USUARIO') {
    // usuário escreveu — avisa o atendente responsável (ou todos, se ninguém pegou o chamado ainda)
    if (atendimento.atendente) {
      const c = contas.find((c: any) => c.perfil === 'ATENDENTE' && c.nome === atendimento.atendente);
      if (c) ids.add(c.id);
    } else {
      contas.filter((c: any) => c.perfil === 'ATENDENTE').forEach((c: any) => ids.add(c.id));
    }
  } else {
    // atendente/admin escreveu — avisa o usuário que abriu o chamado
    const c = contas.find((c: any) => c.perfil === 'USUARIO' && c.nome === atendimento.usuario);
    if (c) ids.add(c.id);
  }

  await enviarPushParaContas([...ids], `Nova mensagem — ${autorNome}`, texto.slice(0, 100));
}

/* ---------- movimentações (substitui a "Conversa" simples) ---------- */
async function notificarNovaMovimentacao(atendimento: any, autorNome: string, autorPerfil: string, texto: string) {
  const { data: contasList } = await db.from('contas').select('*');
  const contas = contasList || [];

  // push — mesma lógica de sempre: avisa "o outro lado" da conversa
  const idsPush = new Set<string>();
  if (autorPerfil === 'USUARIO') {
    if (atendimento.atendente) {
      const c = contas.find((c: any) => c.perfil === 'ATENDENTE' && c.nome === atendimento.atendente);
      if (c) idsPush.add(c.id);
    } else {
      contas.filter((c: any) => c.perfil === 'ATENDENTE').forEach((c: any) => idsPush.add(c.id));
    }
  } else {
    const c = contas.find((c: any) => c.perfil === 'USUARIO' && c.nome === atendimento.usuario);
    if (c) idsPush.add(c.id);
  }
  await enviarPushParaContas([...idsPush], `Nova movimentação — ${autorNome}`, textoSimples(texto, 100));

  // e-mail — aqui é diferente do push: manda pros DOIS lados (usuário e
  // atendente), não só pro "outro lado"; a única exceção é não avisar a
  // própria pessoa que acabou de postar a movimentação
  if (!gmailTransporter) { console.log('[email] Gmail não configurado — pulando notificação de movimentação.'); return; }
  try {
    const destinatarios = new Set<string>();
    const contaUsuario = contas.find((c: any) => c.perfil === 'USUARIO' && c.nome === atendimento.usuario);
    if (contaUsuario && contaUsuario.email && contaUsuario.nome !== autorNome) destinatarios.add(contaUsuario.email);
    if (atendimento.atendente) {
      const contaAtendente = contas.find((c: any) => c.perfil === 'ATENDENTE' && c.nome === atendimento.atendente);
      if (contaAtendente && contaAtendente.email && contaAtendente.nome !== autorNome) destinatarios.add(contaAtendente.email);
    }
    if (destinatarios.size === 0) { console.log('[email] Nenhum destinatário com e-mail pra essa movimentação.'); return; }

    const rotulo = autorPerfil === 'USUARIO' ? 'Usuário' : autorPerfil === 'ATENDENTE' ? 'Atendente' : 'Admin';
    const assunto = `Nova movimentação — ${atendimento.cliente} / ${atendimento.usuario}`;
    const corpo = [
      `${autorNome} (${rotulo}) adicionou uma nova movimentação no atendimento:`, '',
      textoSimples(texto), '', `Acesse o sistema: ${URL_APP}`,
    ].join('\n');

    console.log(`[email] Movimentação — enviando pra: ${[...destinatarios].join(', ')}`);
    await Promise.all([...destinatarios].map(async (email) => {
      try {
        await gmailTransporter!.sendMail({ from: `"Controle de Atendimentos" <${GMAIL_USER}>`, to: email, subject: assunto, text: corpo });
        console.log(`[email] Movimentação enviada pra ${email}`);
      } catch (e: any) {
        console.error(`[email] Falha ao enviar movimentação pra ${email}:`, e && e.message);
      }
    }));
  } catch (e: any) {
    console.error('[email] Erro inesperado ao notificar movimentação:', e && e.message);
  }
}

async function acaoListarMovimentacoes(req: any) {
  if (!req.atendimentoId) return { ok: false, erro: 'Atendimento não informado.' };
  const { data: movs, error } = await db.from('movimentacoes').select('*').eq('atendimento_id', req.atendimentoId).order('criado_em');
  if (error) return { ok: false, erro: error.message };
  const { data: anexosMov } = await db.from('anexos').select('*').eq('atendimento_id', req.atendimentoId).not('movimentacao_id', 'is', null);
  const anexosPorMov: Record<string, any[]> = {};
  (anexosMov || []).forEach((a: any) => {
    if (!anexosPorMov[a.movimentacao_id]) anexosPorMov[a.movimentacao_id] = [];
    anexosPorMov[a.movimentacao_id].push({ id: a.id, nome: a.nome, url: a.url });
  });
  return {
    ok: true,
    movimentacoes: (movs || []).map((m: any) => ({
      id: m.id, atendimentoId: m.atendimento_id, autorNome: m.autor_nome, autorPerfil: m.autor_perfil,
      texto: m.texto, tempoInicio: m.tempo_inicio || '', tempoFim: m.tempo_fim || '',
      respondendoA: m.respondendo_a || null, criadoEm: m.criado_em,
      anexos: anexosPorMov[m.id] || [],
    })),
  };
}

async function acaoCriarMovimentacao(req: any) {
  if (!req.atendimentoId) return { ok: false, erro: 'Atendimento não informado.' };
  const texto = String(req.texto || '').trim();
  if (!texto && !req.anexoBase64) return { ok: false, erro: 'Escreva algo ou anexe um arquivo.' };

  const { data: atendimento } = await db.from('atendimentos').select('status,cliente,usuario,atendente').eq('id', req.atendimentoId).maybeSingle();
  if (!atendimento) return { ok: false, erro: 'Atendimento não encontrado.' };
  if (atendimento.status === 'VALIDADO') return { ok: false, erro: 'Esse atendimento já foi validado — não é possível adicionar novas movimentações.' };

  const registro = {
    id: gerarId(), atendimento_id: req.atendimentoId, autor_nome: req.autorNome, autor_perfil: req.autorPerfil,
    texto: texto || '(anexo)', tempo_inicio: req.tempoInicio || null, tempo_fim: req.tempoFim || null,
    respondendo_a: req.respondendoA || null,
  };
  const { error } = await db.from('movimentacoes').insert(registro);
  if (error) return { ok: false, erro: error.message };

  let anexoSalvo = null;
  if (req.anexoBase64) {
    try {
      const salvo = await salvarAnexo(req.anexoBase64, req.anexoTipo, req.anexoNome);
      const anexoRegistro = { id: gerarId(), atendimento_id: req.atendimentoId, movimentacao_id: registro.id, nome: salvo.nome, url: salvo.url };
      await db.from('anexos').insert(anexoRegistro);
      anexoSalvo = { id: anexoRegistro.id, nome: anexoRegistro.nome, url: anexoRegistro.url };
    } catch (_e) {
      // a movimentação já foi salva — só o anexo falhou, não interrompe o resto
    }
  }

  await notificarNovaMovimentacao(atendimento, req.autorNome, req.autorPerfil, texto);
  return { ok: true, id: registro.id, anexo: anexoSalvo };
}

async function acaoAtualizarMovimentacao(req: any) {
  if (!req.id) return { ok: false, erro: 'Movimentação não informada.' };
  const { data: mov } = await db.from('movimentacoes').select('*').eq('id', req.id).maybeSingle();
  if (!mov) return { ok: false, erro: 'Movimentação não encontrada.' };
  const { data: conta } = await db.from('contas').select('nome,perfil,eh_administrador').eq('id', req.contaId).maybeSingle();
  if (!conta) return { ok: false, erro: 'Conta não encontrada.' };
  if (!ehAdminEfetivo(conta) && conta.nome !== mov.autor_nome) return { ok: false, erro: 'Você só pode editar suas próprias movimentações.' };

  const { data: atendimento } = await db.from('atendimentos').select('status').eq('id', mov.atendimento_id).maybeSingle();
  if (atendimento && atendimento.status === 'VALIDADO') return { ok: false, erro: 'Esse atendimento já foi validado — não é possível editar movimentações.' };

  const texto = String(req.texto || '').trim();
  if (!texto) return { ok: false, erro: 'Escreva algo.' };
  const atualizado: any = { texto };
  if (req.tempoInicio !== undefined) atualizado.tempo_inicio = req.tempoInicio || null;
  if (req.tempoFim !== undefined) atualizado.tempo_fim = req.tempoFim || null;
  const { error } = await db.from('movimentacoes').update(atualizado).eq('id', req.id);
  if (error) return { ok: false, erro: error.message };
  return { ok: true };
}

async function acaoRemoverMovimentacao(req: any) {
  if (!req.id) return { ok: false, erro: 'Movimentação não informada.' };
  const { data: mov } = await db.from('movimentacoes').select('*').eq('id', req.id).maybeSingle();
  if (!mov) return { ok: false, erro: 'Movimentação não encontrada.' };
  const { data: conta } = await db.from('contas').select('nome,perfil,eh_administrador').eq('id', req.contaId).maybeSingle();
  if (!conta) return { ok: false, erro: 'Conta não encontrada.' };
  if (!ehAdminEfetivo(conta) && conta.nome !== mov.autor_nome) return { ok: false, erro: 'Você só pode excluir suas próprias movimentações.' };

  const { data: atendimento } = await db.from('atendimentos').select('status').eq('id', mov.atendimento_id).maybeSingle();
  if (atendimento && atendimento.status === 'VALIDADO') return { ok: false, erro: 'Esse atendimento já foi validado — não é possível excluir movimentações.' };

  await db.from('anexos').delete().eq('movimentacao_id', req.id);
  await db.from('movimentacoes').delete().eq('id', req.id);
  return { ok: true };
}

/* ---------- vídeos / tutoriais (aba visível pra todo mundo, admin cadastra) ---------- */
function videoParaApi(v: any) {
  return {
    id: v.id, titulo: v.titulo, descricao: v.descricao || '', urlYoutube: v.url_youtube,
    cliente: v.cliente || '', modulo: v.modulo || '', visivelPerfis: v.visivel_perfis || [],
    ordem: v.ordem || 0, criadoPor: v.criado_por || '',
  };
}

async function acaoListarVideos(req: any) {
  const { data: conta } = await db.from('contas').select('*').eq('id', req.contaId).maybeSingle();
  if (!conta) return { ok: false, erro: 'Conta não encontrada.' };

  const { data, error } = await db.from('videos_tutoriais').select('*').order('ordem').order('criado_em');
  if (error) return { ok: false, erro: error.message };
  let videos = data || [];

  // admin vê tudo (pra gerenciar); os outros perfis só o que foi
  // liberado pra eles — e, no caso de usuário, só o que é "Todos" ou
  // do próprio cliente (atendente não tem cliente fixo, então não
  // filtra por cliente pra esse perfil)
  if (!ehAdminEfetivo(conta)) {
    videos = videos.filter((v: any) => (v.visivel_perfis || []).includes(conta.perfil));
    if (conta.perfil === 'USUARIO') {
      let nomeCliente = '';
      if (conta.cliente_id) {
        const { data: clienteInfo } = await db.from('clientes').select('nome').eq('id', conta.cliente_id).maybeSingle();
        nomeCliente = clienteInfo ? clienteInfo.nome : '';
      }
      videos = videos.filter((v: any) => !v.cliente || v.cliente === nomeCliente);
    }
  }

  return { ok: true, videos: videos.map(videoParaApi) };
}

async function acaoCriarVideo(req: any) {
  if (!(await confirmarAdmin(req.contaId)) && !(await podeAgir(req.contaId, 'videos', 'inserir'))) return { ok: false, erro: 'Você não tem permissão para cadastrar vídeos.' };
  if (!req.titulo || !req.urlYoutube) return { ok: false, erro: 'Preencha o título e o link do YouTube.' };
  const { data: conta } = await db.from('contas').select('nome').eq('id', req.contaId).maybeSingle();
  const registro = {
    id: gerarId(), titulo: req.titulo, descricao: req.descricao || '', url_youtube: req.urlYoutube,
    cliente: req.cliente || null, modulo: req.modulo || null,
    visivel_perfis: (req.visivelPerfis && req.visivelPerfis.length > 0) ? req.visivelPerfis : ['ATENDENTE', 'USUARIO'],
    ordem: Number(req.ordem) || 0, criado_por: conta ? conta.nome : '',
  };
  const { error } = await db.from('videos_tutoriais').insert(registro);
  if (error) return { ok: false, erro: error.message };
  return { ok: true, id: registro.id };
}

async function acaoAtualizarVideo(req: any) {
  if (!(await confirmarAdmin(req.contaId)) && !(await podeAgir(req.contaId, 'videos', 'editar'))) return { ok: false, erro: 'Você não tem permissão para editar vídeos.' };
  if (!req.id) return { ok: false, erro: 'Vídeo não informado.' };
  const atualizado: any = {};
  if (req.titulo !== undefined) atualizado.titulo = req.titulo;
  if (req.descricao !== undefined) atualizado.descricao = req.descricao;
  if (req.urlYoutube !== undefined) atualizado.url_youtube = req.urlYoutube;
  if (req.cliente !== undefined) atualizado.cliente = req.cliente || null;
  if (req.modulo !== undefined) atualizado.modulo = req.modulo || null;
  if (req.visivelPerfis !== undefined) atualizado.visivel_perfis = req.visivelPerfis;
  if (req.ordem !== undefined) atualizado.ordem = Number(req.ordem) || 0;
  const { error } = await db.from('videos_tutoriais').update(atualizado).eq('id', req.id);
  if (error) return { ok: false, erro: error.message };
  return { ok: true };
}

async function acaoRemoverVideo(req: any) {
  if (!(await confirmarAdmin(req.contaId)) && !(await podeAgir(req.contaId, 'videos', 'excluir'))) return { ok: false, erro: 'Você não tem permissão para remover vídeos.' };
  await db.from('videos_tutoriais').delete().eq('id', req.id);
  return { ok: true };
}

/* ---------- comentários de vídeo ---------- */
async function contaPodeVerVideo(conta: any, video: any): Promise<boolean> {
  if (ehAdminEfetivo(conta)) return true;
  if (!(video.visivel_perfis || []).includes(conta.perfil)) return false;
  if (conta.perfil === 'USUARIO' && video.cliente) {
    if (!conta.cliente_id) return false;
    const { data: clienteInfo } = await db.from('clientes').select('nome').eq('id', conta.cliente_id).maybeSingle();
    if (!clienteInfo || clienteInfo.nome !== video.cliente) return false;
  }
  return true;
}

function comentarioVideoParaApi(c: any) {
  return { id: c.id, videoId: c.video_id, autorNome: c.autor_nome, autorPerfil: c.autor_perfil, texto: c.texto, criadoEm: c.criado_em };
}

async function acaoListarComentariosVideo(req: any) {
  if (!req.videoId) return { ok: false, erro: 'Vídeo não informado.' };
  const { data: conta } = await db.from('contas').select('*').eq('id', req.contaId).maybeSingle();
  if (!conta) return { ok: false, erro: 'Conta não encontrada.' };
  const { data: video } = await db.from('videos_tutoriais').select('*').eq('id', req.videoId).maybeSingle();
  if (!video) return { ok: false, erro: 'Vídeo não encontrado.' };
  if (!(await contaPodeVerVideo(conta, video))) return { ok: false, erro: 'Sem acesso a esse vídeo.' };

  const { data, error } = await db.from('video_comentarios').select('*').eq('video_id', req.videoId).order('criado_em');
  if (error) return { ok: false, erro: error.message };
  return { ok: true, comentarios: (data || []).map(comentarioVideoParaApi) };
}

async function acaoCriarComentarioVideo(req: any) {
  if (!req.videoId || !String(req.texto || '').trim()) return { ok: false, erro: 'Escreva um comentário.' };
  const { data: conta } = await db.from('contas').select('*').eq('id', req.contaId).maybeSingle();
  if (!conta) return { ok: false, erro: 'Conta não encontrada.' };
  const { data: video } = await db.from('videos_tutoriais').select('*').eq('id', req.videoId).maybeSingle();
  if (!video) return { ok: false, erro: 'Vídeo não encontrado.' };
  if (!(await contaPodeVerVideo(conta, video))) return { ok: false, erro: 'Sem acesso a esse vídeo.' };

  const registro = { id: gerarId(), video_id: req.videoId, autor_nome: conta.nome, autor_perfil: conta.perfil, texto: String(req.texto).trim() };
  const { error } = await db.from('video_comentarios').insert(registro);
  if (error) return { ok: false, erro: error.message };
  return { ok: true, id: registro.id };
}

async function acaoRemoverComentarioVideo(req: any) {
  if (!req.id) return { ok: false, erro: 'Comentário não informado.' };
  const { data: comentario } = await db.from('video_comentarios').select('*').eq('id', req.id).maybeSingle();
  if (!comentario) return { ok: false, erro: 'Comentário não encontrado.' };
  const { data: conta } = await db.from('contas').select('nome,perfil,eh_administrador').eq('id', req.contaId).maybeSingle();
  if (!conta) return { ok: false, erro: 'Conta não encontrada.' };
  if (!ehAdminEfetivo(conta) && conta.nome !== comentario.autor_nome) return { ok: false, erro: 'Você só pode apagar seus próprios comentários.' };
  await db.from('video_comentarios').delete().eq('id', req.id);
  return { ok: true };
}

/* ---------- vínculo entre atendimento e vídeos/tutoriais ---------- */
// não repete a checagem de visibilidade do vídeo (contaPodeVerVideo) aqui —
// mesma lógica já usada em "vinculos" entre chamados: quem já tem acesso ao
// atendimento (checado no front antes de chegar aqui) pode ver/gerenciar o
// que está vinculado a ele
async function acaoListarVideosDoAtendimento(req: any) {
  if (!req.atendimentoId) return { ok: false, erro: 'Atendimento não informado.' };
  const { data: vinculos, error } = await db.from('atendimento_videos').select('id,video_id').eq('atendimento_id', req.atendimentoId);
  if (error) return { ok: false, erro: error.message };
  if (!vinculos || vinculos.length === 0) return { ok: true, videos: [] };

  const videoIds = vinculos.map((v: any) => v.video_id);
  const { data: videos, error: erroVideos } = await db.from('videos_tutoriais').select('*').in('id', videoIds);
  if (erroVideos) return { ok: false, erro: erroVideos.message };
  const videosPorId: Record<string, any> = {};
  (videos || []).forEach((v: any) => { videosPorId[v.id] = v; });

  return {
    ok: true,
    videos: vinculos
      .filter((v: any) => videosPorId[v.video_id])
      .map((v: any) => ({ vinculoId: v.id, ...videoParaApi(videosPorId[v.video_id]) })),
  };
}

async function acaoVincularVideoAtendimento(req: any) {
  if (!req.atendimentoId || !req.videoId) return { ok: false, erro: 'Selecione um vídeo.' };
  const { data: existente, error: erroSelect } = await db.from('atendimento_videos').select('id')
    .eq('atendimento_id', req.atendimentoId).eq('video_id', req.videoId).maybeSingle();
  if (erroSelect) return { ok: false, erro: erroSelect.message };
  if (existente) return { ok: false, erro: 'Esse vídeo já está vinculado a este atendimento.' };

  const { error } = await db.from('atendimento_videos').insert({ id: gerarId(), atendimento_id: req.atendimentoId, video_id: req.videoId });
  if (error) return { ok: false, erro: error.message };
  return { ok: true };
}

async function acaoDesvincularVideoAtendimento(req: any) {
  if (!req.id) return { ok: false, erro: 'Vínculo não informado.' };
  await db.from('atendimento_videos').delete().eq('id', req.id);
  return { ok: true };
}

async function acaoSalvarInscricaoPush(req: any) {
  if (!req.contaId || !req.endpoint || !req.p256dh || !req.auth) return { ok: false, erro: 'Dados de inscrição incompletos.' };
  const { error } = await db.from('push_inscricoes').upsert(
    { id: gerarId(), conta_id: req.contaId, endpoint: req.endpoint, p256dh: req.p256dh, auth: req.auth },
    { onConflict: 'endpoint' }
  );
  if (error) return { ok: false, erro: error.message };
  return { ok: true };
}

async function acaoRemoverInscricaoPush(req: any) {
  if (req.endpoint) await db.from('push_inscricoes').delete().eq('endpoint', req.endpoint);
  return { ok: true };
}

// token de push nativo (FCM) do app Android — mesma ideia da inscrição web
// acima, mas guardado à parte porque não tem p256dh/auth, só o token
async function acaoSalvarTokenFcm(req: any) {
  if (!req.contaId || !req.token) return { ok: false, erro: 'Dados de inscrição incompletos.' };
  const { error } = await db.from('push_fcm_tokens').upsert(
    { id: gerarId(), conta_id: req.contaId, token: req.token },
    { onConflict: 'token' }
  );
  if (error) return { ok: false, erro: error.message };
  return { ok: true };
}

async function acaoRemoverTokenFcm(req: any) {
  if (req.token) await db.from('push_fcm_tokens').delete().eq('token', req.token);
  return { ok: true };
}

/* ---------- relatórios salvos/publicados ---------- */
// admin vê todos os que ele mesmo pode gerenciar; os demais perfis só veem
// os publicados em que o próprio perfil está na lista de "visivel_perfis"
async function acaoListarRelatoriosSalvos(req: any) {
  const { data: conta } = await db.from('contas').select('perfil,eh_administrador').eq('id', req.contaId).maybeSingle();
  if (!conta) return { ok: false, erro: 'Conta não encontrada.' };

  let query = db.from('relatorios_salvos').select('*').order('nome');
  if (!ehAdminEfetivo(conta)) {
    query = query.eq('publicado', true).contains('visivel_perfis', JSON.stringify([conta.perfil]));
  }
  const { data, error } = await query;
  if (error) return { ok: false, erro: error.message };
  return {
    ok: true,
    relatorios: (data || []).map((r: any) => ({
      id: r.id, nome: r.nome, config: r.config, visivelPerfis: r.visivel_perfis,
      publicado: r.publicado, criadoPor: r.criado_por,
    })),
  };
}

async function acaoSalvarRelatorio(req: any) {
  const { data: conta } = await db.from('contas').select('perfil,nome,eh_administrador').eq('id', req.contaId).maybeSingle();
  if (!conta || !ehAdminEfetivo(conta)) return { ok: false, erro: 'Só o admin pode criar/editar relatórios.' };
  if (!req.nome) return { ok: false, erro: 'Dê um nome ao relatório.' };

  const registro = {
    nome: req.nome,
    config: req.config || {},
    visivel_perfis: req.visivelPerfis || ['ADMIN'],
    publicado: !!req.publicado,
    criado_por: conta.nome,
    atualizado_em: new Date().toISOString(),
  };

  if (req.id) {
    const { error } = await db.from('relatorios_salvos').update(registro).eq('id', req.id);
    if (error) return { ok: false, erro: error.message };
    return { ok: true, id: req.id };
  } else {
    const id = gerarId();
    const { error } = await db.from('relatorios_salvos').insert({ id, ...registro });
    if (error) return { ok: false, erro: error.message };
    return { ok: true, id };
  }
}

async function acaoRemoverRelatorio(req: any) {
  const { data: conta } = await db.from('contas').select('perfil,eh_administrador').eq('id', req.contaId).maybeSingle();
  if (!conta || !ehAdminEfetivo(conta)) return { ok: false, erro: 'Só o admin pode remover relatórios.' };
  await db.from('relatorios_salvos').delete().eq('id', req.id);
  return { ok: true };
}

/* ---------- financeiro (lançamentos/faturas por cliente+mês) ---------- */
async function confirmarAdmin(contaId: string) {
  const { data: conta } = await db.from('contas').select('perfil,eh_administrador').eq('id', contaId).maybeSingle();
  return ehAdminEfetivo(conta);
}

// admin (ou atendente-administrador) sempre pode; senão, checa se algum
// Perfil de Acesso vinculado à conta libera o campo pedido (visualizar/
// editar/excluir/inserir) pro menu informado — usado nas ações em que faz
// sentido um perfil customizado liberar acesso além do admin
async function podeAgir(contaId: string, menu: string, campo: 'visualizar' | 'editar' | 'excluir' | 'inserir'): Promise<boolean> {
  const { data: conta } = await db.from('contas').select('perfil,eh_administrador').eq('id', contaId).maybeSingle();
  if (ehAdminEfetivo(conta)) return true;
  if (!conta) return false;
  const { data: vinculos } = await db.from('conta_perfis_acesso').select('perfil_id').eq('conta_id', contaId);
  const perfilIds = (vinculos || []).map((v: any) => v.perfil_id);
  if (perfilIds.length === 0) return false;
  const { data: permissoes } = await db.from('perfil_acesso_permissoes').select('*').in('perfil_id', perfilIds).eq('menu', menu);
  return (permissoes || []).some((p: any) => !!p[campo]);
}

function lancamentoParaApi(l: any) {
  return {
    id: l.id, cliente: l.cliente, mesReferencia: l.mes_referencia, valorTotal: Number(l.valor_total),
    atendimentoIds: l.atendimento_ids || [], dataVencimento: l.data_vencimento || '',
    dataBaixa: l.data_baixa || '', dataPrevisaoBaixa: l.data_previsao_baixa || '',
    numeroNotaFiscal: l.numero_nota_fiscal || '', status: l.status, historico: l.historico || '',
    criadoPor: l.criado_por || '',
  };
}

async function acaoListarLancamentos(req: any) {
  if (!(await confirmarAdmin(req.contaId))) return { ok: false, erro: 'Só o admin acessa o financeiro.' };
  const { data, error } = await db.from('lancamentos_financeiros').select('*').order('mes_referencia', { ascending: false }).order('criado_em', { ascending: false });
  if (error) return { ok: false, erro: error.message };
  return { ok: true, lancamentos: (data || []).map(lancamentoParaApi) };
}

async function acaoCriarLancamento(req: any) {
  if (!(await confirmarAdmin(req.contaId))) return { ok: false, erro: 'Só o admin pode criar lançamentos.' };
  if (!req.cliente || !req.mesReferencia) return { ok: false, erro: 'Cliente e mês de referência são obrigatórios.' };
  const { data: conta } = await db.from('contas').select('nome').eq('id', req.contaId).maybeSingle();
  const registro = {
    id: gerarId(), cliente: req.cliente, mes_referencia: req.mesReferencia,
    valor_total: Number(req.valorTotal) || 0, atendimento_ids: req.atendimentoIds || [],
    data_vencimento: req.dataVencimento || '', numero_nota_fiscal: req.numeroNotaFiscal || '',
    historico: req.historico || '', status: 'ABERTO', criado_por: conta ? conta.nome : '',
  };
  const { error } = await db.from('lancamentos_financeiros').insert(registro);
  if (error) return { ok: false, erro: error.message };
  return { ok: true, id: registro.id };
}

async function acaoAtualizarLancamento(req: any) {
  if (!(await confirmarAdmin(req.contaId))) return { ok: false, erro: 'Só o admin pode editar lançamentos.' };
  if (!req.id) return { ok: false, erro: 'Lançamento não informado.' };
  const atualizado: any = { atualizado_em: new Date().toISOString() };
  if (req.dataVencimento !== undefined) atualizado.data_vencimento = req.dataVencimento;
  if (req.dataPrevisaoBaixa !== undefined) atualizado.data_previsao_baixa = req.dataPrevisaoBaixa;
  if (req.numeroNotaFiscal !== undefined) atualizado.numero_nota_fiscal = req.numeroNotaFiscal;
  if (req.historico !== undefined) atualizado.historico = req.historico;
  const { error } = await db.from('lancamentos_financeiros').update(atualizado).eq('id', req.id);
  if (error) return { ok: false, erro: error.message };
  return { ok: true };
}

async function acaoBaixarLancamento(req: any) {
  if (!(await confirmarAdmin(req.contaId))) return { ok: false, erro: 'Só o admin pode dar baixa em lançamentos.' };
  if (!req.id || !req.dataBaixa) return { ok: false, erro: 'Informe a data de baixa.' };
  const { error } = await db.from('lancamentos_financeiros').update({
    status: 'BAIXADO', data_baixa: req.dataBaixa, atualizado_em: new Date().toISOString(),
  }).eq('id', req.id);
  if (error) return { ok: false, erro: error.message };
  return { ok: true };
}

async function acaoCancelarLancamento(req: any) {
  if (!(await confirmarAdmin(req.contaId))) return { ok: false, erro: 'Só o admin pode cancelar lançamentos.' };
  const { error } = await db.from('lancamentos_financeiros').update({
    status: 'CANCELADO', atualizado_em: new Date().toISOString(),
  }).eq('id', req.id);
  if (error) return { ok: false, erro: error.message };
  return { ok: true };
}

async function acaoRemoverLancamento(req: any) {
  if (!(await confirmarAdmin(req.contaId))) return { ok: false, erro: 'Só o admin pode remover lançamentos.' };
  await db.from('lancamentos_financeiros').delete().eq('id', req.id);
  return { ok: true };
}

/* ---------- notas fiscais importadas (via XML) ---------- */
function notaParaApi(n: any) {
  return {
    id: n.id, numeroNota: n.numero_nota || '', codigoVerificacao: n.codigo_verificacao || '',
    dataEmissao: n.data_emissao || '', cliente: n.cliente || '', clienteId: n.cliente_id || null,
    cnpjCpfTomador: n.cnpj_cpf_tomador || '',
    valorServicos: Number(n.valor_servicos) || 0, valorIss: Number(n.valor_iss) || 0,
    valorLiquido: Number(n.valor_liquido) || 0, discriminacao: n.discriminacao || '',
    lancamentoGeradoId: n.lancamento_gerado_id || null, importadoPor: n.importado_por || '',
    xmlOriginal: n.xml_original || '',
  };
}

async function acaoImportarNotaFiscal(req: any) {
  if (!(await confirmarAdmin(req.contaId))) return { ok: false, erro: 'Só o admin pode importar notas fiscais.' };
  const { data: conta } = await db.from('contas').select('nome').eq('id', req.contaId).maybeSingle();

  // tenta casar o CNPJ do tomador (que veio no XML) com um cliente já
  // cadastrado — se achar, usa o nome oficial do cadastro e vincula o
  // id; comparação ignora pontuação, já que CNPJ pode estar formatado
  // de jeitos diferentes em cada lugar
  const soDigitos = (s: string) => String(s || '').replace(/\D/g, '');
  let clienteId: string | null = null;
  let nomeCliente = req.cliente || '';
  const cnpjTomador = soDigitos(req.cnpjCpfTomador);
  if (cnpjTomador) {
    const { data: clientesList } = await db.from('clientes').select('id,nome,cnpj');
    const encontrado = (clientesList || []).find((c: any) => soDigitos(c.cnpj) && soDigitos(c.cnpj) === cnpjTomador);
    if (encontrado) { clienteId = encontrado.id; nomeCliente = encontrado.nome; }
  }

  const registro = {
    id: gerarId(),
    numero_nota: req.numeroNota || '', codigo_verificacao: req.codigoVerificacao || '',
    data_emissao: req.dataEmissao || '', cliente: nomeCliente, cliente_id: clienteId,
    cnpj_cpf_tomador: req.cnpjCpfTomador || '',
    valor_servicos: Number(req.valorServicos) || 0, valor_iss: Number(req.valorIss) || 0,
    valor_liquido: Number(req.valorLiquido) || 0, discriminacao: req.discriminacao || '',
    xml_original: req.xmlOriginal || '', importado_por: conta ? conta.nome : '',
  };
  const { error } = await db.from('notas_fiscais_importadas').insert(registro);
  if (error) return { ok: false, erro: error.message };
  return { ok: true, id: registro.id, clienteEncontrado: !!clienteId };
}

async function acaoListarNotasImportadas(req: any) {
  if (!(await confirmarAdmin(req.contaId))) return { ok: false, erro: 'Só o admin acessa o financeiro.' };
  const { data, error } = await db.from('notas_fiscais_importadas').select('*').order('importado_em', { ascending: false });
  if (error) return { ok: false, erro: error.message };
  return { ok: true, notas: (data || []).map(notaParaApi) };
}

async function acaoRemoverNotaImportada(req: any) {
  if (!(await confirmarAdmin(req.contaId))) return { ok: false, erro: 'Só o admin pode remover notas importadas.' };
  await db.from('notas_fiscais_importadas').delete().eq('id', req.id);
  return { ok: true };
}

async function acaoVincularNotaLancamento(req: any) {
  if (!(await confirmarAdmin(req.contaId))) return { ok: false, erro: 'Só o admin pode fazer essa ação.' };
  const { error } = await db.from('notas_fiscais_importadas').update({ lancamento_gerado_id: req.lancamentoId }).eq('id', req.notaId);
  if (error) return { ok: false, erro: error.message };
  return { ok: true };
}

/* ---------- agenda (agendamentos de visitas/atendimentos) ---------- */
function agendamentoParaApi(a: any) {
  return {
    id: a.id, titulo: a.titulo, descricao: a.descricao || '', cliente: a.cliente || '',
    atendente: a.atendente || '', data: a.data, horaInicio: a.hora_inicio, horaFim: a.hora_fim,
    cor: a.cor || '', criadoPor: a.criado_por || '',
  };
}

async function podeGerenciarAgenda(contaId: string) {
  const { data: conta } = await db.from('contas').select('perfil').eq('id', contaId).maybeSingle();
  return !!(conta && (conta.perfil === 'ADMIN' || conta.perfil === 'ATENDENTE'));
}

async function acaoListarAgendamentos(req: any) {
  const { data: conta } = await db.from('contas').select('*').eq('id', req.contaId).maybeSingle();
  if (!conta) return { ok: false, erro: 'Conta não encontrada.' };

  let query = db.from('agendamentos').select('*').order('data', { ascending: true }).order('hora_inicio', { ascending: true });
  if (conta.perfil === 'ATENDENTE') {
    query = query.eq('atendente', conta.nome);
  } else if (conta.perfil === 'USUARIO') {
    // usuário comum não vê agenda — só o "administrador do cliente" vê a
    // do próprio cliente
    if (!conta.admin_cliente || !conta.cliente_id) return { ok: true, agendamentos: [] };
    const { data: clienteInfo } = await db.from('clientes').select('nome').eq('id', conta.cliente_id).maybeSingle();
    if (!clienteInfo) return { ok: true, agendamentos: [] };
    query = query.eq('cliente', clienteInfo.nome);
  }
  const { data, error } = await query;
  if (error) return { ok: false, erro: error.message };
  return { ok: true, agendamentos: (data || []).map(agendamentoParaApi) };
}

async function acaoCriarAgendamento(req: any) {
  if (!(await podeGerenciarAgenda(req.contaId))) return { ok: false, erro: 'Sem permissão pra criar agendamento.' };
  if (!req.titulo || !req.data || !req.horaInicio || !req.horaFim) return { ok: false, erro: 'Preencha título, data e horário.' };
  const { data: conta } = await db.from('contas').select('nome').eq('id', req.contaId).maybeSingle();
  const registro = {
    id: gerarId(), titulo: req.titulo, descricao: req.descricao || '', cliente: req.cliente || '',
    atendente: req.atendente || (conta ? conta.nome : ''), data: req.data,
    hora_inicio: req.horaInicio, hora_fim: req.horaFim, cor: req.cor || null, criado_por: conta ? conta.nome : '',
  };
  const { error } = await db.from('agendamentos').insert(registro);
  if (error) return { ok: false, erro: error.message };
  return { ok: true, id: registro.id };
}

async function acaoAtualizarAgendamento(req: any) {
  if (!(await podeGerenciarAgenda(req.contaId))) return { ok: false, erro: 'Sem permissão pra editar agendamento.' };
  if (!req.id) return { ok: false, erro: 'Agendamento não informado.' };
  const atualizado: any = { atualizado_em: new Date().toISOString() };
  if (req.titulo !== undefined) atualizado.titulo = req.titulo;
  if (req.descricao !== undefined) atualizado.descricao = req.descricao;
  if (req.cliente !== undefined) atualizado.cliente = req.cliente;
  if (req.atendente !== undefined) atualizado.atendente = req.atendente;
  if (req.data !== undefined) atualizado.data = req.data;
  if (req.horaInicio !== undefined) atualizado.hora_inicio = req.horaInicio;
  if (req.horaFim !== undefined) atualizado.hora_fim = req.horaFim;
  if (req.cor !== undefined) atualizado.cor = req.cor || null;
  const { error } = await db.from('agendamentos').update(atualizado).eq('id', req.id);
  if (error) return { ok: false, erro: error.message };
  return { ok: true };
}

async function acaoRemoverAgendamento(req: any) {
  if (!(await podeGerenciarAgenda(req.contaId))) return { ok: false, erro: 'Sem permissão pra remover agendamento.' };
  await db.from('agendamentos').delete().eq('id', req.id);
  return { ok: true };
}

/* ---------- histórico ---------- */
async function registrarHistorico(atendimentoId: string, descricao: string) {
  await db.from('historico').insert({ id: gerarId(), atendimento_id: atendimentoId, descricao });
}
async function acaoListarHistorico(req: any) {
  const { data } = await db.from('historico').select('*').eq('atendimento_id', req.atendimentoId).order('data_hora');
  return { ok: true, historico: (data || []).map(historicoParaApi) };
}

// Vínculos entre chamados: cada linha na tabela "vinculos" é uma ligação
// entre dois atendimentos (não tem "pai"/"filho" — a ligação vale pros dois
// lados). Devolve todos os atendimentos ligados a este, com a soma das
// horas de todo mundo — sem gravar total em lugar nenhum, calcula na hora.
async function acaoListarVinculados(req: any) {
  const { data: atual } = await db.from('atendimentos').select('id,qtd').eq('id', req.atendimentoId).maybeSingle();
  if (!atual) return { ok: false, erro: 'Atendimento não encontrado.' };

  const [{ data: comoA }, { data: comoB }] = await Promise.all([
    db.from('vinculos').select('id,atendimento_b').eq('atendimento_a', req.atendimentoId),
    db.from('vinculos').select('id,atendimento_a').eq('atendimento_b', req.atendimentoId),
  ]);

  const ligacoes = [
    ...(comoA || []).map((v: any) => ({ vinculoId: v.id, outroId: v.atendimento_b })),
    ...(comoB || []).map((v: any) => ({ vinculoId: v.id, outroId: v.atendimento_a })),
  ];

  let vinculados: any[] = [];
  if (ligacoes.length > 0) {
    const ids = ligacoes.map((l) => l.outroId);
    const { data } = await db.from('atendimentos').select('id,data,cliente,usuario,detalhe,qtd,status').in('id', ids);
    vinculados = (data || []).map((r: any) => ({ ...r, vinculoId: ligacoes.find((l) => l.outroId === r.id)?.vinculoId }));
  }

  const horasVinculados = vinculados.reduce((s: number, r: any) => s + Number(r.qtd || 0), 0);

  return {
    ok: true,
    vinculados,
    horasProprio: Number(atual.qtd || 0),
    horasTotais: Number(atual.qtd || 0) + horasVinculados,
  };
}

async function acaoAdicionarVinculo(req: any) {
  if (!req.atendimentoId || !req.outroId) return { ok: false, erro: 'Selecione um chamado.' };
  if (String(req.atendimentoId) === String(req.outroId)) return { ok: false, erro: 'Um chamado não pode se vincular a si mesmo.' };

  const { data: existente, error: erroSelect } = await db.from('vinculos').select('id')
    .or(`and(atendimento_a.eq.${req.atendimentoId},atendimento_b.eq.${req.outroId}),and(atendimento_a.eq.${req.outroId},atendimento_b.eq.${req.atendimentoId})`);
  if (erroSelect) return { ok: false, erro: erroSelect.message };
  if (existente && existente.length > 0) return { ok: false, erro: 'Esses chamados já estão vinculados.' };

  const { error } = await db.from('vinculos').insert({ id: gerarId(), atendimento_a: req.atendimentoId, atendimento_b: req.outroId });
  if (error) return { ok: false, erro: error.message };
  return { ok: true };
}

async function acaoRemoverVinculo(req: any) {
  await db.from('vinculos').delete().eq('id', req.id);
  return { ok: true };
}

// Altera o status de vários atendimentos de uma vez (admin ou atendente).
// Registra uma entrada de histórico por atendimento que realmente mudou.
async function acaoAlterarStatusEmMassa(req: any) {
  const { data: conta, error: erroConta } = await db.from('contas').select('perfil,nome').eq('id', req.contaId).maybeSingle();
  if (erroConta) return { ok: false, erro: 'Erro ao verificar permissão: ' + erroConta.message };
  if (!conta || (conta.perfil !== 'ADMIN' && conta.perfil !== 'ATENDENTE')) {
    return { ok: false, erro: 'Sem permissão pra alterar status em massa.' };
  }

  const ids: string[] = Array.isArray(req.ids) ? req.ids : [];
  if (ids.length === 0) return { ok: false, erro: 'Nenhum atendimento selecionado.' };
  if (!req.novoStatus) return { ok: false, erro: 'Escolha um status.' };

  const { data: atuais, error: erroSelect } = await db.from('atendimentos').select('id,status').in('id', ids);
  if (erroSelect) return { ok: false, erro: 'Erro ao ler atendimentos: ' + erroSelect.message };

  let atualizados = 0;
  for (const a of atuais || []) {
    if (a.status === req.novoStatus) continue;
    const { error } = await db.from('atendimentos').update({ status: req.novoStatus }).eq('id', a.id);
    if (!error) {
      atualizados++;
      await registrarHistorico(a.id, `Status alterado de ${a.status} para ${req.novoStatus} (alteração em massa por ${conta.nome})`);
    }
  }

  return { ok: true, total: ids.length, atualizados };
}

/* ---------- mensagens (bate-papo) ---------- */
async function acaoListarMensagens(req: any) {
  const { data } = await db.from('mensagens').select('*').eq('atendimento_id', req.atendimentoId).order('data_hora');
  return { ok: true, mensagens: (data || []).map(mensagemParaApi) };
}
async function acaoEnviarMensagem(req: any) {
  if (!req.atendimentoId || !String(req.texto || '').trim()) return { ok: false, erro: 'Mensagem vazia.' };
  const texto = String(req.texto).trim();
  await db.from('mensagens').insert({
    id: gerarId(), atendimento_id: req.atendimentoId, autor_nome: req.autorNome,
    autor_perfil: req.autorPerfil, texto,
  });
  await notificarNovaMensagem(req.atendimentoId, req.autorNome, req.autorPerfil, texto);
  return { ok: true };
}

/* ---------- contas (atendentes / usuários) ---------- */
async function acaoAddConta(req: any, perfil: string) {
  const { data: existente } = await db.from('contas').select('id').ilike('login', req.login).maybeSingle();
  if (existente) return { ok: false, erro: 'Esse login já existe.' };
  const conta = {
    id: gerarId(), nome: req.nome, login: req.login, senha: req.senha, perfil,
    cliente_id: req.clienteId || null, email: req.email || '', telefone: req.telefone || '',
    admin_cliente: !!req.adminCliente,
    // só faz sentido pra ATENDENTE — usuário tem seu próprio flag (admin_cliente)
    eh_administrador: perfil === 'ATENDENTE' ? !!req.ehAdministrador : false,
  };
  const { error } = await db.from('contas').insert(conta);
  if (error) return { ok: false, erro: error.message };
  return { ok: true, conta: contaParaApi(conta) };
}

async function acaoAtualizarConta(req: any) {
  const { data: existente } = await db.from('contas').select('*').eq('id', req.id).maybeSingle();
  if (!existente) return { ok: false, erro: 'Conta não encontrada.' };

  if (String(req.login).toLowerCase() !== String(existente.login).toLowerCase()) {
    const { data: outraConta } = await db.from('contas').select('id').ilike('login', req.login).neq('id', req.id).maybeSingle();
    if (outraConta) return { ok: false, erro: 'Esse login já existe.' };
  }

  const atualizado: any = {
    nome: req.nome, login: req.login,
    cliente_id: req.clienteId !== undefined ? req.clienteId : existente.cliente_id,
    email: req.email !== undefined ? req.email : existente.email,
    telefone: req.telefone !== undefined ? req.telefone : existente.telefone,
    admin_cliente: req.adminCliente !== undefined ? !!req.adminCliente : existente.admin_cliente,
    eh_administrador: req.ehAdministrador !== undefined ? !!req.ehAdministrador : existente.eh_administrador,
  };
  if (req.senha) atualizado.senha = req.senha; // em branco = mantém a senha atual

  const { error } = await db.from('contas').update(atualizado).eq('id', req.id);
  if (error) return { ok: false, erro: error.message };
  return { ok: true };
}

// Troca de senha feita pelo próprio usuário (admin, atendente ou usuário
// solicitante) — exige a senha atual certa, diferente da edição pelo admin
// em Cadastros (que não pede a senha atual).
async function acaoAlterarMinhaSenha(req: any) {
  const { data: conta, error: erroSelect } = await db.from('contas').select('*').eq('id', req.contaId).maybeSingle();
  if (erroSelect) return { ok: false, erro: erroSelect.message };
  if (!conta) return { ok: false, erro: 'Conta não encontrada.' };
  if (String(conta.senha) !== String(req.senhaAtual)) return { ok: false, erro: 'Senha atual incorreta.' };
  if (!req.novaSenha || String(req.novaSenha).length < 4) return { ok: false, erro: 'A nova senha precisa ter pelo menos 4 caracteres.' };

  const { error } = await db.from('contas').update({ senha: req.novaSenha }).eq('id', req.contaId);
  if (error) return { ok: false, erro: error.message };
  return { ok: true };
}

async function acaoRemoverConta(req: any) {
  await db.from('contas').delete().eq('id', req.id);
  return { ok: true };
}

/* ---------- perfis de acesso (menus x visualizar/editar/excluir/inserir) ---------- */
async function acaoListarPerfisAcesso(req: any) {
  if (!(await confirmarAdmin(req.contaId))) return { ok: false, erro: 'Só o admin pode gerenciar perfis de acesso.' };
  const [{ data: perfisRaw, error }, { data: permissoesRaw }] = await Promise.all([
    db.from('perfis_acesso').select('*').order('nome'),
    db.from('perfil_acesso_permissoes').select('*'),
  ]);
  if (error) return { ok: false, erro: error.message };
  const perfis = (perfisRaw || []).map((p: any) => {
    const permissoes = permissaoVaziaPorMenu();
    (permissoesRaw || []).filter((pp: any) => pp.perfil_id === p.id).forEach((pp: any) => {
      permissoes[pp.menu] = { visualizar: !!pp.visualizar, editar: !!pp.editar, excluir: !!pp.excluir, inserir: !!pp.inserir };
    });
    return { id: p.id, nome: p.nome, permissoes };
  });
  return { ok: true, perfis };
}

async function acaoSalvarPerfilAcesso(req: any) {
  if (!(await confirmarAdmin(req.contaId))) return { ok: false, erro: 'Só o admin pode gerenciar perfis de acesso.' };
  const nome = String(req.nome || '').trim();
  if (!nome) return { ok: false, erro: 'Dê um nome ao perfil.' };
  const permissoes = req.permissoes || {};

  const id = req.id || gerarId();
  if (req.id) {
    const { error } = await db.from('perfis_acesso').update({ nome }).eq('id', id);
    if (error) return { ok: false, erro: error.message };
    await db.from('perfil_acesso_permissoes').delete().eq('perfil_id', id);
  } else {
    const { error } = await db.from('perfis_acesso').insert({ id, nome });
    if (error) return { ok: false, erro: error.message };
  }

  const linhas = MENUS_PERFIL_ACESSO.map((menu) => {
    const p = permissoes[menu] || {};
    return {
      id: gerarId(), perfil_id: id, menu,
      visualizar: !!p.visualizar, editar: !!p.editar, excluir: !!p.excluir, inserir: !!p.inserir,
    };
  });
  const { error: erroPermissoes } = await db.from('perfil_acesso_permissoes').insert(linhas);
  if (erroPermissoes) return { ok: false, erro: erroPermissoes.message };

  return { ok: true, id };
}

async function acaoRemoverPerfilAcesso(req: any) {
  if (!(await confirmarAdmin(req.contaId))) return { ok: false, erro: 'Só o admin pode gerenciar perfis de acesso.' };
  await db.from('perfis_acesso').delete().eq('id', req.id);
  return { ok: true };
}

// substitui por completo os perfis vinculados à conta alvo (mais simples
// e previsível do que calcular um diff — a tela sempre manda a lista
// completa de perfis marcados no momento de salvar)
async function acaoVincularPerfisConta(req: any) {
  if (!(await confirmarAdmin(req.contaId))) return { ok: false, erro: 'Só o admin pode vincular perfis de acesso.' };
  if (!req.contaAlvoId) return { ok: false, erro: 'Conta não informada.' };
  const perfilIds: string[] = Array.isArray(req.perfilIds) ? req.perfilIds : [];

  const { error: erroDelete } = await db.from('conta_perfis_acesso').delete().eq('conta_id', req.contaAlvoId);
  if (erroDelete) return { ok: false, erro: erroDelete.message };
  if (perfilIds.length > 0) {
    const linhas = perfilIds.map((perfilId) => ({ id: gerarId(), conta_id: req.contaAlvoId, perfil_id: perfilId }));
    const { error: erroInsert } = await db.from('conta_perfis_acesso').insert(linhas);
    if (erroInsert) return { ok: false, erro: erroInsert.message };
  }
  return { ok: true };
}

/* ---------- cadastros simples (clientes, tipos, módulos, sub módulos, status) ---------- */
async function acaoAddSimples(tabela: string, req: any) {
  const registro = { id: gerarId(), nome: req.nome };
  const { error } = await db.from(tabela).insert(registro);
  if (error) return { ok: false, erro: error.message };
  return { ok: true, registro };
}
async function acaoRemoverSimples(tabela: string, req: any) {
  await db.from(tabela).delete().eq('id', req.id);
  return { ok: true };
}
async function acaoRemoverCliente(req: any) {
  await db.from('clientes').delete().eq('id', req.id);
  await db.from('valores').delete().eq('cliente_id', req.id);
  await db.from('contas').delete().eq('perfil', 'USUARIO').eq('cliente_id', req.id);
  return { ok: true };
}
async function acaoAddCliente(req: any) {
  const registro = { id: gerarId(), nome: req.nome, cnpj: req.cnpj || '', nome_fantasia: req.nomeFantasia || '' };
  const { error } = await db.from('clientes').insert(registro);
  if (error) return { ok: false, erro: error.message };
  return { ok: true, registro: clienteParaApi(registro) };
}
async function acaoAtualizarCliente(req: any) {
  if (!req.id) return { ok: false, erro: 'Cliente não informado.' };
  const atualizado: any = {};
  if (req.nome !== undefined) atualizado.nome = req.nome;
  if (req.cnpj !== undefined) atualizado.cnpj = req.cnpj;
  if (req.nomeFantasia !== undefined) atualizado.nome_fantasia = req.nomeFantasia;
  const { error } = await db.from('clientes').update(atualizado).eq('id', req.id);
  if (error) return { ok: false, erro: error.message };
  return { ok: true };
}
async function acaoRemoverTipo(req: any) {
  await db.from('tipos').delete().eq('id', req.id);
  await db.from('valores').delete().eq('tipo_id', req.id);
  return { ok: true };
}

// recebe a lista completa de ids de status na nova ordem desejada e regrava
// o campo "ordem" de cada um (0,1,2...) — usada pelos botões ▲▼ em
// Cadastros → Status, e reflete direto na ordem das colunas do Kanban
async function acaoReordenarStatus(req: any) {
  if (!(await confirmarAdmin(req.contaId))) return { ok: false, erro: 'Só o admin pode reordenar status.' };
  const ids: string[] = Array.isArray(req.ids) ? req.ids : [];
  for (let i = 0; i < ids.length; i++) {
    await db.from('status_list').update({ ordem: i }).eq('id', ids[i]);
  }
  return { ok: true };
}

/* ---------- valores/hora ---------- */
async function acaoSalvarValor(req: any) {
  // sem .maybeSingle(): se por acaso já existir mais de uma linha duplicada
  // pra essa combinação (era o que causava valor zerado ao salvar
  // atendimento), isso não quebra — junta tudo numa lista e limpa o excesso.
  const { data: existentes, error: erroSelect } = await db.from('valores').select('id')
    .eq('atendente_id', req.atendenteId).eq('cliente_id', req.clienteId).eq('tipo_id', req.tipoId);
  if (erroSelect) return { ok: false, erro: erroSelect.message };

  const id = (existentes && existentes[0]) ? existentes[0].id : gerarId();
  const { error } = await db.from('valores').upsert(
    { id, atendente_id: req.atendenteId, cliente_id: req.clienteId, tipo_id: req.tipoId, real: req.real, ananda: req.ananda },
    { onConflict: 'atendente_id,cliente_id,tipo_id' }
  );
  if (error) return { ok: false, erro: error.message };

  // limpeza automática: apaga duplicatas antigas dessa mesma combinação, se sobrou alguma
  if (existentes && existentes.length > 1) {
    const idsExtras = existentes.slice(1).map((e: any) => e.id);
    await db.from('valores').delete().in('id', idsExtras);
  }

  return { ok: true };
}

// Recalcula vhr/vha/totalReal/totalAnanda com base na tabela de valores
// atual — só quando encontra uma combinação atendente+cliente+tipo com
// valor cadastrado. Se não encontrar (nome não bate, tabela auxiliar veio
// vazia por qualquer motivo, etc.), PULA aquele atendimento sem tocar nele
// — nunca zera um valor que já existia. É intencionalmente "tudo ou nada"
// nas consultas: se qualquer uma falhar, aborta sem escrever nada, em vez
// de seguir em frente como se as tabelas estivessem vazias (foi isso que
// causou os valores zerados numa versão anterior desta função).
async function acaoRecalcularValores(req: any) {
  const { data: conta, error: erroConta } = await db.from('contas').select('perfil,eh_administrador').eq('id', req.contaId).maybeSingle();
  if (erroConta) return { ok: false, erro: 'Erro ao verificar permissão: ' + erroConta.message };
  if (!conta || !ehAdminEfetivo(conta)) return { ok: false, erro: 'Só o admin pode recalcular valores.' };

  const [rAtendimentos, rValores, rClientes, rTipos, rContas] = await Promise.all([
    db.from('atendimentos').select('*'),
    db.from('valores').select('*'),
    db.from('clientes').select('*'),
    db.from('tipos').select('*'),
    db.from('contas').select('*').eq('perfil', 'ATENDENTE'),
  ]);

  // se qualquer uma das 5 consultas falhar, para tudo — não escreve nada
  for (const r of [rAtendimentos, rValores, rClientes, rTipos, rContas]) {
    if (r.error) return { ok: false, erro: 'Erro ao ler dados, nada foi alterado: ' + r.error.message };
  }

  const clientes = rClientes.data || [];
  const tipos = rTipos.data || [];
  const contasAtendentes = rContas.data || [];
  const valores = rValores.data || [];
  const lista = rAtendimentos.data || [];

  // proteção extra: se a tabela de valores voltou vazia, tem algo muito
  // errado (você confirmou que ela tem dados) — melhor abortar do que
  // recalcular tudo pra zero
  if (valores.length === 0) return { ok: false, erro: 'A tabela de valores voltou vazia — abortado por segurança. Confira Cadastros → Valores antes de tentar de novo.' };

  let atualizados = 0;
  let semCorrespondencia = 0;
  for (const a of lista) {
    const cliente = clientes.find((c: any) => c.nome === a.cliente);
    const tipo = tipos.find((t: any) => t.nome === a.tipo);
    const contaAtendente = a.atendente ? contasAtendentes.find((c: any) => c.nome === a.atendente) : null;

    if (!cliente || !tipo || !contaAtendente) { semCorrespondencia++; continue; }
    const valor = valores.find((v: any) => v.atendente_id === contaAtendente.id && v.cliente_id === cliente.id && v.tipo_id === tipo.id);
    if (!valor) { semCorrespondencia++; continue; } // não encontrado — pula, não zera

    const real = Number(valor.real);
    const ananda = Number(valor.ananda);
    const qtd = Number(a.qtd) || 0;
    const novoTotalReal = qtd * real;
    const novoTotalAnanda = qtd * ananda;
    const mudou = Number(a.vhr) !== real || Number(a.vha) !== ananda ||
      Number(a.total_real) !== novoTotalReal || Number(a.total_ananda) !== novoTotalAnanda;

    if (mudou) {
      const { error } = await db.from('atendimentos').update({ vhr: real, vha: ananda, total_real: novoTotalReal, total_ananda: novoTotalAnanda }).eq('id', a.id);
      if (!error) atualizados++;
    }
  }

  return { ok: true, total: lista.length, atualizados, semCorrespondencia };
}

/* ---------- entrada HTTP ---------- */
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return jsonResponse({ erro: 'método não suportado' }, 405);

  try {
    const corpo = await req.json();
    const resposta = await rotear(corpo);
    return jsonResponse(resposta);
  } catch (erro) {
    return jsonResponse({ erro: String(erro) }, 500);
  }
});
