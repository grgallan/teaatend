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

// data de hoje em yyyy-MM-dd — usada pra preencher a Data Final (Prevista)
// automaticamente quando um atendimento vira CONCLUÍDO sem ela já ter sido informada
function dataAtualIso(): string {
  return new Date().toISOString().slice(0, 10);
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
  // usa getHours()/etc, que refletem o fuso do servidor (UTC no Deno Deploy) — não o de
  // Fortaleza. Fixando o fuso aqui em vez de depender do relógio local do servidor.
  return d.toLocaleString('sv-SE', { timeZone: 'America/Fortaleza' });
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

// duração (em horas) de UMA movimentação com apuração de tempo — usa data +
// horário dos dois lados (não só horário, como o calcularQtd antigo) porque
// o período de trabalho registrado pode virar a virada do dia
function calcularQtdMovimentacao(dataInicial: string, horaInicial: string, dataFinal: string, horaFinal: string, intervaloMin?: number): number {
  const ini = new Date(`${dataInicial}T${horaInicial}:00`).getTime();
  const fim = new Date(`${dataFinal}T${horaFinal}:00`).getTime();
  const totalMin = Math.max(0, (fim - ini) / 60000 - (Number(intervaloMin) || 0));
  return totalMin / 60;
}

// true se os dois períodos (cada um com data+horário inicial/final) se
// cruzam em algum ponto — usado pra impedir duas movimentações do mesmo
// atendimento cobrindo o mesmo intervalo de tempo
function periodosSeSobrepoem(aIni: string, aFim: string, bIni: string, bFim: string): boolean {
  return new Date(aIni).getTime() < new Date(bFim).getTime() && new Date(bIni).getTime() < new Date(aFim).getTime();
}

// procura, entre as movimentações de TODOS os atendimentos do mesmo cliente
// (não só deste atendimento — o mesmo cliente não pode ter duas
// movimentações cobrindo o mesmo período, esteja isso num chamado ou em
// vários), uma que sobreponha o período informado — ignorarId serve pra uma
// movimentação não "colidir consigo mesma" ao ser editada
async function acharMovimentacaoSobreposta(atendimentoId: string, dataInicial: string, horaInicial: string, dataFinal: string, horaFinal: string, ignorarId?: string) {
  const { data: atendimentoAtual } = await db.from('atendimentos').select('cliente').eq('id', atendimentoId).maybeSingle();
  if (!atendimentoAtual) return null;
  const { data: atendimentosMesmoCliente } = await db.from('atendimentos').select('id').eq('cliente', atendimentoAtual.cliente);
  const idsAtendimentos = (atendimentosMesmoCliente || []).map((a: any) => a.id);
  if (idsAtendimentos.length === 0) return null;

  const { data: movs } = await db.from('movimentacoes')
    .select('id,autor_nome,atendimento_id,data_inicial,hora_inicial,data_final,hora_final')
    .in('atendimento_id', idsAtendimentos);
  const novaIni = `${dataInicial}T${horaInicial}:00`, novaFim = `${dataFinal}T${horaFinal}:00`;
  for (const m of (movs || [])) {
    if (ignorarId && m.id === ignorarId) continue;
    if (!m.data_inicial || !m.hora_inicial || !m.data_final || !m.hora_final) continue;
    const ini = `${m.data_inicial}T${m.hora_inicial}:00`, fim = `${m.data_final}T${m.hora_final}:00`;
    if (periodosSeSobrepoem(novaIni, novaFim, ini, fim)) return m;
  }
  return null;
}

// soma as horas de todas as movimentações do atendimento que já têm
// Data/Horário Inicial e Final preenchidos — retorna null se nenhuma tiver
// (nesse caso o chamador deve continuar usando o cálculo antigo, baseado
// nos campos hi/inter/hf do próprio atendimento)
async function qtdApartirDeMovimentacoes(atendimentoId: string): Promise<number | null> {
  const { data: movs } = await db.from('movimentacoes')
    .select('data_inicial,hora_inicial,data_final,hora_final,intervalo_min')
    .eq('atendimento_id', atendimentoId);
  const comTempo = (movs || []).filter((m: any) => m.data_inicial && m.hora_inicial && m.data_final && m.hora_final);
  if (comTempo.length === 0) return null;
  return comTempo.reduce((s: number, m: any) => s + calcularQtdMovimentacao(m.data_inicial, m.hora_inicial, m.data_final, m.hora_final, m.intervalo_min), 0);
}

// chamado depois de criar/editar/remover uma movimentação com tempo — refaz
// a Qtd do atendimento (e o dinheiro que depende dela) a partir da soma das
// movimentações; se a que sobrou/removida era a última com tempo apurado,
// volta a calcular pelos campos antigos hi/inter/hf do atendimento
async function recalcularQtdAtendimento(atendimentoId: string) {
  const { data: at } = await db.from('atendimentos').select('vha,vhr,hi,hf,inter').eq('id', atendimentoId).maybeSingle();
  if (!at) return;
  const qtdMov = await qtdApartirDeMovimentacoes(atendimentoId);
  const qtd = qtdMov !== null ? qtdMov : calcularQtd(at.hi, at.hf, at.inter);
  const vha = Number(at.vha) || 0, vhr = Number(at.vhr) || 0;
  await db.from('atendimentos').update({ qtd, total_ananda: qtd * vha, total_real: qtd * vhr }).eq('id', atendimentoId);
}

// conta ADMIN sempre tem acesso total; conta ATENDENTE marcada com o flag
// "eh_administrador" (Cadastros → Atendentes) passa a ter os mesmos
// privilégios de administrador do sistema, sem deixar de ser atendente
// (continua podendo ser escolhida como atendente nos chamados)
function ehAdminEfetivo(conta: any): boolean {
  return !!conta && (conta.perfil === 'ADMIN' || (conta.perfil === 'ATENDENTE' && !!conta.eh_administrador));
}

/* ---------- conversores linha (snake_case do banco) -> objeto da API (camelCase) ---------- */
function contaParaApi(c: any, comSenha = false, perfisAcessoIds: string[] = [], empresaIds: string[] = []) {
  const base: any = { id: c.id, nome: c.nome, login: c.login, perfil: c.perfil, clienteId: c.cliente_id, email: c.email || '', telefone: c.telefone || '', adminCliente: c.admin_cliente || false, ehAdministrador: c.eh_administrador || false, perfisAcessoIds, empresaIds };
  if (comSenha) base.senha = c.senha;
  return base;
}

// menus válidos pra Perfis de Acesso — precisa bater com o MENUS_PERFIL_ACESSO
// do app.js (Atendimentos, Resumo, Dashboard, Cronograma, Construtor de
// Relatórios, Relatórios, Financeiro, Agenda, Vídeos, Cadastros, Utilitários),
// incluindo os submenus (abas internas) na forma "menu.submenu"
const MENUS_PERFIL_ACESSO = [
  'atendimentos', 'resumo',
  'dashboard', 'dashboard.geral', 'dashboard.operacional', 'dashboard.comparativo',
  'cronograma',
  'construtor_relatorios', 'relatorios',
  'financeiro', 'financeiro.lancar', 'financeiro.importar', 'financeiro.lista', 'financeiro.resumo',
  'agenda', 'agenda.novo', 'agenda.calendario',
  'videos', 'videos.novo', 'videos.lista',
  'cadastros', 'cadastros.atendentes', 'cadastros.clientes', 'cadastros.tipos', 'cadastros.modulos',
  'cadastros.submodulos', 'cadastros.status', 'cadastros.valores', 'cadastros.usuarios',
  'cadastros.perfisacesso', 'cadastros.empresas',
  'cadastros.tabelasrm', 'cadastros.camposrm', 'cadastros.relacionamentosrm', 'cadastros.tabelasauxrm',
  'utilitarios', 'utilitarios.esocial', 'utilitarios.tomticket', 'utilitarios.sqlrm',
];

function permissaoVaziaPorMenu() {
  const obj: Record<string, any> = {};
  for (const m of MENUS_PERFIL_ACESSO) obj[m] = { visualizar: false, editar: false, excluir: false, inserir: false };
  return obj;
}
function valorParaApi(v: any) {
  return { id: v.id, atendenteId: v.atendente_id, clienteId: v.cliente_id, tipoId: v.tipo_id, real: v.real, ananda: v.ananda, valorSegundoAtend: v.valor_segundo_atend || 0 };
}
function atendimentoParaApi(a: any) {
  return {
    id: a.id, data: a.data, mes: a.mes, cliente: a.cliente, usuario: a.usuario, tipo: a.tipo,
    modulo: a.modulo, submodulo: a.submodulo, atendente: a.atendente, assunto: a.assunto || '', detalhe: a.detalhe,
    hi: a.hi, inter: a.inter, hf: a.hf, qtd: a.qtd, vha: a.vha, totalAnanda: a.total_ananda,
    vhr: a.vhr, totalReal: a.total_real, status: a.status, anexoUrl: a.anexo_url, anexoNome: a.anexo_nome,
    solucao: a.solucao || '', dataPrevista: a.data_prevista || '',
    atendente2: a.atendente2 || '', horasAtendente2: a.horas_atendente2 || 0,
    vha2: a.vha2 || 0, totalAnanda2: a.total_ananda2 || 0,
    emValidacaoDesde: a.em_validacao_desde || '',
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
  return { id: c.id, nome: c.nome, cnpj: c.cnpj || '', nomeFantasia: c.nome_fantasia || '', empresaId: c.empresa_id || '', metaMensal: c.meta_mensal || 0 };
}
function empresaParaApi(e: any) {
  return {
    id: e.id, nome: e.nome, nomeFantasia: e.nome_fantasia || '', cnpj: e.cnpj || '',
    endereco: e.endereco || '', telefone: e.telefone || '', email: e.email || '', cidade: e.cidade || '',
    cnae: e.cnae || '', inscricaoMunicipal: e.inscricao_municipal || '', inscricaoEstadual: e.inscricao_estadual || '',
    logoUrl: e.logo_url || '', padrao: !!e.padrao,
    horasValidacaoAutomatica: e.horas_validacao_automatica || 48,
  };
}

/* ---------- roteador ---------- */
async function rotear(req: any): Promise<any> {
  switch (req.action) {
    case 'login': return acaoLogin(req);
    case 'dados': return acaoDados(req);
    case 'salvarAtendimento': return acaoSalvarAtendimento(req);
    case 'excluirAtendimento': return acaoExcluirAtendimento(req);
    case 'aprovarValidacao': return acaoAprovarValidacao(req);
    case 'rejeitarValidacao': return acaoRejeitarValidacao(req);
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
    case 'listarAtividades': return acaoListarAtividades(req);
    case 'criarAtividade': return acaoCriarAtividade(req);
    case 'atualizarAtividade': return acaoAtualizarAtividade(req);
    case 'alternarConclusaoAtividade': return acaoAlternarConclusaoAtividade(req);
    case 'removerAtividade': return acaoRemoverAtividade(req);
    case 'removerSerieAtividade': return acaoRemoverSerieAtividade(req);
    case 'listarAnexosAtividade': return acaoListarAnexosAtividade(req);
    case 'adicionarAnexoAtividade': return acaoAdicionarAnexoAtividade(req);
    case 'removerAnexoAtividade': return acaoRemoverAnexoAtividade(req);
    case 'listarOrcamentos': return acaoListarOrcamentos(req);
    case 'obterOrcamento': return acaoObterOrcamento(req);
    case 'salvarOrcamento': return acaoSalvarOrcamento(req);
    case 'removerOrcamento': return acaoRemoverOrcamento(req);
    case 'removerConta': return acaoRemoverConta(req);
    case 'addCliente': return acaoAddCliente(req);
    case 'atualizarCliente': return acaoAtualizarCliente(req);
    case 'removerCliente': return acaoRemoverCliente(req);
    case 'addTipo': return acaoAddSimples('tipos', 'cadastros.tipos', req);
    case 'removerTipo': return acaoRemoverTipo(req);
    case 'addModulo': return acaoAddSimples('modulos', 'cadastros.modulos', req);
    case 'removerModulo': return acaoRemoverSimples('modulos', 'cadastros.modulos', req);
    case 'addSubModulo': return acaoAddSimples('submodulos', 'cadastros.submodulos', req);
    case 'removerSubModulo': return acaoRemoverSimples('submodulos', 'cadastros.submodulos', req);
    case 'addStatus': return acaoAddSimples('status_list', 'cadastros.status', req);
    case 'removerStatus': return acaoRemoverSimples('status_list', 'cadastros.status', req);
    case 'reordenarStatus': return acaoReordenarStatus(req);
    case 'salvarValor': return acaoSalvarValor(req);
    case 'removerValor': return acaoRemoverSimples('valores', 'cadastros.valores', req);
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
    case 'registrarVisualizacaoVideo': return acaoRegistrarVisualizacaoVideo(req);
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
    case 'empresaPadrao': return acaoEmpresaPadrao(req);
    case 'minhasEmpresas': return acaoMinhasEmpresas(req);
    case 'salvarEmpresa': return acaoSalvarEmpresa(req);
    case 'removerEmpresa': return acaoRemoverEmpresa(req);
    case 'vincularEmpresasConta': return acaoVincularEmpresasConta(req);
    case 'removerTomticketErro': return acaoRemoverTomticketErro(req);
    case 'rmListarTabelas': return acaoRmListarTabelas(req);
    case 'rmAddTabela': return acaoRmAddTabela(req);
    case 'rmAtualizarTabela': return acaoRmAtualizarTabela(req);
    case 'rmRemoverTabela': return acaoRmRemoverTabela(req);
    case 'rmImportarDicionarioLote': return acaoRmImportarDicionarioLote(req);
    case 'rmListarCampos': return acaoRmListarCampos(req);
    case 'rmAddCampo': return acaoRmAddCampo(req);
    case 'rmAtualizarCampo': return acaoRmAtualizarCampo(req);
    case 'rmRemoverCampo': return acaoRmRemoverCampo(req);
    case 'rmListarRelacionamentos': return acaoRmListarRelacionamentos(req);
    case 'rmListarRelacionamentosDe': return acaoRmListarRelacionamentosDe(req);
    case 'rmAddRelacionamento': return acaoRmAddRelacionamento(req);
    case 'rmAtualizarRelacionamento': return acaoRmAtualizarRelacionamento(req);
    case 'rmRemoverRelacionamento': return acaoRmRemoverRelacionamento(req);
    case 'rmImportarRelacionamentosLote': return acaoRmImportarRelacionamentosLote(req);
    case 'rmListarTabelasAuxiliares': return acaoRmListarTabelasAuxiliares(req);
    case 'rmMarcarAuxiliar': return acaoRmMarcarAuxiliar(req);
    case 'rmListarConsultasSalvas': return acaoRmListarConsultasSalvas(req);
    case 'rmSalvarConsulta': return acaoRmSalvarConsulta(req);
    case 'rmRemoverConsulta': return acaoRmRemoverConsulta(req);
    // versões públicas (sem login) — usadas só pela página separada
    // gerador-sql-rm.html; nunca leem/gravam nada fora das tabelas rm_*
    case 'rmPublicoListarTabelas': return acaoRmPublicoListarTabelas(req);
    case 'rmPublicoListarCampos': return acaoRmPublicoListarCampos(req);
    case 'rmPublicoListarRelacionamentosDe': return acaoRmPublicoListarRelacionamentosDe(req);
    default: return { erro: 'ação desconhecida: ' + req.action };
  }
}

/* ---------- login / dados ---------- */
// ADMIN "de verdade" sempre vê todas as empresas (mesmo bypass que ele já
// tem em qualquer outra permissão); ATENDENTE só as que foram vinculadas a
// ele em Cadastros → Atendentes; USUARIO fica preso à empresa do próprio
// cliente dele, sem escolha nenhuma. Usado no login e na troca de empresa
// dentro do app (mesma conta, sem precisar digitar a senha de novo).
async function resolverEmpresasDaConta(contaRow: any): Promise<{ empresas?: any[]; empresa?: any }> {
  // só o ADMIN "de verdade" (perfil = ADMIN) vê todas as empresas — um
  // ATENDENTE marcado como administrador continua restrito só às empresas
  // vinculadas a ele (ehAdminEfetivo daria full-access indevido aqui)
  if (contaRow.perfil === 'ADMIN') {
    const { data: todasEmpresas } = await db.from('empresas').select('*').order('nome');
    return { empresas: (todasEmpresas || []).map(empresaParaApi) };
  }
  if (contaRow.perfil === 'ATENDENTE') {
    const { data: vinculosEmpresa } = await db.from('conta_empresas').select('empresa_id').eq('conta_id', contaRow.id);
    const ids = (vinculosEmpresa || []).map((v: any) => v.empresa_id);
    const { data: empresasLigadas } = ids.length
      ? await db.from('empresas').select('*').in('id', ids).order('nome')
      : { data: [] as any[] };
    return { empresas: (empresasLigadas || []).map(empresaParaApi) };
  }
  if (contaRow.cliente_id) {
    const { data: clienteConta } = await db.from('clientes').select('empresa_id').eq('id', contaRow.cliente_id).maybeSingle();
    if (clienteConta && clienteConta.empresa_id) {
      const { data: empresaUsuario } = await db.from('empresas').select('*').eq('id', clienteConta.empresa_id).maybeSingle();
      if (empresaUsuario) return { empresa: empresaParaApi(empresaUsuario) };
    }
  }
  return {};
}

async function acaoLogin(req: any) {
  const login = String(req.login || '').trim().toLowerCase();
  const { data, error } = await db.from('contas').select('*').ilike('login', login).eq('senha', req.senha).maybeSingle();
  if (error || !data) return { ok: false, erro: 'Usuário ou senha inválidos.' };
  const { data: vinculos } = await db.from('conta_perfis_acesso').select('perfil_id').eq('conta_id', data.id);
  const conta = contaParaApi(data, false, (vinculos || []).map((v: any) => v.perfil_id));
  const resultadoEmpresas = await resolverEmpresasDaConta(data);
  return { ok: true, conta, ...resultadoEmpresas };
}

// re-resolve as empresas disponíveis pra conta já logada, sem pedir senha
// de novo — usado pelo botão "trocar empresa" dentro do app (só faz
// sentido pra ADMIN/ATENDENTE, que podem estar em mais de uma)
async function acaoMinhasEmpresas(req: any) {
  const { data } = await db.from('contas').select('*').eq('id', req.contaId).maybeSingle();
  if (!data) return { ok: false, erro: 'Conta não encontrada.' };
  const resultadoEmpresas = await resolverEmpresasDaConta(data);
  return { ok: true, ...resultadoEmpresas };
}

// empresa exibida na tela de login, antes de qualquer autenticação — só
// nome e logo, informação pública mesmo (aparece pra qualquer visitante)
async function acaoEmpresaPadrao(_req: any) {
  const { data } = await db.from('empresas').select('*').eq('padrao', true).limit(1).maybeSingle();
  return { ok: true, empresa: data ? empresaParaApi(data) : null };
}

async function acaoDados(req: any) {
  const contaId = req.contaId;
  const empresaId = req.empresaId || null;
  let clientesQuery = db.from('clientes').select('*').order('nome');
  if (empresaId) clientesQuery = clientesQuery.eq('empresa_id', empresaId);
  const [{ data: contas }, { data: clientes }, { data: tipos }, { data: modulos }, { data: submodulos }, { data: statusList }, { data: perfisAcessoRaw }, { data: permissoesRaw }, { data: contaPerfisRaw }, { data: empresasRaw }, { data: contaEmpresasRaw }] = await Promise.all([
    db.from('contas').select('*'),
    clientesQuery,
    db.from('tipos').select('*').order('nome'),
    db.from('modulos').select('*').order('nome'),
    db.from('submodulos').select('*').order('nome'),
    db.from('status_list').select('*').order('ordem').order('nome'),
    db.from('perfis_acesso').select('*').order('nome'),
    db.from('perfil_acesso_permissoes').select('*'),
    db.from('conta_perfis_acesso').select('*'),
    db.from('empresas').select('*').order('nome'),
    db.from('conta_empresas').select('*'),
  ]);
  const empresaIdsPorConta: Record<string, string[]> = {};
  (contaEmpresasRaw || []).forEach((v: any) => {
    if (!empresaIdsPorConta[v.conta_id]) empresaIdsPorConta[v.conta_id] = [];
    empresaIdsPorConta[v.conta_id].push(v.empresa_id);
  });

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

  // Atendentes/Usuários também ficam separados por empresa: só aparecem
  // pra quem está vinculado a ela (ATENDENTE) ou pertence a um cliente
  // dela (USUARIO) — um ADMIN "de verdade" continua vendo todo mundo,
  // já que precisa gerenciar contas de qualquer empresa
  const contasVisiveis = !empresaId ? (contas || []) : (contas || []).filter((c: any) => {
    if (c.perfil === 'ADMIN') return true;
    if (c.perfil === 'ATENDENTE') return (empresaIdsPorConta[c.id] || []).includes(empresaId);
    if (c.perfil === 'USUARIO') return (clientes || []).some((cl: any) => String(cl.id) === String(c.cliente_id));
    return true;
  });

  let atendimentosQuery = db.from('atendimentos').select('*').order('data', { ascending: false });
  if (empresaId) atendimentosQuery = atendimentosQuery.eq('empresa_id', empresaId);
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
    let valoresQuery = db.from('valores').select('*');
    if (empresaId) valoresQuery = valoresQuery.eq('empresa_id', empresaId);
    const { data } = await valoresQuery;
    valores = (data || []).map(valorParaApi);
  }

  // vínculos entre chamados — traz tudo de uma vez (em vez de uma consulta
  // por card) pro app conseguir montar a árvore de vínculos na lista/Kanban
  // sem chamada extra nenhuma; só os que apontam pra atendimentos que essa
  // conta já pode ver (os outros ficariam "soltos", sem card correspondente)
  const idsVisiveis = new Set((atendimentosRaw || []).map((a: any) => a.id));
  const { data: vinculosRaw } = await db.from('vinculos').select('id,atendimento_a,atendimento_b');
  const vinculos = (vinculosRaw || [])
    .filter((v: any) => idsVisiveis.has(v.atendimento_a) && idsVisiveis.has(v.atendimento_b))
    .map((v: any) => ({ id: v.id, atendimentoA: v.atendimento_a, atendimentoB: v.atendimento_b }));

  // bolinha de "movimentação não lida" (estilo notificação de app): compara
  // a última movimentação de cada atendimento com a última vez que ESSA
  // conta olhou as movimentações dele — sem registro de visita, ou visita
  // mais antiga que a movimentação, conta como não lida
  const vistoPorAtendimento: Record<string, string> = {};
  if (contaId && idsVisiveis.size > 0) {
    const { data: vistoRaw } = await db.from('atendimento_visto')
      .select('atendimento_id,visto_em').eq('conta_id', contaId).in('atendimento_id', [...idsVisiveis]);
    (vistoRaw || []).forEach((v: any) => { vistoPorAtendimento[v.atendimento_id] = v.visto_em; });
  }

  // anexos de cada atendimento (inicial + os adicionados depois, inclusive
  // os deixados numa movimentação) — traz tudo de uma vez, igual aos
  // vínculos acima, pro 📎 da lista/tabela e a prévia ao passar o mouse não
  // precisarem de uma chamada extra por card
  const anexosPorAtendimento: Record<string, { id: string; nome: string; url: string }[]> = {};
  if (idsVisiveis.size > 0) {
    const { data: anexosRaw } = await db.from('anexos').select('id,atendimento_id,nome,url').in('atendimento_id', [...idsVisiveis]);
    (anexosRaw || []).forEach((an: any) => {
      if (!anexosPorAtendimento[an.atendimento_id]) anexosPorAtendimento[an.atendimento_id] = [];
      anexosPorAtendimento[an.atendimento_id].push({ id: an.id, nome: an.nome, url: an.url });
    });
  }

  let atendimentos = (atendimentosRaw || []).map((a: any) => {
    const visto = vistoPorAtendimento[a.id];
    const naoLidas = !!a.ultima_movimentacao_em && (!visto || new Date(visto) < new Date(a.ultima_movimentacao_em));
    // o anexo inicial (anexo_url) já é gravado também na tabela "anexos" ao
    // criar o atendimento (ver acaoSalvarAtendimento) — só usa o anexo_url
    // aqui pros atendimentos antigos que nunca ganharam essa linha na
    // tabela, senão o mesmo arquivo aparece duplicado na prévia
    const anexosTabela = anexosPorAtendimento[a.id] || [];
    const jaTemNaTabela = a.anexo_url && anexosTabela.some((an: any) => an.url === a.anexo_url);
    const anexos = [
      ...(a.anexo_url && !jaTemNaTabela ? [{ id: 'legado-' + a.id, nome: a.anexo_nome || 'anexo', url: a.anexo_url }] : []),
      ...anexosTabela,
    ];
    return { ...atendimentoParaApi(a), naoLidas, anexos };
  });
  // Valor Real (cobrado do cliente) é do admin, e também do usuário
  // marcado como "administrador do cliente" (vê o valor cobrado do
  // próprio cliente dele, mas não o valor que o atendente ganha).
  // Valor Atendente (antes chamado "Ananda") o próprio atendente também vê —
  // é o quanto ele ganha, faz sentido pra ele acompanhar no resumo dele.
  if (contaAtual && contaAtual.perfil === 'USUARIO') {
    if (contaAtual.admin_cliente) {
      atendimentos = atendimentos.map((a: any) => ({ ...a, vha: '', totalAnanda: '', vha2: '', totalAnanda2: '' }));
    } else {
      atendimentos = atendimentos.map((a: any) => ({ ...a, vha: '', totalAnanda: '', vha2: '', totalAnanda2: '', vhr: '', totalReal: '' }));
    }
  } else if (contaAtual && contaAtual.perfil === 'ATENDENTE' && !isAdmin) {
    atendimentos = atendimentos.map((a: any) => ({ ...a, vhr: '', totalReal: '' }));
  }

  let tomticketErros: any[] = [];
  if (isAdmin) {
    const { data } = await db.from('tomticket_erros').select('*').order('criado_em', { ascending: false }).limit(100);
    tomticketErros = (data || []).map((e: any) => ({ id: e.id, ticketId: e.ticket_id, motivo: e.motivo, criadoEm: e.criado_em }));
  }

  return {
    ok: true,
    contas: contasVisiveis.map((c: any) => contaParaApi(c, false, perfisIdsPorConta[c.id] || [], empresaIdsPorConta[c.id] || [])),
    clientes: (clientes || []).map(clienteParaApi),
    tipos: (tipos || []).map(simplesParaApi),
    modulos: (modulos || []).map(simplesParaApi),
    submodulos: (submodulos || []).map(simplesParaApi),
    statusList: (statusList || []).map(simplesParaApi),
    valores,
    atendimentos,
    vinculos,
    perfisAcesso,
    // gerenciar a lista de empresas (criar/editar/remover) é coisa de
    // ADMIN "de verdade" — um ATENDENTE administrador não gerencia isso,
    // mesmo tendo acesso total dentro da própria empresa dele
    empresas: (contaAtual && contaAtual.perfil === 'ADMIN') ? (empresasRaw || []).map(empresaParaApi) : [],
    tomticketErros,
  };
}

/* ---------- atendimento ---------- */
async function acaoSalvarAtendimento(req: any) {
  let clienteQuery = db.from('clientes').select('*').eq('nome', req.cliente);
  if (req.empresaId) clienteQuery = clienteQuery.eq('empresa_id', req.empresaId);
  const [rCliente, rTipo] = await Promise.all([
    clienteQuery.maybeSingle(),
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

  // segundo atendente (opcional) — mesma busca de conta acima, mas nunca
  // igual ao atendente principal (não faz sentido a mesma pessoa nos dois papéis)
  const atendente2Nome = (req.atendente2 && req.atendente2 !== req.atendente) ? req.atendente2 : '';
  let contaAtendente2 = null;
  if (atendente2Nome) {
    const rAtendente2 = await db.from('contas').select('*').eq('perfil', 'ATENDENTE').eq('nome', atendente2Nome).maybeSingle();
    contaAtendente2 = rAtendente2.data;
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

  // o segundo atendente ganha pela taxa "Valor 2º Atendente/h" cadastrada
  // na mesma linha de valores do atendente principal (não é uma taxa
  // própria dele, é "quanto se paga o ajudante" nessa combinação de
  // atendente principal + cliente + tipo); o valor cobrado do cliente
  // (real/vhr) continua sendo só o do atendente principal
  const ananda2 = contaAtendente2 ? Number(valorEncontrado?.valor_segundo_atend || 0) : 0;
  const horasAtendente2 = contaAtendente2 ? (Number(req.horasAtendente2) || 0) : 0;

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

  const ehNovo = !req.id;
  // fonte da quantidade de horas: ajuste manual do admin (maior prioridade) >
  // soma das movimentações com Data/Horário Inicial e Final preenchidos (a
  // partir do momento em que o atendimento tem ao menos uma) > os campos
  // hi/inter/hf do próprio atendimento — esses só entram pra atendimento já
  // existente, que pode ter sido criado antes desse campo existir; um
  // atendimento NOVO não tem mais tela pra editar hi/hf (o campo nem
  // aparece), então sempre começa em 0h até a primeira movimentação
  let qtd: number;
  if (req.qtdManual !== undefined && req.qtdManual !== null && req.qtdManual !== '') {
    qtd = Number(req.qtdManual); // ajuste manual (só o admin tem esse campo no formulário)
  } else if (ehNovo) {
    qtd = 0;
  } else {
    const qtdMovimentacoes = await qtdApartirDeMovimentacoes(req.id);
    qtd = qtdMovimentacoes !== null ? qtdMovimentacoes : calcularQtd(req.hi, req.hf, req.inter);
  }
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

  const statusFinal = ehNovo ? 'PENDENTE' : req.status; // todo chamado novo abre PENDENTE — reforçado aqui, não confia só no front

  // marca a partir de quando o chamado entrou em "Em Validação" — usado
  // pra saber quando expira o prazo de validação automática; sai desse
  // status (validado pelo usuário, ou voltou pra outro status qualquer)
  // e a marca é limpa
  let emValidacaoDesde: string | null = null;
  if (!ehNovo && statusFinal === 'EM VALIDAÇÃO') {
    const { data: existenteStatus } = await db.from('atendimentos').select('status,em_validacao_desde').eq('id', req.id).maybeSingle();
    emValidacaoDesde = (existenteStatus && existenteStatus.status === 'EM VALIDAÇÃO')
      ? existenteStatus.em_validacao_desde
      : new Date().toISOString();
  }

  const registro = {
    id: req.id || gerarId(),
    data: req.data, mes, cliente: req.cliente, usuario: req.usuario, tipo: req.tipo,
    modulo: req.modulo || '', submodulo: req.submodulo || '',
    atendente: req.atendente || '', assunto: req.assunto || '', detalhe: req.detalhe || '',
    hi: req.hi || '00:00', inter: req.inter || '00:00', hf: req.hf || '00:00',
    qtd, vha: ananda, total_ananda: qtd * ananda, vhr: real, total_real: qtd * real, status: statusFinal,
    anexo_url: anexoUrl, anexo_nome: anexoNome, solucao: req.solucao || '',
    // Data Final (Prevista) some auto-preenchida com hoje quando o chamado vira
    // CONCLUÍDO sem ela ter sido informada (fica só como registro de quando fechou)
    data_prevista: req.dataPrevista || (statusFinal === 'CONCLUÍDO' ? dataAtualIso() : ''),
    atendente2: contaAtendente2 ? atendente2Nome : '', horas_atendente2: horasAtendente2,
    vha2: ananda2, total_ananda2: horasAtendente2 * ananda2,
    em_validacao_desde: emValidacaoDesde,
  };

  if (ehNovo) {
    const { error: erroInsert } = await db.from('atendimentos').insert({ ...registro, empresa_id: req.empresaId || (cliente ? cliente.empresa_id : null) });
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

// o próprio usuário solicitante aprova a validação do chamado (some com o
// prazo de 48h/etc — se ele não aprovar, o cron de validação automática
// faz a mesma coisa mais tarde)
async function acaoAprovarValidacao(req: any) {
  const { data: conta } = await db.from('contas').select('*').eq('id', req.contaId).maybeSingle();
  if (!conta) return { ok: false, erro: 'Conta não encontrada.' };
  const { data: atendimento } = await db.from('atendimentos').select('*').eq('id', req.id).maybeSingle();
  if (!atendimento) return { ok: false, erro: 'Atendimento não encontrado.' };
  if (conta.perfil !== 'USUARIO' || atendimento.usuario !== conta.nome) {
    return { ok: false, erro: 'Só o usuário solicitante pode aprovar a validação desse chamado.' };
  }
  if (atendimento.status !== 'EM VALIDAÇÃO') return { ok: false, erro: 'Esse chamado não está em validação.' };

  const { error } = await db.from('atendimentos').update({ status: 'CONCLUÍDO', em_validacao_desde: null }).eq('id', req.id);
  if (error) return { ok: false, erro: error.message };
  await registrarHistorico(req.id, `Validação aprovada por ${conta.nome}`);
  await notificarStatusAlterado({ ...atendimento, status: 'CONCLUÍDO' }, 'EM VALIDAÇÃO');
  return { ok: true };
}

// o usuário solicitante rejeita a validação (achou que não ficou certo) —
// o chamado volta pra "NÃO VALIDADO" pro atendente revisar e corrigir, em
// vez de simplesmente ficar preso em "Em Validação" até o prazo estourar
async function acaoRejeitarValidacao(req: any) {
  const { data: conta } = await db.from('contas').select('*').eq('id', req.contaId).maybeSingle();
  if (!conta) return { ok: false, erro: 'Conta não encontrada.' };
  const { data: atendimento } = await db.from('atendimentos').select('*').eq('id', req.id).maybeSingle();
  if (!atendimento) return { ok: false, erro: 'Atendimento não encontrado.' };
  if (conta.perfil !== 'USUARIO' || atendimento.usuario !== conta.nome) {
    return { ok: false, erro: 'Só o usuário solicitante pode rejeitar a validação desse chamado.' };
  }
  if (atendimento.status !== 'EM VALIDAÇÃO') return { ok: false, erro: 'Esse chamado não está em validação.' };

  const motivo = String(req.motivo || '').trim();
  const { error } = await db.from('atendimentos').update({ status: 'NÃO VALIDADO', em_validacao_desde: null }).eq('id', req.id);
  if (error) return { ok: false, erro: error.message };
  await registrarHistorico(req.id, `Validação rejeitada por ${conta.nome}${motivo ? ': ' + motivo : ''}`);
  await notificarStatusAlterado({ ...atendimento, status: 'NÃO VALIDADO' }, 'EM VALIDAÇÃO');
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

    const assunto = `Novo atendimento aberto #${registro.id} — ${registro.cliente} / ${registro.usuario}`;
    const corpo = [
      'Um novo atendimento foi registrado.', '',
      `Nº do atendimento: ${registro.id}`,
      `Cliente: ${registro.cliente}`,
      `Usuário solicitante: ${registro.usuario}`,
      `Atendente: ${registro.atendente || '(a definir — qualquer atendente pode assumir)'}`,
      `Data: ${registro.data}`,
      `Tipo: ${registro.tipo}`,
      registro.modulo ? `Módulo: ${registro.modulo}` : '',
      registro.submodulo ? `Sub módulo: ${registro.submodulo}` : '',
      registro.assunto ? `Assunto: ${registro.assunto}` : '',
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
    const assunto = `Nova movimentação #${atendimento.id} — ${atendimento.cliente} / ${atendimento.usuario}`;
    const corpo = [
      `${autorNome} (${rotulo}) adicionou uma nova movimentação no atendimento #${atendimento.id}:`, '',
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
  // marca como "vista" pra essa conta — é isso que apaga a bolinha de
  // movimentação não lida na lista/menu depois que a pessoa abre o chamado
  if (req.contaId) {
    await db.from('atendimento_visto')
      .upsert({ atendimento_id: req.atendimentoId, conta_id: req.contaId, visto_em: new Date().toISOString() });
  }
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
      texto: m.texto, respondendoA: m.respondendo_a || null, criadoEm: m.criado_em,
      anexos: anexosPorMov[m.id] || [],
      dataInicial: m.data_inicial || '', horaInicial: m.hora_inicial || '',
      dataFinal: m.data_final || '', horaFinal: m.hora_final || '', intervaloMin: m.intervalo_min || 0,
      ehResposta: !!m.eh_resposta,
    })),
  };
}

async function acaoCriarMovimentacao(req: any) {
  if (!req.atendimentoId) return { ok: false, erro: 'Atendimento não informado.' };
  const texto = String(req.texto || '').trim();
  if (!texto && !req.anexoBase64) return { ok: false, erro: 'Escreva algo ou anexe um arquivo.' };

  const { data: atendimento } = await db.from('atendimentos').select('id,status,cliente,usuario,atendente').eq('id', req.atendimentoId).maybeSingle();
  if (!atendimento) return { ok: false, erro: 'Atendimento não encontrado.' };
  if (atendimento.status === 'CONCLUÍDO') return { ok: false, erro: 'Esse atendimento já foi concluído — não é possível adicionar novas movimentações.' };

  // "finalizar": quem atende indica, junto com a movimentação, que terminou
  // — o chamado vai pra EM VALIDAÇÃO aguardando o usuário confirmar (ou
  // rejeitar, via acaoRejeitarValidacao). Só quem atende finaliza.
  const finalizar = !!req.finalizar;
  if (finalizar && req.autorPerfil === 'USUARIO') {
    return { ok: false, erro: 'Só quem atende pode finalizar o atendimento.' };
  }

  // apuração de tempo (Data/Horário Inicial e Final + Intervalo) é exclusiva
  // de quem atende — pro Usuário a movimentação continua só texto/anexo,
  // mesmo que o payload venha com esses campos preenchidos; marcado como
  // "é uma resposta", nunca apura tempo (fica em 0h), mesmo se algum campo
  // de data/horário tiver vindo preenchido — não precisa informar horário
  const ehResposta = !!req.ehResposta;
  const usaTempo = !ehResposta && req.autorPerfil !== 'USUARIO' && req.dataInicial && req.horaInicial && req.dataFinal && req.horaFinal;
  let camposTempo: Record<string, unknown> = { data_inicial: '', hora_inicial: '', data_final: '', hora_final: '', intervalo_min: 0 };
  if (usaTempo) {
    if (new Date(`${req.dataFinal}T${req.horaFinal}:00`) <= new Date(`${req.dataInicial}T${req.horaInicial}:00`)) {
      return { ok: false, erro: 'O horário final precisa ser depois do horário inicial.' };
    }
    const intervaloMin = Number(req.intervaloMin) || 0;
    if (calcularQtdMovimentacao(req.dataInicial, req.horaInicial, req.dataFinal, req.horaFinal, intervaloMin) <= 0) {
      return { ok: false, erro: 'O intervalo não pode ser maior ou igual ao período todo.' };
    }
    const conflito = await acharMovimentacaoSobreposta(req.atendimentoId, req.dataInicial, req.horaInicial, req.dataFinal, req.horaFinal);
    if (conflito) {
      const outroAtendimento = conflito.atendimento_id !== req.atendimentoId ? ` (atendimento #${conflito.atendimento_id})` : '';
      return { ok: false, erro: `Esse período sobrepõe uma movimentação de ${conflito.autor_nome}${outroAtendimento} (${conflito.hora_inicial}–${conflito.hora_final} em ${String(conflito.data_inicial).split('-').reverse().join('/')}). Ajuste o horário.` };
    }
    camposTempo = { data_inicial: req.dataInicial, hora_inicial: req.horaInicial, data_final: req.dataFinal, hora_final: req.horaFinal, intervalo_min: intervaloMin };
  }

  const registro = {
    id: gerarId(), atendimento_id: req.atendimentoId, autor_nome: req.autorNome, autor_perfil: req.autorPerfil,
    texto: texto || '(anexo)', respondendo_a: req.respondendoA || null, eh_resposta: ehResposta, ...camposTempo,
  };
  const { error } = await db.from('movimentacoes').insert(registro);
  if (error) return { ok: false, erro: error.message };
  if (usaTempo) await recalcularQtdAtendimento(req.atendimentoId);

  // marca a hora da movimentação nova no atendimento (é o que acende a
  // bolinha de "não lida" pra todo mundo, exceto quem acabou de escrever) e
  // já marca como "vista" pra quem escreveu, senão a própria pessoa veria a
  // bolinha no chamado em que ela mesma acabou de responder
  const agora = new Date().toISOString();
  await db.from('atendimentos').update({ ultima_movimentacao_em: agora }).eq('id', req.atendimentoId);
  if (req.contaId) {
    await db.from('atendimento_visto')
      .upsert({ atendimento_id: req.atendimentoId, conta_id: req.contaId, visto_em: agora });
  }

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

  if (finalizar) {
    // a movimentação que finaliza o atendimento vira também o registro de
    // Solução — replicada pra não depender de reescrever o mesmo texto de
    // novo lá no formulário de edição
    const dadosFinal: Record<string, unknown> = { solucao: registro.texto };
    if (atendimento.status !== 'EM VALIDAÇÃO') {
      dadosFinal.status = 'EM VALIDAÇÃO';
      dadosFinal.em_validacao_desde = agora;
    }
    await db.from('atendimentos').update(dadosFinal).eq('id', req.atendimentoId);
    if (atendimento.status !== 'EM VALIDAÇÃO') {
      await registrarHistorico(req.atendimentoId, `Status alterado de ${atendimento.status} para EM VALIDAÇÃO`);
      await notificarStatusAlterado({ ...atendimento, status: 'EM VALIDAÇÃO' }, atendimento.status);
    }
  }

  return { ok: true, id: registro.id, anexo: anexoSalvo, finalizado: finalizar };
}

async function acaoAtualizarMovimentacao(req: any) {
  if (!req.id) return { ok: false, erro: 'Movimentação não informada.' };
  const { data: mov } = await db.from('movimentacoes').select('*').eq('id', req.id).maybeSingle();
  if (!mov) return { ok: false, erro: 'Movimentação não encontrada.' };
  const { data: conta } = await db.from('contas').select('nome,perfil,eh_administrador').eq('id', req.contaId).maybeSingle();
  if (!conta) return { ok: false, erro: 'Conta não encontrada.' };
  if (!ehAdminEfetivo(conta) && conta.nome !== mov.autor_nome) return { ok: false, erro: 'Você só pode editar suas próprias movimentações.' };

  const { data: atendimento } = await db.from('atendimentos').select('status').eq('id', mov.atendimento_id).maybeSingle();
  if (atendimento && atendimento.status === 'CONCLUÍDO') return { ok: false, erro: 'Esse atendimento já foi concluído — não é possível editar movimentações.' };

  const texto = String(req.texto || '').trim();
  if (!texto) return { ok: false, erro: 'Escreva algo.' };

  const atualizacao: Record<string, unknown> = { texto };
  // marcado como "é uma resposta", zera qualquer tempo que já estivesse
  // apurado — não precisa mais informar horário, o cálculo vira 0h
  const ehResposta = req.ehResposta !== undefined ? !!req.ehResposta : !!mov.eh_resposta;
  atualizacao.eh_resposta = ehResposta;
  // só quem já podia ter apurado tempo mexe nesses campos aqui — pra Usuário
  // (ou quando o payload não manda os 4 campos, ou virou resposta) não
  // toca no que já estava salvo, exceto pra zerar quando virou resposta
  const usaTempo = !ehResposta && mov.autor_perfil !== 'USUARIO' && req.dataInicial && req.horaInicial && req.dataFinal && req.horaFinal;
  if (usaTempo) {
    if (new Date(`${req.dataFinal}T${req.horaFinal}:00`) <= new Date(`${req.dataInicial}T${req.horaInicial}:00`)) {
      return { ok: false, erro: 'O horário final precisa ser depois do horário inicial.' };
    }
    const intervaloMin = Number(req.intervaloMin) || 0;
    if (calcularQtdMovimentacao(req.dataInicial, req.horaInicial, req.dataFinal, req.horaFinal, intervaloMin) <= 0) {
      return { ok: false, erro: 'O intervalo não pode ser maior ou igual ao período todo.' };
    }
    const conflito = await acharMovimentacaoSobreposta(mov.atendimento_id, req.dataInicial, req.horaInicial, req.dataFinal, req.horaFinal, req.id);
    if (conflito) {
      const outroAtendimento = conflito.atendimento_id !== mov.atendimento_id ? ` (atendimento #${conflito.atendimento_id})` : '';
      return { ok: false, erro: `Esse período sobrepõe uma movimentação de ${conflito.autor_nome}${outroAtendimento} (${conflito.hora_inicial}–${conflito.hora_final} em ${String(conflito.data_inicial).split('-').reverse().join('/')}). Ajuste o horário.` };
    }
    Object.assign(atualizacao, { data_inicial: req.dataInicial, hora_inicial: req.horaInicial, data_final: req.dataFinal, hora_final: req.horaFinal, intervalo_min: intervaloMin });
  } else if (ehResposta) {
    Object.assign(atualizacao, { data_inicial: '', hora_inicial: '', data_final: '', hora_final: '', intervalo_min: 0 });
  }

  const { error } = await db.from('movimentacoes').update(atualizacao).eq('id', req.id);
  if (error) return { ok: false, erro: error.message };
  if (usaTempo || mov.data_inicial) await recalcularQtdAtendimento(mov.atendimento_id);
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
  if (atendimento && atendimento.status === 'CONCLUÍDO') return { ok: false, erro: 'Esse atendimento já foi concluído — não é possível excluir movimentações.' };

  await db.from('anexos').delete().eq('movimentacao_id', req.id);
  await db.from('movimentacoes').delete().eq('id', req.id);
  if (mov.data_inicial) await recalcularQtdAtendimento(mov.atendimento_id);
  return { ok: true };
}

/* ---------- vídeos / tutoriais (aba visível pra todo mundo, admin cadastra) ---------- */
function videoParaApi(v: any) {
  return {
    id: v.id, titulo: v.titulo, descricao: v.descricao || '', urlYoutube: v.url_youtube,
    cliente: v.cliente || '', modulo: v.modulo || '', visivelPerfis: v.visivel_perfis || [],
    ordem: v.ordem || 0, criadoPor: v.criado_por || '', empresaId: v.empresa_id || '',
    visualizacoes: v.visualizacoes || 0,
  };
}

async function acaoListarVideos(req: any) {
  const { data: conta } = await db.from('contas').select('*').eq('id', req.contaId).maybeSingle();
  if (!conta) return { ok: false, erro: 'Conta não encontrada.' };

  let query = db.from('videos_tutoriais').select('*').order('ordem').order('criado_em');
  if (req.empresaId) query = query.eq('empresa_id', req.empresaId);
  const { data, error } = await query;
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
  if (!(await podeAgir(req.contaId, 'videos', 'inserir'))) return { ok: false, erro: 'Você não tem permissão para cadastrar vídeos.' };
  if (!req.titulo || !req.urlYoutube) return { ok: false, erro: 'Preencha o título e o link do YouTube.' };
  if (!req.empresaId) return { ok: false, erro: 'Escolha uma empresa antes de cadastrar um vídeo.' };
  const { data: conta } = await db.from('contas').select('nome').eq('id', req.contaId).maybeSingle();
  const registro = {
    id: gerarId(), titulo: req.titulo, descricao: req.descricao || '', url_youtube: req.urlYoutube,
    cliente: req.cliente || null, modulo: req.modulo || null,
    visivel_perfis: (req.visivelPerfis && req.visivelPerfis.length > 0) ? req.visivelPerfis : ['ATENDENTE', 'USUARIO'],
    ordem: Number(req.ordem) || 0, criado_por: conta ? conta.nome : '', empresa_id: req.empresaId,
  };
  const { error } = await db.from('videos_tutoriais').insert(registro);
  if (error) return { ok: false, erro: error.message };
  return { ok: true, id: registro.id };
}

async function acaoAtualizarVideo(req: any) {
  if (!(await podeAgir(req.contaId, 'videos', 'editar'))) return { ok: false, erro: 'Você não tem permissão para editar vídeos.' };
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
  if (!(await podeAgir(req.contaId, 'videos', 'excluir'))) return { ok: false, erro: 'Você não tem permissão para remover vídeos.' };
  await db.from('videos_tutoriais').delete().eq('id', req.id);
  return { ok: true };
}

// contador de visualizações — incrementado quando o vídeo vira o destaque
// no player do front (sem exigir login de perfil específico: qualquer
// conta que já pôde listar o vídeo pode contar como visualização dele)
async function acaoRegistrarVisualizacaoVideo(req: any) {
  if (!req.videoId) return { ok: false, erro: 'Vídeo não informado.' };
  const { data: video } = await db.from('videos_tutoriais').select('visualizacoes').eq('id', req.videoId).maybeSingle();
  if (!video) return { ok: false, erro: 'Vídeo não encontrado.' };
  const visualizacoes = (video.visualizacoes || 0) + 1;
  const { error } = await db.from('videos_tutoriais').update({ visualizacoes }).eq('id', req.videoId);
  if (error) return { ok: false, erro: error.message };
  return { ok: true, visualizacoes };
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
  const campo = req.id ? 'editar' : 'inserir';
  if (!(await podeAgir(req.contaId, 'construtor_relatorios', campo))) return { ok: false, erro: 'Você não tem permissão para criar/editar relatórios.' };
  const { data: conta } = await db.from('contas').select('perfil,nome,eh_administrador').eq('id', req.contaId).maybeSingle();
  if (!conta) return { ok: false, erro: 'Conta não encontrada.' };
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
  if (!(await podeAgir(req.contaId, 'construtor_relatorios', 'excluir'))) return { ok: false, erro: 'Você não tem permissão para remover relatórios.' };
  await db.from('relatorios_salvos').delete().eq('id', req.id);
  return { ok: true };
}

/* ---------- financeiro (lançamentos/faturas por cliente+mês) ---------- */

// admin (ou atendente-administrador) sempre pode; senão, checa se algum
// Perfil de Acesso vinculado à conta libera o campo pedido (visualizar/
// editar/excluir/inserir) pro menu (ou submenu, "menu.submenu") informado.
// "padrao" é o que vale quando a conta não tem NENHUM Perfil de Acesso
// vinculado — mesma regra do "menuVisivel" do frontend: sem perfil
// configurado, cai no comportamento de sempre (padrao); com pelo menos um
// perfil vinculado, vale só o que ele libera de verdade (allow-list, ignora
// o padrao). Isso é o que garante que contas que nunca tiveram um Perfil de
// Acesso configurado continuem funcionando exatamente como já funcionavam.
async function podeAgir(contaId: string, menu: string, campo: 'visualizar' | 'editar' | 'excluir' | 'inserir', padrao = false): Promise<boolean> {
  const { data: conta } = await db.from('contas').select('perfil,eh_administrador').eq('id', contaId).maybeSingle();
  if (ehAdminEfetivo(conta)) return true;
  if (!conta) return false;
  const { data: vinculos } = await db.from('conta_perfis_acesso').select('perfil_id').eq('conta_id', contaId);
  const perfilIds = (vinculos || []).map((v: any) => v.perfil_id);
  if (perfilIds.length === 0) return padrao;
  const { data: permissoes } = await db.from('perfil_acesso_permissoes').select('*').in('perfil_id', perfilIds).eq('menu', menu);
  return (permissoes || []).some((p: any) => !!p[campo]);
}

function lancamentoParaApi(l: any) {
  return {
    id: l.id, cliente: l.cliente, mesReferencia: l.mes_referencia, valorTotal: Number(l.valor_total),
    atendimentoIds: l.atendimento_ids || [], dataVencimento: l.data_vencimento || '',
    dataBaixa: l.data_baixa || '', dataPrevisaoBaixa: l.data_previsao_baixa || '',
    numeroNotaFiscal: l.numero_nota_fiscal || '', status: l.status, historico: l.historico || '',
    criadoPor: l.criado_por || '', empresaId: l.empresa_id || '',
  };
}

async function acaoListarLancamentos(req: any) {
  if (!(await podeAgir(req.contaId, 'financeiro.lista', 'visualizar'))) return { ok: false, erro: 'Você não tem permissão para acessar o financeiro.' };
  let query = db.from('lancamentos_financeiros').select('*').order('mes_referencia', { ascending: false }).order('criado_em', { ascending: false });
  if (req.empresaId) query = query.eq('empresa_id', req.empresaId);
  const { data, error } = await query;
  if (error) return { ok: false, erro: error.message };
  return { ok: true, lancamentos: (data || []).map(lancamentoParaApi) };
}

async function acaoCriarLancamento(req: any) {
  if (!(await podeAgir(req.contaId, 'financeiro.lancar', 'inserir'))) return { ok: false, erro: 'Você não tem permissão para criar lançamentos.' };
  if (!req.cliente || !req.mesReferencia) return { ok: false, erro: 'Cliente e mês de referência são obrigatórios.' };
  if (!req.empresaId) return { ok: false, erro: 'Escolha uma empresa antes de criar o lançamento.' };
  const { data: conta } = await db.from('contas').select('nome').eq('id', req.contaId).maybeSingle();
  const registro = {
    id: gerarId(), cliente: req.cliente, mes_referencia: req.mesReferencia,
    valor_total: Number(req.valorTotal) || 0, atendimento_ids: req.atendimentoIds || [],
    data_vencimento: req.dataVencimento || '', numero_nota_fiscal: req.numeroNotaFiscal || '',
    historico: req.historico || '', status: 'ABERTO', criado_por: conta ? conta.nome : '',
    empresa_id: req.empresaId,
  };
  const { error } = await db.from('lancamentos_financeiros').insert(registro);
  if (error) return { ok: false, erro: error.message };
  return { ok: true, id: registro.id };
}

async function acaoAtualizarLancamento(req: any) {
  if (!(await podeAgir(req.contaId, 'financeiro.lista', 'editar'))) return { ok: false, erro: 'Você não tem permissão para editar lançamentos.' };
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
  if (!(await podeAgir(req.contaId, 'financeiro.lista', 'editar'))) return { ok: false, erro: 'Você não tem permissão para dar baixa em lançamentos.' };
  if (!req.id || !req.dataBaixa) return { ok: false, erro: 'Informe a data de baixa.' };
  const { error } = await db.from('lancamentos_financeiros').update({
    status: 'BAIXADO', data_baixa: req.dataBaixa, atualizado_em: new Date().toISOString(),
  }).eq('id', req.id);
  if (error) return { ok: false, erro: error.message };
  return { ok: true };
}

async function acaoCancelarLancamento(req: any) {
  if (!(await podeAgir(req.contaId, 'financeiro.lista', 'editar'))) return { ok: false, erro: 'Você não tem permissão para cancelar lançamentos.' };
  const { error } = await db.from('lancamentos_financeiros').update({
    status: 'CANCELADO', atualizado_em: new Date().toISOString(),
  }).eq('id', req.id);
  if (error) return { ok: false, erro: error.message };
  return { ok: true };
}

async function acaoRemoverLancamento(req: any) {
  if (!(await podeAgir(req.contaId, 'financeiro.lista', 'excluir'))) return { ok: false, erro: 'Você não tem permissão para remover lançamentos.' };
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
    xmlOriginal: n.xml_original || '', empresaId: n.empresa_id || '',
  };
}

async function acaoImportarNotaFiscal(req: any) {
  if (!(await podeAgir(req.contaId, 'financeiro.importar', 'inserir'))) return { ok: false, erro: 'Você não tem permissão para importar notas fiscais.' };
  if (!req.empresaId) return { ok: false, erro: 'Escolha uma empresa antes de importar a nota fiscal.' };
  const { data: conta } = await db.from('contas').select('nome').eq('id', req.contaId).maybeSingle();

  // tenta casar o CNPJ do tomador (que veio no XML) com um cliente já
  // cadastrado da MESMA empresa — se achar, usa o nome oficial do
  // cadastro e vincula o id; comparação ignora pontuação, já que CNPJ
  // pode estar formatado de jeitos diferentes em cada lugar
  const soDigitos = (s: string) => String(s || '').replace(/\D/g, '');
  let clienteId: string | null = null;
  let nomeCliente = req.cliente || '';
  const cnpjTomador = soDigitos(req.cnpjCpfTomador);
  if (cnpjTomador) {
    const { data: clientesList } = await db.from('clientes').select('id,nome,cnpj').eq('empresa_id', req.empresaId);
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
    xml_original: req.xmlOriginal || '', importado_por: conta ? conta.nome : '', empresa_id: req.empresaId,
  };
  const { error } = await db.from('notas_fiscais_importadas').insert(registro);
  if (error) return { ok: false, erro: error.message };
  return { ok: true, id: registro.id, clienteEncontrado: !!clienteId };
}

async function acaoListarNotasImportadas(req: any) {
  if (!(await podeAgir(req.contaId, 'financeiro.importar', 'visualizar'))) return { ok: false, erro: 'Você não tem permissão para acessar o financeiro.' };
  let query = db.from('notas_fiscais_importadas').select('*').order('importado_em', { ascending: false });
  if (req.empresaId) query = query.eq('empresa_id', req.empresaId);
  const { data, error } = await query;
  if (error) return { ok: false, erro: error.message };
  return { ok: true, notas: (data || []).map(notaParaApi) };
}

async function acaoRemoverNotaImportada(req: any) {
  if (!(await podeAgir(req.contaId, 'financeiro.importar', 'excluir'))) return { ok: false, erro: 'Você não tem permissão para remover notas importadas.' };
  await db.from('notas_fiscais_importadas').delete().eq('id', req.id);
  return { ok: true };
}

async function acaoVincularNotaLancamento(req: any) {
  if (!(await podeAgir(req.contaId, 'financeiro.importar', 'editar'))) return { ok: false, erro: 'Você não tem permissão para fazer essa ação.' };
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

/* ---------- atividades (tarefas internas — soltas, vinculadas a um ou mais
   atendimentos e/ou aparecendo na Agenda, cada uma independente das outras) ---------- */
function atividadeParaApi(a: any, atendimentoIds: string[] = []) {
  return {
    id: a.id, titulo: a.titulo, descricao: a.descricao || '', tipo: a.tipo || 'TAREFA',
    responsavel: a.responsavel || '', status: a.status || 'PENDENTE',
    atendimentoIds, naAgenda: !!a.na_agenda,
    data: a.data || '', dataEntrega: a.data_entrega || '',
    diaInteiro: !!a.dia_inteiro, horaInicio: a.hora_inicio || '', horaFim: a.hora_fim || '',
    repeticao: a.repeticao || 'NENHUMA', repetirAte: a.repetir_ate || '', serieId: a.serie_id || '',
    criadoPor: a.criado_por || '', criadoEm: a.criado_em, concluidoEm: a.concluido_em || '',
    empresaId: a.empresa_id || '',
  };
}

async function podeGerenciarAtividade(contaId: string) {
  const { data: conta } = await db.from('contas').select('perfil').eq('id', contaId).maybeSingle();
  return !!(conta && (conta.perfil === 'ADMIN' || conta.perfil === 'ATENDENTE'));
}

// mapa atividade_id -> [atendimento_id, ...], pra não fazer uma query por
// atividade (a lista inteira busca de uma vez só)
async function atendimentoIdsPorAtividade(atividadeIds: string[]): Promise<Record<string, string[]>> {
  if (atividadeIds.length === 0) return {};
  const { data } = await db.from('atividade_atendimentos').select('atividade_id,atendimento_id').in('atividade_id', atividadeIds);
  const mapa: Record<string, string[]> = {};
  (data || []).forEach((v: any) => { (mapa[v.atividade_id] = mapa[v.atividade_id] || []).push(v.atendimento_id); });
  return mapa;
}

function validarCamposAtividade(req: any) {
  if (!req.titulo || !String(req.titulo).trim()) return 'Preencha o título.';
  if (req.naAgenda) {
    if (!req.data) return 'Preencha a data pra colocar na Agenda.';
    if (!req.diaInteiro && (!req.horaInicio || !req.horaFim)) return 'Preencha o horário pra colocar na Agenda (ou marque "dia inteiro").';
  }
  if (req.repeticao && req.repeticao !== 'NENHUMA') {
    if (!req.data) return 'Preencha a data pra repetir a atividade.';
    if (!req.repetirAte) return 'Preencha até quando repetir.';
    if (String(req.repetirAte) < String(req.data)) return '"Repetir até" precisa ser depois da data.';
  }
  return null;
}

const REPETICOES_VALIDAS = new Set(['NENHUMA', 'DIARIA', 'SEMANAL', 'MENSAL']);
// datas das ocorrências SEGUINTES à primeira (essa já é a própria linha
// criada por fora) — limitado a 365 pra nunca gerar uma quantidade de
// linhas fora de controle (ex: diária esquecida sem data final perto)
function proximasOcorrencias(dataInicial: string, repeticao: string, repetirAte: string): string[] {
  const LIMITE = 365;
  const datas: string[] = [];
  const atual = new Date(`${dataInicial}T00:00:00`);
  const fim = new Date(`${repetirAte}T00:00:00`);
  for (let i = 0; i < LIMITE; i++) {
    if (repeticao === 'DIARIA') atual.setDate(atual.getDate() + 1);
    else if (repeticao === 'SEMANAL') atual.setDate(atual.getDate() + 7);
    else if (repeticao === 'MENSAL') atual.setMonth(atual.getMonth() + 1);
    else break;
    if (atual > fim) break;
    datas.push(atual.toISOString().slice(0, 10));
  }
  return datas;
}

async function acaoListarAtividades(req: any) {
  const { data: conta } = await db.from('contas').select('*').eq('id', req.contaId).maybeSingle();
  if (!conta) return { ok: false, erro: 'Conta não encontrada.' };
  if (conta.perfil === 'USUARIO') return { ok: true, atividades: [] }; // tarefa interna da equipe — usuário solicitante não acessa

  let query = db.from('atividades').select('*').order('data', { ascending: true }).order('criado_em', { ascending: false });
  if (req.empresaId) query = query.eq('empresa_id', req.empresaId);
  const { data, error } = await query;
  if (error) return { ok: false, erro: error.message };
  let atividades = data || [];
  // atendente só vê as que é responsável ou que ele mesmo criou (senão uma
  // atividade que ele cria pra outro colega "some" da própria lista dele);
  // admin vê tudo
  if (conta.perfil === 'ATENDENTE') {
    atividades = atividades.filter((a: any) => a.responsavel === conta.nome || a.criado_por === conta.nome);
  }
  const mapaVinculos = await atendimentoIdsPorAtividade(atividades.map((a: any) => a.id));
  return { ok: true, atividades: atividades.map((a: any) => atividadeParaApi(a, mapaVinculos[a.id] || [])) };
}

async function acaoCriarAtividade(req: any) {
  if (!(await podeGerenciarAtividade(req.contaId))) return { ok: false, erro: 'Sem permissão pra criar atividades.' };
  const erroValidacao = validarCamposAtividade(req);
  if (erroValidacao) return { ok: false, erro: erroValidacao };
  const { data: conta } = await db.from('contas').select('nome').eq('id', req.contaId).maybeSingle();

  const repeticao = REPETICOES_VALIDAS.has(req.repeticao) ? req.repeticao : 'NENHUMA';
  const idPrincipal = gerarId();
  const base = {
    titulo: req.titulo, descricao: req.descricao || '', tipo: req.tipo || 'TAREFA',
    responsavel: req.responsavel || (conta ? conta.nome : ''), status: req.status || 'PENDENTE',
    na_agenda: !!req.naAgenda, dia_inteiro: !!req.diaInteiro,
    hora_inicio: (req.naAgenda && !req.diaInteiro) ? req.horaInicio : null,
    hora_fim: (req.naAgenda && !req.diaInteiro) ? req.horaFim : null,
    criado_por: conta ? conta.nome : '', empresa_id: req.empresaId || null,
    repeticao, repetir_ate: repeticao !== 'NENHUMA' ? req.repetirAte : null,
    concluido_em: req.status === 'CONCLUIDA' ? new Date().toISOString() : null,
  };

  // diferença (em dias) entre Data e Data de entrega — preservada em cada
  // ocorrência da série, pra manter o mesmo prazo relativo em todas
  const offsetEntregaDias = (req.data && req.dataEntrega)
    ? Math.round((new Date(`${req.dataEntrega}T00:00:00`).getTime() - new Date(`${req.data}T00:00:00`).getTime()) / 86400000)
    : null;

  const datasOcorrencias = (repeticao !== 'NENHUMA' && req.data)
    ? [req.data, ...proximasOcorrencias(req.data, repeticao, req.repetirAte)]
    : [req.data || null];

  const registros = datasOcorrencias.map((data, i) => ({
    id: i === 0 ? idPrincipal : gerarId(),
    ...base,
    data,
    data_entrega: (data && offsetEntregaDias !== null)
      ? new Date(new Date(`${data}T00:00:00`).getTime() + offsetEntregaDias * 86400000).toISOString().slice(0, 10)
      : (i === 0 ? (req.dataEntrega || null) : null),
    serie_id: datasOcorrencias.length > 1 ? idPrincipal : null,
  }));

  const { error } = await db.from('atividades').insert(registros);
  if (error) return { ok: false, erro: error.message };

  const atendimentoIds = Array.isArray(req.atendimentoIds) ? req.atendimentoIds.filter(Boolean) : [];
  if (atendimentoIds.length > 0) {
    const vinculos = registros.flatMap((r) => atendimentoIds.map((atendimentoId: string) => ({ id: gerarId(), atividade_id: r.id, atendimento_id: atendimentoId })));
    await db.from('atividade_atendimentos').insert(vinculos);
  }

  return { ok: true, id: idPrincipal, ocorrenciasGeradas: registros.length };
}

async function acaoAtualizarAtividade(req: any) {
  if (!(await podeGerenciarAtividade(req.contaId))) return { ok: false, erro: 'Sem permissão pra editar atividades.' };
  if (!req.id) return { ok: false, erro: 'Atividade não informada.' };
  const erroValidacao = validarCamposAtividade(req);
  if (erroValidacao) return { ok: false, erro: erroValidacao };
  const { data: existente } = await db.from('atividades').select('status,concluido_em').eq('id', req.id).maybeSingle();
  if (!existente) return { ok: false, erro: 'Atividade não encontrada.' };

  const statusFinal = req.status || 'PENDENTE';
  let concluidoEm = existente.concluido_em;
  if (statusFinal === 'CONCLUIDA' && existente.status !== 'CONCLUIDA') concluidoEm = new Date().toISOString();
  else if (statusFinal !== 'CONCLUIDA') concluidoEm = null;

  // edição sempre mexe só nessa linha — não regenera nem propaga pra série
  // (repetição só se aplica na criação; cada ocorrência já gerada vira uma
  // atividade independente daqui pra frente)
  const atualizado = {
    titulo: req.titulo, descricao: req.descricao || '', tipo: req.tipo || 'TAREFA',
    responsavel: req.responsavel || '', status: statusFinal,
    na_agenda: !!req.naAgenda, dia_inteiro: !!req.diaInteiro,
    data: req.data || null, data_entrega: req.dataEntrega || null,
    hora_inicio: (req.naAgenda && !req.diaInteiro) ? req.horaInicio : null,
    hora_fim: (req.naAgenda && !req.diaInteiro) ? req.horaFim : null,
    concluido_em: concluidoEm,
  };
  const { error } = await db.from('atividades').update(atualizado).eq('id', req.id);
  if (error) return { ok: false, erro: error.message };

  // sincroniza os vínculos com atendimento — apaga tudo e recria (lista
  // curta, mais simples e mais seguro que calcular o diff)
  await db.from('atividade_atendimentos').delete().eq('atividade_id', req.id);
  const atendimentoIds = Array.isArray(req.atendimentoIds) ? req.atendimentoIds.filter(Boolean) : [];
  if (atendimentoIds.length > 0) {
    await db.from('atividade_atendimentos').insert(atendimentoIds.map((atendimentoId: string) => ({ id: gerarId(), atividade_id: req.id, atendimento_id: atendimentoId })));
  }

  return { ok: true };
}

// alternar concluída/pendente com um clique só (checklist), sem precisar
// abrir e reenviar o formulário inteiro
async function acaoAlternarConclusaoAtividade(req: any) {
  if (!(await podeGerenciarAtividade(req.contaId))) return { ok: false, erro: 'Sem permissão pra editar atividades.' };
  if (!req.id) return { ok: false, erro: 'Atividade não informada.' };
  const { data: existente } = await db.from('atividades').select('status').eq('id', req.id).maybeSingle();
  if (!existente) return { ok: false, erro: 'Atividade não encontrada.' };
  const novoStatus = existente.status === 'CONCLUIDA' ? 'PENDENTE' : 'CONCLUIDA';
  const { error } = await db.from('atividades')
    .update({ status: novoStatus, concluido_em: novoStatus === 'CONCLUIDA' ? new Date().toISOString() : null })
    .eq('id', req.id);
  if (error) return { ok: false, erro: error.message };
  return { ok: true, status: novoStatus };
}

async function acaoRemoverAtividade(req: any) {
  if (!(await podeGerenciarAtividade(req.contaId))) return { ok: false, erro: 'Sem permissão pra remover atividades.' };
  await db.from('atividades').delete().eq('id', req.id);
  return { ok: true };
}

// remove de uma vez todas as ocorrências geradas junto (mesmo serie_id) —
// diferente de acaoRemoverAtividade, que só tira essa ocorrência
async function acaoRemoverSerieAtividade(req: any) {
  if (!(await podeGerenciarAtividade(req.contaId))) return { ok: false, erro: 'Sem permissão pra remover atividades.' };
  if (!req.serieId) return { ok: false, erro: 'Série não informada.' };
  await db.from('atividades').delete().eq('serie_id', req.serieId);
  return { ok: true };
}

/* ---------- anexos de atividade — tabela própria (atividade_anexos), não
   reaproveita "anexos" porque lá atendimento_id é obrigatório ---------- */
async function acaoListarAnexosAtividade(req: any) {
  if (!req.atividadeId) return { ok: false, erro: 'Atividade não informada.' };
  const { data, error } = await db.from('atividade_anexos').select('*').eq('atividade_id', req.atividadeId).order('criado_em');
  if (error) return { ok: false, erro: error.message };
  return { ok: true, anexos: (data || []).map((a: any) => ({ id: a.id, atividadeId: a.atividade_id, nome: a.nome, url: a.url })) };
}

async function acaoAdicionarAnexoAtividade(req: any) {
  if (!req.atividadeId) return { ok: false, erro: 'Atividade não informada.' };
  try {
    const salvo = await salvarAnexo(req.base64, req.tipo, req.nome);
    const registro = { id: gerarId(), atividade_id: req.atividadeId, nome: salvo.nome, url: salvo.url };
    const { error } = await db.from('atividade_anexos').insert(registro);
    if (error) return { ok: false, erro: error.message };
    return { ok: true, anexo: { id: registro.id, atividadeId: req.atividadeId, nome: registro.nome, url: registro.url } };
  } catch (e) {
    return { ok: false, erro: 'Não foi possível enviar o anexo.' };
  }
}

async function acaoRemoverAnexoAtividade(req: any) {
  await db.from('atividade_anexos').delete().eq('id', req.id);
  return { ok: true };
}

/* ---------- orçamentos (proposta comercial: itens por valor/hora, PDF e
   Excel pra envio ao cliente) ---------- */
async function podeGerenciarOrcamento(contaId: string) {
  const { data: conta } = await db.from('contas').select('perfil').eq('id', contaId).maybeSingle();
  return !!(conta && (conta.perfil === 'ADMIN' || conta.perfil === 'ATENDENTE'));
}

function orcamentoItemParaApi(it: any) {
  return {
    id: it.id, itemPaiId: it.item_pai_id || '', descricao: it.descricao,
    qtdHoras: it.qtd_horas !== null ? Number(it.qtd_horas) : null,
    valorHora: it.valor_hora !== null ? Number(it.valor_hora) : null,
    ordem: it.ordem || 0,
  };
}

// só os itens "folha" (sem filhos) somam de verdade — um item com filhos
// não tem qtd_horas/valor_hora próprios, o valor dele já É a soma deles
function calcularTotaisOrcamento(itens: any[]) {
  const temFilhos = new Set(itens.filter((it) => it.item_pai_id).map((it) => it.item_pai_id));
  let totalHoras = 0, totalValor = 0;
  itens.forEach((it) => {
    if (temFilhos.has(it.id)) return;
    const horas = Number(it.qtd_horas) || 0;
    totalHoras += horas;
    totalValor += horas * (Number(it.valor_hora) || 0);
  });
  return { totalHoras, totalValor };
}

function orcamentoParaApi(o: any, totalHoras: number, totalValor: number) {
  return {
    id: o.id, numero: o.numero, cliente: o.cliente, assunto: o.assunto || '',
    responsavel: o.responsavel || '', validade: o.validade || '', condicoes: o.condicoes || '',
    status: o.status || 'RASCUNHO', criadoPor: o.criado_por || '', criadoEm: o.criado_em,
    empresaId: o.empresa_id || '', totalHoras, totalValor,
  };
}

async function gerarNumeroOrcamento(empresaId?: string): Promise<string> {
  const ano = new Date().getFullYear();
  let query = db.from('orcamentos').select('numero').ilike('numero', `${ano}-%`);
  if (empresaId) query = query.eq('empresa_id', empresaId);
  const { data } = await query;
  const seq = (data || []).length + 1;
  return `${ano}-${String(seq).padStart(3, '0')}`;
}

async function acaoListarOrcamentos(req: any) {
  if (!(await podeGerenciarOrcamento(req.contaId))) return { ok: true, orcamentos: [] };
  let query = db.from('orcamentos').select('*').order('criado_em', { ascending: false });
  if (req.empresaId) query = query.eq('empresa_id', req.empresaId);
  const { data, error } = await query;
  if (error) return { ok: false, erro: error.message };
  const orcamentos = data || [];
  if (orcamentos.length === 0) return { ok: true, orcamentos: [] };

  const { data: todosItens } = await db.from('orcamento_itens').select('*').in('orcamento_id', orcamentos.map((o: any) => o.id));
  const itensPorOrcamento: Record<string, any[]> = {};
  (todosItens || []).forEach((it: any) => { (itensPorOrcamento[it.orcamento_id] = itensPorOrcamento[it.orcamento_id] || []).push(it); });

  return {
    ok: true,
    orcamentos: orcamentos.map((o: any) => {
      const { totalHoras, totalValor } = calcularTotaisOrcamento(itensPorOrcamento[o.id] || []);
      return orcamentoParaApi(o, totalHoras, totalValor);
    }),
  };
}

async function acaoObterOrcamento(req: any) {
  if (!(await podeGerenciarOrcamento(req.contaId))) return { ok: false, erro: 'Sem permissão pra acessar orçamentos.' };
  if (!req.id) return { ok: false, erro: 'Orçamento não informado.' };
  const { data: o } = await db.from('orcamentos').select('*').eq('id', req.id).maybeSingle();
  if (!o) return { ok: false, erro: 'Orçamento não encontrado.' };
  const { data: itens, error } = await db.from('orcamento_itens').select('*').eq('orcamento_id', req.id).order('ordem');
  if (error) return { ok: false, erro: error.message };
  const { totalHoras, totalValor } = calcularTotaisOrcamento(itens || []);
  return { ok: true, orcamento: orcamentoParaApi(o, totalHoras, totalValor), itens: (itens || []).map(orcamentoItemParaApi) };
}

// cria ou atualiza o orçamento inteiro de uma vez (cabeçalho + itens) — os
// itens são sempre apagados e recriados (lista curta, mais simples e mais
// seguro que calcular o diff). Cada item chega com um "tempId" só pra essa
// requisição (não é o id de verdade) — serve pra um subitem conseguir
// referenciar o pai antes dele existir de fato no banco.
async function acaoSalvarOrcamento(req: any) {
  if (!(await podeGerenciarOrcamento(req.contaId))) return { ok: false, erro: 'Sem permissão pra gerenciar orçamentos.' };
  if (!req.cliente) return { ok: false, erro: 'Escolha um cliente.' };
  const itensReq = Array.isArray(req.itens) ? req.itens.filter((it: any) => String(it.descricao || '').trim()) : [];
  if (itensReq.length === 0) return { ok: false, erro: 'Adicione pelo menos um item.' };

  const { data: conta } = await db.from('contas').select('nome').eq('id', req.contaId).maybeSingle();
  const ehNovo = !req.id;
  const orcamentoId = req.id || gerarId();
  const numero = ehNovo ? await gerarNumeroOrcamento(req.empresaId) : req.numero;

  if (ehNovo) {
    const registro = {
      id: orcamentoId, numero, cliente: req.cliente, assunto: req.assunto || '',
      responsavel: req.responsavel || (conta ? conta.nome : ''), validade: req.validade || null,
      condicoes: req.condicoes || '', status: req.status || 'RASCUNHO',
      criado_por: conta ? conta.nome : '', empresa_id: req.empresaId || null,
    };
    const { error } = await db.from('orcamentos').insert(registro);
    if (error) return { ok: false, erro: error.message };
  } else {
    const registro = {
      cliente: req.cliente, assunto: req.assunto || '', responsavel: req.responsavel || '',
      validade: req.validade || null, condicoes: req.condicoes || '', status: req.status || 'RASCUNHO',
    };
    const { error } = await db.from('orcamentos').update(registro).eq('id', orcamentoId);
    if (error) return { ok: false, erro: error.message };
  }

  const idPorTemp: Record<string, string> = {};
  itensReq.forEach((it: any) => { idPorTemp[it.tempId] = gerarId(); });
  const registrosItens = itensReq.map((it: any, i: number) => ({
    id: idPorTemp[it.tempId], orcamento_id: orcamentoId,
    item_pai_id: it.itemPaiTempId ? (idPorTemp[it.itemPaiTempId] || null) : null,
    descricao: it.descricao, ordem: i,
    qtd_horas: (it.qtdHoras !== '' && it.qtdHoras != null) ? Number(it.qtdHoras) : null,
    valor_hora: (it.valorHora !== '' && it.valorHora != null) ? Number(it.valorHora) : null,
  }));

  await db.from('orcamento_itens').delete().eq('orcamento_id', orcamentoId);
  const { error: erroItens } = await db.from('orcamento_itens').insert(registrosItens);
  if (erroItens) return { ok: false, erro: erroItens.message };

  return { ok: true, id: orcamentoId, numero };
}

async function acaoRemoverOrcamento(req: any) {
  if (!(await podeGerenciarOrcamento(req.contaId))) return { ok: false, erro: 'Sem permissão pra remover orçamentos.' };
  await db.from('orcamentos').delete().eq('id', req.id);
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

  const { data: atuais, error: erroSelect } = await db.from('atendimentos').select('id,status,data_prevista').in('id', ids);
  if (erroSelect) return { ok: false, erro: 'Erro ao ler atendimentos: ' + erroSelect.message };

  let atualizados = 0;
  for (const a of atuais || []) {
    if (a.status === req.novoStatus) continue;
    const atualizacao: Record<string, unknown> = { status: req.novoStatus };
    // Data Final (Prevista) some auto-preenchida com hoje quando o chamado vira
    // CONCLUÍDO sem ela ter sido informada (fica só como registro de quando fechou)
    if (req.novoStatus === 'CONCLUÍDO' && !a.data_prevista) atualizacao.data_prevista = dataAtualIso();
    const { error } = await db.from('atendimentos').update(atualizacao).eq('id', a.id);
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
  const menu = perfil === 'USUARIO' ? 'cadastros.usuarios' : 'cadastros.atendentes';
  if (!(await podeAgir(req.contaId, menu, 'inserir'))) return { ok: false, erro: 'Você não tem permissão para cadastrar contas.' };
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
  const menu = existente.perfil === 'USUARIO' ? 'cadastros.usuarios' : 'cadastros.atendentes';
  if (!(await podeAgir(req.contaId, menu, 'editar'))) return { ok: false, erro: 'Você não tem permissão para editar essa conta.' };

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
  const { data: existente } = await db.from('contas').select('perfil').eq('id', req.id).maybeSingle();
  if (!existente) return { ok: false, erro: 'Conta não encontrada.' };
  const menu = existente.perfil === 'USUARIO' ? 'cadastros.usuarios' : 'cadastros.atendentes';
  if (!(await podeAgir(req.contaId, menu, 'excluir'))) return { ok: false, erro: 'Você não tem permissão para remover essa conta.' };
  await db.from('contas').delete().eq('id', req.id);
  return { ok: true };
}

/* ---------- perfis de acesso (menus x visualizar/editar/excluir/inserir) ---------- */
async function acaoListarPerfisAcesso(req: any) {
  if (!(await podeAgir(req.contaId, 'cadastros.perfisacesso', 'visualizar'))) return { ok: false, erro: 'Você não tem permissão para ver os perfis de acesso.' };
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
  const campo = req.id ? 'editar' : 'inserir';
  if (!(await podeAgir(req.contaId, 'cadastros.perfisacesso', campo))) return { ok: false, erro: 'Você não tem permissão para gerenciar perfis de acesso.' };
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
  if (!(await podeAgir(req.contaId, 'cadastros.perfisacesso', 'excluir'))) return { ok: false, erro: 'Você não tem permissão para remover perfis de acesso.' };
  await db.from('perfis_acesso').delete().eq('id', req.id);
  return { ok: true };
}

// substitui por completo os perfis vinculados à conta alvo (mais simples
// e previsível do que calcular um diff — a tela sempre manda a lista
// completa de perfis marcados no momento de salvar)
async function acaoVincularPerfisConta(req: any) {
  if (!req.contaAlvoId) return { ok: false, erro: 'Conta não informada.' };
  const { data: contaAlvo } = await db.from('contas').select('perfil').eq('id', req.contaAlvoId).maybeSingle();
  const menu = (contaAlvo && contaAlvo.perfil === 'USUARIO') ? 'cadastros.usuarios' : 'cadastros.atendentes';
  if (!(await podeAgir(req.contaId, menu, 'editar'))) return { ok: false, erro: 'Você não tem permissão para vincular perfis de acesso.' };
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

/* ---------- empresas (multi-empresa) ---------- */
async function acaoSalvarEmpresa(req: any) {
  const campo = req.id ? 'editar' : 'inserir';
  if (!(await podeAgir(req.contaId, 'cadastros.empresas', campo))) return { ok: false, erro: 'Você não tem permissão para gerenciar empresas.' };
  const nome = String(req.nome || '').trim();
  if (!nome) return { ok: false, erro: 'Dê um nome à empresa.' };

  const registro = {
    nome, nome_fantasia: req.nomeFantasia || '', cnpj: req.cnpj || '', endereco: req.endereco || '',
    telefone: req.telefone || '', email: req.email || '', cidade: req.cidade || '', cnae: req.cnae || '',
    inscricao_municipal: req.inscricaoMunicipal || '', inscricao_estadual: req.inscricaoEstadual || '',
    logo_url: req.logoUrl || '', horas_validacao_automatica: Number(req.horasValidacaoAutomatica) || 48,
  };

  const id = req.id || gerarId();
  // só uma empresa pode ser a padrão (aparece na tela de login) — marcar
  // uma nova como padrão tira a marca de quem era antes
  if (req.padrao) await db.from('empresas').update({ padrao: false }).neq('id', id);

  if (req.id) {
    const { error } = await db.from('empresas').update({ ...registro, padrao: !!req.padrao }).eq('id', id);
    if (error) return { ok: false, erro: error.message };
  } else {
    const { error } = await db.from('empresas').insert({ id, ...registro, padrao: !!req.padrao });
    if (error) return { ok: false, erro: error.message };
  }
  return { ok: true, id };
}

async function acaoRemoverEmpresa(req: any) {
  if (!(await podeAgir(req.contaId, 'cadastros.empresas', 'excluir'))) return { ok: false, erro: 'Você não tem permissão para remover empresas.' };
  const { data: emUso } = await db.from('clientes').select('id').eq('empresa_id', req.id).limit(1);
  if (emUso && emUso.length) return { ok: false, erro: 'Essa empresa tem clientes vinculados — mova ou remova os clientes antes.' };
  await db.from('empresas').delete().eq('id', req.id);
  return { ok: true };
}

// mesmo padrão de acaoVincularPerfisConta: substitui por completo a lista
// de empresas vinculadas à conta alvo (atendente/admin)
async function acaoVincularEmpresasConta(req: any) {
  if (!(await podeAgir(req.contaId, 'cadastros.atendentes', 'editar'))) return { ok: false, erro: 'Você não tem permissão para vincular empresas.' };
  if (!req.contaAlvoId) return { ok: false, erro: 'Conta não informada.' };
  const empresaIds: string[] = Array.isArray(req.empresaIds) ? req.empresaIds : [];

  const { error: erroDelete } = await db.from('conta_empresas').delete().eq('conta_id', req.contaAlvoId);
  if (erroDelete) return { ok: false, erro: erroDelete.message };
  if (empresaIds.length > 0) {
    const linhas = empresaIds.map((empresaId) => ({ id: gerarId(), conta_id: req.contaAlvoId, empresa_id: empresaId }));
    const { error: erroInsert } = await db.from('conta_empresas').insert(linhas);
    if (erroInsert) return { ok: false, erro: erroInsert.message };
  }
  return { ok: true };
}

/* ---------- integração TomTicket (ver tomticket-webhook) ---------- */
async function acaoRemoverTomticketErro(req: any) {
  if (!(await podeAgir(req.contaId, 'utilitarios.tomticket', 'excluir'))) return { ok: false, erro: 'Você não tem permissão para gerenciar isso.' };
  await db.from('tomticket_erros').delete().eq('id', req.id);
  return { ok: true };
}

/* ---------- cadastros simples (clientes, tipos, módulos, sub módulos, status) ---------- */
async function acaoAddSimples(tabela: string, menu: string, req: any) {
  if (!(await podeAgir(req.contaId, menu, 'inserir'))) return { ok: false, erro: 'Você não tem permissão para cadastrar isso.' };
  const registro = { id: gerarId(), nome: req.nome };
  const { error } = await db.from(tabela).insert(registro);
  if (error) return { ok: false, erro: error.message };
  return { ok: true, registro };
}
async function acaoRemoverSimples(tabela: string, menu: string, req: any) {
  if (!(await podeAgir(req.contaId, menu, 'excluir'))) return { ok: false, erro: 'Você não tem permissão para remover isso.' };
  await db.from(tabela).delete().eq('id', req.id);
  return { ok: true };
}
async function acaoRemoverCliente(req: any) {
  if (!(await podeAgir(req.contaId, 'cadastros.clientes', 'excluir'))) return { ok: false, erro: 'Você não tem permissão para remover clientes.' };
  await db.from('clientes').delete().eq('id', req.id);
  await db.from('valores').delete().eq('cliente_id', req.id);
  await db.from('contas').delete().eq('perfil', 'USUARIO').eq('cliente_id', req.id);
  return { ok: true };
}
async function acaoAddCliente(req: any) {
  if (!(await podeAgir(req.contaId, 'cadastros.clientes', 'inserir'))) return { ok: false, erro: 'Você não tem permissão para cadastrar clientes.' };
  if (!req.empresaId) return { ok: false, erro: 'Escolha uma empresa antes de cadastrar um cliente.' };
  const registro = { id: gerarId(), nome: req.nome, cnpj: req.cnpj || '', nome_fantasia: req.nomeFantasia || '', meta_mensal: Number(req.metaMensal) || 0, empresa_id: req.empresaId };
  const { error } = await db.from('clientes').insert(registro);
  if (error) return { ok: false, erro: error.message };
  return { ok: true, registro: clienteParaApi(registro) };
}
async function acaoAtualizarCliente(req: any) {
  if (!(await podeAgir(req.contaId, 'cadastros.clientes', 'editar'))) return { ok: false, erro: 'Você não tem permissão para editar clientes.' };
  if (!req.id) return { ok: false, erro: 'Cliente não informado.' };
  const atualizado: any = {};
  if (req.nome !== undefined) atualizado.nome = req.nome;
  if (req.cnpj !== undefined) atualizado.cnpj = req.cnpj;
  if (req.nomeFantasia !== undefined) atualizado.nome_fantasia = req.nomeFantasia;
  if (req.metaMensal !== undefined) atualizado.meta_mensal = Number(req.metaMensal) || 0;
  if (req.empresaId) atualizado.empresa_id = req.empresaId;
  const { error } = await db.from('clientes').update(atualizado).eq('id', req.id);
  if (error) return { ok: false, erro: error.message };
  return { ok: true };
}
async function acaoRemoverTipo(req: any) {
  if (!(await podeAgir(req.contaId, 'cadastros.tipos', 'excluir'))) return { ok: false, erro: 'Você não tem permissão para remover tipos.' };
  await db.from('tipos').delete().eq('id', req.id);
  await db.from('valores').delete().eq('tipo_id', req.id);
  return { ok: true };
}

// recebe a lista completa de ids de status na nova ordem desejada e regrava
// o campo "ordem" de cada um (0,1,2...) — usada pelos botões ▲▼ em
// Cadastros → Status, e reflete direto na ordem das colunas do Kanban
async function acaoReordenarStatus(req: any) {
  if (!(await podeAgir(req.contaId, 'cadastros.status', 'editar'))) return { ok: false, erro: 'Você não tem permissão para reordenar status.' };
  const ids: string[] = Array.isArray(req.ids) ? req.ids : [];
  for (let i = 0; i < ids.length; i++) {
    await db.from('status_list').update({ ordem: i }).eq('id', ids[i]);
  }
  return { ok: true };
}

/* ---------- valores/hora ---------- */
async function acaoSalvarValor(req: any) {
  if (!(await podeAgir(req.contaId, 'cadastros.valores', 'editar')) && !(await podeAgir(req.contaId, 'cadastros.valores', 'inserir'))) {
    return { ok: false, erro: 'Você não tem permissão para gerenciar valores.' };
  }
  // sem .maybeSingle(): se por acaso já existir mais de uma linha duplicada
  // pra essa combinação (era o que causava valor zerado ao salvar
  // atendimento), isso não quebra — junta tudo numa lista e limpa o excesso.
  const { data: existentes, error: erroSelect } = await db.from('valores').select('id,empresa_id')
    .eq('atendente_id', req.atendenteId).eq('cliente_id', req.clienteId).eq('tipo_id', req.tipoId);
  if (erroSelect) return { ok: false, erro: erroSelect.message };

  const id = (existentes && existentes[0]) ? existentes[0].id : gerarId();
  const empresaId = req.empresaId || (existentes && existentes[0] ? existentes[0].empresa_id : null);
  const { error } = await db.from('valores').upsert(
    { id, atendente_id: req.atendenteId, cliente_id: req.clienteId, tipo_id: req.tipoId, real: req.real, ananda: req.ananda, valor_segundo_atend: req.valorSegundoAtend || 0, empresa_id: empresaId },
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
  if (!(await podeAgir(req.contaId, 'cadastros.valores', 'editar'))) return { ok: false, erro: 'Você não tem permissão para recalcular valores.' };

  const empresaId = req.empresaId || null;
  let qAtendimentos = db.from('atendimentos').select('*');
  let qValores = db.from('valores').select('*');
  let qClientes = db.from('clientes').select('*');
  if (empresaId) { qAtendimentos = qAtendimentos.eq('empresa_id', empresaId); qValores = qValores.eq('empresa_id', empresaId); qClientes = qClientes.eq('empresa_id', empresaId); }
  const [rAtendimentos, rValores, rClientes, rTipos, rContas] = await Promise.all([
    qAtendimentos,
    qValores,
    qClientes,
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

    // segundo atendente (se tiver) — usa a taxa "Valor 2º Atendente/h" da
    // mesma linha de valores encontrada acima, igual acontece ao salvar
    const temAtendente2 = a.atendente2 && contasAtendentes.some((c: any) => c.nome === a.atendente2);
    const ananda2 = temAtendente2 ? Number(valor.valor_segundo_atend || 0) : 0;
    const horasAtendente2 = temAtendente2 ? (Number(a.horas_atendente2) || 0) : 0;
    const novoTotalAnanda2 = horasAtendente2 * ananda2;

    const mudou = Number(a.vhr) !== real || Number(a.vha) !== ananda ||
      Number(a.total_real) !== novoTotalReal || Number(a.total_ananda) !== novoTotalAnanda ||
      Number(a.vha2 || 0) !== ananda2 || Number(a.total_ananda2 || 0) !== novoTotalAnanda2;

    if (mudou) {
      const { error } = await db.from('atendimentos').update({
        vhr: real, vha: ananda, total_real: novoTotalReal, total_ananda: novoTotalAnanda,
        vha2: ananda2, total_ananda2: novoTotalAnanda2,
      }).eq('id', a.id);
      if (!error) atualizados++;
    }
  }

  return { ok: true, total: lista.length, atualizados, semCorrespondencia };
}

/* =========================================================
   Gerador SQL RM — dicionário de dados do TOTVS RM (tabelas, campos e
   relacionamentos) guardado no nosso banco, pra montar consultas SQL
   Server sem decorar nome de tabela/campo do RM. Alimentado por
   importação em lote (GDIC2 = dicionário, GLINKSREL = relacionamentos)
   ou cadastro manual — ver Cadastros → Tabelas RM/Campos RM/
   Relacionamentos RM/Tabelas Auxiliares RM e Utilitários → Gerador SQL RM.
   ========================================================= */
function normalizarNomeRm(s: any): string {
  return String(s || '').trim().toUpperCase();
}
// chave composta do RM vem como "CODCOLIGADA,CHAPA" (às vezes com espaço
// depois da vírgula) — normaliza pra sempre "CODCOLIGADA,CHAPA", sem espaço,
// pra bater exatamente na hora de comparar/gerar o SQL
function normalizarCamposRm(s: any): string {
  return String(s || '').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean).join(',');
}
// tira caracteres que quebrariam a sintaxe de filtro do PostgREST (usada
// direto numa string interpolada em .or()/.in()) — a busca continua
// funcionando normalmente, só perde esses símbolos específicos
function sanitizarBuscaRm(s: any): string {
  return String(s || '').replace(/[,()%*]/g, ' ').trim();
}
function dedupPorChaveRm<T>(arr: T[], chave: (x: T) => string): T[] {
  const mapa = new Map<string, T>();
  for (const item of arr) mapa.set(chave(item), item);
  return [...mapa.values()];
}
// verdadeiro se a conta tiver a permissão pedida em QUALQUER um dos menus
// informados — usado pelas telas que servem tanto o Cadastro (admin) quanto
// o Gerador SQL RM (uso corrente, ex: buscar tabelas/campos pra montar consulta)
async function podeAgirRm(contaId: string, menus: string[], campo: 'visualizar' | 'editar' | 'excluir' | 'inserir'): Promise<boolean> {
  for (const m of menus) { if (await podeAgir(contaId, m, campo)) return true; }
  return false;
}
function rmTabelaParaApi(t: any) {
  return { id: t.id, nome: t.nome, apelido: t.apelido || '', descricao: t.descricao || '', auxiliar: !!t.auxiliar, auxCampoCodigo: t.aux_campo_codigo || '', auxCampoDescricao: t.aux_campo_descricao || '' };
}
function rmCampoParaApi(c: any) {
  return { id: c.id, tabelaId: c.tabela_id, nome: c.nome, rotulo: c.rotulo || '', tipo: c.tipo || '' };
}
function rmConsultaParaApi(c: any) {
  return { id: c.id, nome: c.nome, tabelaPrincipalId: c.tabela_principal_id, config: c.config, sqlGerado: c.sql_gerado, criadoPor: c.criado_por || '', criadoEm: c.criado_em };
}

// busca tabelas por nome em pedaços pequenos — um único .in('nome', [...])
// com centenas/milhares de nomes de uma vez (comum na importação do
// GLINKSREL, onde cada linha cita 2 tabelas e um lote de 1500 linhas pode
// citar milhares de nomes distintos) monta uma URL gigante e o servidor
// recusa a requisição (erro de protocolo HTTP/2)
async function buscarTabelasExistentesRm(nomes: any[]): Promise<{ mapa: Map<string, string>; erro?: string }> {
  const mapa = new Map<string, string>();
  const TAM_PEDACO = 150;
  for (let i = 0; i < nomes.length; i += TAM_PEDACO) {
    const pedaco = nomes.slice(i, i + TAM_PEDACO);
    const { data, error } = await db.from('rm_tabelas').select('id,nome').in('nome', pedaco);
    if (error) return { mapa, erro: error.message };
    (data || []).forEach((t: any) => mapa.set(t.nome, t.id));
  }
  return { mapa };
}

// miolo sem checagem de permissão — usado pela versão autenticada
// (acaoRmListarTabelas) e pela pública (acaoRmPublicoListarTabelas)
async function nucleoRmListarTabelas(req: any) {
  const limite = Math.min(Number(req.limit) || 40, 1000);
  const offset = Math.max(Number(req.offset) || 0, 0);
  let query = db.from('rm_tabelas').select('*', { count: 'exact' }).order('nome').range(offset, offset + limite - 1);
  if (req.somenteAuxiliares) query = query.eq('auxiliar', true);
  if (req.busca) {
    const termo = sanitizarBuscaRm(req.busca);
    query = query.or(`nome.ilike.%${termo}%,apelido.ilike.%${termo}%`);
  }
  const { data, error, count } = await query;
  if (error) return { ok: false, erro: error.message };
  return { ok: true, tabelas: (data || []).map(rmTabelaParaApi), total: count || 0 };
}
async function acaoRmListarTabelas(req: any) {
  if (!(await podeAgirRm(req.contaId, ['utilitarios.sqlrm', 'cadastros.tabelasrm'], 'visualizar'))) {
    return { ok: false, erro: 'Você não tem permissão para ver as tabelas do RM.' };
  }
  return nucleoRmListarTabelas(req);
}
async function acaoRmAddTabela(req: any) {
  if (!(await podeAgir(req.contaId, 'cadastros.tabelasrm', 'inserir'))) return { ok: false, erro: 'Você não tem permissão para cadastrar tabelas do RM.' };
  const nome = normalizarNomeRm(req.nome);
  if (!nome) return { ok: false, erro: 'Informe o nome real da tabela.' };
  const { data: existente } = await db.from('rm_tabelas').select('id').eq('nome', nome).maybeSingle();
  if (existente) return { ok: false, erro: 'Já existe uma tabela cadastrada com esse nome.' };
  const registro = { id: gerarId(), nome, apelido: req.apelido || nome, descricao: req.descricao || '' };
  const { error } = await db.from('rm_tabelas').insert(registro);
  if (error) return { ok: false, erro: error.message };
  return { ok: true, tabela: rmTabelaParaApi(registro) };
}
async function acaoRmAtualizarTabela(req: any) {
  if (!(await podeAgir(req.contaId, 'cadastros.tabelasrm', 'editar'))) return { ok: false, erro: 'Você não tem permissão para editar tabelas do RM.' };
  const atualizacao: any = {};
  if (req.apelido !== undefined) atualizacao.apelido = req.apelido;
  if (req.descricao !== undefined) atualizacao.descricao = req.descricao;
  const { error } = await db.from('rm_tabelas').update(atualizacao).eq('id', req.id);
  if (error) return { ok: false, erro: error.message };
  return { ok: true };
}
async function acaoRmRemoverTabela(req: any) {
  if (!(await podeAgir(req.contaId, 'cadastros.tabelasrm', 'excluir'))) return { ok: false, erro: 'Você não tem permissão para remover tabelas do RM.' };
  await db.from('rm_tabelas').delete().eq('id', req.id);
  return { ok: true };
}

// importação em lote do dicionário do RM (export GDIC2: TABELA;COLUNA;
// DESCRICAO;...) — o front-end já manda só as 3 colunas que interessam,
// em lotes de ~1500 linhas, pra nunca estourar tempo/tamanho de uma
// requisição só, mesmo num dicionário com mais de 100 mil linhas.
// COLUNA "#" é uma linha especial do RM: não é um campo de verdade, é o
// próprio rótulo/descrição da tabela.
async function acaoRmImportarDicionarioLote(req: any) {
  if (!(await podeAgir(req.contaId, 'cadastros.tabelasrm', 'inserir'))) {
    return { ok: false, erro: 'Você não tem permissão para importar o dicionário do RM.' };
  }
  const linhas = (Array.isArray(req.linhas) ? req.linhas : [])
    .map((l: any) => ({ tabela: normalizarNomeRm(l.tabela), coluna: String(l.coluna || '').trim(), descricao: String(l.descricao || '').trim() }))
    .filter((l: any) => l.tabela);
  if (linhas.length === 0) return { ok: true, tabelas: 0, campos: 0 };

  const nomesTabelas = [...new Set(linhas.map((l: any) => l.tabela))] as string[];
  // 1) descobre quem já existe (pelo nome) — só depois disso decide o que
  // é INSERT (nome ainda não existe, precisa de id novo) e o que é UPDATE
  // (nome já existe, usa o id de verdade — nunca gera/upserta sem saber o
  // id certo, que foi exatamente a causa do erro "null value in column id")
  const { mapa: mapaId, erro: erroExistentes } = await buscarTabelasExistentesRm(nomesTabelas);
  if (erroExistentes) return { ok: false, erro: erroExistentes };

  const nomesFaltando = nomesTabelas.filter((nome) => !mapaId.has(nome));
  if (nomesFaltando.length) {
    const novos = nomesFaltando.map((nome) => ({ id: gerarId(), nome }));
    const { data: inseridos, error: erroInsert } = await db.from('rm_tabelas').insert(novos).select('id,nome');
    if (erroInsert) return { ok: false, erro: erroInsert.message };
    (inseridos || []).forEach((t: any) => mapaId.set(t.nome, t.id));
  }

  // 2) aplica o rótulo/descrição da tabela (linhas coluna="#") via upsert
  // por id — o id usado é sempre o real (recém-criado ou já existente),
  // então "on conflict (id) do update" nunca troca o id de ninguém
  const linhasTabela = dedupPorChaveRm(linhas.filter((l: any) => l.coluna === '#' && l.descricao), (l: any) => l.tabela);
  if (linhasTabela.length) {
    const atualizacoesTabela = linhasTabela
      .map((l: any) => {
        const id = mapaId.get(l.tabela);
        return id ? { id, nome: l.tabela, apelido: l.descricao, descricao: l.descricao } : null;
      })
      .filter(Boolean);
    if (atualizacoesTabela.length) {
      const { error: erroApelido } = await db.from('rm_tabelas').upsert(atualizacoesTabela, { onConflict: 'id' });
      if (erroApelido) return { ok: false, erro: erroApelido.message };
    }
  }

  const linhasCampo = dedupPorChaveRm(
    linhas.filter((l: any) => l.coluna && l.coluna !== '#'),
    (l: any) => `${l.tabela}|${normalizarNomeRm(l.coluna)}`
  );
  let camposProcessados = 0;
  if (linhasCampo.length) {
    const registrosCampo = linhasCampo
      .map((l: any) => {
        const tabelaId = mapaId.get(l.tabela);
        if (!tabelaId) return null;
        return { id: gerarId(), tabela_id: tabelaId, nome: normalizarNomeRm(l.coluna), rotulo: l.descricao };
      })
      .filter(Boolean);
    if (registrosCampo.length) {
      const { error: erroCampo } = await db.from('rm_campos').upsert(registrosCampo, { onConflict: 'tabela_id,nome', ignoreDuplicates: false });
      if (erroCampo) return { ok: false, erro: erroCampo.message };
      camposProcessados = registrosCampo.length;
    }
  }
  return { ok: true, tabelas: nomesTabelas.length, campos: camposProcessados };
}

async function nucleoRmListarCampos(req: any) {
  if (!req.tabelaId) return { ok: true, campos: [] };
  let query = db.from('rm_campos').select('*').eq('tabela_id', req.tabelaId).order('nome');
  if (req.busca) {
    const termo = sanitizarBuscaRm(req.busca);
    query = query.or(`nome.ilike.%${termo}%,rotulo.ilike.%${termo}%`);
  }
  const { data, error } = await query;
  if (error) return { ok: false, erro: error.message };
  return { ok: true, campos: (data || []).map(rmCampoParaApi) };
}
async function acaoRmListarCampos(req: any) {
  if (!(await podeAgirRm(req.contaId, ['utilitarios.sqlrm', 'cadastros.camposrm'], 'visualizar'))) {
    return { ok: false, erro: 'Você não tem permissão para ver os campos do RM.' };
  }
  return nucleoRmListarCampos(req);
}
async function acaoRmAddCampo(req: any) {
  if (!(await podeAgir(req.contaId, 'cadastros.camposrm', 'inserir'))) return { ok: false, erro: 'Você não tem permissão para cadastrar campos do RM.' };
  const nome = normalizarNomeRm(req.nome);
  if (!nome || !req.tabelaId) return { ok: false, erro: 'Informe a tabela e o nome real do campo.' };
  const registro = { id: gerarId(), tabela_id: req.tabelaId, nome, rotulo: req.rotulo || nome, tipo: req.tipo || '' };
  const { error } = await db.from('rm_campos').insert(registro);
  if (error) return { ok: false, erro: error.message };
  return { ok: true, campo: rmCampoParaApi(registro) };
}
async function acaoRmAtualizarCampo(req: any) {
  if (!(await podeAgir(req.contaId, 'cadastros.camposrm', 'editar'))) return { ok: false, erro: 'Você não tem permissão para editar campos do RM.' };
  const atualizacao: any = {};
  if (req.rotulo !== undefined) atualizacao.rotulo = req.rotulo;
  if (req.tipo !== undefined) atualizacao.tipo = req.tipo;
  const { error } = await db.from('rm_campos').update(atualizacao).eq('id', req.id);
  if (error) return { ok: false, erro: error.message };
  return { ok: true };
}
async function acaoRmRemoverCampo(req: any) {
  if (!(await podeAgir(req.contaId, 'cadastros.camposrm', 'excluir'))) return { ok: false, erro: 'Você não tem permissão para remover campos do RM.' };
  await db.from('rm_campos').delete().eq('id', req.id);
  return { ok: true };
}

// devolve os relacionamentos de UMA tabela (dos dois lados — ela pode ser
// origem ou destino do relacionamento no RM) já com o nome/apelido da
// OUTRA tabela resolvido — é isso que faz a lista de "tabelas relacionadas"
// do Gerador SQL RM mostrar só quem realmente tem relação com a principal
async function nucleoRmListarRelacionamentosDe(req: any) {
  const tabelaId = String(req.tabelaId || '');
  if (!/^[a-zA-Z0-9-]+$/.test(tabelaId)) return { ok: true, relacionamentos: [] };
  const { data, error } = await db.from('rm_relacionamentos').select('*')
    .or(`tabela_origem_id.eq.${tabelaId},tabela_destino_id.eq.${tabelaId}`);
  if (error) return { ok: false, erro: error.message };
  const idsTabelas = new Set<string>();
  (data || []).forEach((r: any) => { idsTabelas.add(r.tabela_origem_id); idsTabelas.add(r.tabela_destino_id); });
  const { data: tabelas } = idsTabelas.size ? await db.from('rm_tabelas').select('id,nome,apelido').in('id', [...idsTabelas]) : { data: [] as any[] };
  const mapaTabela = new Map<string, any>((tabelas || []).map((t: any) => [t.id, t]));
  const relacionamentos = (data || []).map((r: any) => {
    const outraId = r.tabela_origem_id === tabelaId ? r.tabela_destino_id : r.tabela_origem_id;
    const outra = mapaTabela.get(outraId);
    const meuCampo = r.tabela_origem_id === tabelaId ? r.campo_origem : r.campo_destino;
    const campoOutra = r.tabela_origem_id === tabelaId ? r.campo_destino : r.campo_origem;
    return {
      id: r.id, tipoJoin: r.tipo_join,
      outraTabelaId: outraId, outraTabelaNome: outra ? outra.nome : '', outraTabelaApelido: outra ? (outra.apelido || outra.nome) : '',
      meuCampo, campoOutraTabela: campoOutra,
    };
  });
  return { ok: true, relacionamentos };
}
async function acaoRmListarRelacionamentosDe(req: any) {
  if (!(await podeAgirRm(req.contaId, ['utilitarios.sqlrm', 'cadastros.relacionamentosrm'], 'visualizar'))) {
    return { ok: false, erro: 'Você não tem permissão para ver os relacionamentos do RM.' };
  }
  return nucleoRmListarRelacionamentosDe(req);
}
// lista/busca administrativa (tela Cadastros → Relacionamentos RM) — filtra
// pelo nome/apelido de qualquer uma das tabelas envolvidas
async function acaoRmListarRelacionamentos(req: any) {
  if (!(await podeAgir(req.contaId, 'cadastros.relacionamentosrm', 'visualizar'))) {
    return { ok: false, erro: 'Você não tem permissão para ver os relacionamentos do RM.' };
  }
  const limite = Math.min(Number(req.limit) || 50, 1000);
  let idsTabelasFiltro: string[] | null = null;
  if (req.busca) {
    const termo = sanitizarBuscaRm(req.busca);
    const { data: tabelasBusca } = await db.from('rm_tabelas').select('id').or(`nome.ilike.%${termo}%,apelido.ilike.%${termo}%`).limit(300);
    idsTabelasFiltro = (tabelasBusca || []).map((t: any) => t.id);
    if (!idsTabelasFiltro || idsTabelasFiltro.length === 0) return { ok: true, relacionamentos: [] };
  }
  let query = db.from('rm_relacionamentos').select('*').order('criado_em', { ascending: false }).limit(limite);
  if (idsTabelasFiltro) query = query.or(`tabela_origem_id.in.(${idsTabelasFiltro.join(',')}),tabela_destino_id.in.(${idsTabelasFiltro.join(',')})`);
  const { data, error } = await query;
  if (error) return { ok: false, erro: error.message };
  const idsTabelas = new Set<string>();
  (data || []).forEach((r: any) => { idsTabelas.add(r.tabela_origem_id); idsTabelas.add(r.tabela_destino_id); });
  const { data: tabelas } = idsTabelas.size ? await db.from('rm_tabelas').select('id,nome,apelido').in('id', [...idsTabelas]) : { data: [] as any[] };
  const mapaTabela = new Map<string, any>((tabelas || []).map((t: any) => [t.id, t]));
  const relacionamentos = (data || []).map((r: any) => ({
    id: r.id,
    tabelaOrigemId: r.tabela_origem_id, tabelaOrigemNome: mapaTabela.get(r.tabela_origem_id)?.nome || '',
    campoOrigem: r.campo_origem,
    tabelaDestinoId: r.tabela_destino_id, tabelaDestinoNome: mapaTabela.get(r.tabela_destino_id)?.nome || '',
    campoDestino: r.campo_destino, tipoJoin: r.tipo_join,
  }));
  return { ok: true, relacionamentos };
}
async function acaoRmAddRelacionamento(req: any) {
  if (!(await podeAgir(req.contaId, 'cadastros.relacionamentosrm', 'inserir'))) return { ok: false, erro: 'Você não tem permissão para cadastrar relacionamentos do RM.' };
  const campoOrigem = normalizarCamposRm(req.campoOrigem);
  const campoDestino = normalizarCamposRm(req.campoDestino);
  if (!req.tabelaOrigemId || !req.tabelaDestinoId || !campoOrigem || !campoDestino) {
    return { ok: false, erro: 'Preencha tabela e campo de origem e destino.' };
  }
  const registro = {
    id: gerarId(), tabela_origem_id: req.tabelaOrigemId, campo_origem: campoOrigem,
    tabela_destino_id: req.tabelaDestinoId, campo_destino: campoDestino,
    tipo_join: req.tipoJoin === 'INNER' ? 'INNER' : 'LEFT',
  };
  const { error } = await db.from('rm_relacionamentos').insert(registro);
  if (error) return { ok: false, erro: error.message };
  return { ok: true };
}
// atualiza um relacionamento já existente — tanto o tipo de junção quanto
// a própria definição de quais tabelas/campos se relacionam (o import traz
// um padrão a partir do GLINKSREL; essa ação deixa o admin corrigir/ajustar
// manualmente). Só atualiza os campos que vierem definidos no pedido.
async function acaoRmAtualizarRelacionamento(req: any) {
  if (!(await podeAgir(req.contaId, 'cadastros.relacionamentosrm', 'editar'))) return { ok: false, erro: 'Você não tem permissão para editar relacionamentos do RM.' };
  const atualizacao: any = {};
  if (req.tipoJoin !== undefined) atualizacao.tipo_join = req.tipoJoin === 'INNER' ? 'INNER' : 'LEFT';
  if (req.tabelaOrigemId !== undefined) atualizacao.tabela_origem_id = req.tabelaOrigemId;
  if (req.tabelaDestinoId !== undefined) atualizacao.tabela_destino_id = req.tabelaDestinoId;
  if (req.campoOrigem !== undefined) {
    const campo = normalizarCamposRm(req.campoOrigem);
    if (!campo) return { ok: false, erro: 'Informe o campo de origem.' };
    atualizacao.campo_origem = campo;
  }
  if (req.campoDestino !== undefined) {
    const campo = normalizarCamposRm(req.campoDestino);
    if (!campo) return { ok: false, erro: 'Informe o campo de destino.' };
    atualizacao.campo_destino = campo;
  }
  const { error } = await db.from('rm_relacionamentos').update(atualizacao).eq('id', req.id);
  if (error) {
    if (String(error.message || '').includes('rm_relacionamentos_unico')) {
      return { ok: false, erro: 'Já existe um relacionamento igual (mesma tabela/campo de origem e destino).' };
    }
    return { ok: false, erro: error.message };
  }
  return { ok: true };
}
async function acaoRmRemoverRelacionamento(req: any) {
  if (!(await podeAgir(req.contaId, 'cadastros.relacionamentosrm', 'excluir'))) return { ok: false, erro: 'Você não tem permissão para remover relacionamentos do RM.' };
  await db.from('rm_relacionamentos').delete().eq('id', req.id);
  return { ok: true };
}

// importação em lote dos relacionamentos do RM (export GLINKSREL:
// MASTERTABLE;CHILDTABLE;MASTERFIELD;CHILDFIELD) — mesmo esquema em lotes
// da importação do dicionário. ignoreDuplicates:true na upsert final
// preserva o tipo de junção (INNER/LEFT) que o admin já tiver ajustado à
// mão pra um relacionamento que já existia.
async function acaoRmImportarRelacionamentosLote(req: any) {
  if (!(await podeAgir(req.contaId, 'cadastros.relacionamentosrm', 'inserir'))) {
    return { ok: false, erro: 'Você não tem permissão para importar relacionamentos do RM.' };
  }
  const linhas = (Array.isArray(req.linhas) ? req.linhas : [])
    .map((l: any) => ({
      tabelaOrigem: normalizarNomeRm(l.tabelaOrigem),
      campoOrigem: normalizarCamposRm(l.campoOrigem),
      tabelaDestino: normalizarNomeRm(l.tabelaDestino),
      campoDestino: normalizarCamposRm(l.campoDestino),
    }))
    .filter((l: any) => l.tabelaOrigem && l.campoOrigem && l.tabelaDestino && l.campoDestino);
  if (linhas.length === 0) return { ok: true, relacionamentos: 0 };

  // mesmo padrão do import do dicionário: descobre quem já existe antes de
  // decidir o que precisa de id novo, nunca upserta uma tabela sem saber
  // com certeza o id dela
  const nomesTabelas = [...new Set(linhas.flatMap((l: any) => [l.tabelaOrigem, l.tabelaDestino]))] as string[];
  const { mapa: mapaId, erro: erroExistentes } = await buscarTabelasExistentesRm(nomesTabelas);
  if (erroExistentes) return { ok: false, erro: erroExistentes };

  const nomesFaltando = nomesTabelas.filter((nome) => !mapaId.has(nome));
  if (nomesFaltando.length) {
    const novos = nomesFaltando.map((nome) => ({ id: gerarId(), nome }));
    const { data: inseridos, error: erroInsert } = await db.from('rm_tabelas').insert(novos).select('id,nome');
    if (erroInsert) return { ok: false, erro: erroInsert.message };
    (inseridos || []).forEach((t: any) => mapaId.set(t.nome, t.id));
  }

  const registros = dedupPorChaveRm(
    linhas
      .map((l: any) => {
        const origemId = mapaId.get(l.tabelaOrigem);
        const destinoId = mapaId.get(l.tabelaDestino);
        if (!origemId || !destinoId) return null;
        return { id: gerarId(), tabela_origem_id: origemId, campo_origem: l.campoOrigem, tabela_destino_id: destinoId, campo_destino: l.campoDestino, tipo_join: 'LEFT' };
      })
      .filter(Boolean) as any[],
    (r: any) => `${r.tabela_origem_id}|${r.campo_origem}|${r.tabela_destino_id}|${r.campo_destino}`
  );
  if (registros.length === 0) return { ok: true, relacionamentos: 0 };
  const { error: erroRel } = await db.from('rm_relacionamentos').upsert(registros, {
    onConflict: 'tabela_origem_id,campo_origem,tabela_destino_id,campo_destino',
    ignoreDuplicates: true,
  });
  if (erroRel) return { ok: false, erro: erroRel.message };
  return { ok: true, relacionamentos: registros.length };
}

async function acaoRmListarTabelasAuxiliares(req: any) {
  if (!(await podeAgir(req.contaId, 'cadastros.tabelasauxrm', 'visualizar'))) {
    return { ok: false, erro: 'Você não tem permissão para ver as tabelas auxiliares do RM.' };
  }
  const { data, error } = await db.from('rm_tabelas').select('*').eq('auxiliar', true).order('nome');
  if (error) return { ok: false, erro: error.message };
  return { ok: true, tabelas: (data || []).map(rmTabelaParaApi) };
}
async function acaoRmMarcarAuxiliar(req: any) {
  if (!(await podeAgir(req.contaId, 'cadastros.tabelasauxrm', 'inserir'))) {
    return { ok: false, erro: 'Você não tem permissão para marcar tabelas auxiliares do RM.' };
  }
  const atualizacao = {
    auxiliar: !!req.auxiliar,
    aux_campo_codigo: req.auxCampoCodigo ? normalizarNomeRm(req.auxCampoCodigo) : null,
    aux_campo_descricao: req.auxCampoDescricao ? normalizarNomeRm(req.auxCampoDescricao) : null,
  };
  const { error } = await db.from('rm_tabelas').update(atualizacao).eq('id', req.tabelaId);
  if (error) return { ok: false, erro: error.message };
  return { ok: true };
}

async function acaoRmListarConsultasSalvas(req: any) {
  if (!(await podeAgir(req.contaId, 'utilitarios.sqlrm', 'visualizar'))) {
    return { ok: false, erro: 'Você não tem permissão para ver as consultas salvas.' };
  }
  const { data, error } = await db.from('rm_consultas_salvas').select('*').order('criado_em', { ascending: false }).limit(100);
  if (error) return { ok: false, erro: error.message };
  return { ok: true, consultas: (data || []).map(rmConsultaParaApi) };
}
async function acaoRmSalvarConsulta(req: any) {
  if (!(await podeAgir(req.contaId, 'utilitarios.sqlrm', 'inserir'))) {
    return { ok: false, erro: 'Você não tem permissão para salvar consultas.' };
  }
  if (!req.nome || !req.tabelaPrincipalId || !req.sqlGerado) return { ok: false, erro: 'Preencha nome, tabela principal e gere o SQL antes de salvar.' };
  const { data: conta } = await db.from('contas').select('nome').eq('id', req.contaId).maybeSingle();
  const registro = {
    id: gerarId(), nome: req.nome, tabela_principal_id: req.tabelaPrincipalId,
    config: req.config || {}, sql_gerado: req.sqlGerado, criado_por: conta ? conta.nome : '',
  };
  const { error } = await db.from('rm_consultas_salvas').insert(registro);
  if (error) return { ok: false, erro: error.message };
  return { ok: true, consulta: rmConsultaParaApi(registro) };
}
async function acaoRmRemoverConsulta(req: any) {
  if (!(await podeAgir(req.contaId, 'utilitarios.sqlrm', 'excluir'))) {
    return { ok: false, erro: 'Você não tem permissão para remover consultas salvas.' };
  }
  await db.from('rm_consultas_salvas').delete().eq('id', req.id);
  return { ok: true };
}

/* =========================================================
   Gerador SQL RM — versões PÚBLICAS (sem login), usadas só pela página
   separada gerador-sql-rm.html (link livre, sem acesso ao resto do
   sistema — pedido explícito do usuário, aceitando que qualquer um com o
   link acessa o dicionário de tabelas do RM e pode gerar/baixar consultas).
   Só LEITURA — a página pública não salva/lista/remove consultas
   (rm_consultas_salvas continua exclusivo da tela autenticada). Sem
   contaId, então sem como restringir por Perfil de Acesso; a restrição
   aqui é só "só lê o dicionário do RM", nunca atendimentos/clientes/
   financeiro/etc.
   ========================================================= */
async function acaoRmPublicoListarTabelas(req: any) {
  return nucleoRmListarTabelas(req);
}
async function acaoRmPublicoListarCampos(req: any) {
  return nucleoRmListarCampos(req);
}
async function acaoRmPublicoListarRelacionamentosDe(req: any) {
  return nucleoRmListarRelacionamentosDe(req);
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
