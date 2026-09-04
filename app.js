/* =========================================================
   Controle de Atendimentos — versão Supabase
   Os dados (contas, clientes, tipos, valores, atendimentos)
   ficam centralizados num banco Postgres (Supabase), acessado
   através de uma Edge Function que faz o mesmo papel que o
   Google Apps Script fazia na versão anterior.
   ========================================================= */

const CONFIG = {
  // Cole aqui a URL da sua Edge Function (algo como
  // https://SEU-PROJETO.supabase.co/functions/v1/api)
  API_URL: 'https://prchmojpfgeqbnoiisyf.supabase.co/functions/v1/super-function',
  // Cole aqui a chave "anon public" do seu projeto Supabase
  // (Project Settings → API Keys). Essa chave é segura pra expor
  // no código do site — ela sozinha não dá acesso ao banco.
  ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InByY2htb2pwZmdlcWJub2lpc3lmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY5NjMzMDYsImV4cCI6MjEwMjUzOTMwNn0.BnkW_pMECVDuV-bIjVJ0mpkmQhdTyty_2ityu7gyy80',
  // Chave pública VAPID (notificações push) — veja o LEIA-ME.md.
  // Deixe vazio ('') se não quiser usar notificações push.
  VAPID_PUBLIC_KEY: 'BISfjGp1ZksMHOnvGJmSGk4vP8khf8H6tCcSUywhXaL6Fwl0CGML4yEROkJ_VAsH0z2AmmStgODOBOo2O_Oe5oY'
};

const SESSAO_KEY = 'sessao_v4';

let contas = [], clientes = [], tipos = [], modulos = [], submodulos = [], statusList = [], valores = [], atendimentos = [], vinculos = [], perfisAcesso = [], empresas = [], tomticketErros = [];
let sessaoConta = null; // conta logada (sem senha), guardada após login
let empresaAtual = null; // empresa escolhida pra essa sessão — {id, nome, logoUrl, ...}
let empresasParaEscolher = []; // lista temporária mostrada na tela de escolha de empresa, entre o login e a entrada no app
let editandoEmpresaId = null;
let empresaLogoArquivoSelecionado = null; // File escolhido no input, enviado só quando salvar
let editandoId = null;
let anexoAtendimentoId = null; // atendimento cujos anexos múltiplos estão sendo geridos ao editar
let editandoAtendenteId = null;
let editandoUsuarioId = null;
let editandoClienteId = null;
let excluindoAcao = null;
let filtroCliente = new Set(); // vazio = todos
let filtroStatus = new Set(); // vazio = todos
let filtroId = ''; // vazio = todos — busca por trecho do ID do atendimento
let visualizacaoAtendimentos = 'lista'; // 'lista' | 'cards'
// tabela ordenável/agrupável da Lista (só em telas largas — no celular a
// lista continua em cards, sem essa mecânica)
let listaOrdenacao = { campo: 'data', direcao: 'desc' }; // igual à ordenação padrão de sempre
let listaAgrupamentos = []; // ordem dos campos de agrupamento (múltiplos níveis, do mais externo pro mais interno)
// agrupamento só acontece arrastando o cabeçalho da coluna até a faixa
// "Agrupar por" (pode soltar mais de uma coluna, criando subníveis);
// agrupaComo é o campo de agrupamento resultante (a coluna Data agrupa por
// Mês — dia a dia não faria sentido). Cliente e Status também servem de
// filtro de coluna estilo Excel reaproveitando os mesmos Sets do filtro de
// cima (filtroCliente/filtroStatus); Atendente e Tipo têm um filtro
// próprio, só válido aqui na tabela. Toda coluna pode ser arrastada pra
// mudar a ordem das colunas, soltando em cima de outra.
const COLUNAS_LISTA_TABELA = [
  { campo:'cliente', label:'Cliente', agrupaComo:'cliente', filtravel:true },
  { campo:'assunto', label:'Assunto' },
  { campo:'atendente', label:'Atendente', agrupaComo:'atendente', filtravel:true },
  { campo:'tipo', label:'Tipo', agrupaComo:'tipo', filtravel:true },
  { campo:'status', label:'Status', agrupaComo:'status', filtravel:true },
  { campo:'data', label:'Data', agrupaComo:'mes' },
  { campo:'horas', label:'Horas' },
  { campo:'valor', label:'Valor Real' },
];
// ordem atual das colunas na tabela (lista de campos) — muda quando o
// usuário arrasta um cabeçalho de coluna e solta em cima de outro
let listaOrdemColunas = COLUNAS_LISTA_TABELA.map(c => c.campo);
let listaFiltrosColuna = { atendente: new Set(), tipo: new Set() }; // filtro de coluna estilo Excel (só na tabela)
let listaFiltroColunaAberta = null; // campo cujo dropdown de filtro está aberto agora
let vinculosExpandidos = new Set(); // ids de atendimento com as linhas-filha de vínculo visíveis — vazio por padrão (tudo recolhido)
let selecionados = new Set();
let cadAba = 'atendentes';
let editandoPerfilAcessoId = null;
// menus e, quando existem, seus submenus (as abas internas de cada seção)
// — cada submenu vira uma permissão própria na matriz do Perfil de Acesso,
// com chave composta "menu.submenu" (ex: "cadastros.perfisacesso").
// subContainer/subDataAttr descrevem onde fica o botão daquela aba no DOM,
// pra aplicarVisibilidadeSubmenus() poder escondê-lo quando não liberado.
const MENUS_PERFIL_ACESSO = [
  { chave:'atendimentos', label:'Atendimentos' },
  { chave:'resumo', label:'Resumo' },
  { chave:'dashboard', label:'Dashboard', subContainer:'#dashSubtabs', subDataAttr:'dashsub', submenus:[
    { chave:'geral', label:'Visão Geral' },
    { chave:'operacional', label:'Operacional' },
    { chave:'comparativo', label:'Comparativo' },
  ]},
  { chave:'construtor_relatorios', label:'Construtor de Relatórios' },
  { chave:'relatorios', label:'Relatórios' },
  { chave:'financeiro', label:'Financeiro', subContainer:'#finSubtabs', subDataAttr:'finsub', submenus:[
    { chave:'lancar', label:'Criar Lançamento' },
    { chave:'importar', label:'Importar XML' },
    { chave:'lista', label:'Lançamentos' },
    { chave:'resumo', label:'Resumo Financeiro' },
  ]},
  { chave:'agenda', label:'Agenda', subContainer:'#agSubtabs', subDataAttr:'agsub', submenus:[
    { chave:'novo', label:'Novo Agendamento' },
    { chave:'calendario', label:'Agenda' },
  ]},
  { chave:'videos', label:'Vídeos', subContainer:'#vidSubtabs', subDataAttr:'vidsub', submenus:[
    { chave:'novo', label:'Novo Vídeo/Tutorial' },
    { chave:'lista', label:'Vídeos' },
  ]},
  { chave:'cadastros', label:'Cadastros', subContainer:'#cadSubtabs', subDataAttr:'sub', submenus:[
    { chave:'atendentes', label:'Atendentes' },
    { chave:'clientes', label:'Clientes' },
    { chave:'tipos', label:'Tipos' },
    { chave:'modulos', label:'Módulos' },
    { chave:'submodulos', label:'Sub Módulos' },
    { chave:'status', label:'Status' },
    { chave:'valores', label:'Valores' },
    { chave:'usuarios', label:'Usuários (login)' },
    { chave:'perfisacesso', label:'Perfis de Acesso' },
    { chave:'empresas', label:'Empresas' },
  ]},
  { chave:'utilitarios', label:'Utilitários', subContainer:'#utilCategorias', subDataAttr:'util-cat', submenus:[
    { chave:'esocial', label:'eSocial' },
    { chave:'tomticket', label:'TomTicket' },
  ]},
];

/* ---------- utilidades ---------- */
function fmtMoeda(v){ return 'R$ ' + (v||0).toLocaleString('pt-BR',{minimumFractionDigits:2, maximumFractionDigits:2}); }
// o link normal do anexo (Supabase Storage) abre o arquivo dentro do
// navegador (PDF/imagem em vez de baixar) — acrescentando ?download=nome
// na URL, o próprio Supabase Storage manda o cabeçalho que força o
// download do arquivo original, com o nome certo
function urlDownloadAnexo(url, nome){
  if(!url) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}download=${encodeURIComponent(nome || 'anexo')}`;
}
function timeToHours(t){ if(!t) return 0; const [h,m]=t.split(':').map(Number); return h + m/60; }
function calcQtd(hi,hf,inter){ let q = timeToHours(hf) - timeToHours(hi); if(q<0) q += 24; q -= timeToHours(inter); return Math.max(0, q); }
function mesFromData(dataStr){ if(!dataStr) return ''; const [y,m]=dataStr.split('-'); return `${m}/${y}`; }
function toast(msg){ const t=document.getElementById('toast'); t.textContent=msg; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),2200); }
function labelTipo(nome){ if(nome==='ATENDIMENTO ONLINE') return 'Online'; if(nome==='VISITA TECNICA') return 'Visita técnica'; return nome; }
// conta ADMIN sempre tem acesso total; conta ATENDENTE marcada com o flag
// "eh_administrador" (Cadastros → Atendentes) passa a ter os mesmos
// privilégios de administrador do sistema, sem deixar de ser atendente
function ehAdminEfetivo(conta){
  return !!conta && (conta.perfil === 'ADMIN' || (conta.perfil === 'ATENDENTE' && !!conta.ehAdministrador));
}
function podeVerValores(){ const c = contaAtual(); return ehAdminEfetivo(c); }

/* ---------- perfis de acesso (menus x visualizar/editar/excluir/inserir) ---------- */
// devolve {visualizar,editar,excluir,inserir} pro menu informado — admin
// (ou atendente marcado como administrador) sempre tem tudo liberado;
// senão, é o OR de todos os perfis de acesso vinculados à conta; se a
// conta não tiver NENHUM perfil de acesso vinculado, devolve null — sinal
// pra quem chamou usar a regra padrão de hoje (compatibilidade com contas
// que nunca tiveram um perfil de acesso configurado)
function permissaoMenu(conta, menu){
  if(ehAdminEfetivo(conta)) return {visualizar:true, editar:true, excluir:true, inserir:true};
  const ids = (conta && conta.perfisAcessoIds) || [];
  if(ids.length === 0) return null;
  const merge = {visualizar:false, editar:false, excluir:false, inserir:false};
  perfisAcesso.filter(p=>ids.includes(p.id)).forEach(p=>{
    const perm = p.permissoes && p.permissoes[menu];
    if(!perm) return;
    if(perm.visualizar) merge.visualizar = true;
    if(perm.editar) merge.editar = true;
    if(perm.excluir) merge.excluir = true;
    if(perm.inserir) merge.inserir = true;
  });
  return merge;
}
// versão prática pra "esse menu aparece?" — usa a permissão configurada
// se existir, senão cai no comportamento padrão (parâmetro "padrao")
function menuVisivel(conta, menu, padrao){
  const p = permissaoMenu(conta, menu);
  return p ? p.visualizar : padrao;
}
// esconde/mostra TODAS as representações de uma view (aba de cima, menu
// lateral e barra inferior) de uma vez, sem precisar de um id em cada uma
function aplicarVisibilidadeMenu(viewName, visivel){
  document.querySelectorAll(`[data-view="${viewName}"]`).forEach(el=>{ el.style.display = visivel ? '' : 'none'; });
}

// mesma ideia do menuVisivel/aplicarVisibilidadeMenu, mas pras abas internas
// (submenus) de Dashboard/Financeiro/Agenda/Vídeos/Cadastros/Utilitários —
// cada submenu usa a chave composta "menu.submenu"; os dois únicos que já
// tinham alguma regra própria antes dessa tela existir (Agenda "Novo
// Agendamento" e Vídeos "Novo Vídeo") continuam com o mesmo padrão de
// sempre quando a conta não tem nenhum Perfil de Acesso configurado
function aplicarVisibilidadeSubmenus(conta){
  const podeGerenciarAg = conta && (conta.perfil === 'ADMIN' || conta.perfil === 'ATENDENTE');
  const permVid = permissaoMenu(conta, 'videos');
  const podeInserirVid = permVid ? permVid.inserir : ehAdminEfetivo(conta);
  const PADROES_SUBMENU = { 'agenda.novo': podeGerenciarAg, 'videos.novo': podeInserirVid };
  MENUS_PERFIL_ACESSO.forEach(m=>{
    if(!m.submenus) return;
    m.submenus.forEach(s=>{
      const chave = `${m.chave}.${s.chave}`;
      const padrao = chave in PADROES_SUBMENU ? PADROES_SUBMENU[chave] : true;
      const visivel = menuVisivel(conta, chave, padrao);
      const el = document.querySelector(`${m.subContainer} [data-${m.subDataAttr}="${s.chave}"]`);
      if(el) el.style.display = visivel ? '' : 'none';
    });
  });
}
// se a aba preferida (a última usada, ou a padrão) desse menu não estiver
// liberada pro Perfil de Acesso da conta, cai pra primeira aba visível
function primeiraSubAbaVisivel(menuChave, preferida){
  const m = MENUS_PERFIL_ACESSO.find(x=>x.chave===menuChave);
  if(!m || !m.submenus) return preferida;
  const attr = `data-${m.subDataAttr}`;
  const datasetChave = m.subDataAttr.replace(/-([a-z])/g, (_,c)=>c.toUpperCase());
  const preferidoEl = document.querySelector(`${m.subContainer} [${attr}="${preferida}"]`);
  if(preferidoEl && preferidoEl.style.display !== 'none') return preferida;
  const primeiroVisivel = [...document.querySelectorAll(`${m.subContainer} [${attr}]`)].find(el=>el.style.display !== 'none');
  return primeiroVisivel ? primeiroVisivel.dataset[datasetChave] : preferida;
}

// bolinha de "movimentação não lida" no menu (sidebar/abas/barra inferior)
// — acende quando qualquer atendimento visível tiver r.naoLidas
function atualizarBadgeAtendimentos(){
  const temNaoLida = (atendimentos||[]).some(a=>a.naoLidas);
  document.querySelectorAll('.badge-naolida-menu').forEach(el=>{ el.classList.toggle('on', temNaoLida); });
}

// alterna tema claro/escuro — o valor salvo é lido de novo (e aplicado antes
// do CSS pintar a tela) por um script inline no <head> do index.html
function alternarTema(){
  const atual = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  const novo = atual === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', novo);
  document.querySelector('meta[name="theme-color"]').setAttribute('content', novo === 'light' ? '#F5F7FA' : '#151A1F');
  try{ localStorage.setItem('tema', novo); }catch(e){ /* sem localStorage, só não persiste entre sessões */ }
}
// nome de status pode ter espaço/acento (ex: "EM VALIDAÇÃO") — não dá pra
// usar direto como classe CSS (classe com espaço vira duas classes, e o
// navegador nunca dá match numa classe assim), por isso esse slug
function statusSlug(nome){
  return String(nome||'').normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/\s+/g,'-').toUpperCase();
}
// data de hoje no fuso do aparelho, formato yyyy-mm-dd — igual ao formato
// já usado em data/dataPrevista, dá pra comparar direto como texto
function hojeLocalISO(){
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
// flag de prazo (🔴 atrasado / 🟢 em dia) comparando hoje com a Data Final
// Prevista — só faz sentido enquanto o chamado ainda não foi validado, e só
// se tiver previsão cadastrada
function flagPrazo(r){
  if(!r.dataPrevista || r.status === 'VALIDADO') return '';
  const [,pm,pd] = String(r.dataPrevista).split('-');
  const previstaFmt = `${pd}/${pm}`;
  const atrasado = hojeLocalISO() > r.dataPrevista;
  return atrasado
    ? `<span class="tag" style="background:var(--bad);color:#fff;">🔴 Atrasado desde ${previstaFmt}</span>`
    : `<span class="tag" style="background:var(--ok);color:#fff;">🟢 Prazo: ${previstaFmt}</span>`;
}
function primeiroDiaMes(d){ return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0,10); }
function ultimoDiaMes(d){ return new Date(d.getFullYear(), d.getMonth()+1, 0).toISOString().slice(0,10); }
/* ---------- seleção múltipla / alteração de status em massa ---------- */
function toggleSelecao(id, marcado){
  if(marcado) selecionados.add(id); else selecionados.delete(id);
  atualizarBarraSelecao();
}
function atualizarBarraSelecao(){
  const barra = document.getElementById('barraSelecao');
  const n = selecionados.size;
  if(n === 0){ barra.style.display = 'none'; return; }
  barra.style.display = '';
  document.getElementById('contadorSelecionados').textContent = `${n} selecionado${n>1?'s':''}`;
}
function limparSelecao(){
  selecionados.clear();
  document.querySelectorAll('.chk-item').forEach(c=>c.checked=false);
  const chkTodos = document.getElementById('chkSelecionarTodos');
  if(chkTodos) chkTodos.checked = false;
  atualizarBarraSelecao();
}

function abrirModalStatusMassa(){
  if(selecionados.size === 0) return;
  document.getElementById('statusMassaTexto').textContent = `Isso vai alterar o status de ${selecionados.size} atendimento${selecionados.size>1?'s':''} selecionado${selecionados.size>1?'s':''}.`;
  document.getElementById('statusMassaSelect').innerHTML = statusList.map(s=>`<option value="${s.nome}">${s.nome}</option>`).join('');
  document.getElementById('statusMassaModal').classList.add('show');
}
function fecharModalStatusMassa(){
  document.getElementById('statusMassaModal').classList.remove('show');
}
async function aplicarStatusMassa(){
  const novoStatus = document.getElementById('statusMassaSelect').value;
  const conta = contaAtual();
  const btn = document.getElementById('statusMassaConfirmar');
  btn.disabled = true;
  btn.textContent = 'Aplicando…';
  try{
    const r = await api('alterarStatusEmMassa', { ids: [...selecionados], novoStatus, contaId: conta.id });
    if(!r.ok){ toast(r.erro || 'Não foi possível alterar o status.'); return; }
    fecharModalStatusMassa();
    limparSelecao();
    await carregarTudo();
    renderLista(); renderResumo();
    toast(`${r.atualizados} de ${r.total} atendimentos atualizados`);
  }catch(e){
    toast(e && e.message ? e.message : 'Não foi possível alterar o status.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Aplicar';
  }
}

/* ---------- vínculo entre chamados (múltiplos — cada um numa linha própria, nunca substitui) ---------- */
function descreverAtendimentoParaVinculo(r){
  const [y,m,d] = String(r.data).split('-');
  const resumoDetalhe = r.detalhe ? stripHtml(r.detalhe).slice(0,40) : '';
  return `${d}/${m}/${y} · ${r.cliente} · ${r.usuario}${resumoDetalhe ? ' · '+resumoDetalhe : ''}`;
}

// busca genérica — usada tanto no formulário de edição quanto na tela de
// detalhe; cada contexto tem seu próprio input/lista de resultados
function configurarBuscaVinculo(buscaInputId, resultadosId, obterAtendimentoIdAtual, aoSelecionar){
  document.getElementById(buscaInputId).addEventListener('input', e=>{
    const termo = e.target.value.trim().toLowerCase();
    const cont = document.getElementById(resultadosId);
    if(termo.length < 2){ cont.innerHTML = ''; return; }
    const atualId = obterAtendimentoIdAtual();
    const resultados = atendimentos
      .filter(r => String(r.id) !== String(atualId))
      .filter(r => `${r.cliente} ${r.usuario} ${r.assunto||''} ${stripHtml(r.detalhe||'')} ${r.tipo}`.toLowerCase().includes(termo))
      .slice(0, 8);
    if(resultados.length === 0){ cont.innerHTML = `<div class="empty" style="padding:8px 0;font-size:12.5px;">Nenhum chamado encontrado.</div>`; return; }
    cont.innerHTML = resultados.map(r=>`
      <div class="vinculo-resultado" data-id="${r.id}">
        <b>${escaparHtml(r.cliente)} · ${escaparHtml(r.usuario)}</b>
        <span>${descreverAtendimentoParaVinculo(r)}</span>
      </div>`).join('');
    cont.querySelectorAll('.vinculo-resultado').forEach(el=>{
      el.addEventListener('click', ()=>{
        aoSelecionar(el.dataset.id);
        document.getElementById(buscaInputId).value = '';
        cont.innerHTML = '';
      });
    });
  });
}

async function adicionarVinculoAgora(atendimentoId, outroId, containerId, podeRemover){
  if(!atendimentoId){ toast('Salve o atendimento antes de vincular.'); return; }
  const r = await api('adicionarVinculo', { atendimentoId, outroId });
  if(!r.ok){ toast(r.erro || 'Não foi possível vincular.'); return; }
  await recarregarVinculos(atendimentoId, containerId, podeRemover);
  toast('Vinculado');
}
async function removerVinculoAgora(vinculoId, atendimentoId, containerId, podeRemover){
  const r = await api('removerVinculo', { id: vinculoId });
  if(!r.ok){ toast(r.erro || 'Não foi possível remover o vínculo.'); return; }
  await recarregarVinculos(atendimentoId, containerId, podeRemover);
  toast('Vínculo removido');
}
async function recarregarVinculos(atendimentoId, containerId, podeRemover){
  try{
    const r = await api('listarVinculados', { atendimentoId });
    if(!r.ok){ document.getElementById(containerId).innerHTML = `<div class="empty" style="padding:8px 0;font-size:12.5px;">${r.erro||'Não foi possível carregar.'}</div>`; return null; }
    renderVinculosLista(containerId, r.vinculados, atendimentoId, podeRemover);
    return r;
  }catch(e){
    document.getElementById(containerId).innerHTML = `<div class="empty" style="padding:8px 0;font-size:12.5px;">Não foi possível carregar os vínculos.</div>`;
    return null;
  }
}
function renderVinculosLista(containerId, lista, atendimentoId, podeRemover){
  const cont = document.getElementById(containerId);
  if(!lista || lista.length === 0){ cont.innerHTML = `<div class="empty" style="padding:8px 0;font-size:12.5px;">Nenhum vínculo ainda.</div>`; return; }
  cont.innerHTML = lista.map(v=>{
    const [y,m,d] = String(v.data).split('-');
    return `<div class="cad-item">
      <div class="info" style="cursor:pointer;" onclick="abrirDetalhe('${v.id}')">
        <b>${d}/${m}/${y} · ${escaparHtml(v.cliente)}</b>
        <span>${escaparHtml(v.usuario)} · ${Number(v.qtd).toFixed(2).replace('.',',')}h · <span class="tag status-${statusSlug(v.status)}">${v.status}</span></span>
      </div>
      ${podeRemover ? `<div class="acts"><button class="danger" onclick="removerVinculoAgora('${v.vinculoId}','${atendimentoId}','${containerId}',true)">Remover</button></div>` : ''}
    </div>`;
  }).join('');
}

/* ---------- árvore de vínculos (lista + Kanban) — usa o array "vinculos"
   já carregado por inteiro em carregarTudo, sem chamada nenhuma por card ---------- */
// ids diretamente vinculados a um atendimento (vínculo vale pros dois lados)
function idsVinculadosDe(atendimentoId){
  const ids = [];
  vinculos.forEach(v=>{
    if(String(v.atendimentoA)===String(atendimentoId)) ids.push(v.atendimentoB);
    else if(String(v.atendimentoB)===String(atendimentoId)) ids.push(v.atendimentoA);
  });
  return ids;
}
// monta a árvore até `profundidade` níveis; nunca repete um id que já
// apareceu em QUALQUER lugar da mesma árvore (vínculo não tem hierarquia —
// evita ciclo tipo A-B-A e também um mesmo C aparecer duas vezes quando A
// está vinculado tanto a B quanto a C, e B também está vinculado a C).
// `visitados` é o mesmo Set em toda a árvore, de propósito — vai sendo
// preenchido conforme os irmãos são processados, não é clonado por galho
function montarArvoreVinculos(atendimentoId, profundidade, visitados){
  if(profundidade <= 0) return [];
  visitados = visitados || new Set([String(atendimentoId)]);
  const nos = [];
  for(const id of idsVinculadosDe(atendimentoId)){
    if(visitados.has(String(id))) continue;
    const r = atendimentos.find(x=>String(x.id)===String(id));
    if(!r) continue; // vínculo aponta pra um atendimento que essa conta não vê
    visitados.add(String(id));
    nos.push({ atendimento: r, filhos: montarArvoreVinculos(id, profundidade-1, visitados) });
  }
  return nos;
}
function renderArvoreVinculosHtml(nos, nivel){
  nivel = nivel || 1;
  return nos.map((no,i)=>{
    const galho = (i === nos.length-1) ? '└─' : '├─';
    const [y,m,d] = String(no.atendimento.data).split('-');
    const filhosHtml = (no.filhos && no.filhos.length) ? renderArvoreVinculosHtml(no.filhos, nivel+1) : '';
    return `<div class="arv-linha${nivel>1?' n2':''}" onclick="event.stopPropagation();abrirDetalhe('${no.atendimento.id}')">
      <span class="galho">${galho}</span><span class="pt" style="background:${corStatusDot(no.atendimento.status)};"></span>
      <span class="arv-cli">${escaparHtml(no.atendimento.cliente)}</span> · ${d}/${m} · ${escaparHtml(no.atendimento.status)}
    </div>${filhosHtml}`;
  }).join('');
}
// bloco completo (título + árvore), pronto pra encaixar num card/item —
// devolve string vazia quando o atendimento não tem vínculo nenhum
function blocoArvoreVinculos(atendimentoId){
  const arvore = montarArvoreVinculos(atendimentoId, 2);
  if(arvore.length === 0) return '';
  const total = idsVinculadosDe(atendimentoId).length;
  return `<div class="arv-wrap" onclick="event.stopPropagation();">
    <div class="arv-titulo">🔗 ${total} vínculo${total>1?'s':''}</div>
    ${renderArvoreVinculosHtml(arvore)}
  </div>`;
}

/* ---------- vínculo entre atendimento e vídeos/tutoriais ---------- */
// ids dos vídeos já vinculados, por container (form de edição x modal de
// detalhe) — usado só pra não sugerir de novo, na busca, um vídeo que já
// está vinculado
let videosVinculadosPorContainer = {};

// carrega o cache de vídeos sem mexer na tela da aba Vídeos — usado só
// pra alimentar a busca de vínculo no formulário/detalhe do atendimento
async function carregarVideosCacheParaVinculo(){
  const conta = contaAtual();
  if(!conta) return;
  try{
    const r = await api('listarVideos', { contaId: conta.id, empresaId: empresaAtual ? empresaAtual.id : '' });
    if(r.ok) videosCache = r.videos || [];
  }catch(e){ /* busca de vínculo fica só sem resultados — não é crítico */ }
}

function configurarBuscaVideo(buscaInputId, resultadosId, obterVideosJaVinculados, aoSelecionar){
  document.getElementById(buscaInputId).addEventListener('input', e=>{
    const termo = e.target.value.trim().toLowerCase();
    const cont = document.getElementById(resultadosId);
    if(termo.length < 2){ cont.innerHTML = ''; return; }
    const jaVinculados = new Set(obterVideosJaVinculados());
    const resultados = videosCache
      .filter(v => !jaVinculados.has(String(v.id)))
      .filter(v => `${v.titulo} ${v.modulo||''} ${v.cliente||''}`.toLowerCase().includes(termo))
      .slice(0, 8);
    if(resultados.length === 0){ cont.innerHTML = `<div class="empty" style="padding:8px 0;font-size:12.5px;">Nenhum vídeo encontrado.</div>`; return; }
    cont.innerHTML = resultados.map(v=>`
      <div class="vinculo-resultado" data-id="${v.id}">
        <b>${escaparHtml(v.titulo)}</b>
        <span>${escaparHtml([v.cliente, v.modulo].filter(Boolean).join(' · ') || 'Geral')}</span>
      </div>`).join('');
    cont.querySelectorAll('.vinculo-resultado').forEach(el=>{
      el.addEventListener('click', ()=>{
        aoSelecionar(el.dataset.id);
        document.getElementById(buscaInputId).value = '';
        cont.innerHTML = '';
      });
    });
  });
}

async function adicionarVideoVinculoAgora(atendimentoId, videoId, containerId, podeRemover){
  if(!atendimentoId){ toast('Salve o atendimento antes de vincular um vídeo.'); return; }
  const r = await api('vincularVideoAtendimento', { atendimentoId, videoId });
  if(!r.ok){ toast(r.erro || 'Não foi possível vincular o vídeo.'); return; }
  await recarregarVideosVinculados(atendimentoId, containerId, podeRemover);
  toast('Vídeo vinculado');
}
async function removerVideoVinculoAgora(vinculoId, atendimentoId, containerId, podeRemover){
  const r = await api('desvincularVideoAtendimento', { id: vinculoId });
  if(!r.ok){ toast(r.erro || 'Não foi possível remover o vídeo.'); return; }
  await recarregarVideosVinculados(atendimentoId, containerId, podeRemover);
  toast('Vídeo desvinculado');
}
async function recarregarVideosVinculados(atendimentoId, containerId, podeRemover){
  try{
    const r = await api('listarVideosDoAtendimento', { atendimentoId });
    if(!r.ok){ document.getElementById(containerId).innerHTML = `<div class="empty" style="padding:8px 0;font-size:12.5px;">${r.erro||'Não foi possível carregar.'}</div>`; return null; }
    videosVinculadosPorContainer[containerId] = (r.videos || []).map(v=>String(v.id));
    renderVideosVinculadosLista(containerId, r.videos, atendimentoId, podeRemover);
    return r;
  }catch(e){
    document.getElementById(containerId).innerHTML = `<div class="empty" style="padding:8px 0;font-size:12.5px;">Não foi possível carregar os vídeos vinculados.</div>`;
    return null;
  }
}
function renderVideosVinculadosLista(containerId, lista, atendimentoId, podeRemover){
  const cont = document.getElementById(containerId);
  if(!lista || lista.length === 0){ cont.innerHTML = `<div class="empty" style="padding:8px 0;font-size:12.5px;">Nenhum vídeo vinculado ainda.</div>`; return; }
  cont.innerHTML = lista.map(v=>{
    const videoId = extrairIdYoutube(v.urlYoutube);
    const link = videoId ? `https://www.youtube.com/watch?v=${videoId}` : v.urlYoutube;
    return `<div class="cad-item">
      <div class="info"><a href="${link}" target="_blank" rel="noopener" style="color:var(--text);text-decoration:none;">
        <b>▶ ${escaparHtml(v.titulo)}</b>
        <span>${escaparHtml([v.cliente, v.modulo].filter(Boolean).join(' · ') || 'Geral')}</span>
      </a></div>
      ${podeRemover ? `<div class="acts"><button class="danger" onclick="removerVideoVinculoAgora('${v.vinculoId}','${atendimentoId}','${containerId}',true)">Remover</button></div>` : ''}
    </div>`;
  }).join('');
}

function contatoDoAtendente(nomeAtendente){
  const a = contas.find(c=>c.perfil==='ATENDENTE' && c.nome===nomeAtendente);
  if(!a) return '';
  const linkWpp = linkWhatsapp(a.telefone);
  return [
    a.email ? `<a href="mailto:${a.email}" style="color:var(--muted);">✉️ e-mail</a>` : '',
    linkWpp ? `<a href="${linkWpp}" target="_blank" style="color:var(--ok);">📱 WhatsApp</a>` : ''
  ].filter(Boolean).join(' · ');
}
function podeUsarChat(r){
  const c = contaAtual();
  if(!c) return false;
  if(ehAdminEfetivo(c)) return true;
  if(c.perfil === 'ATENDENTE') return r.atendente === c.nome;
  if(c.perfil === 'USUARIO') return r.usuario === c.nome;
  return false;
}
function lerArquivoBase64(file){
  return new Promise((resolve, reject)=>{
    const reader = new FileReader();
    reader.onload = ()=> resolve(String(reader.result).split(',')[1]); // remove o prefixo data:...;base64,
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/* ---------- comunicação com o backend (Edge Function do Supabase) ---------- */
async function api(action, payload={}){
  if(!CONFIG.API_URL || CONFIG.API_URL.includes('COLE_AQUI') || !CONFIG.ANON_KEY || CONFIG.ANON_KEY.includes('COLE_AQUI')){
    const msg = 'Configure a URL e a chave da API em app.js (CONFIG.API_URL / CONFIG.ANON_KEY)';
    toast(msg);
    throw new Error(msg);
  }
  let resp;
  try{
    resp = await fetch(CONFIG.API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': CONFIG.ANON_KEY,
        'Authorization': `Bearer ${CONFIG.ANON_KEY}`
      },
      body: JSON.stringify({ action, ...payload })
    });
  }catch(e){
    // erro de rede de verdade (sem internet, DNS, CORS bloqueado, etc.)
    const msg = 'Não foi possível conectar. Verifique sua internet e tente novamente.';
    toast(msg);
    throw new Error(msg);
  }
  if(!resp.ok){
    const msg = `O servidor respondeu com erro (${resp.status}). Tente novamente em instantes.`;
    toast(msg);
    throw new Error(msg);
  }
  let json;
  try{
    json = await resp.json();
  }catch(e){
    // resposta não veio em JSON (algo incomum retornado pela Edge Function)
    const msg = 'Resposta inesperada do servidor. Confira se a Edge Function está implantada corretamente.';
    toast(msg);
    throw new Error(msg);
  }
  if(json.erro && !json.ok){ toast(json.erro); }
  return json;
}

function mostrarCarregando(mostrar){
  document.getElementById('loadingOverlay').style.display = mostrar ? 'flex' : 'none';
}

async function carregarTudo(){
  const contaId = sessaoConta ? sessaoConta.id : '';
  const empresaId = empresaAtual ? empresaAtual.id : '';
  const r = await api('dados', { contaId, empresaId });
  if(!r.ok) return false;
  contas = r.contas; clientes = r.clientes; tipos = r.tipos; modulos = r.modulos||[]; submodulos = r.submodulos||[]; statusList = r.statusList||[]; valores = r.valores; atendimentos = r.atendimentos;
  atualizarBadgeAtendimentos();
  vinculos = r.vinculos||[];
  perfisAcesso = r.perfisAcesso||[];
  empresas = r.empresas||[];
  tomticketErros = r.tomticketErros||[];
  // a sessão foi salva no login (antes de existir "perfisAcesso") — depois
  // do primeiro carregamento de dados, sincroniza com a versão mais
  // atual da própria conta (permissões podem ter mudado desde o login)
  if(sessaoConta){
    const atualizada = contas.find(c=>String(c.id)===String(sessaoConta.id));
    if(atualizada) { sessaoConta = atualizada; gravarSessao(sessaoConta); }
  }
  return true;
}

/* ---------- sessão / login ---------- */
function lerSessao(){ try{ const raw = localStorage.getItem(SESSAO_KEY); return raw ? JSON.parse(raw) : null; }catch(e){ return null; } }
function gravarSessao(conta){ try{ localStorage.setItem(SESSAO_KEY, JSON.stringify(conta)); }catch(e){} }
function limparSessao(){ try{ localStorage.removeItem(SESSAO_KEY); }catch(e){} }
const EMPRESA_KEY = 'empresa_v1';
function lerEmpresaSalva(){ try{ const raw = localStorage.getItem(EMPRESA_KEY); return raw ? JSON.parse(raw) : null; }catch(e){ return null; } }
function gravarEmpresaSalva(empresa){ try{ localStorage.setItem(EMPRESA_KEY, JSON.stringify(empresa)); }catch(e){} }
function limparEmpresaSalva(){ try{ localStorage.removeItem(EMPRESA_KEY); }catch(e){} }

async function tentarLogin(){
  const login = document.getElementById('loginUser').value.trim();
  const senha = document.getElementById('loginPass').value;
  const err = document.getElementById('loginError');
  err.classList.remove('show');
  if(!login || !senha){ err.textContent='Preencha usuário e senha.'; err.classList.add('show'); return; }

  document.getElementById('btnLogin').textContent = 'Entrando…';
  document.getElementById('btnLogin').disabled = true;
  try{
    const r = await api('login', { login, senha });
    if(!r.ok){ err.textContent = r.erro || 'Usuário ou senha inválidos.'; err.classList.add('show'); return; }
    sessaoConta = r.conta;
    gravarSessao(sessaoConta);

    // USUARIO já vem com a empresa resolvida (a do próprio cliente dele) —
    // ADMIN/ATENDENTE escolhem entre as empresas vinculadas à conta
    if(r.empresa){
      empresaAtual = r.empresa;
      await finalizarLoginComEmpresa();
    }else if(Array.isArray(r.empresas) && r.empresas.length === 1){
      empresaAtual = r.empresas[0];
      await finalizarLoginComEmpresa();
    }else if(Array.isArray(r.empresas) && r.empresas.length > 1){
      mostrarTelaEscolhaEmpresa(r.empresas);
    }else{
      err.textContent = 'Sua conta não está vinculada a nenhuma empresa. Fale com o administrador.';
      err.classList.add('show');
    }
  } catch(e) {
    // qualquer falha de conexão/servidor cai aqui — sem isso, o botão só
    // "piscava" e voltava ao normal sem explicar nada (parecia que "não entrava")
    err.textContent = e && e.message ? e.message : 'Não foi possível entrar. Tente novamente.';
    err.classList.add('show');
  } finally {
    document.getElementById('btnLogin').textContent = 'Entrar';
    document.getElementById('btnLogin').disabled = false;
  }
}

let trocandoEmpresa = false; // true = veio do botão "trocar empresa" já logado (Cancelar só fecha a tela); false = é a escolha do login
function mostrarTelaEscolhaEmpresa(listaEmpresas, emTroca){
  trocandoEmpresa = !!emTroca;
  empresasParaEscolher = listaEmpresas;
  document.getElementById('listaEmpresasEscolha').innerHTML = listaEmpresas.map((e,i)=>`
    <button type="button" class="empresa-opcao" data-idx="${i}">
      <span class="logo">${e.logoUrl ? `<img src="${e.logoUrl}">` : escaparHtml((e.nome||'?').slice(0,2).toUpperCase())}</span>
      <span class="nome">${escaparHtml(e.nome)}</span>
    </button>
  `).join('');
  document.getElementById('screen-login').style.display = 'none';
  document.getElementById('app').style.display = 'none';
  document.getElementById('screen-empresa').style.display = 'flex';
  document.getElementById('btnCancelarEscolhaEmpresa').textContent = trocandoEmpresa ? 'Cancelar' : 'Voltar ao login';
}

async function abrirTrocaDeEmpresa(){
  const conta = contaAtual();
  if(!conta) return;
  const r = await api('minhasEmpresas', { contaId: conta.id });
  if(!r.ok || !Array.isArray(r.empresas) || r.empresas.length < 2){ toast('Sua conta não tem outra empresa vinculada.'); return; }
  mostrarTelaEscolhaEmpresa(r.empresas, true);
}

async function finalizarLoginComEmpresa(){
  gravarEmpresaSalva(empresaAtual);
  document.getElementById('screen-empresa').style.display = 'none';
  mostrarCarregando(true);
  const carregou = await carregarTudo();
  mostrarCarregando(false);
  if(!carregou){
    const err = document.getElementById('loginError');
    document.getElementById('screen-login').style.display = 'flex';
    err.textContent = 'Login certo, mas não consegui carregar os dados. Tente novamente.';
    err.classList.add('show');
    return;
  }
  entrarNoApp();
}

function sair(){
  sessaoConta = null;
  empresaAtual = null;
  limparSessao();
  limparEmpresaSalva();
  document.getElementById('app').style.display = 'none';
  document.getElementById('screen-empresa').style.display = 'none';
  document.getElementById('screen-login').style.display = 'flex';
  document.getElementById('loginUser').value = '';
  document.getElementById('loginPass').value = '';
}

function abrirModalSenha(){
  document.getElementById('senha_atual').value = '';
  document.getElementById('senha_nova').value = '';
  document.getElementById('senha_confirma').value = '';
  document.getElementById('senhaError').classList.remove('show');
  document.getElementById('senhaModal').classList.add('show');
}
function fecharModalSenha(){
  document.getElementById('senhaModal').classList.remove('show');
}
async function salvarNovaSenha(){
  const senhaAtual = document.getElementById('senha_atual').value;
  const novaSenha = document.getElementById('senha_nova').value;
  const confirma = document.getElementById('senha_confirma').value;
  const err = document.getElementById('senhaError');
  err.classList.remove('show');

  if(!senhaAtual || !novaSenha || !confirma){ err.textContent = 'Preencha todos os campos.'; err.classList.add('show'); return; }
  if(novaSenha !== confirma){ err.textContent = 'A nova senha e a confirmação não coincidem.'; err.classList.add('show'); return; }
  if(novaSenha.length < 4){ err.textContent = 'A nova senha precisa ter pelo menos 4 caracteres.'; err.classList.add('show'); return; }

  const conta = contaAtual();
  const btn = document.getElementById('senhaConfirmar');
  btn.disabled = true;
  btn.textContent = 'Salvando…';
  try{
    const r = await api('alterarMinhaSenha', { contaId: conta.id, senhaAtual, novaSenha });
    if(!r.ok){ err.textContent = r.erro || 'Não foi possível alterar a senha.'; err.classList.add('show'); return; }
    fecharModalSenha();
    toast('Senha alterada com sucesso');
  }catch(e){
    err.textContent = e && e.message ? e.message : 'Não foi possível alterar a senha.';
    err.classList.add('show');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Salvar nova senha';
  }
}

function contaAtual(){ return sessaoConta; }

/* ---------- notificações push ---------- */

// dentro do app Android (Capacitor) usamos push nativo via FCM em vez do
// PushManager do navegador — Web Push não é confiável dentro de uma WebView
// empacotada (sem Firebase por trás não há entrega garantida com o app em
// segundo plano ou fechado)
function emAppNativo(){
  return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
}
function pushNotificationsPlugin(){
  return window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.PushNotifications;
}

let fcmTokenAtual = null;
let fcmListenersProntos = false;

async function iniciarPushNativo(){
  const PN = pushNotificationsPlugin();
  if(!PN) return;
  if(!fcmListenersProntos){
    fcmListenersProntos = true;
    PN.addListener('registration', async (token) => {
      fcmTokenAtual = token.value;
      const conta = contaAtual();
      if(conta){
        try{ await api('salvarTokenFcm', { contaId: conta.id, token: token.value }); }
        catch(e){ console.error('[push] Erro ao salvar token FCM:', e); }
      }
      atualizarBotaoNotificacoes();
    });
    PN.addListener('registrationError', (erro) => {
      console.error('[push] Erro ao registrar pra notificações (FCM):', erro);
    });
    PN.addListener('pushNotificationReceived', (notif) => {
      // com o app aberto o Android não mostra a notificação sozinho — avisa por toast
      if(notif && (notif.title || notif.body)) toast([notif.title, notif.body].filter(Boolean).join(' — '));
    });
  }
  // se a permissão já tinha sido concedida numa sessão anterior, re-registra
  // sozinho (o token pode mudar) sem precisar pedir de novo pra pessoa
  try{
    const status = await PN.checkPermissions();
    if(status.receive === 'granted') await PN.register();
  }catch(e){
    console.error('[push] Erro ao checar permissão de notificações:', e);
  }
}

function urlBase64ToUint8Array(base64String){
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for(let i=0;i<rawData.length;i++) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

async function inscricaoPushAtual(){
  if(!('serviceWorker' in navigator) || !('PushManager' in window)) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

async function atualizarBotaoNotificacoes(){
  const btn = document.getElementById('btnNotificacoes');
  if(emAppNativo()){
    btn.style.display = '';
    btn.textContent = fcmTokenAtual ? '🔕 Desativar avisos' : '🔔 Avisos';
    return;
  }
  if(!CONFIG.VAPID_PUBLIC_KEY || !('serviceWorker' in navigator) || !('PushManager' in window)){
    btn.style.display = 'none';
    return;
  }
  btn.style.display = '';
  const inscricao = await inscricaoPushAtual();
  btn.textContent = inscricao ? '🔕 Desativar avisos' : '🔔 Avisos';
}

async function alternarNotificacoes(){
  const btn = document.getElementById('btnNotificacoes');

  if(emAppNativo()){
    const PN = pushNotificationsPlugin();
    if(!PN) return;
    btn.disabled = true;
    try{
      if(fcmTokenAtual){
        try{ await api('removerTokenFcm', { token: fcmTokenAtual }); }catch(e){ console.error('[push] Erro ao remover token FCM:', e); }
        fcmTokenAtual = null;
        toast('Notificações desativadas');
      } else {
        const status = await PN.requestPermissions();
        if(status.receive !== 'granted'){ toast('Permissão de notificação não concedida'); return; }
        await PN.register();
        toast('Notificações ativadas');
      }
    }catch(e){
      console.error('[push] Erro inesperado ao alternar notificações nativas:', e);
      toast('Não foi possível alterar as notificações — veja o console (F12) pra detalhes');
    } finally {
      btn.disabled = false;
      atualizarBotaoNotificacoes();
    }
    return;
  }

  const inscricaoExistente = await inscricaoPushAtual();

  if(inscricaoExistente){
    // desativar
    btn.disabled = true;
    try{
      await api('removerInscricaoPush', { endpoint: inscricaoExistente.endpoint });
      await inscricaoExistente.unsubscribe();
      toast('Notificações desativadas');
    }catch(e){
      toast('Não foi possível desativar');
    } finally {
      btn.disabled = false;
      atualizarBotaoNotificacoes();
    }
    return;
  }

  // ativar
  if(Notification.permission === 'denied'){
    toast('Notificações bloqueadas no navegador — precisa liberar nas configurações do site');
    return;
  }
  if(!CONFIG.VAPID_PUBLIC_KEY){
    toast('Chave VAPID não configurada no app.js — veja o LEIA-ME.md');
    console.error('[push] CONFIG.VAPID_PUBLIC_KEY está vazia. Cole a chave pública no topo do app.js.');
    return;
  }
  btn.disabled = true;
  try{
    const permissao = await Notification.requestPermission();
    if(permissao !== 'granted'){ toast('Permissão de notificação não concedida no navegador'); return; }
    const reg = await navigator.serviceWorker.ready;
    let inscricao;
    try{
      inscricao = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(CONFIG.VAPID_PUBLIC_KEY)
      });
    }catch(erroSubscribe){
      console.error('[push] Falha ao inscrever no navegador:', erroSubscribe);
      // esse erro específico quase sempre é a chave VAPID errada/incompleta no app.js
      toast('Não foi possível ativar — confira se a chave VAPID no app.js está exatamente igual à que você gerou (veja o console F12 pra detalhes)');
      return;
    }
    const conta = contaAtual();
    const json = inscricao.toJSON();
    const r = await api('salvarInscricaoPush', {
      contaId: conta.id, endpoint: json.endpoint, p256dh: json.keys.p256dh, auth: json.keys.auth
    });
    if(!r.ok){
      console.error('[push] Servidor recusou salvar a inscrição:', r.erro);
      toast(r.erro || 'Não foi possível ativar as notificações');
      return;
    }
    toast('Notificações ativadas');
  }catch(e){
    console.error('[push] Erro inesperado ao ativar notificações:', e);
    toast('Não foi possível ativar as notificações — veja o console (F12) pra detalhes');
  } finally {
    btn.disabled = false;
    atualizarBotaoNotificacoes();
  }
}

function entrarNoApp(){
  const conta = contaAtual();
  if(!conta){ sair(); return; }
  if(!contas.find(c=>String(c.id)===String(conta.id))){ toast('Sua conta não existe mais.'); sair(); return; }

  // sempre entra na visão em Lista — evita confusão de trocar de conta e
  // continuar numa visualização (Cards) escolhida pela pessoa anterior
  visualizacaoAtendimentos = 'lista';
  document.querySelectorAll('#listaVisualizacaoToggle button').forEach(b=>b.classList.toggle('sel', b.dataset.val==='lista'));

  document.getElementById('screen-login').style.display = 'none';
  document.getElementById('app').style.display = 'block';
  document.getElementById('whoName').textContent = conta.nome;
  document.getElementById('avatarIni').textContent = conta.nome.slice(0,2).toUpperCase();
  const btnEmpresa = document.getElementById('btnEmpresaAtual');
  const isAdminBadge = ehAdminEfetivo(conta);
  if(empresaAtual && (isAdminBadge || conta.perfil === 'ATENDENTE')){
    btnEmpresa.style.display = '';
    document.getElementById('empresaAtualNome').textContent = empresaAtual.nome;
  }else{
    btnEmpresa.style.display = 'none';
  }
  atualizarBotaoNotificacoes();
  if(emAppNativo()) iniciarPushNativo();

  const isAdmin = ehAdminEfetivo(conta);
  const isUsuario = conta.perfil === 'USUARIO';
  const podeVerResumo = !isUsuario || conta.adminCliente; // usuário comum não vê; administrador do cliente vê
  const podeVerAgenda = podeVerResumo; // mesma regra: todo mundo, exceto usuário comum (sem ser admin do cliente)

  // visibilidade de cada menu — usa o Perfil de Acesso vinculado à conta
  // quando existir (flag "Visualizar"); sem nenhum perfil vinculado, cai
  // no comportamento padrão de sempre (2º parâmetro)
  aplicarVisibilidadeMenu('lista', menuVisivel(conta, 'atendimentos', true));
  aplicarVisibilidadeMenu('novo', menuVisivel(conta, 'atendimentos', true) && (permissaoMenu(conta,'atendimentos')?.inserir ?? true));
  aplicarVisibilidadeMenu('resumo', menuVisivel(conta, 'resumo', podeVerResumo));
  aplicarVisibilidadeMenu('dashboard', menuVisivel(conta, 'dashboard', podeVerResumo));
  aplicarVisibilidadeMenu('relatorio', menuVisivel(conta, 'construtor_relatorios', isAdmin));
  aplicarVisibilidadeMenu('relatoriospub', menuVisivel(conta, 'relatorios', true));
  aplicarVisibilidadeMenu('cubo', isAdmin);
  aplicarVisibilidadeMenu('financeiro', menuVisivel(conta, 'financeiro', isAdmin));
  aplicarVisibilidadeMenu('agenda', menuVisivel(conta, 'agenda', podeVerAgenda));
  aplicarVisibilidadeMenu('videos', menuVisivel(conta, 'videos', true));
  aplicarVisibilidadeMenu('cadastros', menuVisivel(conta, 'cadastros', isAdmin));
  aplicarVisibilidadeMenu('utilitarios', menuVisivel(conta, 'utilitarios', isAdmin));
  // mesma ideia, mas pras abas internas de cada menu (Dashboard, Financeiro,
  // Agenda, Vídeos, Cadastros, Utilitários) — cada uma com sua própria
  // permissão "menu.submenu" configurável no Perfil de Acesso
  aplicarVisibilidadeSubmenus(conta);

  // valores/hora (R$) só aparecem para o admin — atendentes veem só a quantidade de horas
  document.getElementById('stat_ananda').style.display = isAdmin ? '' : 'none';
  document.getElementById('stat_real').style.display = isAdmin ? '' : 'none';
  document.getElementById('btnExportar').style.display = isAdmin ? '' : 'none';

  popularSelects();
  renderCadastrosTudo();
  resetForm();
  renderFiltros();
  const alvoPadrao = isUsuario ? 'lista' : 'novo';
  const podeAbrirAlvoPadrao = document.querySelector(`.tab[data-view="${alvoPadrao}"]`)?.style.display !== 'none';
  goView(podeAbrirAlvoPadrao ? alvoPadrao : 'lista');
}

/* ---------- selects dinâmicos (form Novo) ---------- */
function popularSelects(){
  const conta = contaAtual();
  const selCliente = document.getElementById('f_cliente');
  selCliente.innerHTML = clientes.map(c=>`<option value="${c.id}">${c.nome}</option>`).join('');
  if(conta && conta.perfil === 'USUARIO'){
    selCliente.value = conta.clienteId;
    selCliente.disabled = true;
  }else{
    selCliente.disabled = false;
  }
  popularUsuariosSolicitantes();
  document.getElementById('f_modulo').innerHTML = modulos.map(m=>`<option value="${m.nome}">${m.nome}</option>`).join('');
  document.getElementById('f_submodulo').innerHTML = submodulos.map(s=>`<option value="${s.nome}">${s.nome}</option>`).join('');
  document.getElementById('f_status').innerHTML = statusList.map(s=>`<option value="${s.nome}">${s.nome}</option>`).join('');

  const isUsuario = conta && conta.perfil === 'USUARIO';
  const tipoOnline = tipos.find(t=>t.nome === 'ATENDIMENTO ONLINE');
  // usuário solicitante sempre abre chamado como "Online" — não escolhe o tipo
  if(isUsuario && tipoOnline){
    document.getElementById('campoTipo').style.display = 'none';
    document.getElementById('campoTipoFixo').style.display = '';
    renderLookupSingle('f_tipo', tipos.map(t=>t.nome), tipoOnline.nome, 'Buscar tipo de atendimento…', labelTipo);
  }else{
    document.getElementById('campoTipo').style.display = '';
    document.getElementById('campoTipoFixo').style.display = 'none';
    renderLookupSingle('f_tipo', tipos.map(t=>t.nome), tipos[0]?.nome, 'Buscar tipo de atendimento…', labelTipo);
  }
  const nomesAtendentesForm = contas.filter(c=>c.perfil==='ATENDENTE').map(a=>a.nome);
  renderLookupSingle('f_atendente', nomesAtendentesForm, nomesAtendentesForm[0] || null, 'Buscar atendente…');
  renderLookupSingle('f_atendente2', ['Nenhum', ...nomesAtendentesForm], 'Nenhum', 'Buscar segundo atendente…');

  // usuário solicitante não escolhe o atendente — um atendente qualquer assume o chamado
  document.getElementById('campoAtendente').style.display = isUsuario ? 'none' : '';
  document.getElementById('campoAtendenteInfo').style.display = isUsuario ? '' : 'none';
  document.getElementById('campoAtendente2').style.display = isUsuario ? 'none' : '';

  // usuário não preenche horário trabalhado — isso é registrado por quem atende
  document.getElementById('campoHorarios').style.display = isUsuario ? 'none' : '';

  // ajuste manual de horas — só o admin tem esse campo
  const isAdmin = ehAdminEfetivo(conta);
  document.getElementById('campoQtdManual').style.display = isAdmin ? '' : 'none';

  // data prevista e vínculo com outro chamado — quem está atendendo é quem define isso
  document.getElementById('campoDataPrevista').style.display = isUsuario ? 'none' : '';
  if(isUsuario){
    document.getElementById('campoVinculo').style.display = 'none';
    document.getElementById('campoVinculoNovo').style.display = 'none';
    document.getElementById('campoVideosVinculo').style.display = 'none';
    document.getElementById('campoVideoVinculoNovo').style.display = 'none';
  }
}
function popularUsuariosSolicitantes(){
  const conta = contaAtual();
  const clienteId = document.getElementById('f_cliente').value;
  const sel = document.getElementById('f_usuario');
  const opcoes = contas.filter(c=>c.perfil==='USUARIO' && String(c.clienteId)===String(clienteId));
  sel.innerHTML = opcoes.map(u=>`<option value="${u.nome}">${u.nome}</option>`).join('');
  if(conta && conta.perfil === 'USUARIO'){
    sel.value = conta.nome;
    sel.disabled = true;
  }else{
    sel.disabled = false;
  }
}
function renderSegmentado(containerId, opcoes, selecionar){
  const el = document.getElementById(containerId);
  el.innerHTML = opcoes.map((o,i)=>`<button data-val="${o}" class="${(selecionar? o===selecionar : i===0) ? 'sel':''}">${labelTipo(o)}</button>`).join('');
}
function getSegSel(containerId){ const sel = document.querySelector(`#${containerId} .sel`); return sel ? sel.dataset.val : null; }
function segmentedSetup(containerId, onChange){
  const el = document.getElementById(containerId);
  el.addEventListener('click', e=>{
    const btn = e.target.closest('button'); if(!btn) return;
    [...el.children].forEach(c=>c.classList.remove('sel'));
    btn.classList.add('sel');
    if(onChange) onChange();
  });
}

/* ---------- lookup de seleção única (campo de busca + dropdown) — usado em
   Tipo de atendimento/Atendente/Segundo atendente, que com muitas opções
   cadastradas ficavam ilegíveis como botões em linha (segmentado) ---------- */
let lookupSingleOpcoes = {};   // containerId -> lista de valores brutos disponíveis
let lookupSingleValores = {};  // containerId -> valor bruto selecionado (ou null)
let lookupSingleOnChange = {}; // containerId -> callback chamado ao confirmar uma escolha
let lookupSingleLabelFn = {};  // containerId -> função opcional valor bruto -> texto exibido
function lookupSingleLabel(containerId, valor){
  if(!valor) return '';
  const fn = lookupSingleLabelFn[containerId];
  return fn ? fn(valor) : valor;
}
function renderLookupSingle(containerId, opcoes, valorAtual, placeholder, labelFn){
  const el = document.getElementById(containerId);
  if(!el) return;
  lookupSingleOpcoes[containerId] = opcoes;
  lookupSingleValores[containerId] = valorAtual || null;
  if(labelFn) lookupSingleLabelFn[containerId] = labelFn;
  el.innerHTML = `<input type="text" class="lookup-single-input" autocomplete="off" placeholder="${escaparHtml(placeholder||'Buscar…')}">
    <div class="lookup-dropdown"></div>`;
  el.querySelector('.lookup-single-input').value = lookupSingleLabel(containerId, valorAtual);
}
function getLookupSingleValor(containerId){ return lookupSingleValores[containerId] || null; }
function setLookupSingleValor(containerId, valor){
  lookupSingleValores[containerId] = valor || null;
  const el = document.getElementById(containerId);
  const input = el && el.querySelector('.lookup-single-input');
  if(input) input.value = lookupSingleLabel(containerId, valor);
}
function renderLookupSingleDropdown(containerId, termo){
  const el = document.getElementById(containerId);
  const dd = el && el.querySelector('.lookup-dropdown');
  if(!dd) return;
  const opcoes = lookupSingleOpcoes[containerId] || [];
  const t = String(termo||'').trim().toLowerCase();
  const filtradas = opcoes.filter(o => !t || lookupSingleLabel(containerId,o).toLowerCase().includes(t));
  if(filtradas.length === 0){ dd.innerHTML = `<div class="lookup-dropdown-empty">Nada encontrado.</div>`; return; }
  const atual = lookupSingleValores[containerId];
  dd.innerHTML = filtradas.map(o=>`<div class="lookup-dropdown-item ${o===atual?'sel':''}" data-lookup-valor="${escaparHtml(o)}">${o===atual?'✓ ':''}${escaparHtml(lookupSingleLabel(containerId,o))}</div>`).join('');
}
// registra os eventos uma única vez por container (o innerHTML é
// recriado a cada renderLookupSingle, mas o próprio container não, então
// o listener continua funcionando por delegação)
function wireLookupSingle(containerId, onChange){
  const el = document.getElementById(containerId);
  if(!el || el.dataset.lookupWired) return;
  el.dataset.lookupWired = '1';
  if(onChange) lookupSingleOnChange[containerId] = onChange;
  el.addEventListener('mousedown', e=>{ if(e.target.closest('.lookup-dropdown-item')) e.preventDefault(); });
  el.addEventListener('click', e=>{
    const item = e.target.closest('.lookup-dropdown-item');
    if(!item) return;
    const valor = item.dataset.lookupValor;
    setLookupSingleValor(containerId, valor);
    el.querySelector('.lookup-dropdown').classList.remove('show');
    const cb = lookupSingleOnChange[containerId];
    if(cb) cb();
  });
  el.addEventListener('input', e=>{
    if(!e.target.classList.contains('lookup-single-input')) return;
    renderLookupSingleDropdown(containerId, e.target.value);
    el.querySelector('.lookup-dropdown').classList.add('show');
  });
  el.addEventListener('focusin', e=>{
    if(!e.target.classList.contains('lookup-single-input')) return;
    renderLookupSingleDropdown(containerId, '');
    el.querySelector('.lookup-dropdown').classList.add('show');
    e.target.select();
  });
  el.addEventListener('focusout', e=>{
    if(!e.target.classList.contains('lookup-single-input')) return;
    // atraso pequeno pra dar tempo do clique num item do dropdown ser
    // processado antes dele sumir (senão o blur esconde antes do click)
    setTimeout(()=>{
      const dd = el.querySelector('.lookup-dropdown');
      if(dd) dd.classList.remove('show');
      const input = el.querySelector('.lookup-single-input');
      if(input) input.value = lookupSingleLabel(containerId, lookupSingleValores[containerId]);
    }, 150);
  });
}

/* ---------- valores por atendente+cliente+tipo (para o preview local) ---------- */
function valoresPara(clienteNome, tipoNome, atendenteNome){
  const cliente = clientes.find(c=>c.nome===clienteNome);
  const tipo = tipos.find(t=>t.nome===tipoNome);
  const atendenteConta = atendenteNome ? contas.find(c=>c.perfil==='ATENDENTE' && c.nome===atendenteNome) : null;
  if(!cliente || !tipo || !atendenteConta) return {real:0, ananda:0, valorSegundoAtend:0};
  const v = valores.find(v=>String(v.atendenteId)===String(atendenteConta.id) && String(v.clienteId)===String(cliente.id) && String(v.tipoId)===String(tipo.id));
  return v ? {real:Number(v.real), ananda:Number(v.ananda), valorSegundoAtend:Number(v.valorSegundoAtend)||0} : {real:0, ananda:0, valorSegundoAtend:0};
}

function atualizarVisibilidadeHoras2(){
  const atendente2Nome = getLookupSingleValor('f_atendente2');
  const tem2 = atendente2Nome && atendente2Nome !== 'Nenhum';
  document.getElementById('campoHorasAtendente2').style.display = tem2 ? '' : 'none';
  if(!tem2) document.getElementById('f_horas_atendente2').value = '';
}

function atualizarPreview(){
  const clienteId = document.getElementById('f_cliente').value;
  const clienteNome = clientes.find(c=>String(c.id)===String(clienteId))?.nome;
  const tipoNome = getLookupSingleValor('f_tipo');
  const atendenteNome = getLookupSingleValor('f_atendente');
  const hi = document.getElementById('f_hi').value;
  const hf = document.getElementById('f_hf').value;
  const inter = document.getElementById('f_inter').value;
  const qtdManualStr = document.getElementById('f_qtd_manual').value;
  const qtd = qtdManualStr !== '' ? Number(qtdManualStr) : calcQtd(hi, hf, inter);
  const vals = valoresPara(clienteNome, tipoNome, atendenteNome);
  document.getElementById('p_qtd').textContent = qtd.toFixed(2).replace('.',',') + 'h';
  document.getElementById('p_ananda').textContent = fmtMoeda(qtd * vals.ananda);
  document.getElementById('p_real').textContent = fmtMoeda(qtd * vals.real);

  const atendente2Nome = getLookupSingleValor('f_atendente2');
  const statAnanda2 = document.getElementById('stat_ananda2');
  if(atendente2Nome && atendente2Nome !== 'Nenhum'){
    // o 2º atendente ganha pela taxa "Valor 2º Atendente/h" cadastrada na
    // mesma linha de valores do atendente principal (vals.valorSegundoAtend)
    const horas2 = Number(document.getElementById('f_horas_atendente2').value) || 0;
    document.getElementById('p_ananda2').textContent = fmtMoeda(horas2 * vals.valorSegundoAtend);
    statAnanda2.style.display = '';
  } else {
    statAnanda2.style.display = 'none';
  }
}

function resetForm(){
  editandoId = null;
  document.getElementById('btnSalvar').textContent = 'Salvar atendimento';
  document.getElementById('f_data').value = new Date().toISOString().slice(0,10);
  popularSelects();
  document.getElementById('f_assunto').value = '';
  document.getElementById('f_detalhe').innerHTML = '';
  document.getElementById('f_solucao').innerHTML = '';
  const conta = contaAtual();
  const isUsuario = conta && conta.perfil === 'USUARIO';
  document.getElementById('f_hi').value = isUsuario ? '00:00' : '08:00';
  document.getElementById('f_inter').value = '00:00';
  document.getElementById('f_hf').value = isUsuario ? '00:00' : '09:00';
  document.getElementById('f_status').value = 'PENDENTE';
  document.getElementById('f_qtd_manual').value = '';
  document.getElementById('f_anexo').value = '';
  document.getElementById('campoAnexoNovo').style.display = '';
  document.getElementById('campoAnexosMultiplos').style.display = 'none';
  anexoAtendimentoId = null;
  document.getElementById('f_data_prevista').value = '';
  document.getElementById('campoVinculo').style.display = 'none';
  document.getElementById('campoVinculoNovo').style.display = '';
  document.getElementById('f_vinculo_busca').value = '';
  document.getElementById('vinculoResultados').innerHTML = '';
  document.getElementById('campoVideosVinculo').style.display = 'none';
  document.getElementById('campoVideoVinculoNovo').style.display = '';
  document.getElementById('f_video_busca').value = '';
  document.getElementById('videoVinculoResultados').innerHTML = '';

  // todo chamado novo abre como PENDENTE e não é escolhível — só aparece
  // o seletor de status quando editando um atendimento já existente
  document.getElementById('campoStatusSelect').style.display = 'none';
  document.getElementById('campoStatusFixo').style.display = '';
  // "Solução" só faz sentido pra quem está atendendo o chamado — some
  // na criação (ninguém resolveu nada ainda) e aparece ao editar
  document.getElementById('campoSolucao').style.display = 'none';
  document.getElementById('blocoMovimentacoesEdicao').style.display = 'none';

  if(conta && conta.perfil === 'ATENDENTE'){
    setLookupSingleValor('f_atendente', conta.nome);
  }
  setLookupSingleValor('f_atendente2', 'Nenhum');
  atualizarVisibilidadeHoras2();
  atualizarPreview();
}

async function salvarRegistro(){
  const data = document.getElementById('f_data').value;
  if(!data){ toast('Informe a data'); return; }
  const clienteId = document.getElementById('f_cliente').value;
  const cliente = clientes.find(c=>String(c.id)===String(clienteId))?.nome || '';
  const usuario = document.getElementById('f_usuario').value;
  const modulo = document.getElementById('f_modulo').value;
  const submodulo = document.getElementById('f_submodulo').value;
  const tipo = getLookupSingleValor('f_tipo');
  const conta = contaAtual();
  const isUsuario = conta && conta.perfil === 'USUARIO';
  const atendente = isUsuario ? '' : getLookupSingleValor('f_atendente');
  if(!tipo || (!isUsuario && !atendente)){ toast('Cadastre ao menos um tipo e um atendente'); return; }
  const at2Sel = isUsuario ? 'Nenhum' : getLookupSingleValor('f_atendente2');
  const atendente2 = at2Sel && at2Sel !== 'Nenhum' ? at2Sel : '';
  if(atendente2 && atendente2 === atendente){ toast('O segundo atendente não pode ser o mesmo que o atendente principal'); return; }
  const horasAtendente2 = atendente2 ? (Number(document.getElementById('f_horas_atendente2').value) || 0) : 0;
  const assunto = document.getElementById('f_assunto').value.trim();
  const detalhe = sanitizarHtml(document.getElementById('f_detalhe').innerHTML.trim());
  const solucao = sanitizarHtml(document.getElementById('f_solucao').innerHTML.trim());
  const hi = document.getElementById('f_hi').value;
  const inter = document.getElementById('f_inter').value;
  const hf = document.getElementById('f_hf').value;
  const status = document.getElementById('f_status').value;
  const isAdmin = ehAdminEfetivo(conta);
  const qtdManualStr = isAdmin ? document.getElementById('f_qtd_manual').value : '';

  const btn = document.getElementById('btnSalvar');
  btn.disabled = true;
  btn.textContent = 'Salvando…';
  try{
    const dataPrevista = isUsuario ? '' : document.getElementById('f_data_prevista').value;
    const payload = { id: editandoId, data, cliente, usuario, modulo, submodulo, tipo, atendente, assunto, detalhe, solucao, hi, inter, hf, status,
      dataPrevista, atendente2, horasAtendente2, empresaId: empresaAtual ? empresaAtual.id : '',
      qtdManual: qtdManualStr !== '' ? Number(qtdManualStr) : undefined };

    // anexo inicial (só existe esse campo na criação — depois de salvo, usa a lista de múltiplos anexos)
    if(!editandoId){
      const arquivo = document.getElementById('f_anexo').files[0];
      if(arquivo){
        if(arquivo.size > 8 * 1024 * 1024){ toast('Anexo muito grande (máx. 8MB)'); btn.disabled = false; btn.textContent = 'Salvar atendimento'; return; }
        payload.anexoBase64 = await lerArquivoBase64(arquivo);
        payload.anexoTipo = arquivo.type;
        payload.anexoNome = arquivo.name;
      }
    }

    const r = await api('salvarAtendimento', payload);
    if(!r.ok) return;
    toast(editandoId ? 'Atendimento atualizado' : 'Atendimento salvo');
    await carregarTudo();
    resetForm();
    renderLista();
    renderResumo();
    goView('lista');
  } finally { btn.disabled = false; }
}

function editar(id){
  const r = atendimentos.find(x=>String(x.id)===String(id));
  if(!r) return;
  editandoId = r.id;
  document.getElementById('btnSalvar').textContent = 'Atualizar atendimento';
  document.getElementById('f_data').value = r.data;
  popularSelects();
  document.getElementById('campoStatusSelect').style.display = '';
  document.getElementById('campoStatusFixo').style.display = 'none';
  document.getElementById('campoHorarios').style.display = ''; // quem edita é atendente/admin, sempre vê horários
  document.getElementById('campoSolucao').style.display = '';
  const cliente = clientes.find(c=>c.nome===r.cliente);
  if(cliente) document.getElementById('f_cliente').value = cliente.id;
  popularUsuariosSolicitantes();
  document.getElementById('f_usuario').value = r.usuario;
  document.getElementById('f_modulo').value = r.modulo || '';
  document.getElementById('f_submodulo').value = r.submodulo || '';
  setLookupSingleValor('f_tipo', r.tipo);
  setLookupSingleValor('f_atendente', r.atendente);
  setLookupSingleValor('f_atendente2', r.atendente2 || 'Nenhum');
  document.getElementById('f_horas_atendente2').value = r.atendente2 ? Number(r.horasAtendente2||0) : '';
  atualizarVisibilidadeHoras2();
  document.getElementById('f_assunto').value = r.assunto || '';
  document.getElementById('f_detalhe').innerHTML = sanitizarHtml(r.detalhe || '');
  document.getElementById('f_solucao').innerHTML = sanitizarHtml(r.solucao || '');
  document.getElementById('f_hi').value = r.hi;
  document.getElementById('f_inter').value = r.inter;
  document.getElementById('f_hf').value = r.hf;
  document.getElementById('f_status').value = r.status;
  document.getElementById('f_qtd_manual').value = '';
  document.getElementById('f_qtd_manual').placeholder = `Atual: ${Number(r.qtd).toFixed(2).replace('.',',')}h — deixe em branco pra manter`;
  document.getElementById('campoAnexoNovo').style.display = 'none';
  document.getElementById('campoAnexosMultiplos').style.display = '';
  anexoAtendimentoId = r.id;
  carregarAnexosMultiplos(r.id);
  document.getElementById('f_data_prevista').value = r.dataPrevista || '';
  document.getElementById('campoVinculo').style.display = '';
  document.getElementById('campoVinculoNovo').style.display = 'none';
  document.getElementById('f_vinculo_busca').value = '';
  document.getElementById('vinculoResultados').innerHTML = '';
  recarregarVinculos(r.id, 'listaVinculos', true);
  document.getElementById('campoVideosVinculo').style.display = '';
  document.getElementById('campoVideoVinculoNovo').style.display = 'none';
  document.getElementById('f_video_busca').value = '';
  document.getElementById('videoVinculoResultados').innerHTML = '';
  carregarVideosCacheParaVinculo();
  recarregarVideosVinculados(r.id, 'listaVideosVinculo', true);
  document.getElementById('blocoMovimentacoesEdicao').style.display = '';
  movLimparComposer('_ed');
  carregarMovimentacoes(r.id, '_ed');
  atualizarPreview();
  goView('novo');
}

function copiarAtendimento(id){
  const r = atendimentos.find(x=>String(x.id)===String(id));
  if(!r) return;
  editandoId = null; // fica como um lançamento NOVO — salvar cria outro registro, não sobrescreve o original
  document.getElementById('btnSalvar').textContent = 'Salvar atendimento';
  document.getElementById('f_data').value = new Date().toISOString().slice(0,10);
  popularSelects();
  document.getElementById('campoStatusSelect').style.display = 'none';
  document.getElementById('campoStatusFixo').style.display = '';
  document.getElementById('campoSolucao').style.display = 'none';
  document.getElementById('blocoMovimentacoesEdicao').style.display = 'none';
  const cliente = clientes.find(c=>c.nome===r.cliente);
  if(cliente) document.getElementById('f_cliente').value = cliente.id;
  popularUsuariosSolicitantes();
  document.getElementById('f_usuario').value = r.usuario;
  document.getElementById('f_modulo').value = r.modulo || '';
  document.getElementById('f_submodulo').value = r.submodulo || '';
  setLookupSingleValor('f_tipo', r.tipo);
  setLookupSingleValor('f_atendente', r.atendente);
  setLookupSingleValor('f_atendente2', r.atendente2 || 'Nenhum');
  document.getElementById('f_horas_atendente2').value = r.atendente2 ? Number(r.horasAtendente2||0) : '';
  atualizarVisibilidadeHoras2();
  document.getElementById('f_assunto').value = r.assunto || '';
  document.getElementById('f_detalhe').innerHTML = sanitizarHtml(r.detalhe || '');
  document.getElementById('f_solucao').innerHTML = '';
  document.getElementById('f_hi').value = r.hi;
  document.getElementById('f_inter').value = r.inter;
  document.getElementById('f_hf').value = r.hf;
  document.getElementById('f_qtd_manual').value = '';
  document.getElementById('f_qtd_manual').placeholder = 'Deixe em branco pra calcular pelo horário acima';
  // anexo não é copiado — cada atendimento tem o seu
  document.getElementById('f_anexo').value = '';
  document.getElementById('campoAnexoNovo').style.display = '';
  document.getElementById('campoAnexosMultiplos').style.display = 'none';
  anexoAtendimentoId = null;
  document.getElementById('f_data_prevista').value = '';
  document.getElementById('campoVinculo').style.display = 'none';
  document.getElementById('campoVinculoNovo').style.display = '';
  document.getElementById('f_vinculo_busca').value = '';
  document.getElementById('vinculoResultados').innerHTML = '';
  // vídeos vinculados também não são copiados — cada atendimento tem os seus
  document.getElementById('campoVideosVinculo').style.display = 'none';
  document.getElementById('campoVideoVinculoNovo').style.display = '';
  document.getElementById('f_video_busca').value = '';
  document.getElementById('videoVinculoResultados').innerHTML = '';
  atualizarPreview();
  goView('novo');
  toast('Copiado — ajuste o que precisar e salve como um novo atendimento');
}

function pedirConfirmacao(titulo, texto, acao, labelBotao){
  document.getElementById('modalTitle').textContent = titulo;
  document.getElementById('modalText').textContent = texto;
  const botao = document.getElementById('modalConfirm');
  botao.textContent = labelBotao || 'Excluir';
  botao.classList.toggle('neutro', !!labelBotao && labelBotao !== 'Excluir');
  excluindoAcao = acao;
  document.getElementById('modalBg').classList.add('show');
}

/* ---------- menu de ações (Editar/Copiar/Excluir) do item da lista ---------- */
function fecharAcoesMenu(){
  document.querySelectorAll('.acoes-menu.show').forEach(m=>m.classList.remove('show'));
}
function toggleAcoesMenu(id){
  const menu = document.getElementById(`acoesMenu-${id}`);
  if(!menu) return;
  const jaAberto = menu.classList.contains('show');
  fecharAcoesMenu();
  if(!jaAberto) menu.classList.add('show');
}

/* ---------- recolher/expandir as linhas de vínculo, na Lista (qualquer nível) ---------- */
function toggleVinculosExpandidos(id){
  id = String(id);
  if(vinculosExpandidos.has(id)) vinculosExpandidos.delete(id);
  else vinculosExpandidos.add(id);
  renderLista();
}

/* ---------- lista de lançamentos ---------- */
function aplicarPeriodoPadraoSeVazio(){
  const de = document.getElementById('periodo_de');
  const ate = document.getElementById('periodo_ate');
  if(de && ate && !de.value && !ate.value){
    const hoje = new Date();
    de.value = primeiroDiaMes(hoje);
    ate.value = ultimoDiaMes(hoje);
  }
}

function renderFiltros(){
  const el = document.getElementById('filtros');
  const conta = contaAtual();
  aplicarPeriodoPadraoSeVazio();
  const inputId = `<input type="text" id="filtroIdBusca" placeholder="Filtrar por ID…" autocomplete="off" value="${escaparHtml(filtroId)}" style="min-width:140px;">`;
  // usuário não filtra por cliente (só vê o próprio cliente mesmo) — mas
  // status, período e ID são liberados abaixo
  if(conta && conta.perfil === 'USUARIO'){ el.innerHTML = inputId; renderFiltrosStatus(); return; }
  el.innerHTML = `
    <div class="lookup-multi">
      <div class="lookup-tags" id="filtroClienteTags"></div>
      <input type="text" id="filtroClienteBusca" placeholder="Filtrar por cliente…" autocomplete="off">
      <div class="lookup-dropdown" id="filtroClienteDropdown"></div>
    </div>
    ${inputId}`;
  renderFiltroClienteTags();
  renderFiltroClienteDropdown('');
  renderFiltrosStatus();
}

function renderFiltroClienteTags(){
  const el = document.getElementById('filtroClienteTags');
  if(!el) return;
  el.innerHTML = [...filtroCliente].map(nome=>`<div class="lookup-tag">${escaparHtml(nome)}<button type="button" data-remover="${escaparHtml(nome)}">×</button></div>`).join('');
}

function renderFiltroClienteDropdown(termo){
  const el = document.getElementById('filtroClienteDropdown');
  if(!el) return;
  const t = String(termo||'').trim().toLowerCase();
  const opcoes = clientes.filter(c=> !t || c.nome.toLowerCase().includes(t));
  if(opcoes.length === 0){ el.innerHTML = `<div class="lookup-dropdown-empty">Nenhum cliente encontrado.</div>`; return; }
  el.innerHTML = opcoes.map(c=>`<div class="lookup-dropdown-item ${filtroCliente.has(c.nome)?'sel':''}" data-cliente="${escaparHtml(c.nome)}">${filtroCliente.has(c.nome)?'✓ ':''}${escaparHtml(c.nome)}</div>`).join('');
}

// mesmo padrão do filtro de cliente (busca + dropdown + tags), só que pra status
function renderFiltrosStatus(){
  const el = document.getElementById('filtrosStatus');
  el.innerHTML = `
    <div class="lookup-multi">
      <div class="lookup-tags" id="filtroStatusTags"></div>
      <input type="text" id="filtroStatusBusca" placeholder="Filtrar por status…" autocomplete="off">
      <div class="lookup-dropdown" id="filtroStatusDropdown"></div>
    </div>`;
  renderFiltroStatusTags();
  renderFiltroStatusDropdown('');
}

function renderFiltroStatusTags(){
  const el = document.getElementById('filtroStatusTags');
  if(!el) return;
  el.innerHTML = [...filtroStatus].map(nome=>`<div class="lookup-tag">${escaparHtml(nome)}<button type="button" data-remover-status="${escaparHtml(nome)}">×</button></div>`).join('');
}

function renderFiltroStatusDropdown(termo){
  const el = document.getElementById('filtroStatusDropdown');
  if(!el) return;
  const t = String(termo||'').trim().toLowerCase();
  const opcoes = statusList.filter(s=> !t || s.nome.toLowerCase().includes(t));
  if(opcoes.length === 0){ el.innerHTML = `<div class="lookup-dropdown-empty">Nenhum status encontrado.</div>`; return; }
  el.innerHTML = opcoes.map(s=>`<div class="lookup-dropdown-item ${filtroStatus.has(s.nome)?'sel':''}" data-status-opcao="${escaparHtml(s.nome)}">${filtroStatus.has(s.nome)?'✓ ':''}${escaparHtml(s.nome)}</div>`).join('');
}

const STATUS_SEMPRE_VISIVEL = new Set(['PENDENTE', 'EM ANDAMENTO', 'EM VALIDAÇÃO', 'NÃO VALIDADO']);

// filtros de cliente/status/período aplicados tanto na visão em Lista
// quanto na visão em Cards (kanban) — mesma base, dois jeitos de mostrar
function itensAtendimentosFiltrados(){
  const conta = contaAtual();
  const isUsuario = conta && conta.perfil === 'USUARIO';
  let itens = atendimentos.slice();
  // usuário: o servidor já manda só o que ele pode ver (os próprios, ou
  // todos do cliente se for "administrador do cliente") — não filtra por
  // cliente aqui, senão descarta os atendimentos dos outros do mesmo
  // cliente; mas status e período valem pra ele também
  if(!isUsuario && filtroCliente.size > 0) itens = itens.filter(r=>filtroCliente.has(r.cliente));
  if(filtroStatus.size > 0) itens = itens.filter(r=>filtroStatus.has(r.status));
  if(filtroId.trim()) { const t = filtroId.trim().toLowerCase(); itens = itens.filter(r=>String(r.id).toLowerCase().includes(t)); }
  const de = document.getElementById('periodo_de').value;
  const ate = document.getElementById('periodo_ate').value;
  // PENDENTE/EM ANDAMENTO/EM VALIDAÇÃO ainda precisam de atenção, então
  // aparecem sempre, independente do período escolhido — só os já
  // encerrados (VALIDADO e demais) respeitam o filtro de período
  if(de) itens = itens.filter(r=>STATUS_SEMPRE_VISIVEL.has(r.status) || String(r.data) >= de);
  if(ate) itens = itens.filter(r=>STATUS_SEMPRE_VISIVEL.has(r.status) || String(r.data) <= ate);
  itens.sort((a,b)=> String(b.data).localeCompare(String(a.data)));
  return itens;
}

function renderLista(){
  const cont = document.getElementById('listaItens');
  const conta = contaAtual();
  const podeEditar = conta && conta.perfil !== 'USUARIO';
  const isUsuario = conta && conta.perfil === 'USUARIO';
  const itens = itensAtendimentosFiltrados();

  document.getElementById('filtroPeriodo').style.display = 'grid';
  const verValores = podeVerValores();
  const isAdmin = ehAdminEfetivo(conta);
  const permAt = permissaoMenu(conta, 'atendimentos');
  const podeEditarBtn = permAt ? permAt.editar : podeEditar;
  const podeExcluirBtn = permAt ? permAt.excluir : podeEditar;

  const emTabela = visualizacaoAtendimentos !== 'cards' && window.matchMedia('(min-width: 860px)').matches;
  renderAgruparListaBar(emTabela);
  toggleFiltrosClienteStatusUI(emTabela);

  document.getElementById('listaItens').style.display = visualizacaoAtendimentos==='cards' ? 'none' : '';
  document.getElementById('kanbanBoard').style.display = visualizacaoAtendimentos==='cards' ? '' : 'none';
  if(visualizacaoAtendimentos === 'cards'){
    document.getElementById('linhaSelecionarTodos').style.display = 'none';
    renderKanbanBoard(itens, { isUsuario, verValores, isAdmin, podeEditarBtn, podeExcluirBtn });
    return;
  }

  document.getElementById('linhaSelecionarTodos').style.display = (podeEditarBtn || podeExcluirBtn) ? 'flex' : 'none';
  if(!podeEditarBtn && !podeExcluirBtn){ selecionados.clear(); }
  atualizarBarraSelecao();

  if(itens.length===0){ cont.innerHTML = `<div class="empty"><div class="big">🗂️</div>Nenhum atendimento encontrado.</div>`; return; }

  const ctx = { isUsuario, verValores, isAdmin, podeEditarBtn, podeExcluirBtn };

  // em telas largas, a Lista vira uma tabela ordenável/agrupável (estilo
  // Cubo); no celular não tem coluna pra arrastar, então continua em cards
  if(emTabela){
    renderTabelaAtendimentos(cont, itens, ctx);
    return;
  }
  cont.innerHTML = itens.map(r => renderLinhaComVinculos(r, ctx)).join('');
}

/* ---------- Lista em tabela (desktop): ordenar por coluna, agrupar arrastando,
   filtro por coluna estilo Excel ---------- */
const LABEL_AGRUPAMENTO_LISTA = { status:'Status', cliente:'Cliente', atendente:'Atendente', tipo:'Tipo', mes:'Mês' };

function valorOrdenacaoLista(r, campo){
  switch(campo){
    case 'cliente': return r.cliente || '';
    case 'assunto': return r.assunto || '';
    case 'atendente': return r.atendente || '';
    case 'tipo': return labelTipo(r.tipo) || '';
    case 'status': return r.status || '';
    case 'data': return `${r.data} ${r.hi}`;
    case 'horas': return Number(r.qtd) || 0;
    case 'valor': return Number(r.totalReal) || 0;
    default: return '';
  }
}
function compararLista(a, b, campo, direcao){
  const va = valorOrdenacaoLista(a, campo), vb = valorOrdenacaoLista(b, campo);
  const cmp = (typeof va === 'number' && typeof vb === 'number') ? va - vb : String(va).localeCompare(String(vb), 'pt-BR');
  return direcao === 'asc' ? cmp : -cmp;
}
function valorAgrupamentoLista(r, campo){
  switch(campo){
    case 'cliente': return r.cliente || '(sem cliente)';
    case 'atendente': return r.atendente || 'A definir';
    case 'tipo': return labelTipo(r.tipo) || '(sem tipo)';
    case 'status': return r.status || '(sem status)';
    case 'mes': return r.mes || '(sem mês)';
    default: return '';
  }
}
function ordenarListaPor(campo){
  if(listaOrdenacao.campo === campo) listaOrdenacao.direcao = listaOrdenacao.direcao === 'asc' ? 'desc' : 'asc';
  else listaOrdenacao = { campo, direcao: 'asc' };
  renderLista();
}
// arrasta mais de uma coluna pra faixa "Agrupar por" pra agrupar em vários
// níveis — a ordem em que soltou vira a ordem dos níveis (mais externo primeiro)
function definirAgrupamentoLista(campo){
  if(!listaAgrupamentos.includes(campo)) listaAgrupamentos.push(campo);
  renderLista();
}
function removerAgrupamentoLista(campo){
  listaAgrupamentos = listaAgrupamentos.filter(c => c !== campo);
  renderLista();
}

// a faixa "Agrupar por" é um bloco fixo no HTML (dentro do card de
// filtros) — só troca de conteúdo/visibilidade, nunca de posição
function renderAgruparListaBar(emTabela){
  const bloco = document.getElementById('blocoAgruparLista');
  if(bloco) bloco.style.display = emTabela ? '' : 'none';
  const drop = document.getElementById('listaAgruparDrop');
  if(!drop) return;
  drop.innerHTML = listaAgrupamentos.length
    ? listaAgrupamentos.map(campo=>`<div class="lookup-tag">${escaparHtml(LABEL_AGRUPAMENTO_LISTA[campo] || campo)}<button type="button" onclick="removerAgrupamentoLista('${campo}')">×</button></div>`).join('')
    : `<span style="color:var(--muted);font-size:12.5px;">⠿⠿ arraste uma coluna aqui</span>`;
}

// muda a ordem das colunas: tira a arrastada de onde estava e enfia bem
// antes da coluna alvo em que foi solta
function reordenarColunaLista(campoArrastado, campoAlvo){
  if(!campoArrastado || !campoAlvo || campoArrastado === campoAlvo) return;
  const semArrastado = listaOrdemColunas.filter(c => c !== campoArrastado);
  const idxAlvo = semArrastado.indexOf(campoAlvo);
  if(idxAlvo === -1) return;
  semArrastado.splice(idxAlvo, 0, campoArrastado);
  listaOrdemColunas = semArrastado;
  renderLista();
}

// na tabela, Cliente e Status já têm o filtro estilo Excel no cabeçalho da
// coluna — os campos "Filtrar por cliente/status" de cima ficam redundantes
// e somem; em Cards/mobile (sem cabeçalho de coluna) eles continuam.
function toggleFiltrosClienteStatusUI(emTabela){
  const clienteWrap = document.querySelector('#filtros .lookup-multi');
  if(clienteWrap) clienteWrap.style.display = emTabela ? 'none' : '';
  const statusEl = document.getElementById('filtrosStatus');
  if(statusEl) statusEl.style.display = emTabela ? 'none' : '';
}

// filtro de coluna estilo Excel — Cliente/Status reaproveitam os mesmos
// Sets do filtro de cima (fica tudo em sincronia); Atendente/Tipo só
// existem aqui mesmo, válidos só pra tabela
function filtroColunaAtivo(campo){
  if(campo === 'cliente') return filtroCliente;
  if(campo === 'status') return filtroStatus;
  return listaFiltrosColuna[campo];
}
function distintosColunaLista(campo){
  const valores = new Set();
  atendimentos.forEach(r=>{
    let v;
    if(campo === 'cliente') v = r.cliente;
    else if(campo === 'atendente') v = r.atendente || 'A definir';
    else if(campo === 'tipo') v = labelTipo(r.tipo);
    else if(campo === 'status') v = r.status;
    if(v) valores.add(v);
  });
  return [...valores].sort((a,b)=>a.localeCompare(b, 'pt-BR'));
}
function toggleFiltroColunaLista(campo){
  listaFiltroColunaAberta = listaFiltroColunaAberta === campo ? null : campo;
  renderLista();
}
function fecharFiltroColunaLista(){
  if(listaFiltroColunaAberta !== null){ listaFiltroColunaAberta = null; renderLista(); }
}
function celulaFiltroColunaLista(c){
  const campo = c.campo;
  const set = filtroColunaAtivo(campo);
  const ativo = set.size > 0;
  const aberto = listaFiltroColunaAberta === campo;
  const valores = distintosColunaLista(campo);
  const itensDropdown = valores.map(v=>
    `<div class="lista-filtro-coluna-item" data-campo="${campo}" data-valor="${escaparHtml(v)}">${set.has(v) ? '✓ ' : ''}${escaparHtml(v)}</div>`
  ).join('');
  return `<span class="lista-th-filtro-wrap" style="position:relative;display:inline-block;margin-left:6px;">
    <span onclick="toggleFiltroColunaLista('${campo}')" style="cursor:pointer;${ativo ? 'color:var(--accent);' : ''}" title="Filtrar ${escaparHtml(c.label)}">▾</span>
    ${aberto ? `<div class="lista-filtro-coluna-dropdown">
      <div class="lista-filtro-coluna-item" data-campo="${campo}" data-valor="" style="font-weight:700;border-bottom:1px solid var(--line);">Selecionar todos</div>
      ${itensDropdown}
    </div>` : ''}
  </span>`;
}

function renderCabecalhoColunaLista(c){
  const ordenadoAtivo = listaOrdenacao.campo === c.campo;
  const seta = ordenadoAtivo ? (listaOrdenacao.direcao === 'asc' ? ' ▲' : ' ▼') : '';
  const filtro = c.filtravel ? celulaFiltroColunaLista(c) : '';
  return `<th class="lista-th-arrastavel${ordenadoAtivo ? ' ordenado' : ''}" data-campo="${c.campo}" data-agrupa="${c.agrupaComo || ''}" data-label="${escaparHtml(c.label)}">⠿⠿ ${escaparHtml(c.label)}${seta}${filtro}</th>`;
}

function renderTabelaAtendimentos(cont, itensOriginais, ctx){
  const { verValores, podeEditarBtn, podeExcluirBtn } = ctx;
  let itens = itensOriginais.slice();
  if(listaFiltrosColuna.atendente.size > 0) itens = itens.filter(r => listaFiltrosColuna.atendente.has(r.atendente || 'A definir'));
  if(listaFiltrosColuna.tipo.size > 0) itens = itens.filter(r => listaFiltrosColuna.tipo.has(labelTipo(r.tipo)));
  itens.sort((a,b)=>compararLista(a, b, listaOrdenacao.campo, listaOrdenacao.direcao));

  const podeSelecionar = podeEditarBtn || podeExcluirBtn;
  const colunasPorCampo = Object.fromEntries(COLUNAS_LISTA_TABELA.map(c => [c.campo, c]));
  const colunas = listaOrdemColunas
    .map(campo => colunasPorCampo[campo])
    .filter(c => c.campo !== 'valor' || verValores)
    .filter(c => !listaAgrupamentos.includes(c.agrupaComo));

  const headerHtml = `<tr>
    ${podeSelecionar ? '<th style="width:30px;"></th>' : ''}
    ${colunas.map(c=>renderCabecalhoColunaLista(c)).join('')}
    <th style="width:56px;"></th>
  </tr>`;

  const corpoHtml = listaAgrupamentos.length
    ? renderNosGrupoTabela(listaAgrupar(itens, listaAgrupamentos), colunas, podeSelecionar, ctx, 0)
    : itens.map(r=>renderLinhaComVinculosTabela(r, ctx, colunas, podeSelecionar)).join('');

  cont.innerHTML = `<div class="card" style="padding:0;"><table class="lista-tabela"><thead>${headerHtml}</thead><tbody>${corpoHtml}</tbody></table></div>`;
}

// agrupamento em vários níveis: agrupa pelo primeiro campo, e dentro de
// cada grupo repete pro campo seguinte — mesma ideia do Cubo (cuboAgrupar)
function listaAgrupar(itens, campos){
  if(campos.length === 0) return null;
  const [campo, ...resto] = campos;
  const grupos = new Map();
  itens.forEach(r=>{
    const chave = valorAgrupamentoLista(r, campo);
    if(!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave).push(r);
  });
  return [...grupos.entries()].map(([chave, itensGrupo])=>({
    chave, itens: itensGrupo, filhos: listaAgrupar(itensGrupo, resto)
  }));
}

// caminho de cada grupo (cadeia de chaves dos ancestrais) guarda se ele
// está recolhido — igual ao padrão já usado no Cubo (cuboLinhasColapsadas)
let listaGruposColapsados = new Set();
function toggleGrupoListaColapsado(caminho){
  if(listaGruposColapsados.has(caminho)) listaGruposColapsados.delete(caminho);
  else listaGruposColapsados.add(caminho);
  renderLista();
}

function renderNosGrupoTabela(nos, colunas, podeSelecionar, ctx, nivel, caminhoPai){
  return nos.map(no=>{
    const caminho = caminhoPai ? caminhoPai + '|||' + no.chave : String(no.chave);
    const colapsado = listaGruposColapsados.has(caminho);
    const linhaGrupo = renderLinhaGrupoTabela(no.chave, no.itens, colunas, podeSelecionar, nivel, caminho, colapsado);
    if(colapsado) return linhaGrupo;
    const corpo = no.filhos
      ? renderNosGrupoTabela(no.filhos, colunas, podeSelecionar, ctx, nivel+1, caminho)
      : no.itens.map(r=>renderLinhaComVinculosTabela(r, ctx, colunas, podeSelecionar)).join('');
    return linhaGrupo + corpo;
  }).join('');
}

function renderLinhaGrupoTabela(chave, linhas, colunas, podeSelecionar, nivel, caminho, colapsado){
  const horas = linhas.reduce((s,r)=>s+Number(r.qtd||0), 0);
  const valor = linhas.reduce((s,r)=>s+Number(r.totalReal||0), 0);
  let primeira = true;
  const seta = colapsado ? '▸' : '▾';
  const toggle = `<button type="button" class="lista-grupo-toggle" data-caminho="${escaparHtml(caminho)}" title="${colapsado ? 'Expandir' : 'Recolher'}" style="background:none;border:none;cursor:pointer;color:inherit;font:inherit;font-weight:700;padding:0;">${seta}</button>`;
  const celulas = colunas.map(c=>{
    if(c.campo === 'horas') return `<td style="text-align:right;font-family:'JetBrains Mono',monospace;">${horas.toFixed(2).replace('.',',')}h</td>`;
    if(c.campo === 'valor') return `<td style="text-align:right;font-family:'JetBrains Mono',monospace;">${fmtMoeda(valor)}</td>`;
    if(primeira){ primeira = false; return `<td style="padding-left:${14 + (nivel||0)*18}px;">${toggle} ${escaparHtml(chave)}<span class="lista-grupo-contagem">${linhas.length}</span></td>`; }
    return `<td></td>`;
  }).join('');
  return `<tr class="lista-grupo">${podeSelecionar ? '<td></td>' : ''}${celulas}<td></td></tr>`;
}

// atendimento principal + suas linhas de vínculo (até 2 níveis), igual ao
// que já existe nos cards — mesma árvore (montarArvoreVinculos), só que
// como linhas de tabela em vez de divs
function renderLinhaComVinculosTabela(r, ctx, colunas, podeSelecionar){
  const arvore = montarArvoreVinculos(r.id, 2);
  let html = renderLinhaTabela(r, ctx, colunas, podeSelecionar, { temVinculos: arvore.length > 0 });
  if(arvore.length > 0 && vinculosExpandidos.has(String(r.id))){
    html += renderLinhasVinculosFilhosTabela(arvore, ctx, colunas, podeSelecionar, 1);
  }
  return html;
}
function renderLinhasVinculosFilhosTabela(nos, ctx, colunas, podeSelecionar, nivel){
  return nos.map((no,i)=>{
    const temFilhos = !!(no.filhos && no.filhos.length);
    let html = renderLinhaTabela(no.atendimento, ctx, colunas, podeSelecionar, { filho:true, nivel, ultimo: i === nos.length-1, temVinculos: temFilhos });
    if(temFilhos && vinculosExpandidos.has(String(no.atendimento.id))){
      html += renderLinhasVinculosFilhosTabela(no.filhos, ctx, colunas, podeSelecionar, nivel+1);
    }
    return html;
  }).join('');
}

function renderLinhaTabela(r, ctx, colunas, podeSelecionar, opts){
  opts = opts || {};
  const ehFilho = !!opts.filho;
  const { isAdmin, podeEditarBtn, podeExcluirBtn } = ctx;
  const [y,m,d] = String(r.data).split('-');
  const clicavel = podeUsarChat(r);
  const checkboxTd = !podeSelecionar ? '' : (ehFilho ? '<td></td>' :
    `<td onclick="event.stopPropagation();"><input type="checkbox" class="chk-item" data-id="${r.id}" ${selecionados.has(r.id)?'checked':''} onclick="toggleSelecao('${r.id}', this.checked)" style="width:16px;height:16px;"></td>`);

  const galho = ehFilho ? (opts.ultimo ? '└─ ' : '├─ ') : '';
  const expandido = vinculosExpandidos.has(String(r.id));
  const toggleVinculos = opts.temVinculos
    ? `<button type="button" class="btn-colapsar-vinculos" onclick="event.stopPropagation();toggleVinculosExpandidos('${r.id}')" title="${expandido ? 'Esconder vínculos' : 'Mostrar vínculos'}" style="margin-right:4px;">${expandido ? '▾' : '▸'}</button>`
    : '';
  const prefixo = `${galho}${toggleVinculos}${ehFilho ? '🔗 ' : ''}`;

  const celulas = colunas.map((c,i)=>{
    const pre = i===0 ? prefixo : '';
    switch(c.campo){
      case 'cliente': return `<td>${pre}${r.naoLidas ? '<span class="dot-naolida" title="Tem movimentação não lida"></span>' : ''}<span style="font-weight:700;">${escaparHtml(r.cliente)}</span><div style="color:var(--muted);font-size:11px;">${escaparHtml(r.usuario)}</div></td>`;
      case 'assunto': return `<td>${pre}${r.assunto ? escaparHtml(r.assunto) : `<span style="color:var(--muted);">—</span>`}</td>`;
      case 'atendente': return `<td>${pre}${escaparHtml(r.atendente || 'A definir')}${r.atendente2 ? `<div style="color:var(--muted);font-size:11px;">+2º: ${escaparHtml(r.atendente2)}</div>` : ''}</td>`;
      case 'tipo': return `<td>${pre}${labelTipo(r.tipo)}</td>`;
      case 'status': return `<td>${pre}<span class="tag status-${statusSlug(r.status)}">${escaparHtml(r.status)}</span></td>`;
      case 'data': return `<td style="font-family:'JetBrains Mono',monospace;">${pre}${d}/${m}/${y}<div style="color:var(--muted);font-size:11px;">${r.hi}–${r.hf}</div></td>`;
      case 'horas': return `<td style="text-align:right;font-family:'JetBrains Mono',monospace;">${pre}${Number(r.qtd).toFixed(2).replace('.',',')}h</td>`;
      case 'valor': return `<td style="text-align:right;font-family:'JetBrains Mono',monospace;color:var(--accent);">${pre}${fmtMoeda(Number(r.totalReal))}</td>`;
      default: return '<td></td>';
    }
  }).join('');

  const acoesTd = ehFilho ? '<td></td>' : ((podeEditarBtn || podeExcluirBtn || isAdmin) ? `
    <td onclick="event.stopPropagation();">
      <div class="acoes-wrap">
        <button class="ghost" onclick="toggleAcoesMenu('${r.id}')">⋮</button>
        <div class="acoes-menu" id="acoesMenu-${r.id}">
          ${podeEditarBtn ? `<div class="acoes-menu-item" onclick="fecharAcoesMenu();editar('${r.id}')">✎ Editar</div>` : ''}
          ${isAdmin ? `<div class="acoes-menu-item" onclick="fecharAcoesMenu();copiarAtendimento('${r.id}')">⧉ Copiar</div>` : ''}
          ${podeExcluirBtn ? `<div class="acoes-menu-item danger" onclick="fecharAcoesMenu();pedirConfirmacao('Excluir lançamento?','Essa ação não pode ser desfeita.', ()=>excluirAtendimento('${r.id}'))">🗑 Excluir</div>` : ''}
        </div>
      </div>
    </td>` : '<td></td>');

  const estilos = [];
  if(clicavel) estilos.push('cursor:pointer');
  if(ehFilho) estilos.push('background:var(--panel-2)');
  const styleAttr = estilos.length ? ` style="${estilos.join(';')};"` : '';
  return `<tr${styleAttr}${clicavel ? ` onclick="abrirDetalhe('${r.id}')"` : ''}>${checkboxTd}${celulas}${acoesTd}</tr>`;
}

/* ---------- arrastar o cabeçalho da coluna (Pointer Events, igual ao drag
   do Kanban) — um clique simples (sem arrastar) ordena a coluna; soltar em
   cima da faixa "Agrupar por" agrupa; soltar em cima de outra coluna troca
   a ordem das colunas ---------- */
function iniciarPossivelDragColunaLista(e, thEl){
  const campo = thEl.dataset.campo;
  const agrupaComo = thEl.dataset.agrupa;
  const label = thEl.dataset.label;
  const startX = e.clientX, startY = e.clientY;
  const rect = thEl.getBoundingClientRect();
  const offsetX = e.clientX - rect.left, offsetY = e.clientY - rect.top;
  let arrastando = false;
  let ghost = null;
  let thAlvoReordenar = null;

  thEl.setPointerCapture(e.pointerId);

  function limparAlvoReordenar(){
    if(thAlvoReordenar) thAlvoReordenar.classList.remove('lista-th-drop-alvo');
    thAlvoReordenar = null;
  }

  function mover(ev){
    if(!arrastando){
      if(Math.hypot(ev.clientX - startX, ev.clientY - startY) < 6) return;
      arrastando = true;
      ghost = document.createElement('div');
      ghost.className = 'lista-coluna-ghost';
      ghost.textContent = label;
      document.body.appendChild(ghost);
    }
    ghost.style.left = (ev.clientX - offsetX) + 'px';
    ghost.style.top = (ev.clientY - offsetY) + 'px';
    ghost.style.display = 'none';
    const alvo = document.elementFromPoint(ev.clientX, ev.clientY);
    ghost.style.display = '';
    const dropZone = document.getElementById('listaAgruparDrop');
    const sobreAlvo = !!(dropZone && alvo && alvo.closest('#listaAgruparDrop'));
    if(dropZone) dropZone.classList.toggle('drag-over', sobreAlvo);

    limparAlvoReordenar();
    if(!sobreAlvo){
      const thHover = alvo && alvo.closest('th[data-campo]');
      if(thHover && thHover !== thEl){
        thAlvoReordenar = thHover;
        thAlvoReordenar.classList.add('lista-th-drop-alvo');
      }
    }
  }
  function soltar(){
    thEl.removeEventListener('pointermove', mover);
    if(arrastando){
      const dropZone = document.getElementById('listaAgruparDrop');
      const sobreAlvo = dropZone && dropZone.classList.contains('drag-over');
      if(dropZone) dropZone.classList.remove('drag-over');
      const alvoReordenar = thAlvoReordenar ? thAlvoReordenar.dataset.campo : null;
      limparAlvoReordenar();
      ghost.remove();
      if(sobreAlvo && agrupaComo) definirAgrupamentoLista(agrupaComo);
      else if(alvoReordenar) reordenarColunaLista(campo, alvoReordenar);
    }else{
      ordenarListaPor(campo);
    }
  }
  function cancelar(){
    thEl.removeEventListener('pointermove', mover);
    limparAlvoReordenar();
    if(ghost) ghost.remove();
  }
  thEl.addEventListener('pointermove', mover);
  thEl.addEventListener('pointerup', soltar, { once:true });
  thEl.addEventListener('pointercancel', cancelar, { once:true });
}

// uma linha (atendimento normal ou "filho" de vínculo) — extraído de
// renderLista pra poder ser chamado tanto pro atendimento principal quanto
// pros vínculos dele, que aparecem como linhas próprias logo abaixo
function renderLinhaAtendimento(r, ctx, opts){
  opts = opts || {};
  const ehFilho = !!opts.filho;
  const { isUsuario, verValores, isAdmin, podeEditarBtn, podeExcluirBtn } = ctx;
  const [y,m,d] = String(r.data).split('-');
  const dataFmt = `${d}/${m}/${y}`;
  const qtdNum = Number(r.qtd);
  const modSub = [r.modulo, r.submodulo].filter(Boolean).join(' · ');
  const contatoAtendente = (isUsuario && !ehFilho) ? contatoDoAtendente(r.atendente) : '';
  const clicavel = podeUsarChat(r);
  const checkbox = (!ehFilho && (podeEditarBtn || podeExcluirBtn)) ? `<input type="checkbox" class="chk-item" data-id="${r.id}" ${selecionados.has(r.id)?'checked':''} onclick="event.stopPropagation();toggleSelecao('${r.id}', this.checked)" style="width:18px;height:18px;flex-shrink:0;margin-top:2px;">` : '';
  const galho = ehFilho ? `<span class="linha-galho">${opts.ultimo ? '└─' : '├─'}</span>` : '';
  const clienteTexto = `${ehFilho ? '🔗 ' : ''}${r.cliente} · ${r.usuario}`;
  // seta pra recolher/expandir as linhas de vínculo — em qualquer nível,
  // sempre que aquele atendimento (principal ou já filho de outro) também
  // tiver vínculo próprio; recolhido por padrão
  const expandido = vinculosExpandidos.has(String(r.id));
  const toggleVinculos = opts.temVinculos
    ? `<button type="button" class="btn-colapsar-vinculos" onclick="event.stopPropagation();toggleVinculosExpandidos('${r.id}')" title="${expandido ? 'Esconder vínculos' : 'Mostrar vínculos'}">${expandido ? '▾' : '▸'}</button>`
    : '';

  // vínculo, sendo bem menos usado, ganha só o botão de Detalhes — abrir o
  // atendimento é sempre o primeiro passo antes de editar/excluir mesmo
  const acoes = ehFilho
    ? (clicavel ? `<div class="item-actions"><button class="ghost chatbtn" onclick="event.stopPropagation();abrirDetalhe('${r.id}')">👁 Detalhes</button></div>` : '')
    : ((podeEditarBtn || podeExcluirBtn || isAdmin) ? `
      <div class="item-actions">
        <div class="acoes-wrap">
          <button class="ghost" onclick="event.stopPropagation();toggleAcoesMenu('${r.id}')">⋮ Ações</button>
          <div class="acoes-menu" id="acoesMenu-${r.id}">
            ${podeEditarBtn ? `<div class="acoes-menu-item" onclick="event.stopPropagation();fecharAcoesMenu();editar('${r.id}')">✎ Editar</div>` : ''}
            ${isAdmin ? `<div class="acoes-menu-item" onclick="event.stopPropagation();fecharAcoesMenu();copiarAtendimento('${r.id}')">⧉ Copiar</div>` : ''}
            ${podeExcluirBtn ? `<div class="acoes-menu-item danger" onclick="event.stopPropagation();fecharAcoesMenu();pedirConfirmacao('Excluir lançamento?','Essa ação não pode ser desfeita.', ()=>excluirAtendimento('${r.id}'))">🗑 Excluir</div>` : ''}
          </div>
        </div>
        ${clicavel ? `<button class="ghost chatbtn" onclick="event.stopPropagation();abrirDetalhe('${r.id}')">👁 Detalhes</button>` : ''}
      </div>` : (clicavel ? `
      <div class="item-actions">
        <button class="ghost chatbtn" onclick="event.stopPropagation();abrirDetalhe('${r.id}')">👁 Ver atendimento</button>
      </div>` : ''));

  return `
    <div class="item${ehFilho ? ' filho nivel'+(opts.nivel||1) : ''}" ${clicavel ? `style="cursor:pointer;" onclick="abrirDetalhe('${r.id}')"` : ''}>
      ${galho}
      <div class="top">
        ${(toggleVinculos || checkbox) ? `<div style="display:flex;gap:8px;align-items:flex-start;">${toggleVinculos}${checkbox}<div>` : '<div>'}
        <div><div class="cliente">${r.naoLidas ? '<span class="dot-naolida" title="Tem movimentação não lida"></span>' : ''}${clienteTexto}</div>
        <div class="data">${dataFmt} · ${r.hi}–${r.hf}${r.inter && r.inter!=='00:00' ? ' (int. '+r.inter+')' : ''}</div></div>
        ${(toggleVinculos || checkbox) ? `</div></div>` : '</div>'}
        <div style="display:flex;flex-direction:column;gap:4px;align-items:flex-end;">
          <span class="tag status-${statusSlug(r.status)}">${r.status}</span>
          ${flagPrazo(r)}
        </div>
      </div>
      ${modSub ? `<div class="detalhe" style="color:var(--accent);font-weight:600;">${modSub}</div>` : ''}
      ${r.assunto ? `<div class="detalhe" style="font-weight:600;">${escaparHtml(r.assunto)}</div>` : ''}
      ${r.detalhe ? `<div class="detalhe">${escaparHtml(stripHtml(r.detalhe).slice(0,140))}${stripHtml(r.detalhe).length>140?'…':''}</div>` : ''}
      <div class="meta">
        <span class="tag" title="ID do atendimento">#${escaparHtml(String(r.id))}</span>
        <span class="tag">${labelTipo(r.tipo)}</span>
        <span class="tag">${r.atendente || 'A definir'}</span>
        <span class="tag">${qtdNum.toFixed(2).replace('.',',')}h</span>
        ${r.atendente2 ? `<span class="tag">+2º: ${r.atendente2} (${Number(r.horasAtendente2||0).toFixed(2).replace('.',',')}h)</span>` : ''}
        ${r.solucao ? `<span class="tag" style="color:var(--ok);">✓ Solucionado</span>` : ''}
        ${r.anexoUrl ? `<a class="tag" style="color:var(--accent);" href="${r.anexoUrl}" target="_blank" onclick="event.stopPropagation();">📎 ${r.anexoNome||'anexo'}</a>
        <a class="tag" style="color:var(--accent);" href="${urlDownloadAnexo(r.anexoUrl, r.anexoNome)}" onclick="event.stopPropagation();" title="Baixar arquivo original">⬇ Baixar</a>` : ''}
      </div>
      ${contatoAtendente ? `<div style="margin-top:8px;font-size:12px;" onclick="event.stopPropagation();">Contato do atendente: ${contatoAtendente}</div>` : ''}
      ${verValores ? `
      <div class="valores">
        <span class="v1">Atendente: ${fmtMoeda(Number(r.totalAnanda))}${r.atendente2 ? ` + ${fmtMoeda(Number(r.totalAnanda2))} (2º)` : ''}</span>
        <span class="v2">${fmtMoeda(Number(r.totalReal))}</span>
      </div>` : ''}
      ${acoes}
    </div>`;
}

// atendimento principal + suas linhas de vínculo (até 2 níveis), uma
// abaixo da outra — igual uma ferramenta de projeto mostra subtarefas.
// Cada nível tem sua própria seta de recolher/expandir, começando tudo
// recolhido por padrão.
function renderLinhaComVinculos(r, ctx){
  const arvore = montarArvoreVinculos(r.id, 2);
  let html = renderLinhaAtendimento(r, ctx, { filho: false, temVinculos: arvore.length > 0 });
  if(arvore.length > 0 && vinculosExpandidos.has(String(r.id))){
    html += renderLinhasVinculosFilhos(arvore, ctx, 1);
  }
  return html;
}
function renderLinhasVinculosFilhos(nos, ctx, nivel){
  return nos.map((no,i)=>{
    const temFilhos = !!(no.filhos && no.filhos.length);
    let html = renderLinhaAtendimento(no.atendimento, ctx, { filho: true, nivel, ultimo: i === nos.length-1, temVinculos: temFilhos });
    if(temFilhos && vinculosExpandidos.has(String(no.atendimento.id))){
      html += renderLinhasVinculosFilhos(no.filhos, ctx, nivel+1);
    }
    return html;
  }).join('');
}

/* ---------- Cards (kanban) — mesma lista de Atendimentos, agrupada por status ---------- */
function corStatusDot(nome){
  const mapa = { 'VALIDADO':'var(--ok)', 'PENDENTE':'var(--warn)', 'AGENDADO':'var(--purple)', 'EM-ANDAMENTO':'var(--yellow)', 'EM-VALIDACAO':'var(--blue)', 'CANCELADO':'var(--bad)', 'NAO-VALIDADO':'var(--bad)' };
  return mapa[statusSlug(nome)] || 'var(--muted)';
}

function renderKanbanBoard(itens, opts){
  const board = document.getElementById('kanbanBoard');
  const porStatus = {};
  itens.forEach(r=>{ (porStatus[r.status] = porStatus[r.status] || []).push(r); });
  // colunas na ordem cadastrada em Status; um status "órfão" (removido do
  // cadastro, mas ainda gravado em algum atendimento antigo) ganha coluna extra
  const nomesColunas = statusList.map(s=>s.nome);
  Object.keys(porStatus).forEach(nome=>{ if(!nomesColunas.includes(nome)) nomesColunas.push(nome); });

  if(nomesColunas.length === 0){ board.innerHTML = `<div class="empty"><div class="big">🗂️</div>Nenhum status cadastrado.</div>`; return; }

  board.innerHTML = nomesColunas.map(nome=>{
    const lista = porStatus[nome] || [];
    const cards = lista.map(r=>renderKanbanCard(r, opts)).join('');
    return `
    <div class="kanban-col">
      <div class="kanban-col-header">
        <div class="titulo"><span class="kanban-col-dot" style="background:${corStatusDot(nome)};"></span><span>${escaparHtml(nome)}</span></div>
        <span class="kanban-col-count">${lista.length}</span>
      </div>
      <div class="kanban-col-body" data-status="${escaparHtml(nome)}">
        ${cards || `<div class="kanban-col-empty">Nenhum atendimento</div>`}
      </div>
    </div>`;
  }).join('');
}

function renderKanbanCard(r, opts){
  const [y,m,d] = String(r.data).split('-');
  const dataFmt = `${d}/${m}/${y}`;
  const handle = opts.podeEditarBtn ? `<div class="kanban-card-handle">⠿</div>` : '';
  return `
    <div class="kanban-card" data-id="${r.id}" data-status="${escaparHtml(r.status)}">
      ${handle}
      <div class="kanban-card-body">
        <div class="cliente">${r.naoLidas ? '<span class="dot-naolida" title="Tem movimentação não lida"></span>' : ''}${escaparHtml(r.cliente)} · ${escaparHtml(r.usuario)}</div>
        <div class="data">${dataFmt} · ${Number(r.qtd).toFixed(2).replace('.',',')}h</div>
        ${r.assunto ? `<div class="detalhe" style="font-weight:600;">${escaparHtml(r.assunto)}</div>` : ''}
        ${r.detalhe ? `<div class="detalhe">${escaparHtml(stripHtml(r.detalhe))}</div>` : ''}
        <div class="meta">
          <span class="tag" title="ID do atendimento">#${escaparHtml(String(r.id))}</span>
          <span class="tag">${labelTipo(r.tipo)}</span>
          <span class="tag">${escaparHtml(r.atendente || 'A definir')}</span>
          ${opts.verValores ? `<span class="tag" style="color:var(--accent);">${fmtMoeda(Number(r.totalReal))}</span>` : ''}
          ${flagPrazo(r)}
        </div>
        ${blocoArvoreVinculos(r.id)}
      </div>
    </div>`;
}

/* ---------- arrastar-e-soltar do Kanban (Pointer Events — funciona com mouse e touch) ---------- */
let kanbanDrag = null; // {id, statusOrigem, cardEl, ghost, offsetX, offsetY, colunaAtual}
let kanbanAcabouDeArrastar = false; // suprime o click de abrir detalhe logo depois de soltar

function iniciarDragKanban(e, handleEl){
  const cardEl = handleEl.closest('.kanban-card');
  if(!cardEl) return;
  e.preventDefault();
  const rect = cardEl.getBoundingClientRect();

  const ghost = cardEl.cloneNode(true);
  ghost.classList.add('kanban-card-ghost');
  ghost.style.left = rect.left + 'px';
  ghost.style.top = rect.top + 'px';
  ghost.style.width = rect.width + 'px';
  document.body.appendChild(ghost);
  cardEl.classList.add('dragging');

  kanbanDrag = {
    id: cardEl.dataset.id, statusOrigem: cardEl.dataset.status, cardEl, ghost,
    offsetX: e.clientX - rect.left, offsetY: e.clientY - rect.top,
    colunaAtual: null,
  };

  handleEl.setPointerCapture(e.pointerId);
  handleEl.addEventListener('pointermove', moverDragKanban);
  handleEl.addEventListener('pointerup', soltarDragKanban, { once:true });
  handleEl.addEventListener('pointercancel', cancelarDragKanban, { once:true });
}

function moverDragKanban(e){
  if(!kanbanDrag) return;
  const { ghost, offsetX, offsetY } = kanbanDrag;
  ghost.style.left = (e.clientX - offsetX) + 'px';
  ghost.style.top = (e.clientY - offsetY) + 'px';

  ghost.style.display = 'none';
  const elAlvo = document.elementFromPoint(e.clientX, e.clientY);
  ghost.style.display = '';
  const colunaBody = elAlvo ? elAlvo.closest('.kanban-col-body') : null;

  if(kanbanDrag.colunaAtual && kanbanDrag.colunaAtual !== colunaBody) kanbanDrag.colunaAtual.classList.remove('drag-over');
  if(colunaBody) colunaBody.classList.add('drag-over');
  kanbanDrag.colunaAtual = colunaBody;
}

async function soltarDragKanban(e){
  const handleEl = e.currentTarget;
  handleEl.removeEventListener('pointermove', moverDragKanban);
  if(!kanbanDrag) return;
  const { id, statusOrigem, cardEl, ghost, colunaAtual } = kanbanDrag;
  document.querySelectorAll('.kanban-col-body.drag-over').forEach(el=>el.classList.remove('drag-over'));
  cardEl.classList.remove('dragging');
  ghost.remove();
  kanbanDrag = null;
  kanbanAcabouDeArrastar = true;
  setTimeout(()=>{ kanbanAcabouDeArrastar = false; }, 50);

  const novoStatus = colunaAtual ? colunaAtual.dataset.status : null;
  if(!novoStatus || novoStatus === statusOrigem) return;

  const conta = contaAtual();
  try{
    const r = await api('alterarStatusEmMassa', { ids:[id], novoStatus, contaId: conta.id });
    if(!r.ok){ toast(r.erro || 'Não foi possível mudar o status.'); return; }
    await carregarTudo();
    renderLista();
    renderResumo();
    toast(`Status alterado para ${novoStatus}`);
  }catch(err){
    toast('Não foi possível mudar o status.');
  }
}

function cancelarDragKanban(e){
  const handleEl = e.currentTarget;
  handleEl.removeEventListener('pointermove', moverDragKanban);
  if(!kanbanDrag) return;
  document.querySelectorAll('.kanban-col-body.drag-over').forEach(el=>el.classList.remove('drag-over'));
  kanbanDrag.cardEl.classList.remove('dragging');
  kanbanDrag.ghost.remove();
  kanbanDrag = null;
}

async function excluirAtendimento(id){
  const r = await api('excluirAtendimento', { id });
  if(!r.ok) return;
  await carregarTudo();
  renderLista(); renderResumo();
  toast('Lançamento excluído');
}

/* ---------- resumo ---------- */
function mesesDisponiveis(){
  const set = new Set(atendimentos.map(r=>r.mes));
  set.add(mesFromData(new Date().toISOString().slice(0,10)));
  return [...set].filter(Boolean).sort((a,b)=>{ const [ma,ya]=a.split('/'); const [mb,yb]=b.split('/'); return (yb+mb).localeCompare(ya+ma); });
}
function popularMeses(){
  const sel = document.getElementById('r_mes');
  const atual = sel.value;
  const meses = mesesDisponiveis();
  sel.innerHTML = meses.map(m=>`<option value="${m}">${m}</option>`).join('');
  sel.value = atual && meses.includes(atual) ? atual : meses[0];
}
let filtroResumoAtendente = 'TODOS';
let filtroResumoCliente = new Set(); // vazio = todos

// quanto uma pessoa ganhou (e quantas horas ela trabalhou) num atendimento
// específico — considera tanto o papel de atendente principal quanto o de
// segundo atendente (o normal é só um dos dois valer pra cada pessoa)
function ganhoAtendente(r, nome){
  let valor = 0, horas = 0;
  if(r.atendente === nome){ valor += Number(r.totalAnanda)||0; horas += Number(r.qtd)||0; }
  if(r.atendente2 === nome){ valor += Number(r.totalAnanda2)||0; horas += Number(r.horasAtendente2)||0; }
  return { valor, horas };
}

function renderResumo(){
  popularMeses();
  const mes = document.getElementById('r_mes').value;
  const conta = contaAtual();
  const isAdmin = ehAdminEfetivo(conta);
  const isAtendente = conta && conta.perfil === 'ATENDENTE';
  let itens = atendimentos.filter(r=>r.mes===mes);

  // pessoa cujas horas/ganhos queremos isolar (conta os atendimentos em que
  // ela é atendente principal OU segundo atendente); null = visão geral,
  // com todo mundo somado. Admin pode escolher qualquer atendente;
  // atendente só vê o próprio resumo.
  let nomeAlvo = null;
  const campoFiltro = document.getElementById('campoFiltroAtendenteResumo');
  if(isAdmin){
    campoFiltro.style.display = '';
    const selAt = document.getElementById('r_atendente');
    const nomesAtendentes = contas.filter(c=>c.perfil==='ATENDENTE').map(a=>a.nome);
    selAt.innerHTML = `<option value="TODOS">Todos os atendentes</option>` + nomesAtendentes.map(n=>`<option value="${n}">${n}</option>`).join('');
    selAt.value = filtroResumoAtendente;
    if(filtroResumoAtendente !== 'TODOS') nomeAlvo = filtroResumoAtendente;
  }else{
    campoFiltro.style.display = 'none';
    if(isAtendente) nomeAlvo = conta.nome;
  }
  if(nomeAlvo) itens = itens.filter(r=>r.atendente === nomeAlvo || r.atendente2 === nomeAlvo);

  // filtro por cliente — disponível pro admin e pro atendente
  const campoFiltroCliente = document.getElementById('campoFiltroClienteResumo');
  if(isAdmin || isAtendente){
    campoFiltroCliente.style.display = '';
    const elChips = document.getElementById('r_cliente_chips');
    elChips.innerHTML = `<div class="chip ${filtroResumoCliente.size===0?'on':''}" data-cliente="TODOS">Todos</div>` +
      clientes.map(c=>`<div class="chip ${filtroResumoCliente.has(c.nome)?'on':''}" data-cliente="${c.nome}">${c.nome}</div>`).join('');
    if(filtroResumoCliente.size > 0) itens = itens.filter(r=>filtroResumoCliente.has(r.cliente));
  }else{
    campoFiltroCliente.style.display = 'none';
  }

  // com uma pessoa específica selecionada, horas/ganho contam só a parte
  // dela (principal ou 2º); na visão geral, somam tudo — inclusive o que
  // cada segundo atendente ganhou em cada chamado
  const totalHoras = nomeAlvo
    ? itens.reduce((s,r)=>s+ganhoAtendente(r,nomeAlvo).horas,0)
    : itens.reduce((s,r)=>s+Number(r.qtd),0);
  const verValoresReal = isAdmin || (conta && conta.perfil === 'USUARIO' && conta.adminCliente); // Valor Real — admin e o usuário administrador do cliente
  const verValorAtendente = isAdmin || (conta && conta.perfil === 'ATENDENTE'); // Valor Atendente — admin e o próprio atendente

  if(verValoresReal || verValorAtendente){
    const totalAnanda = nomeAlvo
      ? itens.reduce((s,r)=>s+ganhoAtendente(r,nomeAlvo).valor,0)
      : itens.reduce((s,r)=>s+(Number(r.totalAnanda)||0)+(Number(r.totalAnanda2)||0),0);
    const boxesExtra = [
      verValoresReal ? `<div class="box"><div class="k">Total real</div><div class="v" style="color:var(--accent)">${fmtMoeda(itens.reduce((s,r)=>s+Number(r.totalReal||0),0))}</div></div>` : '',
      verValorAtendente ? `<div class="box"><div class="k">Total Atendente</div><div class="v"${verValoresReal?'':' style="color:var(--accent)"'}>${fmtMoeda(totalAnanda)}</div></div>` : '',
    ].join('');
    document.getElementById('resumoBoxes').innerHTML = `
      ${boxesExtra}
      <div class="box"><div class="k">Horas no mês</div><div class="v">${totalHoras.toFixed(1).replace('.',',')}h</div></div>
      <div class="box"><div class="k">Atendimentos</div><div class="v">${itens.length}</div></div>`;
  }else{
    document.getElementById('resumoBoxes').innerHTML = `
      <div class="box"><div class="k">Horas no mês</div><div class="v" style="color:var(--accent)">${totalHoras.toFixed(1).replace('.',',')}h</div></div>
      <div class="box"><div class="k">Atendimentos</div><div class="v">${itens.length}</div></div>`;
  }

  // quebra por cliente — mostra horas sempre; valores em R$ conforme o que a conta pode ver
  const cardCliente = document.getElementById('cardResumoCliente');
  if(itens.length > 0){
    cardCliente.style.display = '';
    const porCliente = {};
    itens.forEach(r=>{
      if(!porCliente[r.cliente]) porCliente[r.cliente] = { horas:0, real:0, ananda:0, qtd:0 };
      if(nomeAlvo){
        const g = ganhoAtendente(r, nomeAlvo);
        porCliente[r.cliente].horas += g.horas;
        porCliente[r.cliente].ananda += g.valor;
      }else{
        porCliente[r.cliente].horas += Number(r.qtd);
        porCliente[r.cliente].ananda += (Number(r.totalAnanda)||0) + (Number(r.totalAnanda2)||0);
      }
      porCliente[r.cliente].real += Number(r.totalReal)||0;
      porCliente[r.cliente].qtd += 1;
    });
    // meta mensal é cadastrada por cliente (Cadastros → Clientes) — compara
    // com o Valor Real já realizado no mês pra mostrar se já bateu ou não
    const metaPorCliente = {};
    clientes.forEach(c=>{ metaPorCliente[c.nome] = Number(c.metaMensal)||0; });
    const colunaMeta = (nome, v) => {
      if(!verValoresReal) return '';
      const meta = metaPorCliente[nome] || 0;
      if(meta <= 0) return `<td style="color:var(--muted);">—</td>`;
      const pct = (v.real / meta) * 100;
      const bateu = v.real >= meta;
      return `<td title="${fmtMoeda(v.real)} de ${fmtMoeda(meta)}"><span style="font-weight:700;color:${bateu?'var(--ok)':'var(--warn)'};">${bateu?'✓ ':''}${pct.toFixed(0)}%</span></td>`;
    };
    const colunasExtra = (v, nome) => [
      verValoresReal ? `<td>${fmtMoeda(v.real)}</td>` : '',
      colunaMeta(nome, v),
      verValorAtendente ? `<td>${fmtMoeda(v.ananda)}</td>` : '',
    ].join('');
    const linhasCliente = Object.entries(porCliente)
      .sort((a,b)=>b[1].horas-a[1].horas)
      .map(([nome,v])=>`<tr><td>${nome}</td><td>${v.horas.toFixed(2).replace('.',',')}h</td><td>${v.qtd}</td>${colunasExtra(v,nome)}</tr>`)
      .join('');
    document.getElementById('resumoPorCliente').innerHTML =
      `<tr><th>Cliente</th><th>Horas</th><th>Atend.</th>${verValoresReal?'<th>Real</th><th>Meta</th>':''}${verValorAtendente?'<th>Atendente</th>':''}</tr>${linhasCliente}`;
  }else{
    cardCliente.style.display = 'none';
  }

  const statusCount = {};
  statusList.forEach(s => statusCount[s.nome] = 0);
  itens.forEach(r=> statusCount[r.status] = (statusCount[r.status]||0)+1 );
  const totalItens = itens.length || 1;
  const linhasStatus = Object.entries(statusCount).map(([k,v])=>{
    const pct = ((v/totalItens)*100).toFixed(0);
    return `<tr><td><span class="tag status-${statusSlug(k)}">${k}</span></td><td>${v}</td><td>${pct}%</td></tr>`;
  }).join('');
  document.getElementById('resumoStatus').innerHTML = `<tr><th>Status</th><th>Qtd.</th><th>%</th></tr>${linhasStatus}`;
}

/* ================= DASHBOARD ================= */
let dashFiltroCliente = new Set();
let dashFiltroAtendente = new Set();
let dashFiltroStatus = new Set();
let dashAba = 'geral';
let dashSujo = { geral:true, operacional:true, comparativo:true };
// "concluído" (não fica mais na fila de abertos) — mesmos status que já
// tiram o card do fluxo normal no resto do app
const DASH_STATUS_TERMINAIS = new Set(['VALIDADO','CANCELADO','NAO-VALIDADO']);
function dashEhTerminal(status){ return DASH_STATUS_TERMINAIS.has(statusSlug(status)); }
// dias corridos desde a Data do atendimento — só faz sentido pra quem
// ainda está em aberto (não tem "data de conclusão" separada no sistema)
function dashDiasEmAberto(r){
  if(!r.data) return 0;
  const ini = new Date(r.data+'T00:00:00'), hoje = new Date(hojeLocalISO()+'T00:00:00');
  return Math.max(0, Math.round((hoje-ini)/86400000));
}
// mesma regra do flagPrazo() (só conta atraso enquanto ainda está aberto)
function dashEstaAtrasado(r){
  return !dashEhTerminal(r.status) && !!r.dataPrevista && hojeLocalISO() > r.dataPrevista;
}

function calcularItensDashboard(){
  const conta = contaAtual();
  let de = document.getElementById('dash_de').value;
  let ate = document.getElementById('dash_ate').value;
  if(!de || !ate){
    // padrão: últimos 3 meses (inclui o atual) — o gráfico de tendência
    // por mês não diz muita coisa com um mês só
    const hoje = new Date();
    const primeiro = new Date(hoje.getFullYear(), hoje.getMonth()-2, 1);
    const ultimo = new Date(hoje.getFullYear(), hoje.getMonth()+1, 0);
    de = primeiro.toISOString().slice(0,10);
    ate = ultimo.toISOString().slice(0,10);
    document.getElementById('dash_de').value = de;
    document.getElementById('dash_ate').value = ate;
  }
  let itens = atendimentos.filter(r=>r.data && r.data>=de && r.data<=ate);
  // ADMIN e USUARIO já vêm pré-filtrados do backend; ATENDENTE recebe tudo
  // e precisa se restringir aos próprios atendimentos, igual ao Resumo
  if(conta && conta.perfil === 'ATENDENTE'){
    itens = itens.filter(r=>r.atendente === conta.nome || r.atendente2 === conta.nome);
  }
  if(dashFiltroCliente.size > 0) itens = itens.filter(r=>dashFiltroCliente.has(r.cliente));
  if(dashFiltroAtendente.size > 0) itens = itens.filter(r=>dashFiltroAtendente.has(r.atendente) || dashFiltroAtendente.has(r.atendente2));
  if(dashFiltroStatus.size > 0) itens = itens.filter(r=>dashFiltroStatus.has(r.status));
  return { itens, de, ate };
}

function renderFiltrosDashboard(){
  const conta = contaAtual();
  const isAtendente = conta && conta.perfil === 'ATENDENTE';

  document.getElementById('dashFiltroCliente').innerHTML = `<div class="chip ${dashFiltroCliente.size===0?'on':''}" data-valor="TODOS">Todos</div>` +
    clientes.map(c=>`<div class="chip ${dashFiltroCliente.has(c.nome)?'on':''}" data-valor="${c.nome}">${c.nome}</div>`).join('');

  const cardAt = document.getElementById('dashCardFiltroAtendente');
  cardAt.style.display = isAtendente ? 'none' : '';
  if(!isAtendente){
    const nomesAtendentes = contas.filter(c=>c.perfil==='ATENDENTE').map(a=>a.nome);
    document.getElementById('dashFiltroAtendente').innerHTML = `<div class="chip ${dashFiltroAtendente.size===0?'on':''}" data-valor="TODOS">Todos</div>` +
      nomesAtendentes.map(n=>`<div class="chip ${dashFiltroAtendente.has(n)?'on':''}" data-valor="${n}">${n}</div>`).join('');
  }

  document.getElementById('dashFiltroStatus').innerHTML = `<div class="chip ${dashFiltroStatus.size===0?'on':''}" data-valor="TODOS">Todos</div>` +
    statusList.map(s=>`<div class="chip ${dashFiltroStatus.has(s.nome)?'on':''}" data-valor="${s.nome}">${s.nome}</div>`).join('');
}

function goDashSub(sub){
  dashAba = sub;
  document.querySelectorAll('#dashSubtabs .subtab').forEach(t=>t.classList.toggle('active', t.dataset.dashsub===sub));
  document.querySelectorAll('.dash-view').forEach(v=>v.classList.toggle('active', v.id==='dash-'+sub));
  // desenha só a aba visível (e só quando precisa) — os gráficos usam a
  // largura real do card, e um card escondido (display:none) mede 0
  if(sub==='geral' && dashSujo.geral){ renderDashboardGeral(); dashSujo.geral = false; }
  if(sub==='operacional' && dashSujo.operacional){ renderDashboardOperacional(); dashSujo.operacional = false; }
  if(sub==='comparativo' && dashSujo.comparativo){ renderDashboardComparativo(); dashSujo.comparativo = false; }
}

function renderDashboard(){
  renderFiltrosDashboard();
  dashSujo = { geral:true, operacional:true, comparativo:true };
  goDashSub(primeiraSubAbaVisivel('dashboard', dashAba));
}

/* ---------- gráficos (SVG simples, sem biblioteca) ---------- */
function dashCss(nome){ return getComputedStyle(document.body).getPropertyValue(nome).trim(); }
function dashSvgEl(tag, attrs){
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for(const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}
function dashFmtValor(v, unit){
  if(unit==='R$') return fmtMoeda(v);
  if(unit==='h') return v.toFixed(1).replace('.',',')+'h';
  return String(v);
}
function dashTooltipEl(){
  let tt = document.getElementById('dashTooltip');
  if(!tt){ tt = document.createElement('div'); tt.id = 'dashTooltip'; tt.className = 'dash-tooltip'; document.body.appendChild(tt); }
  return tt;
}
function dashShowTip(evt, html){
  const tt = dashTooltipEl();
  tt.innerHTML = html; tt.style.left = evt.clientX+'px'; tt.style.top = (evt.clientY-10)+'px';
  tt.classList.add('show');
}
function dashMoveTip(evt){ const tt = dashTooltipEl(); tt.style.left = evt.clientX+'px'; tt.style.top = (evt.clientY-10)+'px'; }
function dashHideTip(){ dashTooltipEl().classList.remove('show'); }
function dashLegendHtml(items){
  return items.map(i=>`<span><span class="sw" style="background:${i.cor}"></span>${escaparHtml(i.label)}</span>`).join('');
}

function dashBarChart(container, {data, height=180, horizontal=false, rotateLabels=false, unit=''}){
  container.innerHTML = '';
  if(!data.length || !data.some(d=>d.value>0)){ container.innerHTML = '<div class="dash-empty">Sem dados no período.</div>'; return; }
  const w = container.clientWidth || 300;
  if(horizontal){
    const rowH=26, padL=Math.min(150, Math.max(80, w*0.34)), padR=44;
    const max = Math.max(...data.map(d=>d.value)) || 1;
    const svg = dashSvgEl('svg', {width:w, height:data.length*rowH+6, viewBox:`0 0 ${w} ${data.length*rowH+6}`});
    data.forEach((d,i)=>{
      const y=i*rowH+4, barW=(d.value/max)*(w-padL-padR);
      const lbl = dashSvgEl('text', {x:0, y:y+13, style:`font-size:10.5px;fill:${dashCss('--muted')}`}); lbl.textContent = d.label; svg.appendChild(lbl);
      svg.appendChild(dashSvgEl('rect', {x:padL, y, width:w-padL-padR, height:14, rx:5, fill:dashCss('--panel-2')}));
      const bar = dashSvgEl('rect', {x:padL, y, width:Math.max(barW,3), height:14, rx:5, fill:dashCss(d.tok||'--blue')});
      bar.addEventListener('mouseenter', e=>dashShowTip(e, `<b>${dashFmtValor(d.value,unit)}</b> · ${d.label}`));
      bar.addEventListener('mousemove', dashMoveTip); bar.addEventListener('mouseleave', dashHideTip);
      svg.appendChild(bar);
      const val = dashSvgEl('text', {x:padL+barW+6, y:y+11, style:`font-size:10.5px;fill:${dashCss('--muted')}`}); val.textContent = dashFmtValor(d.value,unit); svg.appendChild(val);
    });
    container.appendChild(svg);
    return;
  }
  const padL=8, padB=rotateLabels?38:20, padT=8;
  const innerW=w-padL-8, innerH=height-padT-padB;
  const max = (Math.max(...data.map(d=>d.value)) || 1) * 1.15;
  const gap = innerW/data.length, bw = Math.min(gap*0.56, 46);
  const svg = dashSvgEl('svg', {width:w, height, viewBox:`0 0 ${w} ${height}`});
  for(let i=0;i<=3;i++){ const y=padT+innerH-i/3*innerH; svg.appendChild(dashSvgEl('line',{x1:padL,x2:w,y1:y,y2:y,stroke:dashCss('--line'),'stroke-width':1})); }
  data.forEach((d,i)=>{
    const x=padL+gap*i+(gap-bw)/2, h=(d.value/max)*innerH, y=padT+innerH-h;
    const bar = dashSvgEl('rect', {x, y, width:bw, height:Math.max(h,0), rx:4, fill:dashCss(d.tok||'--blue')});
    bar.addEventListener('mouseenter', e=>dashShowTip(e, `<b>${dashFmtValor(d.value,unit)}</b> · ${d.label}`));
    bar.addEventListener('mousemove', dashMoveTip); bar.addEventListener('mouseleave', dashHideTip);
    svg.appendChild(bar);
    const t = dashSvgEl('text', {x:x+bw/2, y:height-(rotateLabels?24:6), 'text-anchor':rotateLabels?'end':'middle', style:`font-size:10.5px;fill:${dashCss('--muted')}`, transform: rotateLabels?`rotate(-28 ${x+bw/2} ${height-24})`:''});
    t.textContent = d.label; svg.appendChild(t);
  });
  container.appendChild(svg);
}

function dashStackedBar(container, {labels, series, height=180}){
  container.innerHTML = '';
  if(!labels.length){ container.innerHTML = '<div class="dash-empty">Sem dados no período.</div>'; return; }
  const w = container.clientWidth || 300, padL=8, padB=20, padT=8;
  const innerW=w-padL-8, innerH=height-padT-padB;
  const totals = labels.map((_,i)=>series.reduce((s,ser)=>s+ser.data[i],0));
  const max = (Math.max(...totals) || 1) * 1.15;
  const gap = innerW/labels.length, bw = Math.min(gap*0.56, 46);
  const svg = dashSvgEl('svg', {width:w, height, viewBox:`0 0 ${w} ${height}`});
  for(let i=0;i<=3;i++){ const y=padT+innerH-i/3*innerH; svg.appendChild(dashSvgEl('line',{x1:padL,x2:w,y1:y,y2:y,stroke:dashCss('--line'),'stroke-width':1})); }
  labels.forEach((l,i)=>{
    let acc=0; const x=padL+gap*i+(gap-bw)/2;
    series.forEach(ser=>{
      const v=ser.data[i], h=(v/max)*innerH;
      const yTop = padT+innerH-(acc+v)*(innerH/max);
      const rect = dashSvgEl('rect', {x, y:yTop, width:bw, height:Math.max(h,0), fill:dashCss(ser.tok)});
      rect.addEventListener('mouseenter', e=>dashShowTip(e, `<b>${fmtMoeda(v)}</b> · ${ser.label}<br>${l}`));
      rect.addEventListener('mousemove', dashMoveTip); rect.addEventListener('mouseleave', dashHideTip);
      svg.appendChild(rect);
      acc += v;
    });
    const t = dashSvgEl('text', {x:x+bw/2, y:height-6, 'text-anchor':'middle', style:`font-size:10.5px;fill:${dashCss('--muted')}`}); t.textContent = l; svg.appendChild(t);
  });
  container.appendChild(svg);
}

function dashDonut(container, data, {size=140, thickness=18}={}){
  container.innerHTML = '';
  const total = data.reduce((s,d)=>s+d.value,0);
  if(total===0){ container.innerHTML = '<div class="dash-empty">Sem dados no período.</div>'; return; }
  const r=size/2, ir=r-thickness, cx=r, cy=r;
  const svg = dashSvgEl('svg', {width:size, height:size, viewBox:`0 0 ${size} ${size}`});
  let ang = -Math.PI/2;
  data.forEach(d=>{
    const frac=d.value/total, a1=ang, a2=ang+frac*Math.PI*2;
    ang = a2;
    const large = a2-a1>Math.PI ? 1 : 0;
    const x1=cx+r*Math.cos(a1), y1=cy+r*Math.sin(a1), x2=cx+r*Math.cos(a2), y2=cy+r*Math.sin(a2);
    const xi1=cx+ir*Math.cos(a2), yi1=cy+ir*Math.sin(a2), xi2=cx+ir*Math.cos(a1), yi2=cy+ir*Math.sin(a1);
    const dd = `M${x1},${y1} A${r},${r} 0 ${large} 1 ${x2},${y2} L${xi1},${yi1} A${ir},${ir} 0 ${large} 0 ${xi2},${yi2} Z`;
    const path = dashSvgEl('path', {d:dd, fill:d.cor, stroke:dashCss('--panel'), 'stroke-width':2});
    path.addEventListener('mouseenter', e=>dashShowTip(e, `<b>${d.value}</b> · ${d.label} (${Math.round(frac*100)}%)`));
    path.addEventListener('mousemove', dashMoveTip); path.addEventListener('mouseleave', dashHideTip);
    svg.appendChild(path);
  });
  const t1 = dashSvgEl('text', {x:cx, y:cy-2, 'text-anchor':'middle', style:`font-weight:800;font-size:18px;fill:${dashCss('--text')}`}); t1.textContent = total;
  const t2 = dashSvgEl('text', {x:cx, y:cy+15, 'text-anchor':'middle', style:`font-size:10px;fill:${dashCss('--muted')}`}); t2.textContent = 'total';
  svg.appendChild(t1); svg.appendChild(t2);
  container.appendChild(svg);
}

function dashRanking(container, data){
  container.innerHTML = '';
  if(!data.length){ container.innerHTML = '<div class="dash-empty">Sem atendentes com movimento no período.</div>'; return; }
  const max = Math.max(...data.map(d=>d.valor)) || 1;
  data.forEach(d=>{
    const row = document.createElement('div'); row.className = 'dash-rank-row';
    row.innerHTML = `<div class="name">${escaparHtml(d.label)}</div><div class="track"><div class="fill" style="width:${(d.valor/max*100).toFixed(1)}%"></div></div><div class="val">${fmtMoeda(d.valor)} · ${d.concluidos}✓</div>`;
    container.appendChild(row);
  });
}

function dashLineChart(container, {labels, series, height=180}){
  container.innerHTML = '';
  if(!labels.length){ container.innerHTML = '<div class="dash-empty">Sem dados no período.</div>'; return; }
  const w = container.clientWidth || 300, padL=22, padB=20, padT=8, padR=22;
  const innerW=w-padL-padR, innerH=height-padT-padB;
  const allVals = series.flatMap(s=>s.data);
  const max = (Math.max(...allVals, 0)) * 1.15 || 1;
  const svg = dashSvgEl('svg', {width:w, height, viewBox:`0 0 ${w} ${height}`});
  for(let i=0;i<=3;i++){ const y=padT+innerH-i/3*innerH; svg.appendChild(dashSvgEl('line',{x1:padL,x2:w-padR,y1:y,y2:y,stroke:dashCss('--line'),'stroke-width':1})); }
  const xs = labels.length>1 ? labels.map((_,i)=>padL+i/(labels.length-1)*innerW) : [padL+innerW/2];
  labels.forEach((l,i)=>{ const t=dashSvgEl('text',{x:xs[i],y:height-4,'text-anchor':'middle',style:`font-size:10px;fill:${dashCss('--muted')}`}); t.textContent=l; svg.appendChild(t); });
  const dots = [];
  series.forEach(s=>{
    const ys = s.data.map(v=>padT+innerH-(v/max)*innerH);
    if(labels.length>1){
      const d = xs.map((x,i)=>(i?'L':'M')+x.toFixed(1)+','+ys[i].toFixed(1)).join(' ');
      svg.appendChild(dashSvgEl('path', {d, fill:'none', stroke:dashCss(s.tok), 'stroke-width':2, 'stroke-linecap':'round', 'stroke-linejoin':'round'}));
    }
    xs.forEach((x,i)=>dots.push({x, y:ys[i], v:s.data[i], label:s.label, tok:s.tok, mes:labels[i]}));
  });
  dots.forEach(pt=>{
    svg.appendChild(dashSvgEl('circle', {cx:pt.x, cy:pt.y, r:2.8, fill:dashCss(pt.tok)}));
    const c = dashSvgEl('circle', {cx:pt.x, cy:pt.y, r:9, fill:'transparent'});
    c.addEventListener('mouseenter', e=>dashShowTip(e, `<b>${pt.v}</b> · ${pt.label}<br>${pt.mes}`));
    c.addEventListener('mousemove', dashMoveTip); c.addEventListener('mouseleave', dashHideTip);
    svg.appendChild(c);
  });
  container.appendChild(svg);
}

function dashMatrixHeatmap(container, rows, cols, m){
  container.innerHTML = '';
  if(!rows.length || !cols.length){ container.innerHTML = '<div class="dash-empty">Sem dados no período.</div>'; return; }
  const cell=40, gap=3, padL=Math.min(120, Math.max(70, Math.max(...rows.map(r=>r.length))*6+24)), padT=50;
  const padRLabel = Math.max(...cols.map(c=>c.length))*5; // espaço extra pro rótulo rotacionado da última coluna não cortar
  const w = padL+cols.length*(cell+gap)+padRLabel, h = padT+rows.length*(cell+gap);
  const svg = dashSvgEl('svg', {width:w, height:h, viewBox:`0 0 ${w} ${h}`});
  const max = Math.max(...m.flat(), 1);
  cols.forEach((c,j)=>{
    const x=padL+j*(cell+gap)+cell/2, y=padT-8;
    const t = dashSvgEl('text', {x, y, 'text-anchor':'start', style:`font-size:10.5px;fill:${dashCss('--muted')}`, transform:`rotate(-32 ${x} ${y})`}); t.textContent=c; svg.appendChild(t);
  });
  rows.forEach((rLabel,i)=>{
    const t = dashSvgEl('text', {x:0, y:padT+i*(cell+gap)+cell/2+4, style:`font-size:10.5px;fill:${dashCss('--muted')}`}); t.textContent=rLabel; svg.appendChild(t);
    cols.forEach((c,j)=>{
      const v=m[i][j], x=padL+j*(cell+gap), y=padT+i*(cell+gap);
      const frac=v/max;
      const rect = dashSvgEl('rect', {x, y, width:cell, height:cell, rx:6, fill:`color-mix(in srgb, ${dashCss('--blue')} ${Math.round(10+frac*85)}%, ${dashCss('--panel-2')})`});
      rect.addEventListener('mouseenter', e=>dashShowTip(e, `<b>${v}</b> atendimentos<br>${rLabel} · ${c}`));
      rect.addEventListener('mousemove', dashMoveTip); rect.addEventListener('mouseleave', dashHideTip);
      svg.appendChild(rect);
      const lbl = dashSvgEl('text', {x:x+cell/2, y:y+cell/2+4, 'text-anchor':'middle', style:`font-size:11px;font-weight:700;fill:${frac>.55?dashCss('--panel'):dashCss('--text')}`}); lbl.textContent=v;
      svg.appendChild(lbl);
    });
  });
  container.appendChild(svg);
}

/* ---------- aba Visão Geral ---------- */
function renderDashboardGeral(){
  const { itens } = calcularItensDashboard();
  const conta = contaAtual();
  const isAdmin = ehAdminEfetivo(conta);
  const isAtendente = conta && conta.perfil === 'ATENDENTE';
  const verValoresReal = isAdmin || (conta && conta.perfil === 'USUARIO' && conta.adminCliente);
  const verValorAtendente = isAdmin || isAtendente;

  const validados = itens.filter(r=>statusSlug(r.status)==='VALIDADO').length;
  const abertos = itens.filter(r=>!dashEhTerminal(r.status)).length;
  const boxesExtra = [
    verValoresReal ? `<div class="box"><div class="k">Faturado (Total Real)</div><div class="v" style="color:var(--accent)">${fmtMoeda(itens.reduce((s,r)=>s+(Number(r.totalReal)||0),0))}</div></div>` : '',
    verValorAtendente ? `<div class="box"><div class="k">Total Atendente</div><div class="v"${verValoresReal?'':' style="color:var(--accent)"'}>${fmtMoeda(itens.reduce((s,r)=>s+(Number(r.totalAnanda)||0)+(Number(r.totalAnanda2)||0),0))}</div></div>` : '',
  ].join('');
  document.getElementById('dashBoxesGeral').innerHTML = `
    <div class="box"><div class="k">Atendimentos no período</div><div class="v">${itens.length}</div></div>
    <div class="box"><div class="k">Validados</div><div class="v">${validados}${itens.length ? ' · '+Math.round(validados/itens.length*100)+'%' : ''}</div></div>
    <div class="box"><div class="k">Em aberto</div><div class="v">${abertos}</div></div>
    ${boxesExtra}`;

  const meses = [...new Set(itens.map(r=>r.mes))].sort((a,b)=>{
    const [ma,ya]=a.split('/'); const [mb,yb]=b.split('/');
    return (ya+ma).localeCompare(yb+mb);
  });
  dashLineChart(document.getElementById('dashGraficoMeses'), {
    labels: meses,
    series: [
      { label:'Total', tok:'--blue', data: meses.map(m=>itens.filter(r=>r.mes===m).length) },
      { label:'Validados', tok:'--ok', data: meses.map(m=>itens.filter(r=>r.mes===m && statusSlug(r.status)==='VALIDADO').length) },
    ],
  });
  document.getElementById('dashLegendaMeses').innerHTML = dashLegendHtml([{label:'Total',cor:'var(--blue)'},{label:'Validados',cor:'var(--ok)'}]);

  const statusCount = {};
  statusList.forEach(s=>statusCount[s.nome]=0);
  itens.forEach(r=>{ statusCount[r.status] = (statusCount[r.status]||0)+1; });
  const statusData = Object.entries(statusCount).filter(([,v])=>v>0).map(([label,value])=>({label, value, cor:corStatusDot(label)}));
  dashDonut(document.getElementById('dashDonutStatus'), statusData);
  document.getElementById('dashLegendaStatus').innerHTML = dashLegendHtml(statusData);

  const porCliente = {};
  itens.forEach(r=>{ porCliente[r.cliente] = (porCliente[r.cliente]||0)+1; });
  const listaClientes = Object.entries(porCliente).sort((a,b)=>b[1]-a[1]);
  const coresClientes = ['--blue','--ok','--purple','--bad','--yellow'];
  const topClientes = listaClientes.slice(0,5).map(([label,value],i)=>({label, value, tok:coresClientes[i%coresClientes.length]}));
  const outrosClientes = listaClientes.slice(5).reduce((s,[,v])=>s+v,0);
  if(outrosClientes>0) topClientes.push({label:'Outros clientes', value:outrosClientes, tok:'--yellow'});
  dashBarChart(document.getElementById('dashTopClientes'), {data:topClientes, horizontal:true});

  const cardRank = document.getElementById('dashCardRankingAtendentes');
  if(verValorAtendente){
    cardRank.style.display = '';
    const nomesAtendentes = contas.filter(c=>c.perfil==='ATENDENTE').map(a=>a.nome);
    const ranking = nomesAtendentes.map(nome=>{
      const seus = itens.filter(r=>r.atendente===nome || r.atendente2===nome);
      return {
        label: nome,
        valor: seus.reduce((s,r)=>s+ganhoAtendente(r,nome).valor,0),
        concluidos: seus.filter(r=>statusSlug(r.status)==='VALIDADO').length,
      };
    }).filter(d=>d.valor>0 || d.concluidos>0).sort((a,b)=>b.valor-a.valor);
    dashRanking(document.getElementById('dashRankingAtendentes'), ranking);
  }else{
    cardRank.style.display = 'none';
  }
}

/* ---------- aba Operacional ---------- */
function renderDashboardOperacional(){
  const { itens } = calcularItensDashboard();
  const conta = contaAtual();
  const isAdmin = ehAdminEfetivo(conta);
  const isAtendente = conta && conta.perfil === 'ATENDENTE';
  const verValoresReal = isAdmin || (conta && conta.perfil === 'USUARIO' && conta.adminCliente);
  const verValorAtendente = isAdmin || isAtendente;

  const abertosItens = itens.filter(r=>!dashEhTerminal(r.status));
  const atrasadosItens = abertosItens.filter(dashEstaAtrasado);

  let boxesValor = '';
  if(verValoresReal){
    boxesValor = `
      <div class="box"><div class="k">Valor em aberto</div><div class="v" style="color:var(--accent)">${fmtMoeda(abertosItens.reduce((s,r)=>s+(Number(r.totalReal)||0),0))}</div></div>
      <div class="box"><div class="k">Valor atrasado</div><div class="v" style="color:var(--bad)">${fmtMoeda(atrasadosItens.reduce((s,r)=>s+(Number(r.totalReal)||0),0))}</div></div>`;
  }else if(verValorAtendente){
    boxesValor = `
      <div class="box"><div class="k">Valor Atendente em aberto</div><div class="v" style="color:var(--accent)">${fmtMoeda(abertosItens.reduce((s,r)=>s+(Number(r.totalAnanda)||0)+(Number(r.totalAnanda2)||0),0))}</div></div>
      <div class="box"><div class="k">Valor Atendente atrasado</div><div class="v" style="color:var(--bad)">${fmtMoeda(atrasadosItens.reduce((s,r)=>s+(Number(r.totalAnanda)||0)+(Number(r.totalAnanda2)||0),0))}</div></div>`;
  }
  document.getElementById('dashBoxesOperacional').innerHTML = `
    <div class="box"><div class="k">Em aberto</div><div class="v">${abertosItens.length}</div></div>
    <div class="box"><div class="k">Atrasados</div><div class="v"${atrasadosItens.length?' style="color:var(--bad)"':''}>${atrasadosItens.length}</div></div>
    ${boxesValor}`;

  const buckets = [
    { label:'0–2 dias', min:0, max:2, tok:'--ok' },
    { label:'3–5 dias', min:3, max:5, tok:'--warn' },
    { label:'6–10 dias', min:6, max:10, tok:'--yellow' },
    { label:'+10 dias', min:11, max:Infinity, tok:'--bad' },
  ].map(b=>({ label:b.label, tok:b.tok, value: abertosItens.filter(r=>{ const d=dashDiasEmAberto(r); return d>=b.min && d<=b.max; }).length }));
  dashBarChart(document.getElementById('dashAging'), {data:buckets});

  const DIAS_SEMANA = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
  const porDia = new Array(7).fill(0);
  itens.forEach(r=>{ if(r.data) porDia[new Date(r.data+'T00:00:00').getDay()]++; });
  dashBarChart(document.getElementById('dashDiaSemana'), {data: DIAS_SEMANA.map((label,i)=>({label, value:porDia[i], tok:'--blue'}))});

  const pendentesOrdenados = abertosItens.slice().sort((a,b)=>dashDiasEmAberto(b)-dashDiasEmAberto(a)).slice(0,8);
  const mostrarValor = verValoresReal || verValorAtendente;
  const colValor = r=>{
    if(verValoresReal) return `<td>${fmtMoeda(Number(r.totalReal)||0)}</td>`;
    if(verValorAtendente) return `<td>${fmtMoeda((Number(r.totalAnanda)||0)+(Number(r.totalAnanda2)||0))}</td>`;
    return '';
  };
  const linhas = pendentesOrdenados.map(r=>{
    const dias = dashDiasEmAberto(r);
    const tagCor = dias>10 ? '--bad' : dias>5 ? '--warn' : '--ok';
    return `<tr><td>${escaparHtml(r.cliente)}</td><td>${escaparHtml(labelTipo(r.tipo))}</td><td>${escaparHtml(r.atendente||'—')}</td><td><span class="tag" style="background:var(${tagCor});color:#fff;">${dias}d</span></td>${colValor(r)}</tr>`;
  }).join('');
  document.getElementById('dashTabelaPendentes').innerHTML = pendentesOrdenados.length
    ? `<tr><th>Cliente</th><th>Tipo</th><th>Atendente</th><th>Dias</th>${mostrarValor?'<th>Valor</th>':''}</tr>${linhas}`
    : `<tr><td class="dash-empty">Nenhum atendimento em aberto no período.</td></tr>`;
}

/* ---------- aba Comparativo ---------- */
function renderDashboardComparativo(){
  const { itens } = calcularItensDashboard();
  const conta = contaAtual();
  const isAdmin = ehAdminEfetivo(conta);
  const isAtendente = conta && conta.perfil === 'ATENDENTE';
  const verValoresReal = isAdmin || (conta && conta.perfil === 'USUARIO' && conta.adminCliente);
  const verValorAtendente = isAdmin || isAtendente;
  const unidadeTipo = (verValoresReal || verValorAtendente) ? 'R$' : '';

  const porTipo = {};
  itens.forEach(r=>{
    if(!(r.tipo in porTipo)) porTipo[r.tipo] = 0;
    if(verValoresReal) porTipo[r.tipo] += Number(r.totalReal)||0;
    else if(verValorAtendente) porTipo[r.tipo] += (Number(r.totalAnanda)||0)+(Number(r.totalAnanda2)||0);
    else porTipo[r.tipo] += 1;
  });
  document.getElementById('dashTituloPorTipo').textContent = verValoresReal ? 'Faturado por tipo de atendimento' : verValorAtendente ? 'Valor Atendente por tipo de atendimento' : 'Atendimentos por tipo';
  const coresTipo = ['--purple','--blue','--ok','--yellow','--bad'];
  const dadosTipo = Object.entries(porTipo).filter(([,v])=>v>0).sort((a,b)=>b[1]-a[1])
    .map(([label,value],i)=>({label:labelTipo(label), value, tok:coresTipo[i%coresTipo.length]}));
  dashBarChart(document.getElementById('dashPorTipo'), {data:dadosTipo, rotateLabels:true, height:200, unit:unidadeTipo});

  const cardHoras = document.getElementById('dashCardHorasAtendente');
  if(verValorAtendente){
    cardHoras.style.display = '';
    const nomesAtendentes = contas.filter(c=>c.perfil==='ATENDENTE').map(a=>a.nome);
    const horasData = nomesAtendentes.map(nome=>({
      label: nome,
      value: itens.reduce((s,r)=>s+ganhoAtendente(r,nome).horas,0),
      tok: '--blue',
    })).filter(d=>d.value>0).sort((a,b)=>a.value-b.value);
    dashBarChart(document.getElementById('dashHorasAtendente'), {data:horasData, unit:'h', rotateLabels:true, height:200});
  }else{
    cardHoras.style.display = 'none';
  }

  const clientesUsados = [...new Set(itens.map(r=>r.cliente))];
  const tiposUsados = [...new Set(itens.map(r=>r.tipo))];
  const topClientesMatriz = clientesUsados
    .map(c=>({c, n:itens.filter(r=>r.cliente===c).length}))
    .sort((a,b)=>b.n-a.n).slice(0,8).map(x=>x.c);
  const matriz = topClientesMatriz.map(c=>tiposUsados.map(t=>itens.filter(r=>r.cliente===c && r.tipo===t).length));
  dashMatrixHeatmap(document.getElementById('dashMatrizClienteTipo'), topClientesMatriz, tiposUsados.map(labelTipo), matriz);

  const cardFat = document.getElementById('dashCardFaturadoCliente');
  if(verValoresReal){
    cardFat.style.display = '';
    const meses = [...new Set(itens.map(r=>r.mes))].sort((a,b)=>{
      const [ma,ya]=a.split('/'); const [mb,yb]=b.split('/');
      return (ya+ma).localeCompare(yb+mb);
    });
    const totalPorCliente = {};
    itens.forEach(r=>{ totalPorCliente[r.cliente] = (totalPorCliente[r.cliente]||0)+(Number(r.totalReal)||0); });
    const topN = Object.entries(totalPorCliente).sort((a,b)=>b[1]-a[1]).slice(0,4).map(([c])=>c);
    const cores = ['--blue','--ok','--purple','--bad'];
    const series = topN.map((c,i)=>({
      label: c, tok: cores[i%cores.length],
      data: meses.map(m=>itens.filter(r=>r.cliente===c && r.mes===m).reduce((s,r)=>s+(Number(r.totalReal)||0),0)),
    }));
    const outrosData = meses.map(m=>itens.filter(r=>r.mes===m && !topN.includes(r.cliente)).reduce((s,r)=>s+(Number(r.totalReal)||0),0));
    if(outrosData.some(v=>v>0)) series.push({label:'Outros', tok:'--yellow', data:outrosData});
    dashStackedBar(document.getElementById('dashFaturadoCliente'), {labels:meses, series});
    document.getElementById('dashLegendaFaturado').innerHTML = dashLegendHtml(series.map(s=>({label:s.label, cor:`var(${s.tok})`})));
  }else{
    cardFat.style.display = 'none';
  }
}

/* ---------- cronograma (Gantt) ---------- */
function renderFiltrosGantt(){
  const conta = contaAtual();
  const isUsuario = conta && conta.perfil === 'USUARIO';

  // usuário só mantém o filtro de Status — cliente/tipo não fazem sentido
  // pra quem já só vê os próprios atendimentos (ou os do cliente inteiro)
  document.getElementById('ganttFiltroCliente').closest('.card').style.display = isUsuario ? 'none' : '';
  document.getElementById('ganttFiltroTipo').closest('.card').style.display = isUsuario ? 'none' : '';

  const elCliente = document.getElementById('ganttFiltroCliente');
  elCliente.innerHTML = `<div class="chip ${filtroGanttCliente.size===0?'on':''}" data-valor="TODOS">Todos</div>` +
    clientes.map(c=>`<div class="chip ${filtroGanttCliente.has(c.nome)?'on':''}" data-valor="${c.nome}">${c.nome}</div>`).join('');

  const elTipo = document.getElementById('ganttFiltroTipo');
  elTipo.innerHTML = `<div class="chip ${filtroGanttTipo.size===0?'on':''}" data-valor="TODOS">Todos</div>` +
    tipos.map(t=>`<div class="chip ${filtroGanttTipo.has(t.nome)?'on':''}" data-valor="${t.nome}">${labelTipo(t.nome)}</div>`).join('');

  const elStatus = document.getElementById('ganttFiltroStatus');
  elStatus.innerHTML = `<div class="chip ${filtroGanttStatus.size===0?'on':''}" data-valor="TODOS">Todos</div>` +
    statusList.map(s=>`<div class="chip ${filtroGanttStatus.has(s.nome)?'on':''}" data-valor="${s.nome}">${s.nome}</div>`).join('');
}

function toggleFiltroMultiplo(set, valor){
  if(valor === 'TODOS'){ set.clear(); return; }
  if(set.has(valor)) set.delete(valor); else set.add(valor);
}

// calcula o período e os itens filtrados — usado tanto pra desenhar o
// gráfico quanto pra exportar o CSV, garantindo que os dois batem sempre
function calcularItensGantt(){
  const conta = contaAtual();
  let de = document.getElementById('gantt_de').value;
  let ate = document.getElementById('gantt_ate').value;
  if(!de || !ate){
    const hoje = new Date();
    const primeiro = new Date(hoje.getFullYear(), hoje.getMonth(), 1);
    const ultimo = new Date(hoje.getFullYear(), hoje.getMonth()+1, 0);
    de = primeiro.toISOString().slice(0,10);
    ate = ultimo.toISOString().slice(0,10);
    document.getElementById('gantt_de').value = de;
    document.getElementById('gantt_ate').value = ate;
  }
  const dataInicio = new Date(de+'T00:00:00');
  const dataFim = new Date(ate+'T00:00:00');
  if(dataFim < dataInicio) return { itens: [], dataInicio, dataFim, de, ate, invalido: true };

  let itens = atendimentos.slice();
  if(conta && conta.perfil === 'ATENDENTE'){
    itens = itens.filter(r=>r.atendente === conta.nome);
  }
  if(filtroGanttCliente.size > 0) itens = itens.filter(r=>filtroGanttCliente.has(r.cliente));
  if(filtroGanttTipo.size > 0) itens = itens.filter(r=>filtroGanttTipo.has(r.tipo));
  if(filtroGanttStatus.size > 0) itens = itens.filter(r=>filtroGanttStatus.has(r.status));
  itens = itens.filter(r=>{
    if(!r.data) return false;
    const ini = new Date(r.data+'T00:00:00');
    const fim = new Date((r.dataPrevista || r.data)+'T00:00:00');
    return fim >= dataInicio && ini <= dataFim;
  });
  itens.sort((a,b)=> String(a.data).localeCompare(String(b.data)));
  return { itens, dataInicio, dataFim, de, ate, invalido: false };
}

function renderGantt(){
  const { itens, dataInicio, dataFim, invalido } = calcularItensGantt();
  if(invalido){ document.getElementById('ganttChart').innerHTML = `<div class="empty">O período "Até" precisa ser depois do "De".</div>`; return; }
  const totalDias = Math.max(1, Math.round((dataFim - dataInicio) / 86400000) + 1);

  const cont = document.getElementById('ganttChart');
  if(itens.length === 0){ cont.innerHTML = `<div class="empty"><div class="big">📊</div>Nenhum atendimento no período/filtros selecionados.</div>`; return; }

  const larguraDia = 100 / totalDias;
  let headerDias = '';
  for(let i=0;i<totalDias;i++){
    const d = new Date(dataInicio); d.setDate(d.getDate()+i);
    const mostrarNumero = totalDias <= 45 || d.getDate() === 1 || i === 0;
    headerDias += `<div class="gantt-day" style="width:${larguraDia}%;">${mostrarNumero ? d.getDate()+'/'+(d.getMonth()+1) : ''}</div>`;
  }

  const linhas = itens.map(r=>{
    const ini = new Date(r.data+'T00:00:00');
    const semPrevisao = !r.dataPrevista;
    const fim = new Date((r.dataPrevista || r.data)+'T00:00:00');
    const iniClamp = ini < dataInicio ? dataInicio : ini;
    const fimClamp = fim > dataFim ? dataFim : fim;
    const offsetDias = Math.round((iniClamp - dataInicio) / 86400000);
    const duracaoDias = Math.max(1, Math.round((fimClamp - iniClamp) / 86400000) + 1);
    const left = offsetDias * larguraDia;
    const width = duracaoDias * larguraDia;
    const label = `${r.usuario} | ${stripHtml(r.detalhe||'') || '(sem detalhe)'}`;
    const [y,m,d] = String(r.data).split('-');
    const tituloBarra = `${label} — início ${d}/${m}${r.dataPrevista ? ' · previsão '+String(r.dataPrevista).split('-').reverse().slice(0,2).join('/') : ' · sem previsão'} — ${r.status}`;
    return `<div class="gantt-row">
      <div class="gantt-label" title="${escaparHtml(label)}">${escaparHtml(label)}</div>
      <div class="gantt-track">
        <div class="gantt-bar status-${statusSlug(r.status)} ${semPrevisao?'gantt-bar-sem-previsao':''}" style="left:${left}%;width:${width}%;" title="${escaparHtml(tituloBarra)}" onclick="abrirDetalhe('${r.id}')"></div>
      </div>
    </div>`;
  }).join('');

  cont.innerHTML = `
    <div class="gantt-header"><div class="gantt-label-col"></div><div class="gantt-days">${headerDias}</div></div>
    ${linhas}
  `;
}

/* ---------- gerar PDF (usa o "Salvar como PDF" do próprio navegador) ---------- */
let html2pdfCarregado = null;
// carrega a lib só quando alguém realmente pede um PDF dentro do app —
// não faz sentido baixar isso pra quem acessa pelo navegador (usa window.print())
function carregarHtml2Pdf(){
  if(window.html2pdf) return Promise.resolve();
  if(html2pdfCarregado) return html2pdfCarregado;
  html2pdfCarregado = new Promise((resolve, reject)=>{
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/html2pdf.js@0.14.0/dist/html2pdf.bundle.min.js';
    script.onload = ()=> resolve();
    script.onerror = ()=> reject(new Error('Não foi possível carregar a biblioteca de PDF.'));
    document.head.appendChild(script);
  });
  return html2pdfCarregado;
}

// troca temporariamente a regra @media print pra "all" — assim reaproveita o
// mesmo CSS que já esconde sidebar/nav/outras telas na hora de imprimir, sem
// precisar duplicar aquele bloco de CSS só pra geração nativa de PDF
async function comEstiloDeImpressaoAtivo(fn){
  let regra = null;
  for(const sheet of document.styleSheets){
    let regras;
    try{ regras = sheet.cssRules; }catch(e){ continue; } // folha de outra origem — não dá pra inspecionar, ignora
    for(const r of regras){
      if(r.media && /\bprint\b/.test(r.media.mediaText)){ regra = r; break; }
    }
    if(regra) break;
  }
  if(!regra) return fn();
  const original = regra.media.mediaText;
  regra.media.mediaText = 'all';
  try{
    return await fn();
  } finally {
    regra.media.mediaText = original;
  }
}

function slugArquivo(texto){
  return String(texto||'').normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-zA-Z0-9]+/g,'-').replace(/^-+|-+$/g,'').toLowerCase() || 'documento';
}

// dentro do app Android (Capacitor) a WebView não tem window.print() — gera o
// PDF no próprio JS (html2pdf) e abre o menu de compartilhar nativo do Android
async function gerarPdfNativo(titulo){
  const plugins = window.Capacitor.Plugins || {};
  const { Filesystem, Share } = plugins;
  if(!Filesystem || !Share){
    toast('Gerar PDF não está disponível nessa versão do app — atualize o aplicativo.');
    document.body.classList.remove('print-modo-atendimento');
    return;
  }
  toast('Gerando PDF…');
  try{
    await carregarHtml2Pdf();
    const blob = await comEstiloDeImpressaoAtivo(()=>
      window.html2pdf().set({
        margin: 10,
        html2canvas: { scale: 2, useCORS: true },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
        pagebreak: { mode: ['css', 'legacy'] },
      }).from(document.body).outputPdf('blob')
    );
    const base64 = await lerArquivoBase64(blob);
    const nomeArquivo = `${slugArquivo(titulo)}.pdf`;
    const gravado = await Filesystem.writeFile({ path: nomeArquivo, data: base64, directory: 'CACHE' });
    await Share.share({ title: titulo, dialogTitle: 'Compartilhar PDF', files: [gravado.uri] });
  }catch(err){
    toast(err && err.message ? err.message : 'Não foi possível gerar o PDF.');
  } finally {
    document.body.classList.remove('print-modo-atendimento'); // sem window.print(), o afterprint que tiraria essa classe nunca dispara
  }
}

// substitui o XLSX.writeFile(livro, nome) direto — mesmo problema do PDF: a
// WebView do app Android não salva um blob: sozinha, então a mensagem de
// sucesso aparecia mas nenhum arquivo era gerado de verdade. Fora do app,
// continua exatamente igual (baixa o arquivo pelo navegador).
async function salvarWorkbook(livro, nomeArquivo){
  if(!emAppNativo()){
    XLSX.writeFile(livro, nomeArquivo);
    return;
  }
  const plugins = window.Capacitor.Plugins || {};
  const { Filesystem, Share } = plugins;
  if(!Filesystem || !Share){
    toast('Gerar planilha não está disponível nessa versão do app — atualize o aplicativo.');
    return;
  }
  const arrayBuffer = XLSX.write(livro, { type: 'array', bookType: 'xlsx' });
  const blob = new Blob([arrayBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const base64 = await lerArquivoBase64(blob);
  const gravado = await Filesystem.writeFile({ path: nomeArquivo, data: base64, directory: 'CACHE' });
  await Share.share({ title: nomeArquivo, dialogTitle: 'Compartilhar planilha', files: [gravado.uri] });
}

function prepararImpressao(titulo, filtrosTexto){
  const agora = new Date();
  const dataHora = agora.toLocaleDateString('pt-BR') + ' às ' + agora.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
  const logo = empresaAtual && empresaAtual.logoUrl ? `<img class="print-logo" src="${empresaAtual.logoUrl}">` : '';
  document.getElementById('printHeader').innerHTML = `
    <div class="print-topo">
      ${logo}
      <div>
        <div class="print-empresa">${escaparHtml(empresaAtual ? empresaAtual.nome : '')}</div>
        <h1>${escaparHtml(titulo)}</h1>
        ${filtrosTexto ? `<div class="print-filtros">${escaparHtml(filtrosTexto)}</div>` : ''}
        <div class="print-data">Gerado em ${dataHora}</div>
      </div>
    </div>
  `;
  if(emAppNativo()){ gerarPdfNativo(titulo); return; }
  window.print();
}

function gerarPdfResumo(){
  const conta = contaAtual();
  const mesTexto = document.getElementById('r_mes').selectedOptions[0]?.textContent || '';
  const partes = [`Mês: ${mesTexto}`];
  if(ehAdminEfetivo(conta) && filtroResumoAtendente !== 'TODOS') partes.push(`Atendente: ${filtroResumoAtendente}`);
  if((conta && (conta.perfil === 'ADMIN' || conta.perfil === 'ATENDENTE')) && filtroResumoCliente.size > 0) partes.push(`Cliente: ${[...filtroResumoCliente].join(', ')}`);
  prepararImpressao('Resumo de Atendimentos', partes.join(' · '));
}

function gerarPdfLista(){
  const partes = [];
  if(filtroCliente.size > 0) partes.push(`Cliente: ${[...filtroCliente].join(', ')}`);
  if(filtroStatus.size > 0) partes.push(`Status: ${[...filtroStatus].join(', ')}`);
  const de = document.getElementById('periodo_de').value;
  const ate = document.getElementById('periodo_ate').value;
  if(de || ate) partes.push(`Período: ${de || '(início)'} a ${ate || '(hoje)'}`);
  prepararImpressao('Lista de Atendimentos', partes.join(' · '));
}

function gerarPdfGantt(){
  const { de, ate } = calcularItensGantt();
  const partes = [`Período: ${de} a ${ate}`];
  if(filtroGanttCliente.size > 0) partes.push(`Cliente: ${[...filtroGanttCliente].join(', ')}`);
  if(filtroGanttTipo.size > 0) partes.push(`Tipo: ${[...filtroGanttTipo].map(labelTipo).join(', ')}`);
  if(filtroGanttStatus.size > 0) partes.push(`Status: ${[...filtroGanttStatus].join(', ')}`);
  prepararImpressao('Cronograma', partes.join(' · '));
}

function gerarPdfAtendimento(){
  const r = atendimentos.find(x=>String(x.id)===String(chatAtendimentoId));
  const titulo = r ? `Atendimento — ${r.cliente} · ${r.usuario}` : 'Atendimento';
  document.body.classList.add('print-modo-atendimento');
  window.addEventListener('afterprint', ()=>{ document.body.classList.remove('print-modo-atendimento'); }, { once: true });
  prepararImpressao(titulo, '');
}

function renderRelatorioFiltros(){
  document.getElementById('relFiltroCliente').innerHTML = `<div class="chip ${relFiltroCliente.size===0?'on':''}" data-valor="TODOS">Todos</div>` +
    clientes.map(c=>`<div class="chip ${relFiltroCliente.has(c.nome)?'on':''}" data-valor="${c.nome}">${c.nome}</div>`).join('');
  document.getElementById('relFiltroTipo').innerHTML = `<div class="chip ${relFiltroTipo.size===0?'on':''}" data-valor="TODOS">Todos</div>` +
    tipos.map(t=>`<div class="chip ${relFiltroTipo.has(t.nome)?'on':''}" data-valor="${t.nome}">${labelTipo(t.nome)}</div>`).join('');
  document.getElementById('relFiltroStatus').innerHTML = `<div class="chip ${relFiltroStatus.size===0?'on':''}" data-valor="TODOS">Todos</div>` +
    statusList.map(s=>`<div class="chip ${relFiltroStatus.has(s.nome)?'on':''}" data-valor="${s.nome}">${s.nome}</div>`).join('');
}

// lista reordenável (as que já estão escolhidas) + lista de disponíveis pra adicionar
function renderRelatorioColunas(){
  const cont = document.getElementById('relatorioColunasOrdem');
  if(relColunas.length === 0){
    cont.innerHTML = `<div class="empty" style="padding:10px 0;font-size:12px;">Nenhuma coluna escolhida ainda.</div>`;
  }else{
    cont.innerHTML = relColunas.map((key,i)=>{
      const c = colunaInfo(key);
      if(!c) return '';
      return `<div class="rel-coluna-ordem">
        <span class="rel-coluna-nome">${escaparHtml(c.label)}</span>
        <button type="button" data-acao="up" data-key="${key}" ${i===0?'disabled':''} title="Mover pra cima">↑</button>
        <button type="button" data-acao="down" data-key="${key}" ${i===relColunas.length-1?'disabled':''} title="Mover pra baixo">↓</button>
        <button type="button" data-acao="remover" data-key="${key}" title="Remover">✕</button>
      </div>`;
    }).join('');
  }

  const disponiveis = COLUNAS_RELATORIO.filter(c=>!relColunas.includes(c.key));
  document.getElementById('relatorioColunasDisponiveis').innerHTML = disponiveis.length === 0
    ? `<div class="empty" style="padding:6px 0;font-size:11.5px;grid-column:1/-1;">Todas as colunas já foram adicionadas.</div>`
    : disponiveis.map(c=>`
      <label style="display:flex;align-items:center;gap:6px;font-size:12px;padding:4px 0;cursor:pointer;">
        <input type="checkbox" class="rel-coluna-add" data-key="${c.key}">
        ${escaparHtml(c.label)}
      </label>`).join('');
}

function moverColunaRelatorio(key, direcao){
  const i = relColunas.indexOf(key);
  if(i === -1) return;
  const j = direcao === 'up' ? i-1 : i+1;
  if(j < 0 || j >= relColunas.length) return;
  [relColunas[i], relColunas[j]] = [relColunas[j], relColunas[i]];
  renderRelatorioColunas();
  renderRelatorioPreview();
}

function calcularItensRelatorio(){
  let itens = atendimentos.slice();
  if(relFiltroCliente.size > 0) itens = itens.filter(r=>relFiltroCliente.has(r.cliente));
  if(relFiltroTipo.size > 0) itens = itens.filter(r=>relFiltroTipo.has(r.tipo));
  if(relFiltroStatus.size > 0) itens = itens.filter(r=>relFiltroStatus.has(r.status));
  const de = document.getElementById('rel_de').value;
  const ate = document.getElementById('rel_ate').value;
  if(de) itens = itens.filter(r=>String(r.data) >= de);
  if(ate) itens = itens.filter(r=>String(r.data) <= ate);
  itens.sort((a,b)=> String(a.data).localeCompare(String(b.data)));
  return itens;
}

function totalizarColunas(colunasNumericas, itensGrupo){
  return colunasNumericas.map(c=>{
    const soma = itensGrupo.reduce((s,r)=>s+c.valorBruto(r), 0);
    return `${c.label}: ${c.ehHoras ? soma.toFixed(2).replace('.',',')+'h' : fmtMoeda(soma)}`;
  }).join(' · ');
}

// em qual tela estamos gerando/pré-visualizando agora — o construtor
// (admin) ou a tela de consumo de relatórios publicados (todo mundo)
function relContainerAtivo(){
  return document.getElementById('view-relatoriospub').classList.contains('active') ? 'relatorioPubPreview' : 'relatorioPreview';
}

function renderFichaRelatorio(itens, cont){
  if(itens.length === 0){ cont.innerHTML = `<div class="empty">Nenhum atendimento encontrado com esses filtros.</div>`; return; }
  cont.innerHTML = itens.map(r=>{
    const [y,m,d] = String(r.data).split('-');
    return `<div class="rel-ficha-item">
      <h3>${escaparHtml(r.cliente)} · ${escaparHtml(r.usuario)}</h3>
      <div class="rel-ficha-sub">${d}/${m}/${y} · Atendente: ${escaparHtml(r.atendente||'(a definir)')} · ${escaparHtml(r.status)}</div>
      <div class="rel-ficha-label">Detalhe</div>
      <div class="rel-content">${r.detalhe ? sanitizarHtml(r.detalhe) : '<span style="color:var(--muted);">(sem detalhe)</span>'}</div>
      <div class="rel-ficha-label">Solução</div>
      <div class="rel-content">${r.solucao ? sanitizarHtml(r.solucao) : '<span style="color:var(--muted);">(sem solução registrada)</span>'}</div>
    </div>`;
  }).join('');
}

function renderRelatorioPreview(){
  const itens = calcularItensRelatorio();
  const cont = document.getElementById(relContainerAtivo());

  if(relTipoVisualizacao === 'ficha'){
    renderFichaRelatorio(itens, cont);
    document.getElementById('btnExcelRelatorio').style.display = 'none';
    if(document.getElementById('btnExcelRelatorioPub')) document.getElementById('btnExcelRelatorioPub').style.display = 'none';
    return;
  }
  document.getElementById('btnExcelRelatorio').style.display = '';
  if(document.getElementById('btnExcelRelatorioPub')) document.getElementById('btnExcelRelatorioPub').style.display = '';

  const colunasAtivas = relColunas.map(colunaInfo).filter(Boolean);
  const colunasNumericas = colunasAtivas.filter(c=>c.numerica);

  if(colunasAtivas.length === 0){ cont.innerHTML = `<div class="empty">Marque ao menos uma coluna.</div>`; return; }
  if(itens.length === 0){ cont.innerHTML = `<div class="empty">Nenhum atendimento encontrado com esses filtros.</div>`; return; }

  const linhaHtml = r => `<tr>${colunasAtivas.map(c=>`<td>${escaparHtml(String(c.formatar(r)))}</td>`).join('')}</tr>`;

  let corpo;
  if(relAgrupar === 'nenhum'){
    corpo = itens.map(linhaHtml).join('');
  }else{
    const chaveDe = r => relAgrupar==='cliente' ? r.cliente : relAgrupar==='atendente' ? (r.atendente||'(a definir)') : r.status;
    const grupos = {};
    itens.forEach(r=>{ const k=chaveDe(r); (grupos[k]=grupos[k]||[]).push(r); });
    corpo = Object.entries(grupos).map(([nome, itensGrupo])=>{
      const subtotal = colunasNumericas.length > 0
        ? `<tr class="rel-subtotal"><td colspan="${colunasAtivas.length}">Subtotal — ${totalizarColunas(colunasNumericas, itensGrupo)}</td></tr>`
        : '';
      return `<tr class="rel-grupo"><td colspan="${colunasAtivas.length}">${escaparHtml(nome)} (${itensGrupo.length})</td></tr>${itensGrupo.map(linhaHtml).join('')}${subtotal}`;
    }).join('');
  }

  const totalGeral = colunasNumericas.length > 0
    ? `<tr class="rel-total"><td colspan="${colunasAtivas.length}">TOTAL GERAL — ${totalizarColunas(colunasNumericas, itens)}</td></tr>`
    : '';

  cont.innerHTML = `<table class="valores-table rel-tabela">
    <thead><tr>${colunasAtivas.map(c=>`<th>${escaparHtml(c.label)}</th>`).join('')}</tr></thead>
    <tbody>${corpo}${totalGeral}</tbody>
  </table>`;
}

// os dois modelos abaixo NUNCA mudam — são o ponto de partida original.
// "Detalhado" é um modelo novo que não mexe nos outros dois.
function aplicarPresetRelatorio(tipo){
  if(tipo === 'atendimentos'){
    relColunas = ['data','cliente','usuario','atendente','tipo','detalhe','horario','qtd','status'];
    relAgrupar = 'nenhum';
    relTipoVisualizacao = 'tabela';
    document.getElementById('rel_titulo').value = 'Relatório de Atendimentos';
  }else if(tipo === 'financeiro'){
    relColunas = ['cliente','atendente','qtd','totalReal','totalAnanda'];
    relAgrupar = 'cliente';
    relTipoVisualizacao = 'tabela';
    document.getElementById('rel_titulo').value = 'Relatório Financeiro';
  }else{
    relColunas = ['data','cliente','usuario','atendente','status'];
    relAgrupar = 'nenhum';
    relTipoVisualizacao = 'ficha';
    document.getElementById('rel_titulo').value = 'Relatório Detalhado';
  }
  document.getElementById('rel_agrupar').value = relAgrupar;
  renderRelatorioColunas();
  renderRelatorioPreview();
}

function tituloEFiltrosRelatorio(){
  const titulo = document.getElementById('rel_titulo').value.trim() || 'Relatório Personalizado';
  const partes = [];
  if(relFiltroCliente.size > 0) partes.push(`Cliente: ${[...relFiltroCliente].join(', ')}`);
  if(relFiltroTipo.size > 0) partes.push(`Tipo: ${[...relFiltroTipo].map(labelTipo).join(', ')}`);
  if(relFiltroStatus.size > 0) partes.push(`Status: ${[...relFiltroStatus].join(', ')}`);
  const de = document.getElementById('rel_de').value;
  const ate = document.getElementById('rel_ate').value;
  if(de || ate) partes.push(`Período: ${de || '(início)'} a ${ate || '(hoje)'}`);
  return { titulo, filtrosTexto: partes.join(' · ') };
}

function gerarPdfRelatorio(){
  renderRelatorioPreview();
  const { titulo, filtrosTexto } = tituloEFiltrosRelatorio();
  prepararImpressao(titulo, filtrosTexto);
}

async function gerarExcelRelatorio(){
  if(relTipoVisualizacao === 'ficha'){ toast('O modelo "Detalhado" não sai em Excel — use o PDF.'); return; }
  const itens = calcularItensRelatorio();
  const colunasAtivas = relColunas.map(colunaInfo).filter(Boolean);
  if(colunasAtivas.length === 0){ toast('Marque ao menos uma coluna.'); return; }
  if(itens.length === 0){ toast('Nada pra exportar com esses filtros.'); return; }
  if(typeof XLSX === 'undefined'){ toast('Não foi possível carregar o gerador de Excel. Confira sua internet.'); return; }

  const linhas = [colunasAtivas.map(c=>c.label)];
  if(relAgrupar === 'nenhum'){
    itens.forEach(r=>linhas.push(colunasAtivas.map(c=>c.formatar(r))));
  }else{
    const chaveDe = r => relAgrupar==='cliente' ? r.cliente : relAgrupar==='atendente' ? (r.atendente||'(a definir)') : r.status;
    const grupos = {};
    itens.forEach(r=>{ const k=chaveDe(r); (grupos[k]=grupos[k]||[]).push(r); });
    const colunasNumericas = colunasAtivas.filter(c=>c.numerica);
    Object.entries(grupos).forEach(([nome, itensGrupo])=>{
      linhas.push([`${nome} (${itensGrupo.length})`]);
      itensGrupo.forEach(r=>linhas.push(colunasAtivas.map(c=>c.formatar(r))));
      if(colunasNumericas.length > 0){
        linhas.push(['Subtotal', ...colunasNumericas.map(c=>{
          const soma = itensGrupo.reduce((s,r)=>s+c.valorBruto(r), 0);
          return c.ehHoras ? soma.toFixed(2).replace('.',',')+'h' : soma;
        })]);
      }
      linhas.push([]);
    });
  }

  const { titulo } = tituloEFiltrosRelatorio();
  const planilha = XLSX.utils.aoa_to_sheet(linhas);
  const livro = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(livro, planilha, 'Relatório');
  await salvarWorkbook(livro, `${titulo.replace(/[^a-zA-Z0-9 ]/g,'').trim() || 'relatorio'}.xlsx`);
  toast('Excel gerado');
}

/* ---------- Utilitários › eSocial › Evento 1200 (Remuneração) ----------
   Confronta o(s) XML(s) do evento 1200 com a planilha de Rubricas cadastrada
   e gera um Excel de conferência — tudo no navegador, sem passar pelo backend */
function renderUtilTomticketLista(){
  const el = document.getElementById('utilTomticketLista');
  if(tomticketErros.length === 0){ el.innerHTML = `<div class="empty">Nenhuma pendência — tudo importado certinho.</div>`; return; }
  el.innerHTML = tomticketErros.map(e=>{
    const dataHora = e.criadoEm ? new Date(e.criadoEm).toLocaleString('pt-BR') : '';
    return `
    <div class="cad-item">
      <div class="info"><b>Chamado ${escaparHtml(e.ticketId)}</b><span>${escaparHtml(e.motivo)}</span><span>${dataHora}</span></div>
      <div class="acts"><button class="danger" onclick="pedirConfirmacao('Remover essa pendência?','Isso só tira da lista — não cria o atendimento nem afeta o chamado no TomTicket.', ()=>removerTomticketErroUi('${e.id}'))">Remover</button></div>
    </div>`;
  }).join('');
}
async function removerTomticketErroUi(id){
  const conta = contaAtual();
  const r = await api('removerTomticketErro', { contaId: conta.id, id });
  if(!r.ok) return;
  await carregarTudo();
  renderUtilTomticketLista();
  toast('Removido');
}

function resetUtilitarios(){
  document.getElementById('utilCategorias').style.display = '';
  document.getElementById('utilEsocial').style.display = 'none';
  document.getElementById('utilTomticket').style.display = 'none';
  document.getElementById('utilTomticketBadge').innerHTML = tomticketErros.length > 0
    ? `<span class="tag" style="background:var(--bad);color:#fff;">${tomticketErros.length}</span>` : '';
  document.getElementById('utilEvento1200').style.display = 'none';
  document.getElementById('util1200_xmls').value = '';
  document.getElementById('util1200_rubricas').value = '';
  document.getElementById('util1200_status').textContent = '';
  document.getElementById('utilEvento1200Retorno').style.display = 'none';
  document.getElementById('util1200ret_xmls').value = '';
  document.getElementById('util1200ret_status').textContent = '';
  document.getElementById('utilXmlGenerico').style.display = 'none';
  document.getElementById('utilXmlGenerico_xmls').value = '';
  document.getElementById('utilXmlGenerico_status').textContent = '';
}

function textoTag(el, tag){
  if(!el) return '';
  const f = el.getElementsByTagName(tag)[0];
  return f ? (f.textContent||'').trim() : '';
}

// o código da rubrica pode vir com zeros à esquerda tanto no XML quanto na
// planilha (ou não, se o Excel converteu "0002" pra número 2) — gera as
// variações possíveis pra casar dos dois jeitos
function chavesRubrica(valor){
  const bruto = String(valor==null ? '' : valor).trim();
  const chaves = new Set([bruto]);
  const n = Number(bruto);
  if(bruto !== '' && !isNaN(n)){
    chaves.add(String(n));
    chaves.add(String(n).padStart(4,'0'));
  }
  return [...chaves];
}

function parseEvento1200Xml(xmlText, nomeArquivo){
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  if(doc.querySelector('parsererror')) throw new Error(`${nomeArquivo}: XML inválido ou corrompido.`);
  const evt = doc.getElementsByTagName('evtRemun')[0];
  if(!evt) throw new Error(`${nomeArquivo}: não parece ser um XML do evento 1200 (evtRemun não encontrado).`);
  const perApur = textoTag(evt.getElementsByTagName('ideEvento')[0], 'perApur');
  const nrInscEmpregador = textoTag(evt.getElementsByTagName('ideEmpregador')[0], 'nrInsc');
  const cpfTrab = textoTag(evt.getElementsByTagName('ideTrabalhador')[0], 'cpfTrab');

  const linhas = [];
  [...evt.getElementsByTagName('dmDev')].forEach(dmDev=>{
    const ideDmDev = textoTag(dmDev, 'ideDmDev');
    const codCateg = textoTag(dmDev, 'codCateg');
    [...dmDev.getElementsByTagName('ideEstabLot')].forEach(estabLot=>{
      const nrInscEstab = textoTag(estabLot, 'nrInsc');
      const codLotacao = textoTag(estabLot, 'codLotacao');
      [...estabLot.getElementsByTagName('remunPerApur')].forEach(remun=>{
        const matricula = textoTag(remun, 'matricula');
        [...remun.getElementsByTagName('itensRemun')].forEach(item=>{
          linhas.push({
            arquivo: nomeArquivo, cpfTrab, perApur, nrInscEmpregador,
            ideDmDev, codCateg, nrInscEstab, codLotacao, matricula,
            codRubr: textoTag(item, 'codRubr'),
            ideTabRubr: textoTag(item, 'ideTabRubr'),
            qtdRubr: textoTag(item, 'qtdRubr'),
            vrRubr: textoTag(item, 'vrRubr'),
            indApurIR: textoTag(item, 'indApurIR'),
          });
        });
      });
    });
  });
  if(linhas.length === 0) throw new Error(`${nomeArquivo}: nenhuma rubrica encontrada no XML.`);
  return linhas;
}

function normalizarCabecalho(s){
  return String(s||'').trim().toLowerCase().replace(/\s+/g,' ');
}

function lerRubricasXlsx(arrayBuffer){
  const wb = XLSX.read(arrayBuffer, { type: 'array' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const linhas = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  if(linhas.length < 2) throw new Error('Planilha de Rubricas vazia ou sem dados.');
  const cabecalho = linhas[0].map(normalizarCabecalho);
  const idx = nome => cabecalho.indexOf(normalizarCabecalho(nome));
  const iCodigo = idx('Código');
  const iDescricao = idx('Descrição');
  const iNatureza = idx('Natureza da Rubrica (eSocial)');
  const iCodCalculo = idx('Código de Cálculo');
  const iClassificacao = idx('Prov/Desc/Base');
  const iUnidade = idx('Val/Hor/Dia/Ref');
  if(iCodigo < 0 || iClassificacao < 0){
    throw new Error('A planilha de Rubricas precisa ter, no mínimo, as colunas "Código" e "Prov/Desc/Base".');
  }
  const mapa = {};
  for(let i=1;i<linhas.length;i++){
    const linha = linhas[i];
    const codigo = linha[iCodigo];
    if(codigo === '' || codigo == null) continue;
    const registro = {
      codigo: String(codigo).trim(),
      descricao: iDescricao>=0 ? String(linha[iDescricao]||'').trim() : '',
      natureza: iNatureza>=0 ? String(linha[iNatureza]||'').trim() : '',
      codigoCalculo: iCodCalculo>=0 ? linha[iCodCalculo] : '',
      classificacao: iClassificacao>=0 ? String(linha[iClassificacao]||'').trim() : '',
      unidade: iUnidade>=0 ? String(linha[iUnidade]||'').trim() : '',
    };
    chavesRubrica(codigo).forEach(k=>{ mapa[k] = registro; });
  }
  return mapa;
}

async function montarWorkbookConferenciaEvento1200(detalhe, porCpf){
  const cabecalhoResumo = ['CPF Trabalhador','Matrícula','Total Proventos','Total Descontos','Saldo Final','Rubricas não cadastradas'];
  const listaCpf = Object.values(porCpf);
  const linhasResumo = listaCpf.map(r=>[r.cpf, r.matricula, r.proventos, r.descontos, r.proventos - r.descontos, r.naoMapeadas]);
  const totalProventos = listaCpf.reduce((s,r)=>s+r.proventos, 0);
  const totalDescontos = listaCpf.reduce((s,r)=>s+r.descontos, 0);
  linhasResumo.push(['TOTAL GERAL', '', totalProventos, totalDescontos, totalProventos - totalDescontos, listaCpf.reduce((s,r)=>s+r.naoMapeadas, 0)]);

  const cabecalhoDetalhe = [
    'Arquivo','CPF Trabalhador','Matrícula','Categoria','Período Apuração',
    'Insc. Empregador','Insc. Estabelecimento','Cód. Lotação','ID Demonstrativo',
    'Código Rubrica','ID Tabela Rubrica','Quantidade','Valor','Ind. Apuração IR',
    'Descrição (cadastro)','Natureza da Rubrica (eSocial)','Código de Cálculo',
    'Prov/Desc/Base','Val/Hor/Dia/Ref','Situação',
  ];
  const linhasDetalhe = detalhe.map(l=>[
    l.arquivo, l.cpfTrab, l.matricula, l.codCateg, l.perApur,
    l.nrInscEmpregador, l.nrInscEstab, l.codLotacao, l.ideDmDev,
    l.codRubr, l.ideTabRubr, l.qtdRubr ? Number(l.qtdRubr) : '', Number(l.vrRubr)||0, l.indApurIR,
    l.rubrica ? l.rubrica.descricao : '', l.rubrica ? l.rubrica.natureza : '', l.rubrica ? l.rubrica.codigoCalculo : '',
    l.rubrica ? l.rubrica.classificacao : '', l.rubrica ? l.rubrica.unidade : '',
    l.rubrica ? 'OK' : 'RUBRICA NÃO CADASTRADA',
  ]);

  const livro = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(livro, XLSX.utils.aoa_to_sheet([cabecalhoResumo, ...linhasResumo]), 'Resumo por CPF');
  XLSX.utils.book_append_sheet(livro, XLSX.utils.aoa_to_sheet([cabecalhoDetalhe, ...linhasDetalhe]), 'Detalhe');
  await salvarWorkbook(livro, `conferencia-evento-1200-${hojeLocalISO()}.xlsx`);
}

async function gerarConferenciaEvento1200(){
  const inputXmls = document.getElementById('util1200_xmls');
  const inputRubricas = document.getElementById('util1200_rubricas');
  const statusEl = document.getElementById('util1200_status');
  const arquivosXml = [...(inputXmls.files||[])];
  const arquivoRubricas = inputRubricas.files && inputRubricas.files[0];
  if(arquivosXml.length === 0){ toast('Selecione ao menos um XML do evento 1200.'); return; }
  if(!arquivoRubricas){ toast('Selecione o arquivo de Rubricas (Excel).'); return; }
  if(typeof XLSX === 'undefined'){ toast('Não foi possível carregar o gerador de Excel. Confira sua internet.'); return; }

  statusEl.textContent = 'Lendo arquivos…';
  try{
    const mapaRubricas = lerRubricasXlsx(await arquivoRubricas.arrayBuffer());

    let todasLinhas = [];
    for(const arquivo of arquivosXml){
      const linhas = parseEvento1200Xml(await arquivo.text(), arquivo.name);
      todasLinhas = todasLinhas.concat(linhas);
    }

    let naoMapeadas = 0;
    const detalhe = todasLinhas.map(l=>{
      let rubrica = null;
      for(const k of chavesRubrica(l.codRubr)){ if(mapaRubricas[k]){ rubrica = mapaRubricas[k]; break; } }
      if(!rubrica) naoMapeadas++;
      return { ...l, rubrica };
    });

    const porCpf = {};
    detalhe.forEach(l=>{
      const cpf = l.cpfTrab || '(sem CPF)';
      if(!porCpf[cpf]) porCpf[cpf] = { cpf, matricula: l.matricula, proventos: 0, descontos: 0, naoMapeadas: 0 };
      const valor = Number(l.vrRubr) || 0;
      const classificacao = l.rubrica ? l.rubrica.classificacao : '';
      if(/provento/i.test(classificacao)) porCpf[cpf].proventos += valor;
      else if(/desconto/i.test(classificacao)) porCpf[cpf].descontos += valor;
      // "Base de cálculo" não soma em nada — é só referência de cálculo, não movimenta dinheiro
      if(!l.rubrica) porCpf[cpf].naoMapeadas++;
    });

    await montarWorkbookConferenciaEvento1200(detalhe, porCpf);
    const qtdCpf = Object.keys(porCpf).length;
    statusEl.textContent = `Pronto! ${detalhe.length} rubrica(s) de ${qtdCpf} trabalhador(es) processadas.` +
      (naoMapeadas > 0 ? `\n⚠ ${naoMapeadas} rubrica(s) sem cadastro na planilha de Rubricas — confira a coluna "Situação" na aba Detalhe.` : '');
    toast('Planilha de conferência gerada!');
  }catch(err){
    statusEl.textContent = '';
    toast(err && err.message ? err.message : 'Não foi possível gerar a planilha.');
  }
}

/* ---------- Utilitários › eSocial › Evento 1200 (Retorno) ----------
   O XML de retorno traz o protocolo/recibo do envio, as rubricas confirmadas
   (com o número de recibo de cada uma) e, anexados, os totalizadores S-5001
   (bases de INSS) e S-5003 (bases de FGTS) gerados pelo próprio eSocial */
function parseEvtBasesTrab(evt, nomeArquivo){
  const ideEvento = evt.getElementsByTagName('ideEvento')[0];
  const ideEmpregador = evt.getElementsByTagName('ideEmpregador')[0];
  const cpfTrab = textoTag(evt.getElementsByTagName('ideTrabalhador')[0], 'cpfTrab');
  const nrRecArqBase = textoTag(ideEvento, 'nrRecArqBase');
  const indApuracao = textoTag(ideEvento, 'indApuracao');
  const perApur = textoTag(ideEvento, 'perApur');
  const nrInscEmpregador = textoTag(ideEmpregador, 'nrInsc');
  const infoCpCalc = evt.getElementsByTagName('infoCpCalc')[0];
  const tpCR = textoTag(infoCpCalc, 'tpCR');
  const vrCpSeg = textoTag(infoCpCalc, 'vrCpSeg');
  const vrDescSeg = textoTag(infoCpCalc, 'vrDescSeg');

  const linhas = [];
  [...evt.getElementsByTagName('infoCp')].forEach(infoCp=>{
    const classTrib = textoTag(infoCp, 'classTrib');
    [...infoCp.getElementsByTagName('ideEstabLot')].forEach(estabLot=>{
      const nrInscEstab = textoTag(estabLot, 'nrInsc');
      const codLotacao = textoTag(estabLot, 'codLotacao');
      [...estabLot.getElementsByTagName('infoCategIncid')].forEach(cat=>{
        const matricula = textoTag(cat, 'matricula');
        const codCateg = textoTag(cat, 'codCateg');
        const baseComum = { arquivo: nomeArquivo, nrRecArqBase, indApuracao, perApur, nrInscEmpregador, cpfTrab, tpCR, vrCpSeg, vrDescSeg, classTrib, nrInscEstab, codLotacao, matricula, codCateg };
        [...cat.getElementsByTagName('infoBaseCS')].forEach(base=>{
          linhas.push({ ...baseComum, origem: 'infoBaseCS', perRef: perApur,
            ind13: textoTag(base,'ind13'), tpValor: textoTag(base,'tpValor'), valor: textoTag(base,'valor') });
        });
        [...cat.getElementsByTagName('infoPerRef')].forEach(perRefEl=>{
          const perRef = textoTag(perRefEl, 'perRef');
          [...perRefEl.getElementsByTagName('detInfoPerRef')].forEach(det=>{
            linhas.push({ ...baseComum, origem: 'detInfoPerRef', perRef,
              ind13: textoTag(det,'ind13'), tpValor: textoTag(det,'tpVrPerRef'), valor: textoTag(det,'vrPerRef') });
          });
        });
      });
    });
  });
  return linhas;
}

function parseEvtBasesFGTS(evt, nomeArquivo){
  const ideEvento = evt.getElementsByTagName('ideEvento')[0];
  const ideEmpregador = evt.getElementsByTagName('ideEmpregador')[0];
  const cpfTrab = textoTag(evt.getElementsByTagName('ideTrabalhador')[0], 'cpfTrab');
  const nrRecArqBase = textoTag(ideEvento, 'nrRecArqBase');
  const indApuracao = textoTag(ideEvento, 'indApuracao');
  const perApur = textoTag(ideEvento, 'perApur');
  const nrInscEmpregador = textoTag(ideEmpregador, 'nrInsc');

  const linhas = [];
  [...evt.getElementsByTagName('ideEstab')].forEach(estab=>{
    const nrInscEstab = textoTag(estab, 'nrInsc');
    [...estab.getElementsByTagName('ideLotacao')].forEach(lot=>{
      const codLotacao = textoTag(lot, 'codLotacao');
      const tpLotacao = textoTag(lot, 'tpLotacao');
      [...lot.getElementsByTagName('infoTrabFGTS')].forEach(trab=>{
        const matricula = textoTag(trab, 'matricula');
        const codCateg = textoTag(trab, 'codCateg');
        const tpRegTrab = textoTag(trab, 'tpRegTrab');
        const baseComum = { arquivo: nomeArquivo, nrRecArqBase, indApuracao, perApur, nrInscEmpregador, cpfTrab, nrInscEstab, codLotacao, tpLotacao, matricula, codCateg, tpRegTrab };
        [...trab.getElementsByTagName('basePerApur')].forEach(base=>{
          linhas.push({ ...baseComum,
            tpValor: textoTag(base,'tpValor'), indIncid: textoTag(base,'indIncid'),
            remFGTS: textoTag(base,'remFGTS'), dpsFGTS: textoTag(base,'dpsFGTS') });
        });
      });
    });
  });
  return linhas;
}

// o XML de retorno repete a tag "retornoEvento" duas vezes (um container sem
// atributos e, dentro do primeiro <eSocial>, o de verdade com Id) — pegando
// o primeiro <eSocial> do documento e procurando dentro dele evita ambiguidade
function parseRetornoEvento1200Xml(xmlText, nomeArquivo){
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  if(doc.querySelector('parsererror')) throw new Error(`${nomeArquivo}: XML inválido ou corrompido.`);

  const resultado = { retorno: null, rubricas: [], basesInss: [], basesFgts: [] };

  const esocialRetorno = doc.getElementsByTagName('eSocial')[0];
  const retornoEvento = esocialRetorno ? esocialRetorno.getElementsByTagName('retornoEvento')[0] : null;
  if(retornoEvento){
    const ideEmpregador = retornoEvento.getElementsByTagName('ideEmpregador')[0];
    const recepcao = retornoEvento.getElementsByTagName('recepcao')[0];
    const processamento = retornoEvento.getElementsByTagName('processamento')[0];
    const recibo = retornoEvento.getElementsByTagName('recibo')[0];
    resultado.retorno = {
      arquivo: nomeArquivo,
      nrInscEmpregador: textoTag(ideEmpregador, 'nrInsc'),
      tpAmb: textoTag(recepcao, 'tpAmb'),
      dhRecepcao: textoTag(recepcao, 'dhRecepcao'),
      versaoAppRecepcao: textoTag(recepcao, 'versaoAppRecepcao'),
      protocoloEnvioLote: textoTag(recepcao, 'protocoloEnvioLote'),
      cdResposta: textoTag(processamento, 'cdResposta'),
      descResposta: textoTag(processamento, 'descResposta'),
      versaoAppProcessamento: textoTag(processamento, 'versaoAppProcessamento'),
      dhProcessamento: textoTag(processamento, 'dhProcessamento'),
      nrRecibo: textoTag(recibo, 'nrRecibo'),
      hash: textoTag(recibo, 'hash'),
    };
    if(recibo){
      [...recibo.getElementsByTagName('rubrica')].forEach(r=>{
        resultado.rubricas.push({
          arquivo: nomeArquivo, nrRecibo: resultado.retorno.nrRecibo,
          ntR: r.getAttribute('ntR')||'', nrR: r.getAttribute('nrR')||'',
          tpR: r.getAttribute('tpR')||'', prA: r.getAttribute('prA')||'',
          inFGTS: r.getAttribute('inFGTS')||'', idE: r.getAttribute('idE')||'',
          cdR: r.getAttribute('cdR')||'', inCP: r.getAttribute('inCP')||'',
          idT: r.getAttribute('idT')||'',
        });
      });
    }
  }

  // totalizadores anexados ao retorno (cada <tot> traz um evtBasesTrab/evtBasesFGTS completo)
  [...doc.getElementsByTagName('tot')].forEach(tot=>{
    const tipo = tot.getAttribute('tipo') || '';
    const esoc = tot.getElementsByTagName('eSocial')[0];
    if(!esoc) return;
    if(tipo === 'S5001'){
      const evt = esoc.getElementsByTagName('evtBasesTrab')[0];
      if(evt) resultado.basesInss = resultado.basesInss.concat(parseEvtBasesTrab(evt, nomeArquivo));
    } else if(tipo === 'S5003'){
      const evt = esoc.getElementsByTagName('evtBasesFGTS')[0];
      if(evt) resultado.basesFgts = resultado.basesFgts.concat(parseEvtBasesFGTS(evt, nomeArquivo));
    }
  });

  return resultado;
}

async function montarWorkbookRetornoEvento1200(retornos, todasRubricas, todasBasesInss, todasBasesFgts){
  const cabRetorno = ['Arquivo','Insc. Empregador','Ambiente','Data/Hora Recepção','Versão App Recepção','Protocolo Envio Lote','Cód. Resposta','Descrição Resposta','Versão App Processamento','Data/Hora Processamento','Nº Recibo','Hash'];
  const linhasRetorno = retornos.map(r=>[r.arquivo, r.nrInscEmpregador, r.tpAmb, r.dhRecepcao, r.versaoAppRecepcao, r.protocoloEnvioLote, r.cdResposta, r.descResposta, r.versaoAppProcessamento, r.dhProcessamento, r.nrRecibo, r.hash]);

  const cabRubricas = ['Arquivo','Nº Recibo','Natureza Rubrica (ntR)','Nº Recibo Rubrica (nrR)','Tipo Rubrica (tpR)','Período Apuração (prA)','Incidência FGTS (inFGTS)','ID Evento Origem (idE)','Código Rubrica (cdR)','Incidência CP (inCP)','ID Tabela (idT)'];
  const linhasRubricas = todasRubricas.map(r=>[r.arquivo, r.nrRecibo, r.ntR, r.nrR, r.tpR, r.prA, r.inFGTS, r.idE, r.cdR, r.inCP, r.idT]);

  const cabInss = ['Arquivo','Nº Recibo Base','Indicador Apuração','Período Apuração','Insc. Empregador','CPF Trabalhador','Tipo Contrib. (tpCR)','Vr. Contrib. Segurado','Vr. Desc. Segurado','Class. Tributária','Insc. Estabelecimento','Cód. Lotação','Matrícula','Categoria','Origem','Período Referência','Indicador 13º','Tipo Valor','Valor'];
  const linhasInss = todasBasesInss.map(r=>[r.arquivo, r.nrRecArqBase, r.indApuracao, r.perApur, r.nrInscEmpregador, r.cpfTrab, r.tpCR, r.vrCpSeg, r.vrDescSeg, r.classTrib, r.nrInscEstab, r.codLotacao, r.matricula, r.codCateg, r.origem, r.perRef, r.ind13, r.tpValor, Number(r.valor)||0]);

  const cabFgts = ['Arquivo','Nº Recibo Base','Indicador Apuração','Período Apuração','Insc. Empregador','CPF Trabalhador','Insc. Estabelecimento','Cód. Lotação','Tipo Lotação','Matrícula','Categoria','Tipo Regime Trab.','Tipo Valor','Indicador Incidência','Remuneração FGTS','Depósito FGTS'];
  const linhasFgts = todasBasesFgts.map(r=>[r.arquivo, r.nrRecArqBase, r.indApuracao, r.perApur, r.nrInscEmpregador, r.cpfTrab, r.nrInscEstab, r.codLotacao, r.tpLotacao, r.matricula, r.codCateg, r.tpRegTrab, r.tpValor, r.indIncid, Number(r.remFGTS)||0, Number(r.dpsFGTS)||0]);

  const livro = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(livro, XLSX.utils.aoa_to_sheet([cabRetorno, ...linhasRetorno]), 'Retorno');
  XLSX.utils.book_append_sheet(livro, XLSX.utils.aoa_to_sheet([cabRubricas, ...linhasRubricas]), 'Rubricas do Recibo');
  XLSX.utils.book_append_sheet(livro, XLSX.utils.aoa_to_sheet([cabInss, ...linhasInss]), 'S-5001 Bases INSS');
  XLSX.utils.book_append_sheet(livro, XLSX.utils.aoa_to_sheet([cabFgts, ...linhasFgts]), 'S-5003 Bases FGTS');
  await salvarWorkbook(livro, `retorno-evento-1200-${hojeLocalISO()}.xlsx`);
}

async function gerarRetornoEvento1200(){
  const inputXmls = document.getElementById('util1200ret_xmls');
  const statusEl = document.getElementById('util1200ret_status');
  const arquivos = [...(inputXmls.files||[])];
  if(arquivos.length === 0){ toast('Selecione ao menos um XML de retorno do evento 1200.'); return; }
  if(typeof XLSX === 'undefined'){ toast('Não foi possível carregar o gerador de Excel. Confira sua internet.'); return; }

  statusEl.textContent = 'Lendo arquivos…';
  try{
    const retornos = [];
    let todasRubricas = [], todasBasesInss = [], todasBasesFgts = [];
    for(const arquivo of arquivos){
      const r = parseRetornoEvento1200Xml(await arquivo.text(), arquivo.name);
      if(r.retorno) retornos.push(r.retorno);
      todasRubricas = todasRubricas.concat(r.rubricas);
      todasBasesInss = todasBasesInss.concat(r.basesInss);
      todasBasesFgts = todasBasesFgts.concat(r.basesFgts);
    }
    if(retornos.length === 0 && todasRubricas.length === 0 && todasBasesInss.length === 0 && todasBasesFgts.length === 0){
      throw new Error('Nenhum dado reconhecido nesses arquivos — confira se são XMLs de retorno do evento 1200.');
    }
    await montarWorkbookRetornoEvento1200(retornos, todasRubricas, todasBasesInss, todasBasesFgts);
    statusEl.textContent = `Pronto! ${retornos.length} retorno(s), ${todasRubricas.length} rubrica(s), ${todasBasesInss.length} linha(s) de base INSS e ${todasBasesFgts.length} linha(s) de base FGTS.`;
    toast('Planilha de retorno gerada!');
  }catch(err){
    statusEl.textContent = '';
    toast(err && err.message ? err.message : 'Não foi possível gerar a planilha.');
  }
}

const MESES_ABREV = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];

/* ---------- Utilitários › eSocial › Evento 1210 (Pagamentos) ---------- */
function parseEvento1210Xml(xmlText, nomeArquivo){
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  if(doc.querySelector('parsererror')) throw new Error(`${nomeArquivo}: XML inválido ou corrompido.`);
  const evt = doc.getElementsByTagName('evtPgtos')[0];
  if(!evt) throw new Error(`${nomeArquivo}: não parece ser um XML do evento 1210 (evtPgtos não encontrado).`);
  const ideEvento = evt.getElementsByTagName('ideEvento')[0];
  const indRetif = textoTag(ideEvento, 'indRetif');
  const perApur = textoTag(ideEvento, 'perApur');
  const nrInscEmpregador = textoTag(evt.getElementsByTagName('ideEmpregador')[0], 'nrInsc');

  const linhas = [];
  [...evt.getElementsByTagName('ideBenef')].forEach(benef=>{
    const cpfBenef = textoTag(benef, 'cpfBenef');
    [...benef.getElementsByTagName('infoPgto')].forEach(pg=>{
      linhas.push({
        arquivo: nomeArquivo, indRetif, perApur, nrInscEmpregador, cpfBenef,
        dtPgto: textoTag(pg, 'dtPgto'), tpPgto: textoTag(pg, 'tpPgto'),
        perRef: textoTag(pg, 'perRef'), ideDmDev: textoTag(pg, 'ideDmDev'),
        vrLiq: textoTag(pg, 'vrLiq'),
      });
    });
  });
  if(linhas.length === 0) throw new Error(`${nomeArquivo}: nenhum pagamento encontrado no XML.`);
  return linhas;
}

async function gerarEvento1210Pagamentos(arquivos){
  let todasLinhas = [];
  for(const arquivo of arquivos){
    todasLinhas = todasLinhas.concat(parseEvento1210Xml(await arquivo.text(), arquivo.name));
  }
  const cabecalho = ['Arquivo','Indicador Retificação','Período Apuração','Insc. Empregador','CPF Beneficiário','Data Pagamento','Tipo Pagamento','Período Referência','ID Demonstrativo','Valor Líquido'];
  const linhas = todasLinhas.map(l=>[l.arquivo, l.indRetif, l.perApur, l.nrInscEmpregador, l.cpfBenef, l.dtPgto, l.tpPgto, l.perRef, l.ideDmDev, Number(l.vrLiq)||0]);
  const livro = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(livro, XLSX.utils.aoa_to_sheet([cabecalho, ...linhas]), 'Pagamentos');
  await salvarWorkbook(livro, `s1210-pagamentos-${hojeLocalISO()}.xlsx`);
  return `Pronto! ${todasLinhas.length} pagamento(s) processado(s).`;
}

/* ---------- Utilitários › eSocial › Evento 1210 (Retorno / S-5002) ---------- */
const CAMPOS_APURACAO_IR = ['CRMen','vlrRendTrib','vlrRendTrib13','vlrPrevOficial','vlrPrevOficial13','vlrCRMen','vlrCR13Men','vlrParcIsenta65','vlrParcIsenta65Dec','vlrDiarias','vlrAjudaCusto','vlrIndResContrato','vlrAbonoPec','vlrRendMoleGrave','vlrRendMoleGrave13','vlrAuxMoradia','vlrBolsaMedico','vlrBolsaMedico13','vlrJurosMora','vlrIsenOutros'];
function lerCamposApuracaoIR(el){
  const obj = {};
  CAMPOS_APURACAO_IR.forEach(campo=>{ obj[campo] = textoTag(el, campo); });
  return obj;
}
function parseEvtIrrfBenef(evt, nomeArquivo){
  const nrRecArqBase = textoTag(evt.getElementsByTagName('ideEvento')[0], 'nrRecArqBase');
  const perApur = textoTag(evt.getElementsByTagName('ideEvento')[0], 'perApur');
  const nrInscEmpregador = textoTag(evt.getElementsByTagName('ideEmpregador')[0], 'nrInsc');
  const ideTrabalhador = evt.getElementsByTagName('ideTrabalhador')[0];
  const cpfBenef = textoTag(ideTrabalhador, 'cpfBenef');

  const infoIR = [], apuracaoMensal = [], consolidado = [];
  [...ideTrabalhador.getElementsByTagName('dmDev')].forEach(dm=>{
    const base = {
      arquivo: nomeArquivo, nrRecArqBase, perApur, nrInscEmpregador, cpfBenef,
      perRef: textoTag(dm, 'perRef'), ideDmDev: textoTag(dm, 'ideDmDev'),
      tpPgto: textoTag(dm, 'tpPgto'), dtPgto: textoTag(dm, 'dtPgto'), codCateg: textoTag(dm, 'codCateg'),
    };
    [...dm.getElementsByTagName('infoIR')].forEach(ir=>{
      infoIR.push({ ...base, tpInfoIR: textoTag(ir,'tpInfoIR'), valor: textoTag(ir,'valor') });
    });
    const totApur = dm.getElementsByTagName('totApurMen')[0];
    if(totApur) apuracaoMensal.push({ ...base, ...lerCamposApuracaoIR(totApur) });
  });
  const totInfoIR = ideTrabalhador.getElementsByTagName('totInfoIR')[0];
  if(totInfoIR){
    [...totInfoIR.getElementsByTagName('consolidApurMen')].forEach(cons=>{
      consolidado.push({ arquivo: nomeArquivo, nrRecArqBase, perApur, nrInscEmpregador, cpfBenef, ...lerCamposApuracaoIR(cons) });
    });
  }
  return { infoIR, apuracaoMensal, consolidado };
}
// mesma forma do retorno do evento 1200 (retornoEvento + rubricas), mas os
// atributos de <rubrica> mudam (aqui vem inIR, não inFGTS/inCP) e o
// totalizador anexado é o S-5002 (evtIrrfBenef), não S-5001/S-5003
function parseRetorno1210Xml(xmlText, nomeArquivo){
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  if(doc.querySelector('parsererror')) throw new Error(`${nomeArquivo}: XML inválido ou corrompido.`);

  const resultado = { retorno: null, rubricas: [], infoIR: [], apuracaoMensal: [], consolidado: [] };

  const esocialRetorno = doc.getElementsByTagName('eSocial')[0];
  const retornoEvento = esocialRetorno ? esocialRetorno.getElementsByTagName('retornoEvento')[0] : null;
  if(retornoEvento){
    const ideEmpregador = retornoEvento.getElementsByTagName('ideEmpregador')[0];
    const recepcao = retornoEvento.getElementsByTagName('recepcao')[0];
    const processamento = retornoEvento.getElementsByTagName('processamento')[0];
    const recibo = retornoEvento.getElementsByTagName('recibo')[0];
    resultado.retorno = {
      arquivo: nomeArquivo,
      nrInscEmpregador: textoTag(ideEmpregador, 'nrInsc'),
      tpAmb: textoTag(recepcao, 'tpAmb'),
      dhRecepcao: textoTag(recepcao, 'dhRecepcao'),
      versaoAppRecepcao: textoTag(recepcao, 'versaoAppRecepcao'),
      protocoloEnvioLote: textoTag(recepcao, 'protocoloEnvioLote'),
      cdResposta: textoTag(processamento, 'cdResposta'),
      descResposta: textoTag(processamento, 'descResposta'),
      versaoAppProcessamento: textoTag(processamento, 'versaoAppProcessamento'),
      dhProcessamento: textoTag(processamento, 'dhProcessamento'),
      nrRecibo: textoTag(recibo, 'nrRecibo'),
      hash: textoTag(recibo, 'hash'),
    };
    if(recibo){
      [...recibo.getElementsByTagName('rubrica')].forEach(r=>{
        resultado.rubricas.push({
          arquivo: nomeArquivo, nrRecibo: resultado.retorno.nrRecibo,
          ntR: r.getAttribute('ntR')||'', nrR: r.getAttribute('nrR')||'',
          tpR: r.getAttribute('tpR')||'', prA: r.getAttribute('prA')||'',
          idE: r.getAttribute('idE')||'', cdR: r.getAttribute('cdR')||'',
          inIR: r.getAttribute('inIR')||'', idT: r.getAttribute('idT')||'',
        });
      });
    }
  }

  [...doc.getElementsByTagName('tot')].forEach(tot=>{
    if((tot.getAttribute('tipo')||'') !== 'S5002') return;
    const esoc = tot.getElementsByTagName('eSocial')[0];
    const evt = esoc ? esoc.getElementsByTagName('evtIrrfBenef')[0] : null;
    if(!evt) return;
    const partes = parseEvtIrrfBenef(evt, nomeArquivo);
    resultado.infoIR = resultado.infoIR.concat(partes.infoIR);
    resultado.apuracaoMensal = resultado.apuracaoMensal.concat(partes.apuracaoMensal);
    resultado.consolidado = resultado.consolidado.concat(partes.consolidado);
  });

  return resultado;
}

async function gerarEvento1210Retorno(arquivos){
  const retornos = [];
  let todasRubricas = [], todoInfoIR = [], todaApuracaoMensal = [], todoConsolidado = [];
  for(const arquivo of arquivos){
    const r = parseRetorno1210Xml(await arquivo.text(), arquivo.name);
    if(r.retorno) retornos.push(r.retorno);
    todasRubricas = todasRubricas.concat(r.rubricas);
    todoInfoIR = todoInfoIR.concat(r.infoIR);
    todaApuracaoMensal = todaApuracaoMensal.concat(r.apuracaoMensal);
    todoConsolidado = todoConsolidado.concat(r.consolidado);
  }
  if(retornos.length === 0 && todasRubricas.length === 0 && todoInfoIR.length === 0){
    throw new Error('Nenhum dado reconhecido nesses arquivos — confira se são XMLs de retorno do evento 1210.');
  }

  const livro = XLSX.utils.book_new();

  const cabRetorno = ['Arquivo','Insc. Empregador','Ambiente','Data/Hora Recepção','Versão App Recepção','Protocolo Envio Lote','Cód. Resposta','Descrição Resposta','Versão App Processamento','Data/Hora Processamento','Nº Recibo','Hash'];
  XLSX.utils.book_append_sheet(livro, XLSX.utils.aoa_to_sheet([cabRetorno, ...retornos.map(r=>[r.arquivo, r.nrInscEmpregador, r.tpAmb, r.dhRecepcao, r.versaoAppRecepcao, r.protocoloEnvioLote, r.cdResposta, r.descResposta, r.versaoAppProcessamento, r.dhProcessamento, r.nrRecibo, r.hash])]), 'Retorno');

  const cabRubricas = ['Arquivo','Nº Recibo','Natureza Rubrica (ntR)','Nº Recibo Rubrica (nrR)','Tipo Rubrica (tpR)','Período Apuração (prA)','ID Evento Origem (idE)','Código Rubrica (cdR)','Incidência IR (inIR)','ID Tabela (idT)'];
  XLSX.utils.book_append_sheet(livro, XLSX.utils.aoa_to_sheet([cabRubricas, ...todasRubricas.map(r=>[r.arquivo, r.nrRecibo, r.ntR, r.nrR, r.tpR, r.prA, r.idE, r.cdR, r.inIR, r.idT])]), 'Rubricas do Recibo');

  const cabInfoIR = ['Arquivo','Nº Recibo Base','Período Apuração','Insc. Empregador','CPF Beneficiário','Período Referência','ID Demonstrativo','Tipo Pagamento','Data Pagamento','Categoria','Tipo Info IR','Valor'];
  XLSX.utils.book_append_sheet(livro, XLSX.utils.aoa_to_sheet([cabInfoIR, ...todoInfoIR.map(l=>[l.arquivo, l.nrRecArqBase, l.perApur, l.nrInscEmpregador, l.cpfBenef, l.perRef, l.ideDmDev, l.tpPgto, l.dtPgto, l.codCateg, l.tpInfoIR, Number(l.valor)||0])]), 'IRRF por Pagamento');

  const cabApuracao = ['Arquivo','Nº Recibo Base','Período Apuração','Insc. Empregador','CPF Beneficiário','Período Referência','ID Demonstrativo', ...CAMPOS_APURACAO_IR];
  XLSX.utils.book_append_sheet(livro, XLSX.utils.aoa_to_sheet([cabApuracao, ...todaApuracaoMensal.map(l=>[l.arquivo, l.nrRecArqBase, l.perApur, l.nrInscEmpregador, l.cpfBenef, l.perRef, l.ideDmDev, ...CAMPOS_APURACAO_IR.map(c=>l[c]!=='' && !isNaN(Number(l[c])) ? Number(l[c]) : l[c])])]), 'Apuração Mensal (IR)');

  const cabConsolidado = ['Arquivo','Nº Recibo Base','Período Apuração','Insc. Empregador','CPF Beneficiário', ...CAMPOS_APURACAO_IR];
  XLSX.utils.book_append_sheet(livro, XLSX.utils.aoa_to_sheet([cabConsolidado, ...todoConsolidado.map(l=>[l.arquivo, l.nrRecArqBase, l.perApur, l.nrInscEmpregador, l.cpfBenef, ...CAMPOS_APURACAO_IR.map(c=>l[c]!=='' && !isNaN(Number(l[c])) ? Number(l[c]) : l[c])])]), 'Consolidado (IR)');

  await salvarWorkbook(livro, `s1210-retorno-${hojeLocalISO()}.xlsx`);
  return `Pronto! ${retornos.length} retorno(s), ${todasRubricas.length} rubrica(s) e ${todoInfoIR.length} linha(s) de IRRF processadas.`;
}

/* ---------- Utilitários › eSocial › S-5011 (Contribuições Sociais Consolidadas) ----------
   Consolida vários XMLs de retorno do evento evtCS (S-5011) num resumo mensal, por categoria
   de trabalhador, anual (13º) e por estabelecimento — mesmas abas/colunas do modelo de Excel
   usado pela contabilidade. Deduplica por Id do evento (arquivos repetidos não contam 2x). */
const CR_MENSAL_CS = [
  ['108201', 'CP Segurados - Empregados/Avulso'],
  ['109901', 'CP Segurados - Contrib. Individuais 11%'],
  ['113801', 'CP Patronal - Empregados/Avulsos'],
  ['113804', 'CP Patronal - Contrib. Individuais'],
  ['117001', 'CP Terceiros - Salário Educação'],
  ['117601', 'CP Terceiros - INCRA'],
  ['119601', 'CP Terceiros - SESC'],
  ['120002', 'CP Terceiros - SEBRAE'],
  ['164601', 'CP Patronal - GILRAT Ajustado'],
];
const CR_ANUAL_CS = [
  ['108221', 'CP Segurados - Empregados/Avulso'],
  ['113821', 'CP Patronal - Empregados/Avulsos'],
  ['117021', 'CP Terceiros - Salário Educação'],
  ['117621', 'CP Terceiros - INCRA'],
  ['119621', 'CP Terceiros - SESC'],
  ['120022', 'CP Terceiros - SEBRAE'],
  ['164621', 'CP Patronal - GILRAT Ajustado'],
];
const CATEGORIAS_CONHECIDAS_CS = {
  '101': 'Empregado - Geral',
  '103': 'Empregado - Categoria Especial',
  '701': 'Contribuinte Individual - Autônomo em Geral',
  '722': 'Contribuinte Individual - Diretor Não Empregado, sem FGTS',
  '901': 'Bolsista / Sem Vínculo de Emprego',
};
function labelCategoriaCS(codigo){
  return CATEGORIAS_CONHECIDAS_CS[codigo] ? `${CATEGORIAS_CONHECIDAS_CS[codigo]}\n(${codigo})` : `Categoria ${codigo}`;
}

function parseEvtCS(evt, nomeArquivo){
  const id = evt.getAttribute('Id') || '';
  const ideEvento = evt.getElementsByTagName('ideEvento')[0];
  const indApuracao = textoTag(ideEvento, 'indApuracao') || '1';
  const perApur = textoTag(ideEvento, 'perApur');
  const nrInscEmpregador = textoTag(evt.getElementsByTagName('ideEmpregador')[0], 'nrInsc');
  const infoCS = evt.getElementsByTagName('infoCS')[0];
  const infoCPSeg = infoCS.getElementsByTagName('infoCPSeg')[0];
  const vrDescCP = Number(textoTag(infoCPSeg, 'vrDescCP')) || 0;
  const vrCpSeg = Number(textoTag(infoCPSeg, 'vrCpSeg')) || 0;

  let vrBcCp00 = 0, vrSuspBcCp00 = 0, vrSalFam = 0, vrSalMat = 0;
  const porCategoria = {};
  const porEstabelecimento = {};

  [...infoCS.getElementsByTagName('ideEstab')].forEach(estab=>{
    const nrInscEstab = textoTag(estab, 'nrInsc');
    if(!porEstabelecimento[nrInscEstab]) porEstabelecimento[nrInscEstab] = { vrBcCp00: 0, totalCR: 0 };
    [...estab.getElementsByTagName('basesRemun')].forEach(br=>{
      const codCateg = textoTag(br, 'codCateg');
      const basesCp = br.getElementsByTagName('basesCp')[0];
      const bc00 = Number(textoTag(basesCp, 'vrBcCp00')) || 0;
      const susp00 = Number(textoTag(basesCp, 'vrSuspBcCp00')) || 0;
      const salFam = Number(textoTag(basesCp, 'vrSalFam')) || 0;
      const salMat = Number(textoTag(basesCp, 'vrSalMat')) || 0;
      vrBcCp00 += bc00; vrSuspBcCp00 += susp00; vrSalFam += salFam; vrSalMat += salMat;
      porCategoria[codCateg] = (porCategoria[codCateg]||0) + bc00;
      porEstabelecimento[nrInscEstab].vrBcCp00 += bc00;
    });
    [...estab.getElementsByTagName('infoCREstab')].forEach(cr=>{
      porEstabelecimento[nrInscEstab].totalCR += Number(textoTag(cr,'vrCR')) || 0;
    });
  });

  const crContrib = {};
  [...infoCS.getElementsByTagName('infoCRContrib')].forEach(cr=>{
    crContrib[textoTag(cr,'tpCR')] = Number(textoTag(cr,'vrCR')) || 0;
  });

  return { arquivo: nomeArquivo, id, indApuracao, perApur, nrInscEmpregador, vrBcCp00, vrSuspBcCp00, vrSalFam, vrSalMat, vrDescCP, vrCpSeg, crContrib, porCategoria, porEstabelecimento };
}

// deduplica por Id (o mesmo evento pode chegar em 2 arquivos com nomes diferentes)
function deduplicarPorId(lista){
  const vistos = new Set();
  return lista.filter(e=>{
    if(!e.id) return true;
    if(vistos.has(e.id)) return false;
    vistos.add(e.id);
    return true;
  });
}

function agregarEvtCS(todosEvt){
  const unicos = deduplicarPorId(todosEvt);
  const porCompetencia = {}, porAno = {}, porEstabCompetencia = {};
  const categoriasEncontradas = new Set();

  unicos.forEach(e=>{
    Object.keys(e.porCategoria).forEach(c=>categoriasEncontradas.add(c));
    if(e.indApuracao === '2'){
      const ano = String(e.perApur||'').slice(0,4);
      if(!porAno[ano]) porAno[ano] = { vrBcCp00:0, vrSalFam:0, vrSalMat:0, vrDescCP:0, vrCpSeg:0, crContrib:{} };
      const acc = porAno[ano];
      acc.vrBcCp00 += e.vrBcCp00; acc.vrSalFam += e.vrSalFam; acc.vrSalMat += e.vrSalMat;
      acc.vrDescCP += e.vrDescCP; acc.vrCpSeg += e.vrCpSeg;
      Object.entries(e.crContrib).forEach(([cod,val])=>{ acc.crContrib[cod] = (acc.crContrib[cod]||0) + val; });
    } else {
      const comp = e.perApur;
      if(!porCompetencia[comp]) porCompetencia[comp] = { vrBcCp00:0, vrSuspBcCp00:0, vrSalFam:0, vrSalMat:0, vrDescCP:0, vrCpSeg:0, crContrib:{}, porCategoria:{} };
      const acc = porCompetencia[comp];
      acc.vrBcCp00 += e.vrBcCp00; acc.vrSuspBcCp00 += e.vrSuspBcCp00; acc.vrSalFam += e.vrSalFam; acc.vrSalMat += e.vrSalMat;
      acc.vrDescCP += e.vrDescCP; acc.vrCpSeg += e.vrCpSeg;
      Object.entries(e.crContrib).forEach(([cod,val])=>{ acc.crContrib[cod] = (acc.crContrib[cod]||0) + val; });
      Object.entries(e.porCategoria).forEach(([cod,val])=>{ acc.porCategoria[cod] = (acc.porCategoria[cod]||0) + val; });
      Object.entries(e.porEstabelecimento).forEach(([nrInsc, dados])=>{
        const chave = comp + '|' + nrInsc;
        if(!porEstabCompetencia[chave]) porEstabCompetencia[chave] = { perApur: comp, nrInsc, vrBcCp00:0, totalCR:0 };
        porEstabCompetencia[chave].vrBcCp00 += dados.vrBcCp00;
        porEstabCompetencia[chave].totalCR += dados.totalCR;
      });
    }
  });

  return { porCompetencia, porAno, porEstabCompetencia, categoriasEncontradas, totalArquivos: todosEvt.length, totalUnicos: unicos.length };
}

function montarWorkbookS5011(agregado){
  const livro = XLSX.utils.book_new();
  const competencias = Object.keys(agregado.porCompetencia).sort();

  const cabResumo = ['Competência','Ano','Mês','Base de Cálculo Total (vrBcCp00)','Base de Cálculo Suspensa','Valor Total Salário-Família','Valor Total Salário-Maternidade',
    ...CR_MENSAL_CS.map(([cod,label])=>`${label}\n(${cod})`), 'Total do Mês','Valor Declarado (segurados)','Valor Calculado (segurados)','Diferença'];
  const linhasResumo = competencias.map(comp=>{
    const a = agregado.porCompetencia[comp];
    const [ano, mes] = comp.split('-');
    const crValores = CR_MENSAL_CS.map(([cod])=> a.crContrib[cod]||0);
    const totalMes = crValores.reduce((s,v)=>s+v,0);
    return [comp, Number(ano), MESES_ABREV[Number(mes)-1]||mes, a.vrBcCp00, a.vrSuspBcCp00, a.vrSalFam, a.vrSalMat,
      ...crValores, totalMes, a.vrDescCP, a.vrCpSeg, a.vrDescCP - a.vrCpSeg];
  });
  XLSX.utils.book_append_sheet(livro, XLSX.utils.aoa_to_sheet([cabResumo, ...linhasResumo]), 'Resumo Mensal');

  const categorias = [...agregado.categoriasEncontradas].sort();
  const cabCateg = ['Competência','Ano','Mês', ...categorias.map(labelCategoriaCS), 'Total do Mês'];
  const linhasCateg = competencias.map(comp=>{
    const a = agregado.porCompetencia[comp];
    const [ano, mes] = comp.split('-');
    const valores = categorias.map(c=>a.porCategoria[c]||0);
    return [comp, Number(ano), MESES_ABREV[Number(mes)-1]||mes, ...valores, valores.reduce((s,v)=>s+v,0)];
  });
  XLSX.utils.book_append_sheet(livro, XLSX.utils.aoa_to_sheet([cabCateg, ...linhasCateg]), 'Base de Cálculo por Categoria');

  const anos = Object.keys(agregado.porAno).sort();
  const cabAnual = ['Ano','Base de Cálculo Total (vrBcCp00)','Valor Total Salário-Família','Valor Total Salário-Maternidade',
    ...CR_ANUAL_CS.map(([cod,label])=>`${label}\n(${cod})`), 'Total do Ano','Valor Declarado (segurados)','Valor Calculado (segurados)'];
  const linhasAnual = anos.map(ano=>{
    const a = agregado.porAno[ano];
    const crValores = CR_ANUAL_CS.map(([cod])=> a.crContrib[cod]||0);
    return [Number(ano), a.vrBcCp00, a.vrSalFam, a.vrSalMat, ...crValores, crValores.reduce((s,v)=>s+v,0), a.vrDescCP, a.vrCpSeg];
  });
  if(linhasAnual.length){
    linhasAnual.push(['TOTAL GERAL',
      anos.reduce((s,a)=>s+agregado.porAno[a].vrBcCp00,0),
      anos.reduce((s,a)=>s+agregado.porAno[a].vrSalFam,0),
      anos.reduce((s,a)=>s+agregado.porAno[a].vrSalMat,0),
      ...CR_ANUAL_CS.map(([cod])=> anos.reduce((s,a)=>s+(agregado.porAno[a].crContrib[cod]||0),0)),
      anos.reduce((s,a)=>CR_ANUAL_CS.reduce((x,[cod])=>x+(agregado.porAno[a].crContrib[cod]||0),0)+s,0),
      anos.reduce((s,a)=>s+agregado.porAno[a].vrDescCP,0),
      anos.reduce((s,a)=>s+agregado.porAno[a].vrCpSeg,0),
    ]);
  }
  XLSX.utils.book_append_sheet(livro, XLSX.utils.aoa_to_sheet([cabAnual, ...linhasAnual]), '13º Salário (Anual)');

  const chavesEstab = Object.keys(agregado.porEstabCompetencia).sort();
  const cabEstab = ['Competência','CNPJ do Estabelecimento','Base de Cálculo (categ. 00)','Total Contribuições do Estabelecimento'];
  const linhasEstab = chavesEstab.map(k=>{
    const d = agregado.porEstabCompetencia[k];
    return [d.perApur, d.nrInsc, d.vrBcCp00, d.totalCR];
  });
  XLSX.utils.book_append_sheet(livro, XLSX.utils.aoa_to_sheet([cabEstab, ...linhasEstab]), 'Por Estabelecimento');

  return livro;
}

async function gerarS5011(arquivos){
  const todosEvt = [];
  for(const arquivo of arquivos){
    const doc = new DOMParser().parseFromString(await arquivo.text(), 'text/xml');
    const evt = doc.getElementsByTagName('evtCS')[0];
    if(!evt){ throw new Error(`${arquivo.name}: não parece ser um XML de retorno do evento S-5011 (evtCS não encontrado).`); }
    todosEvt.push(parseEvtCS(evt, arquivo.name));
  }
  const agregado = agregarEvtCS(todosEvt);
  const livro = montarWorkbookS5011(agregado);
  await salvarWorkbook(livro, `s5011-contribuicoes-sociais-${hojeLocalISO()}.xlsx`);
  const duplicados = agregado.totalArquivos - agregado.totalUnicos;
  return `Pronto! ${agregado.totalUnicos} evento(s) processado(s) (${Object.keys(agregado.porCompetencia).length} competência(s), ${Object.keys(agregado.porAno).length} ano(s) com 13º).` +
    (duplicados > 0 ? `\n${duplicados} arquivo(s) duplicado(s) (mesmo Id) foram ignorados.` : '');
}

/* ---------- Utilitários › eSocial › S-5012 (IRRF Consolidado) ---------- */
const CRMEN_CONHECIDOS = {
  '056107': 'IRRF - Rendimento do Trabalho Assalariado',
  '058806': 'IRRF - Rendimento do Trabalho sem Vínculo Empregatício',
  '356201': 'IRRF - Participação nos Lucros ou Resultados (PLR)',
};
function labelCRMen(codigo){
  return CRMEN_CONHECIDOS[codigo] ? `${CRMEN_CONHECIDOS[codigo]}\n(${codigo})` : `IRRF - código ${codigo}`;
}
function parseEvtIrrf(evt, nomeArquivo){
  const id = evt.getAttribute('Id') || '';
  const perApur = textoTag(evt.getElementsByTagName('ideEvento')[0], 'perApur');
  const infoIRRF = evt.getElementsByTagName('infoIRRF')[0];
  const crMen = {};
  [...infoIRRF.getElementsByTagName('infoCRMen')].forEach(cr=>{
    crMen[textoTag(cr,'CRMen')] = Number(textoTag(cr,'vrCRMen')) || 0;
  });
  return { arquivo: nomeArquivo, id, perApur, crMen };
}
function agregarEvtIrrf(todosEvt){
  const unicos = deduplicarPorId(todosEvt);
  const porCompetencia = {};
  const codigosEncontrados = new Set();
  unicos.forEach(e=>{
    Object.keys(e.crMen).forEach(c=>codigosEncontrados.add(c));
    if(!porCompetencia[e.perApur]) porCompetencia[e.perApur] = { crMen: {} };
    Object.entries(e.crMen).forEach(([cod,val])=>{
      porCompetencia[e.perApur].crMen[cod] = (porCompetencia[e.perApur].crMen[cod]||0) + val;
    });
  });
  return { porCompetencia, codigosEncontrados, totalArquivos: todosEvt.length, totalUnicos: unicos.length };
}
function montarWorkbookS5012(agregado){
  const livro = XLSX.utils.book_new();
  const competencias = Object.keys(agregado.porCompetencia).sort();
  const codigos = [...agregado.codigosEncontrados].sort();
  const cabResumo = ['Competência','Ano','Mês', ...codigos.map(labelCRMen), 'Total do Mês'];
  const linhas = competencias.map(comp=>{
    const a = agregado.porCompetencia[comp];
    const [ano,mes] = comp.split('-');
    const valores = codigos.map(c=>a.crMen[c]||0);
    return [comp, Number(ano), MESES_ABREV[Number(mes)-1]||mes, ...valores, valores.reduce((s,v)=>s+v,0)];
  });
  XLSX.utils.book_append_sheet(livro, XLSX.utils.aoa_to_sheet([cabResumo, ...linhas]), 'Resumo Mensal');
  return livro;
}

async function gerarS5012(arquivos){
  const todosEvt = [];
  for(const arquivo of arquivos){
    const doc = new DOMParser().parseFromString(await arquivo.text(), 'text/xml');
    const evt = doc.getElementsByTagName('evtIrrf')[0];
    if(!evt){ throw new Error(`${arquivo.name}: não parece ser um XML de retorno do evento S-5012 (evtIrrf não encontrado).`); }
    todosEvt.push(parseEvtIrrf(evt, arquivo.name));
  }
  const agregado = agregarEvtIrrf(todosEvt);
  const livro = montarWorkbookS5012(agregado);
  await salvarWorkbook(livro, `s5012-irrf-consolidado-${hojeLocalISO()}.xlsx`);
  const duplicados = agregado.totalArquivos - agregado.totalUnicos;
  return `Pronto! ${agregado.totalUnicos} evento(s) processado(s) (${Object.keys(agregado.porCompetencia).length} competência(s)).` +
    (duplicados > 0 ? `\n${duplicados} arquivo(s) duplicado(s) (mesmo Id) foram ignorados.` : '');
}

/* ---------- Utilitários › eSocial › S-5013 (FGTS Consolidado) ---------- */
const FGTS_GRUPOS = [
  { nome: 'Mensal (normal)', codigos: [11,13,15,17,19] },
  { nome: '13º Salário', codigos: [12,14,16,18] },
  { nome: 'Mês da Rescisão', codigos: [21,24,27,30] },
  { nome: '13º Salário Rescisório', codigos: [22,25,28,31] },
  { nome: 'Aviso Prévio Indenizado', codigos: [23,26,29,32] },
];
const FGTS_GRUPOS_NOMES = ['Mensal (normal)','13º Salário','Mês da Rescisão','13º Salário Rescisório','Aviso Prévio Indenizado','Outros Códigos'];
function grupoFgts(tpValor){
  const n = Number(tpValor);
  const g = FGTS_GRUPOS.find(g=>g.codigos.includes(n));
  return g ? g.nome : 'Outros Códigos';
}
function parseEvtFGTS(evt, nomeArquivo){
  const id = evt.getAttribute('Id') || '';
  const ideEvento = evt.getElementsByTagName('ideEvento')[0];
  const indApuracao = textoTag(ideEvento, 'indApuracao') || '1';
  const perApur = textoTag(ideEvento, 'perApur');
  const infoFGTS = evt.getElementsByTagName('infoFGTS')[0];

  const porGrupo = {};
  let baseTotal = 0, valorTotal = 0;
  const porEstab = {};

  [...infoFGTS.getElementsByTagName('ideEstab')].forEach(estab=>{
    const nrInscEstab = textoTag(estab, 'nrInsc');
    if(!porEstab[nrInscEstab]) porEstab[nrInscEstab] = { base:0, valor:0 };
    [...estab.getElementsByTagName('basePerApur')].forEach(base=>{
      const tpValor = textoTag(base, 'tpValor');
      const baseFGTS = Number(textoTag(base,'baseFGTS')) || 0;
      const vrFGTS = Number(textoTag(base,'vrFGTS')) || 0;
      const grupo = grupoFgts(tpValor);
      if(!porGrupo[grupo]) porGrupo[grupo] = { base:0, valor:0 };
      porGrupo[grupo].base += baseFGTS; porGrupo[grupo].valor += vrFGTS;
      baseTotal += baseFGTS; valorTotal += vrFGTS;
      porEstab[nrInscEstab].base += baseFGTS; porEstab[nrInscEstab].valor += vrFGTS;
    });
  });

  return { arquivo: nomeArquivo, id, indApuracao, perApur, porGrupo, baseTotal, valorTotal, porEstab };
}
function agregarEvtFGTS(todosEvt){
  const unicos = deduplicarPorId(todosEvt);
  const porCompetencia = {}, porAno = {}, porEstabCompetencia = {};

  unicos.forEach(e=>{
    if(e.indApuracao === '2'){
      const ano = String(e.perApur||'').slice(0,4);
      if(!porAno[ano]) porAno[ano] = { base:0, valor:0 };
      porAno[ano].base += e.baseTotal; porAno[ano].valor += e.valorTotal;
    } else {
      const comp = e.perApur;
      if(!porCompetencia[comp]) porCompetencia[comp] = { porGrupo:{} };
      const acc = porCompetencia[comp];
      Object.entries(e.porGrupo).forEach(([grupo,dados])=>{
        if(!acc.porGrupo[grupo]) acc.porGrupo[grupo] = { base:0, valor:0 };
        acc.porGrupo[grupo].base += dados.base; acc.porGrupo[grupo].valor += dados.valor;
      });
      Object.entries(e.porEstab).forEach(([nrInsc,dados])=>{
        const chave = comp+'|'+nrInsc;
        if(!porEstabCompetencia[chave]) porEstabCompetencia[chave] = { perApur:comp, nrInsc, base:0, valor:0 };
        porEstabCompetencia[chave].base += dados.base;
        porEstabCompetencia[chave].valor += dados.valor;
      });
    }
  });

  return { porCompetencia, porAno, porEstabCompetencia, totalArquivos: todosEvt.length, totalUnicos: unicos.length };
}
function montarWorkbookS5013(agregado){
  const livro = XLSX.utils.book_new();
  const competencias = Object.keys(agregado.porCompetencia).sort();

  const cabResumo = ['Competência','Ano','Mês'];
  FGTS_GRUPOS_NOMES.forEach(nome=>{ cabResumo.push(`Base FGTS ${nome}`, `Valor FGTS ${nome}`); });
  cabResumo.push('Total FGTS do Mês');
  const linhasResumo = competencias.map(comp=>{
    const a = agregado.porCompetencia[comp];
    const [ano,mes] = comp.split('-');
    const linha = [comp, Number(ano), MESES_ABREV[Number(mes)-1]||mes];
    let total = 0;
    FGTS_GRUPOS_NOMES.forEach(nome=>{
      const d = a.porGrupo[nome] || {base:0,valor:0};
      linha.push(d.base, d.valor);
      total += d.valor;
    });
    linha.push(total);
    return linha;
  });
  XLSX.utils.book_append_sheet(livro, XLSX.utils.aoa_to_sheet([cabResumo, ...linhasResumo]), 'Resumo Mensal');

  const anos = Object.keys(agregado.porAno).sort();
  const cabAnual = ['Ano','Base de Cálculo (declarada)','Valor do Depósito FGTS'];
  const linhasAnual = anos.map(ano=>[Number(ano), agregado.porAno[ano].base, agregado.porAno[ano].valor]);
  if(linhasAnual.length){
    linhasAnual.push(['TOTAL GERAL', anos.reduce((s,a)=>s+agregado.porAno[a].base,0), anos.reduce((s,a)=>s+agregado.porAno[a].valor,0)]);
  }
  XLSX.utils.book_append_sheet(livro, XLSX.utils.aoa_to_sheet([cabAnual, ...linhasAnual]), 'Apuração Anual (13º)');

  const chavesEstab = Object.keys(agregado.porEstabCompetencia).sort();
  const cabEstab = ['Competência','CNPJ do Estabelecimento','Base de Cálculo (total)','Valor FGTS (total)'];
  const linhasEstab = chavesEstab.map(k=>{
    const d = agregado.porEstabCompetencia[k];
    return [d.perApur, d.nrInsc, d.base, d.valor];
  });
  XLSX.utils.book_append_sheet(livro, XLSX.utils.aoa_to_sheet([cabEstab, ...linhasEstab]), 'Por Estabelecimento');

  return livro;
}

async function gerarS5013(arquivos){
  const todosEvt = [];
  for(const arquivo of arquivos){
    const doc = new DOMParser().parseFromString(await arquivo.text(), 'text/xml');
    const evt = doc.getElementsByTagName('evtFGTS')[0];
    if(!evt){ throw new Error(`${arquivo.name}: não parece ser um XML de retorno do evento S-5013 (evtFGTS não encontrado).`); }
    todosEvt.push(parseEvtFGTS(evt, arquivo.name));
  }
  const agregado = agregarEvtFGTS(todosEvt);
  const livro = montarWorkbookS5013(agregado);
  await salvarWorkbook(livro, `s5013-fgts-${hojeLocalISO()}.xlsx`);
  const duplicados = agregado.totalArquivos - agregado.totalUnicos;
  return `Pronto! ${agregado.totalUnicos} evento(s) processado(s) (${Object.keys(agregado.porCompetencia).length} competência(s), ${Object.keys(agregado.porAno).length} ano(s) com 13º).` +
    (duplicados > 0 ? `\n${duplicados} arquivo(s) duplicado(s) (mesmo Id) foram ignorados.` : '');
}

/* ---------- card genérico "envie XML(s) e gere a planilha", reaproveitado pelas
   ferramentas que não precisam de nenhum arquivo extra além do(s) XML(s) ---------- */
let utilXmlGenericoProcessar = null;
function abrirUtilXmlGenerico({ titulo, descricao, processar }){
  document.getElementById('utilXmlGenericoTitulo').textContent = titulo;
  document.getElementById('utilXmlGenericoDescricao').textContent = descricao;
  document.getElementById('utilXmlGenerico_xmls').value = '';
  document.getElementById('utilXmlGenerico_status').textContent = '';
  utilXmlGenericoProcessar = processar;
  document.getElementById('utilEsocial').style.display = 'none';
  document.getElementById('utilXmlGenerico').style.display = '';
}
async function gerarUtilXmlGenerico(){
  const inputXmls = document.getElementById('utilXmlGenerico_xmls');
  const statusEl = document.getElementById('utilXmlGenerico_status');
  const arquivos = [...(inputXmls.files||[])];
  if(arquivos.length === 0){ toast('Selecione ao menos um arquivo XML.'); return; }
  if(typeof XLSX === 'undefined'){ toast('Não foi possível carregar o gerador de Excel. Confira sua internet.'); return; }
  if(!utilXmlGenericoProcessar) return;
  statusEl.textContent = 'Lendo arquivos…';
  try{
    statusEl.textContent = await utilXmlGenericoProcessar(arquivos);
    toast('Planilha gerada!');
  }catch(err){
    statusEl.textContent = '';
    toast(err && err.message ? err.message : 'Não foi possível gerar a planilha.');
  }
}

function exportarCsvGantt(){
  const { itens, de, ate, invalido } = calcularItensGantt();
  if(invalido){ toast('O período "Até" precisa ser depois do "De".'); return; }
  if(itens.length===0){ toast('Nada para exportar com esse período/filtros'); return; }
  const header = ['DATA','DATA PREVISTA','CLIENTE','USUARIO','MODULO','SUBMODULO','TIPO ATENDIMENTO','ATENDENTE','DETALHE','QTD','STATUS'];
  const rows = itens.map(r=>{
    const [y,m,d] = String(r.data).split('-');
    const dataFmt = `${d}/${m}/${y}`;
    let previstaFmt = '';
    if(r.dataPrevista){ const [py,pm,pd] = String(r.dataPrevista).split('-'); previstaFmt = `${pd}/${pm}/${py}`; }
    return [dataFmt, previstaFmt, r.cliente, r.usuario, r.modulo||'', r.submodulo||'', r.tipo, r.atendente,
      stripHtml(r.detalhe).replace(/;/g,','), Number(r.qtd).toFixed(2), r.status];
  });
  const csv = [header, ...rows].map(row=>row.join(';')).join('\n');
  const blob = new Blob(['\uFEFF'+csv], {type:'text/csv;charset=utf-8;'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href=url; a.download=`cronograma_${de}_a_${ate}.csv`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
  toast('CSV exportado');
}

/* ---------- salvar / gerenciar / publicar relatórios ---------- */
function configAtualRelatorio(){
  return {
    colunas: relColunas.slice(),
    agrupar: relAgrupar,
    tipoVisualizacao: relTipoVisualizacao,
    titulo: document.getElementById('rel_titulo').value.trim(),
    filtroCliente: [...relFiltroCliente],
    filtroTipo: [...relFiltroTipo],
    filtroStatus: [...relFiltroStatus],
  };
}

function carregarConfigNoRelatorio(config){
  relColunas = (config.colunas || []).slice();
  relAgrupar = config.agrupar || 'nenhum';
  relTipoVisualizacao = config.tipoVisualizacao || 'tabela';
  document.getElementById('rel_titulo').value = config.titulo || '';
  document.getElementById('rel_agrupar').value = relAgrupar;
  relFiltroCliente = new Set(config.filtroCliente || []);
  relFiltroTipo = new Set(config.filtroTipo || []);
  relFiltroStatus = new Set(config.filtroStatus || []);
}

function abrirModalSalvarRelatorio(){
  document.getElementById('salvarRelatorioTitulo').textContent = relEditandoId ? 'Editar relatório salvo' : 'Salvar relatório';
  document.getElementById('rel_salvar_nome').value = document.getElementById('rel_titulo').value.trim();
  document.getElementById('rel_salvar_publicado').checked = false;
  document.getElementById('rel_salvar_perfil_atendente').checked = false;
  document.getElementById('rel_salvar_perfil_usuario').checked = false;
  if(relEditandoId){
    const existente = (relatoriosSalvosCache || []).find(r=>r.id === relEditandoId);
    if(existente){
      document.getElementById('rel_salvar_nome').value = existente.nome;
      document.getElementById('rel_salvar_publicado').checked = !!existente.publicado;
      document.getElementById('rel_salvar_perfil_atendente').checked = (existente.visivelPerfis||[]).includes('ATENDENTE');
      document.getElementById('rel_salvar_perfil_usuario').checked = (existente.visivelPerfis||[]).includes('USUARIO');
    }
  }
  document.getElementById('salvarRelatorioModal').classList.add('show');
}
function fecharModalSalvarRelatorio(){
  document.getElementById('salvarRelatorioModal').classList.remove('show');
}

async function confirmarSalvarRelatorio(){
  const nome = document.getElementById('rel_salvar_nome').value.trim();
  if(!nome){ toast('Dê um nome ao relatório'); return; }
  const publicado = document.getElementById('rel_salvar_publicado').checked;
  const visivelPerfis = ['ADMIN'];
  if(document.getElementById('rel_salvar_perfil_atendente').checked) visivelPerfis.push('ATENDENTE');
  if(document.getElementById('rel_salvar_perfil_usuario').checked) visivelPerfis.push('USUARIO');

  const conta = contaAtual();
  const btn = document.getElementById('rel_salvar_confirmar');
  btn.disabled = true;
  try{
    const r = await api('salvarRelatorio', {
      id: relEditandoId, contaId: conta.id, nome, publicado, visivelPerfis,
      config: configAtualRelatorio(),
    });
    if(!r.ok){ toast(r.erro || 'Não foi possível salvar.'); return; }
    fecharModalSalvarRelatorio();
    relEditandoId = null;
    await carregarRelatoriosSalvos();
    renderListaRelatoriosSalvos();
    toast('Relatório salvo');
  }catch(e){
    toast(e && e.message ? e.message : 'Não foi possível salvar.');
  } finally {
    btn.disabled = false;
  }
}

let relatoriosSalvosCache = [];
async function carregarRelatoriosSalvos(){
  const conta = contaAtual();
  if(!conta) return;
  try{
    const r = await api('listarRelatoriosSalvos', { contaId: conta.id });
    if(r.ok) relatoriosSalvosCache = r.relatorios || [];
  }catch(e){ /* silencioso */ }
}

function renderListaRelatoriosSalvos(){
  const cont = document.getElementById('listaRelatoriosSalvos');
  if(!cont) return;
  if(relatoriosSalvosCache.length === 0){ cont.innerHTML = `<div class="empty" style="padding:10px 0;font-size:12.5px;">Nenhum relatório salvo ainda.</div>`; return; }
  cont.innerHTML = relatoriosSalvosCache.map(r=>`
    <div class="rel-relatorio-item">
      <div class="rel-relatorio-nome">${escaparHtml(r.nome)}</div>
      <div class="rel-relatorio-meta">${r.publicado ? '🟢 Publicado' : '⚪ Rascunho'} · Visível para: ${(r.visivelPerfis||[]).map(p=>({'ADMIN':'Admin','ATENDENTE':'Atendente','USUARIO':'Usuário'}[p]||p)).join(', ')}</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;">
        <button class="ghost" onclick="carregarRelatorioSalvoNoConstrutor('${r.id}')">Editar</button>
        <button class="ghost" onclick="removerRelatorioSalvo('${r.id}')">Excluir</button>
      </div>
    </div>`).join('');
}

function carregarRelatorioSalvoNoConstrutor(id){
  const r = relatoriosSalvosCache.find(x=>x.id === id);
  if(!r) return;
  relEditandoId = id;
  carregarConfigNoRelatorio(r.config || {});
  renderRelatorioColunas();
  renderRelatorioPreview();
  toast(`Editando "${r.nome}" — ajuste e clique em "💾 Salvar como relatório" pra atualizar`);
}

async function removerRelatorioSalvo(id){
  const conta = contaAtual();
  const r = await api('removerRelatorio', { id, contaId: conta.id });
  if(!r.ok){ toast(r.erro || 'Não foi possível remover.'); return; }
  await carregarRelatoriosSalvos();
  renderListaRelatoriosSalvos();
  toast('Relatório removido');
}

/* ---------- consumo de relatórios publicados (todo mundo autorizado) ---------- */
let relatoriosPublicadosCache = [];
async function carregarRelatoriosPublicados(){
  const conta = contaAtual();
  if(!conta) return;
  const cont = document.getElementById('listaRelatoriosPublicados');
  cont.innerHTML = `<div class="empty" style="padding:14px;">Carregando…</div>`;
  try{
    const r = await api('listarRelatoriosSalvos', { contaId: conta.id });
    if(!r.ok){ cont.innerHTML = `<div class="empty">${r.erro||'Não foi possível carregar.'}</div>`; return; }
    relatoriosPublicadosCache = (r.relatorios || []).filter(x=>x.publicado);
    if(relatoriosPublicadosCache.length === 0){ cont.innerHTML = `<div class="empty"><div class="big">📑</div>Nenhum relatório publicado disponível ainda.</div>`; return; }
    cont.innerHTML = relatoriosPublicadosCache.map(rel=>`
      <div class="rel-relatorio-item">
        <div class="rel-relatorio-nome">${escaparHtml(rel.nome)}</div>
        <div class="rel-relatorio-meta">${(rel.config && rel.config.tipoVisualizacao === 'ficha') ? 'Modelo detalhado (com fotos)' : 'Modelo em tabela'}</div>
        <button class="primary" onclick="usarRelatorioPublicado('${rel.id}')">Usar este relatório</button>
      </div>`).join('');
  }catch(e){
    cont.innerHTML = `<div class="empty">Não foi possível carregar os relatórios.</div>`;
  }
}

function usarRelatorioPublicado(id){
  const rel = relatoriosPublicadosCache.find(x=>x.id === id);
  if(!rel) return;
  relEditandoId = null; // consumindo, não editando o salvo original
  carregarConfigNoRelatorio(rel.config || {});
  document.getElementById('rel_titulo').value = rel.nome;
  document.getElementById('relatorioPubTitulo').textContent = rel.nome;
  document.getElementById('cardPreviewRelatoriosPub').style.display = '';
  renderRelatorioPreview();
  document.getElementById('cardPreviewRelatoriosPub').scrollIntoView({ behavior:'smooth' });
}

/* ---------- financeiro (lançamentos/faturas por cliente+mês) ---------- */
let finAtendimentosSelecionados = new Set();
let finFiltroCliente = new Set();
let finFiltroStatus = new Set();
let lancamentosCache = [];
let finLancamentoEmFoco = null; // id do lançamento sendo baixado/editado no modal

function popularClientesFinanceiro(){
  const sel = document.getElementById('fin_cliente');
  const atual = sel.value;
  sel.innerHTML = clientes.map(c=>`<option value="${escaparHtml(c.nome)}">${escaparHtml(c.nome)}</option>`).join('');
  if(atual && clientes.some(c=>c.nome===atual)) sel.value = atual;
}

function popularMesesFinanceiro(){
  const sel = document.getElementById('fin_mes');
  const atual = sel.value;
  const meses = mesesDisponiveis();
  sel.innerHTML = meses.map(m=>`<option value="${m}">${m}</option>`).join('');
  sel.value = atual && meses.includes(atual) ? atual : meses[0];
}

function atendimentosParaFinanceiro(){
  const cliente = document.getElementById('fin_cliente').value;
  const mes = document.getElementById('fin_mes').value;
  return atendimentos.filter(r=>r.cliente===cliente && r.mes===mes).sort((a,b)=>String(a.data).localeCompare(String(b.data)));
}

function renderFinAtendimentosLista(){
  const itens = atendimentosParaFinanceiro();
  // toda vez que troca cliente/mês, começa com tudo marcado
  finAtendimentosSelecionados = new Set(itens.map(r=>r.id));
  renderFinListaComSelecao(itens);
  atualizarValorTotalFin();
}

function renderFinListaComSelecao(itens){
  const cont = document.getElementById('finAtendimentosLista');
  if(itens.length === 0){ cont.innerHTML = `<div class="empty" style="padding:10px 0;font-size:12.5px;">Nenhum atendimento desse cliente nesse mês.</div>`; return; }
  cont.innerHTML = itens.map(r=>{
    const [y,m,d] = String(r.data).split('-');
    return `<label class="fin-item-check">
      <span style="display:flex;align-items:center;gap:8px;">
        <input type="checkbox" class="fin-check-item" data-id="${r.id}" ${finAtendimentosSelecionados.has(r.id)?'checked':''}>
        ${d}/${m} · ${escaparHtml(stripHtml(r.detalhe||'').slice(0,40))} · ${escaparHtml(r.status)}
      </span>
      <b style="color:var(--accent);">${fmtMoeda(Number(r.totalReal)||0)}</b>
    </label>`;
  }).join('');
}

function atualizarValorTotalFin(){
  const itens = atendimentosParaFinanceiro().filter(r=>finAtendimentosSelecionados.has(r.id));
  const total = itens.reduce((s,r)=>s+(Number(r.totalReal)||0), 0);
  document.getElementById('finValorTotal').textContent = fmtMoeda(total);
  return total;
}

async function gerarLancamento(){
  const cliente = document.getElementById('fin_cliente').value;
  const mesReferencia = document.getElementById('fin_mes').value;
  const dataVencimento = document.getElementById('fin_vencimento').value;
  if(!cliente || !mesReferencia){ toast('Escolha cliente e mês'); return; }
  if(!dataVencimento){ toast('Informe a data de vencimento'); return; }
  const atendimentoIds = [...finAtendimentosSelecionados];
  if(atendimentoIds.length === 0){ toast('Marque ao menos um atendimento'); return; }
  const valorTotal = atualizarValorTotalFin();

  const conta = contaAtual();
  const btn = document.getElementById('btnGerarLancamento');
  btn.disabled = true;
  try{
    const r = await api('criarLancamento', {
      contaId: conta.id, cliente, mesReferencia, valorTotal, atendimentoIds, dataVencimento,
      numeroNotaFiscal: document.getElementById('fin_nota_fiscal').value.trim(),
      historico: document.getElementById('fin_historico_novo').value.trim(),
      empresaId: empresaAtual ? empresaAtual.id : '',
    });
    if(!r.ok){ toast(r.erro || 'Não foi possível gerar o lançamento.'); return; }
    document.getElementById('fin_vencimento').value = '';
    document.getElementById('fin_nota_fiscal').value = '';
    document.getElementById('fin_historico_novo').value = '';
    await carregarLancamentos();
    renderListaLancamentos();
    toast('Lançamento gerado');
  }catch(e){
    toast(e && e.message ? e.message : 'Não foi possível gerar o lançamento.');
  } finally {
    btn.disabled = false;
  }
}

async function carregarLancamentos(){
  const conta = contaAtual();
  if(!conta) return;
  try{
    const r = await api('listarLancamentos', { contaId: conta.id, empresaId: empresaAtual ? empresaAtual.id : '' });
    if(r.ok) lancamentosCache = r.lancamentos || [];
  }catch(e){ /* silencioso */ }
}

function renderFinFiltros(){
  document.getElementById('finFiltroCliente').innerHTML = `<div class="chip ${finFiltroCliente.size===0?'on':''}" data-valor="TODOS">Todos</div>` +
    clientes.map(c=>`<div class="chip ${finFiltroCliente.has(c.nome)?'on':''}" data-valor="${c.nome}">${c.nome}</div>`).join('');
  document.getElementById('finFiltroStatus').innerHTML = `<div class="chip ${finFiltroStatus.size===0?'on':''}" data-valor="TODOS">Todos status</div>` +
    ['ABERTO','BAIXADO','CANCELADO'].map(s=>`<div class="chip ${finFiltroStatus.has(s)?'on':''}" data-valor="${s}">${s}</div>`).join('');
}

function renderListaLancamentos(){
  const cont = document.getElementById('listaLancamentos');
  let itens = lancamentosCache.slice();
  if(finFiltroCliente.size > 0) itens = itens.filter(l=>finFiltroCliente.has(l.cliente));
  if(finFiltroStatus.size > 0) itens = itens.filter(l=>finFiltroStatus.has(l.status));
  const de = document.getElementById('fin_lista_de').value;
  const ate = document.getElementById('fin_lista_ate').value;
  if(de) itens = itens.filter(l=>l.dataVencimento && l.dataVencimento >= de);
  if(ate) itens = itens.filter(l=>l.dataVencimento && l.dataVencimento <= ate);

  if(itens.length === 0){ cont.innerHTML = `<div class="empty"><div class="big">💵</div>Nenhum lançamento encontrado.</div>`; return; }

  const fmtData = s => { if(!s) return '—'; const [y,m,d]=s.split('-'); return `${d}/${m}/${y}`; };

  cont.innerHTML = itens.map(l=>`
    <div class="fin-lancamento">
      <div class="fin-topo">
        <div>
          <div class="fin-cliente">${escaparHtml(l.cliente)}</div>
          <div class="fin-mes">Referência: ${escaparHtml(l.mesReferencia)}${l.numeroNotaFiscal ? ' · NF ' + escaparHtml(l.numeroNotaFiscal) : ''}</div>
        </div>
        <div style="text-align:right;">
          <div class="fin-valor">${fmtMoeda(l.valorTotal)}</div>
          <span class="fin-status ${l.status}">${l.status}</span>
        </div>
      </div>
      <div class="fin-datas">
        <div><b>Vencimento</b>${fmtData(l.dataVencimento)}</div>
        <div><b>Previsão de baixa</b>${fmtData(l.dataPrevisaoBaixa)}</div>
        <div><b>Data de baixa</b>${fmtData(l.dataBaixa)}</div>
      </div>
      ${l.historico ? `<div class="fin-historico">${escaparHtml(l.historico)}</div>` : ''}
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;">
        ${l.status === 'ABERTO' ? `<button class="primary" onclick="abrirModalBaixar('${l.id}')" style="flex:none;width:auto;padding:10px 18px;margin-top:0;">Baixar</button>` : ''}
        <button class="ghost" onclick="abrirModalEditarLancamento('${l.id}')">Editar</button>
        ${l.status !== 'CANCELADO' ? `<button class="ghost" onclick="cancelarLancamentoUi('${l.id}')">Cancelar</button>` : ''}
        <button class="ghost" onclick="removerLancamentoUi('${l.id}')">Excluir</button>
      </div>
    </div>`).join('');
}

function abrirModalBaixar(id){
  finLancamentoEmFoco = id;
  document.getElementById('fin_data_baixa_input').value = new Date().toISOString().slice(0,10);
  document.getElementById('baixarLancamentoModal').classList.add('show');
}
function fecharModalBaixar(){
  document.getElementById('baixarLancamentoModal').classList.remove('show');
  finLancamentoEmFoco = null;
}
async function confirmarBaixaLancamento(){
  const dataBaixa = document.getElementById('fin_data_baixa_input').value;
  if(!dataBaixa){ toast('Informe a data de baixa'); return; }
  const conta = contaAtual();
  const r = await api('baixarLancamento', { contaId: conta.id, id: finLancamentoEmFoco, dataBaixa });
  if(!r.ok){ toast(r.erro || 'Não foi possível dar baixa.'); return; }
  fecharModalBaixar();
  await carregarLancamentos();
  renderListaLancamentos();
  toast('Baixa registrada');
}

function abrirModalEditarLancamento(id){
  const l = lancamentosCache.find(x=>x.id===id);
  if(!l) return;
  finLancamentoEmFoco = id;
  document.getElementById('fin_edit_vencimento').value = l.dataVencimento || '';
  document.getElementById('fin_edit_previsao').value = l.dataPrevisaoBaixa || '';
  document.getElementById('fin_edit_nota_fiscal').value = l.numeroNotaFiscal || '';
  document.getElementById('fin_edit_historico').value = l.historico || '';
  document.getElementById('editarLancamentoModal').classList.add('show');
}
function fecharModalEditarLancamento(){
  document.getElementById('editarLancamentoModal').classList.remove('show');
  finLancamentoEmFoco = null;
}
async function confirmarEdicaoLancamento(){
  const conta = contaAtual();
  const r = await api('atualizarLancamento', {
    contaId: conta.id, id: finLancamentoEmFoco,
    dataVencimento: document.getElementById('fin_edit_vencimento').value,
    dataPrevisaoBaixa: document.getElementById('fin_edit_previsao').value,
    numeroNotaFiscal: document.getElementById('fin_edit_nota_fiscal').value.trim(),
    historico: document.getElementById('fin_edit_historico').value.trim(),
  });
  if(!r.ok){ toast(r.erro || 'Não foi possível salvar.'); return; }
  fecharModalEditarLancamento();
  await carregarLancamentos();
  renderListaLancamentos();
  toast('Lançamento atualizado');
}

async function cancelarLancamentoUi(id){
  const conta = contaAtual();
  const r = await api('cancelarLancamento', { contaId: conta.id, id });
  if(!r.ok){ toast(r.erro || 'Não foi possível cancelar.'); return; }
  await carregarLancamentos();
  renderListaLancamentos();
  toast('Lançamento cancelado');
}

async function removerLancamentoUi(id){
  const conta = contaAtual();
  const r = await api('removerLancamento', { contaId: conta.id, id });
  if(!r.ok){ toast(r.erro || 'Não foi possível remover.'); return; }
  await carregarLancamentos();
  renderListaLancamentos();
  toast('Lançamento removido');
}

/* ---------- importar nota fiscal (XML) ---------- */
let xmlNotaOriginal = '';

function textoDaTag(escopo, tag){
  const el = escopo.getElementsByTagName(tag)[0];
  return el ? el.textContent.trim() : '';
}

function extrairDadosNota(textoXml){
  const parser = new DOMParser();
  const doc = parser.parseFromString(textoXml, 'text/xml');
  if(doc.querySelector('parsererror')) return null;

  const numero = textoDaTag(doc, 'Numero');
  const dataEmissaoBruta = textoDaTag(doc, 'DataEmissao'); // ex: 2026-08-03T13:35:35.463-03:00
  const dataEmissao = dataEmissaoBruta ? dataEmissaoBruta.slice(0,10) : '';
  const valorServicos = textoDaTag(doc, 'ValorServicos');
  const valorIss = textoDaTag(doc, 'ValorIss');
  const valorLiquido = textoDaTag(doc, 'ValorLiquidoNfse');
  const discriminacao = textoDaTag(doc, 'Discriminacao');

  // o RazaoSocial aparece 2x no XML (prestador e tomador) — tem que
  // buscar especificamente dentro de TomadorServico, senão pega a nossa
  // própria empresa (prestador) por engano
  const tomadorEl = doc.getElementsByTagName('TomadorServico')[0];
  const cliente = tomadorEl ? textoDaTag(tomadorEl, 'RazaoSocial') : '';
  const cnpjCpf = tomadorEl ? (textoDaTag(tomadorEl, 'Cnpj') || textoDaTag(tomadorEl, 'Cpf')) : '';

  if(!numero && !cliente) return null;
  return { numero, dataEmissao, cliente, cnpjCpf, valorServicos, valorIss, valorLiquido, discriminacao };
}

function preencherPreviewNota(dados, xmlOriginal){
  xmlNotaOriginal = xmlOriginal;
  document.getElementById('fin_xml_numero').value = dados.numero;
  document.getElementById('fin_xml_data').value = dados.dataEmissao;
  document.getElementById('fin_xml_cliente').value = dados.cliente;
  document.getElementById('fin_xml_cnpj').value = dados.cnpjCpf;
  document.getElementById('fin_xml_valor_servicos').value = dados.valorServicos;
  document.getElementById('fin_xml_valor_iss').value = dados.valorIss;
  document.getElementById('fin_xml_valor_liquido').value = dados.valorLiquido;
  document.getElementById('fin_xml_discriminacao').value = dados.discriminacao;
  document.getElementById('fin_xml_preview').style.display = '';
}

function lerArquivoComoTexto(arquivo){
  return new Promise((resolve, reject)=>{
    const leitor = new FileReader();
    leitor.onload = ev => resolve(ev.target.result);
    leitor.onerror = () => reject(new Error(`Não foi possível ler ${arquivo.name}`));
    leitor.readAsText(arquivo, 'UTF-8');
  });
}

async function aoEscolherArquivoXml(e){
  const arquivos = [...e.target.files];
  if(arquivos.length === 0) return;
  document.getElementById('fin_xml_resumo_lote').style.display = 'none';
  document.getElementById('fin_xml_preview').style.display = 'none';

  // 1 arquivo só: mostra a prévia pra conferir/editar antes de salvar
  // (comportamento de sempre)
  if(arquivos.length === 1){
    try{
      const texto = await lerArquivoComoTexto(arquivos[0]);
      const dados = extrairDadosNota(texto);
      if(!dados){ toast('Não consegui encontrar os dados da nota nesse arquivo. Confira se é o XML certo.'); return; }
      preencherPreviewNota(dados, texto);
    }catch(err){ toast(err.message); }
    return;
  }

  // vários arquivos de uma vez: importa tudo direto (sem revisão
  // individual — inviável revisar um por um nesse caso) e mostra um
  // resumo do que deu certo/errado no final
  const conta = contaAtual();
  const resumoEl = document.getElementById('fin_xml_resumo_lote');
  resumoEl.style.display = '';
  resumoEl.innerHTML = `<div class="empty" style="padding:10px 0;">Importando ${arquivos.length} arquivos…</div>`;

  let sucesso = 0, vinculadas = 0;
  const falhas = [];
  for(const arquivo of arquivos){
    try{
      const texto = await lerArquivoComoTexto(arquivo);
      const dados = extrairDadosNota(texto);
      if(!dados){ falhas.push(`${arquivo.name}: não parece um XML de nota fiscal válido`); continue; }
      const r = await api('importarNotaFiscal', {
        contaId: conta.id, numeroNota: dados.numero, codigoVerificacao: '',
        dataEmissao: dados.dataEmissao, cliente: dados.cliente, cnpjCpfTomador: dados.cnpjCpf,
        valorServicos: dados.valorServicos, valorIss: dados.valorIss, valorLiquido: dados.valorLiquido,
        discriminacao: dados.discriminacao, xmlOriginal: texto,
        empresaId: empresaAtual ? empresaAtual.id : '',
      });
      if(!r.ok){ falhas.push(`${arquivo.name}: ${r.erro || 'falha ao salvar'}`); continue; }
      sucesso++;
      if(r.clienteEncontrado) vinculadas++;
    }catch(err){
      falhas.push(`${arquivo.name}: ${err.message}`);
    }
  }

  document.getElementById('fin_xml_arquivo').value = '';
  await carregarNotasImportadas();
  renderListaNotasImportadas();
  resumoEl.innerHTML = `<div class="empty" style="padding:10px 0;text-align:left;">
    <b>${sucesso} de ${arquivos.length} nota(s) importada(s)</b>${sucesso>0 ? ` — ${vinculadas} vinculada(s) automaticamente ao cadastro pelo CNPJ` : ''}.
    ${falhas.length>0 ? `<div style="color:var(--bad);margin-top:6px;">${falhas.map(f=>escaparHtml(f)).join('<br>')}</div>` : ''}
  </div>`;
  toast(`${sucesso} nota(s) importada(s)`);
}

async function salvarNotaImportada(){
  const conta = contaAtual();
  const btn = document.getElementById('btnSalvarNotaImportada');
  btn.disabled = true;
  try{
    const r = await api('importarNotaFiscal', {
      contaId: conta.id,
      numeroNota: document.getElementById('fin_xml_numero').value.trim(),
      codigoVerificacao: '',
      dataEmissao: document.getElementById('fin_xml_data').value,
      cliente: document.getElementById('fin_xml_cliente').value.trim(),
      cnpjCpfTomador: document.getElementById('fin_xml_cnpj').value.trim(),
      valorServicos: document.getElementById('fin_xml_valor_servicos').value,
      valorIss: document.getElementById('fin_xml_valor_iss').value,
      valorLiquido: document.getElementById('fin_xml_valor_liquido').value,
      discriminacao: document.getElementById('fin_xml_discriminacao').value.trim(),
      xmlOriginal: xmlNotaOriginal,
      empresaId: empresaAtual ? empresaAtual.id : '',
    });
    if(!r.ok){ toast(r.erro || 'Não foi possível importar a nota.'); return; }
    document.getElementById('fin_xml_preview').style.display = 'none';
    document.getElementById('fin_xml_arquivo').value = '';
    xmlNotaOriginal = '';
    await carregarNotasImportadas();
    renderListaNotasImportadas();
    toast('Nota fiscal importada');
  }catch(e){
    toast(e && e.message ? e.message : 'Não foi possível importar a nota.');
  } finally {
    btn.disabled = false;
  }
}

let notasImportadasCache = [];
async function carregarNotasImportadas(){
  const conta = contaAtual();
  if(!conta) return;
  try{
    const r = await api('listarNotasImportadas', { contaId: conta.id, empresaId: empresaAtual ? empresaAtual.id : '' });
    if(r.ok) notasImportadasCache = r.notas || [];
  }catch(e){ /* silencioso */ }
}

function renderListaNotasImportadas(){
  const cont = document.getElementById('listaNotasImportadas');
  const de = document.getElementById('fin_notas_periodo_de').value;
  const ate = document.getElementById('fin_notas_periodo_ate').value;
  let notas = notasImportadasCache.slice();
  if(de) notas = notas.filter(n=>String(n.dataEmissao) >= de);
  if(ate) notas = notas.filter(n=>String(n.dataEmissao) <= ate);
  if(notas.length === 0){ cont.innerHTML = `<div class="empty" style="padding:10px 0;font-size:12.5px;">${notasImportadasCache.length === 0 ? 'Nenhuma nota importada ainda.' : 'Nenhuma nota nesse período.'}</div>`; return; }
  const fmtData = s => { if(!s) return '—'; const [y,m,d]=s.split('-'); return `${d}/${m}/${y}`; };
  cont.innerHTML = notas.map(n=>`
    <div class="fin-lancamento">
      <div class="fin-topo">
        <div>
          <div class="fin-cliente">${escaparHtml(n.cliente || '(sem tomador identificado)')}
            ${n.clienteId ? ' <span style="color:var(--ok);font-size:10.5px;">✓ vinculado ao cadastro</span>' : ' <span style="color:var(--bad);font-size:10.5px;">⚠ CNPJ não encontrado no cadastro</span>'}
          </div>
          <div class="fin-mes">NF ${escaparHtml(n.numeroNota)} · Emitida em ${fmtData(n.dataEmissao)}</div>
        </div>
        <div style="text-align:right;">
          <div class="fin-valor">${fmtMoeda(n.valorLiquido)}</div>
        </div>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;">
        ${n.lancamentoGeradoId
          ? `<span class="fin-status BAIXADO">✓ Financeiro já gerado</span>`
          : `<button class="primary" onclick="gerarFinanceiroDaNota('${n.id}')" style="flex:none;width:auto;padding:10px 18px;margin-top:0;">Gerar Financeiro</button>`}
        <button class="ghost" onclick="abrirVerNota('${n.id}')">Ver detalhes</button>
        <button class="ghost" onclick="baixarXmlNota('${n.id}')">⬇ Baixar XML</button>
        <button class="ghost" onclick="removerNotaImportadaUi('${n.id}')">Excluir</button>
      </div>
    </div>`).join('');
}

async function gerarFinanceiroDaNota(notaId){
  const nota = notasImportadasCache.find(n=>n.id===notaId);
  if(!nota) return;
  const conta = contaAtual();

  // vencimento padrão: 30 dias após a emissão — pode ajustar depois pelo "Editar"
  let vencimento = '';
  if(nota.dataEmissao){
    const d = new Date(nota.dataEmissao+'T00:00:00');
    d.setDate(d.getDate()+30);
    vencimento = d.toISOString().slice(0,10);
  }
  const [ano, mes] = (nota.dataEmissao || '').split('-');
  const mesReferencia = (mes && ano) ? `${mes}/${ano}` : mesesDisponiveis()[0];

  const r = await api('criarLancamento', {
    contaId: conta.id, cliente: nota.cliente || '(tomador não identificado)', mesReferencia,
    valorTotal: nota.valorLiquido, atendimentoIds: [], dataVencimento: vencimento,
    numeroNotaFiscal: nota.numeroNota,
    historico: `Gerado a partir da nota fiscal importada nº ${nota.numeroNota}.`,
    empresaId: empresaAtual ? empresaAtual.id : '',
  });
  if(!r.ok){ toast(r.erro || 'Não foi possível gerar o financeiro.'); return; }

  await api('vincularNotaLancamento', { contaId: conta.id, notaId: nota.id, lancamentoId: r.id });
  await Promise.all([carregarNotasImportadas(), carregarLancamentos()]);
  renderListaNotasImportadas();
  renderListaLancamentos();
  toast('Lançamento financeiro gerado a partir da nota — confira o vencimento (30 dias padrão)');
}

async function removerNotaImportadaUi(id){
  const conta = contaAtual();
  const r = await api('removerNotaImportada', { contaId: conta.id, id });
  if(!r.ok){ toast(r.erro || 'Não foi possível remover.'); return; }
  await carregarNotasImportadas();
  renderListaNotasImportadas();
  toast('Nota removida');
}

// percorre o XML inteiro e devolve uma linha por campo "folha" (sem
// filhos), com o caminho completo até ele — assim tags repetidas em
// lugares diferentes (ex: RazaoSocial existe no prestador E no tomador)
// não se confundem
function achatarXml(textoXml){
  const doc = new DOMParser().parseFromString(textoXml, 'text/xml');
  if(doc.querySelector('parsererror')) return [];
  const linhas = [];
  function caminhoDe(el){
    const partes = [];
    let atual = el;
    while(atual && atual.nodeType === 1){ partes.unshift(atual.tagName); atual = atual.parentElement; }
    return partes.join(' › ');
  }
  function percorrer(el){
    const filhos = [...el.children];
    if(filhos.length === 0){
      const valor = (el.textContent || '').trim();
      if(valor) linhas.push({ caminho: caminhoDe(el), valor });
    }else{
      filhos.forEach(percorrer);
    }
  }
  if(doc.documentElement) percorrer(doc.documentElement);
  return linhas;
}

function baixarXmlNota(id){
  const n = notasImportadasCache.find(x=>x.id===id);
  if(!n || !n.xmlOriginal){ toast('XML original não está disponível pra essa nota'); return; }
  const blob = new Blob([n.xmlOriginal], { type: 'text/xml;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `nota_fiscal_${n.numeroNota || n.id}.xml`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function abrirVerNota(id){
  const n = notasImportadasCache.find(x=>x.id===id);
  if(!n) return;
  const fmtData = s => { if(!s) return '—'; const [y,m,d]=s.split('-'); return `${d}/${m}/${y}`; };
  const linhasXml = n.xmlOriginal ? achatarXml(n.xmlOriginal) : [];
  const tabelaXml = linhasXml.length > 0
    ? `<table class="valores-table" style="font-size:11px;">
        <thead><tr><th>Campo (caminho no XML)</th><th>Valor</th></tr></thead>
        <tbody>${linhasXml.map(l=>`<tr><td style="color:var(--muted);">${escaparHtml(l.caminho)}</td><td>${escaparHtml(l.valor)}</td></tr>`).join('')}</tbody>
      </table>`
    : `<div class="empty" style="padding:10px 0;font-size:12px;">XML original não disponível pra essa nota.</div>`;

  document.getElementById('verNotaConteudo').innerHTML = `
    <div class="fin-datas" style="grid-template-columns:1fr 1fr;">
      <div><b>Número da Nota</b>${escaparHtml(n.numeroNota)}</div>
      <div><b>Data de Emissão</b>${fmtData(n.dataEmissao)}</div>
    </div>
    <p style="margin:12px 0 4px;"><b>Cliente (Tomador):</b> ${escaparHtml(n.cliente || '(não identificado)')}
      ${n.clienteId ? ' <span style="color:var(--ok);">✓ vinculado ao cadastro</span>' : ' <span style="color:var(--bad);">⚠ não vinculado — CNPJ não bateu com nenhum cliente cadastrado</span>'}</p>
    <p style="margin:4px 0;"><b>CNPJ/CPF:</b> ${escaparHtml(n.cnpjCpfTomador || '—')}</p>
    <div class="fin-datas" style="grid-template-columns:1fr 1fr 1fr;margin:10px 0;">
      <div><b>Valor Serviços</b>${fmtMoeda(n.valorServicos)}</div>
      <div><b>Valor ISS</b>${fmtMoeda(n.valorIss)}</div>
      <div><b>Valor Líquido</b>${fmtMoeda(n.valorLiquido)}</div>
    </div>
    <p style="margin:10px 0 4px;"><b>Discriminação:</b></p>
    <div class="fin-historico" style="white-space:pre-wrap;">${escaparHtml(n.discriminacao || '(vazio)')}</div>
    <p style="margin:12px 0 4px;"><b>Situação do Financeiro:</b> ${n.lancamentoGeradoId ? '✓ lançamento já gerado' : 'ainda não gerado'}</p>
    <p style="margin:4px 0;color:var(--muted);font-size:11.5px;">Importado por ${escaparHtml(n.importadoPor)}</p>
    <button class="ghost" onclick="baixarXmlNota('${n.id}')" style="margin:10px 0;">⬇ Baixar XML original</button>
    <p style="margin:16px 0 6px;"><b>Todos os campos do XML (${linhasXml.length}):</b></p>
    <div style="max-height:320px;overflow-y:auto;">${tabelaXml}</div>
  `;
  document.getElementById('verNotaModal').classList.add('show');
}

/* ---------- Financeiro: navegação por submenu ---------- */
let finAba = 'lancar';
function goFinSub(sub){
  finAba = sub;
  document.querySelectorAll('#finSubtabs .subtab').forEach(t=>t.classList.toggle('active', t.dataset.finsub===sub));
  document.querySelectorAll('.fin-sub-view').forEach(v=>{ v.style.display = (v.id === 'fin-sub-'+sub) ? '' : 'none'; });
  if(sub === 'resumo') renderResumoFinanceiro();
}

/* ---------- Agenda: navegação por submenu ---------- */
let agAba = 'novo';
function goAgSub(sub){
  agAba = sub;
  document.querySelectorAll('#agSubtabs .subtab').forEach(t=>t.classList.toggle('active', t.dataset.agsub===sub));
  document.querySelectorAll('.ag-sub-view').forEach(v=>{ v.style.display = (v.id === 'ag-sub-'+sub) ? '' : 'none'; });
}

/* ---------- Vídeos/Tutoriais: navegação por submenu ---------- */
let vidAba = 'lista';
function goVidSub(sub){
  vidAba = sub;
  document.querySelectorAll('#vidSubtabs .subtab').forEach(t=>t.classList.toggle('active', t.dataset.vidsub===sub));
  document.querySelectorAll('.vid-sub-view').forEach(v=>{ v.style.display = (v.id === 'vid-sub-'+sub) ? '' : 'none'; });
}

/* ---------- Financeiro: resumo (recebido, em aberto, previsão) ---------- */
let finResumoFiltroCliente = new Set();
function renderResumoFinanceiroFiltros(){
  document.getElementById('finResumoFiltroCliente').innerHTML = `<div class="chip ${finResumoFiltroCliente.size===0?'on':''}" data-valor="TODOS">Todos</div>` +
    clientes.map(c=>`<div class="chip ${finResumoFiltroCliente.has(c.nome)?'on':''}" data-valor="${c.nome}">${escaparHtml(c.nome)}</div>`).join('');
}
function renderResumoFinanceiro(){
  renderResumoFinanceiroFiltros();
  let itens = lancamentosCache.slice();
  if(finResumoFiltroCliente.size > 0) itens = itens.filter(l=>finResumoFiltroCliente.has(l.cliente));
  const de = document.getElementById('fin_resumo_de').value;
  const ate = document.getElementById('fin_resumo_ate').value;
  if(de) itens = itens.filter(l=>l.dataVencimento && l.dataVencimento >= de);
  if(ate) itens = itens.filter(l=>l.dataVencimento && l.dataVencimento <= ate);

  const somaPor = status => itens.filter(l=>l.status===status).reduce((s,l)=>s+Number(l.valorTotal), 0);
  const recebido = somaPor('BAIXADO');
  const aberto = somaPor('ABERTO');
  const previsto = recebido + aberto; // total geral do período/filtro, independente de já ter sido baixado

  document.getElementById('finResumoBoxes').innerHTML = `
    <div class="summary">
      <div class="box"><div class="k">Recebido (Baixado)</div><div class="v" style="color:var(--ok)">${fmtMoeda(recebido)}</div></div>
      <div class="box"><div class="k">Em Aberto</div><div class="v" style="color:var(--accent)">${fmtMoeda(aberto)}</div></div>
      <div class="box"><div class="k">Previsão Total</div><div class="v">${fmtMoeda(previsto)}</div></div>
    </div>
  `;
}

/* ---------- agenda ---------- */
let agendamentosCache = [];
let agModo = 'dia'; // 'dia' | 'semana' | 'mes'
let agDataRef = new Date();
let agFiltroAtendente = 'TODOS';
let agEditandoId = null;

function agIsoLocal(d){
  const y=d.getFullYear(), m=String(d.getMonth()+1).padStart(2,'0'), dd=String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${dd}`;
}
function agInicioSemana(d){
  const r = new Date(d); r.setDate(r.getDate() - r.getDay()); r.setHours(0,0,0,0); return r;
}

async function carregarAgendamentos(){
  const conta = contaAtual();
  if(!conta) return;
  try{
    const r = await api('listarAgendamentos', { contaId: conta.id });
    if(r.ok) agendamentosCache = r.agendamentos || [];
  }catch(e){ /* silencioso */ }
}

function popularSelectsAgenda(){
  const conta = contaAtual();
  const selCliente = document.getElementById('ag_cliente');
  const valorAtualCliente = selCliente.value;
  selCliente.innerHTML = `<option value="">(nenhum)</option>` + clientes.map(c=>`<option value="${escaparHtml(c.nome)}">${escaparHtml(c.nome)}</option>`).join('');
  if([...selCliente.options].some(o=>o.value===valorAtualCliente)) selCliente.value = valorAtualCliente;

  const selClienteEdit = document.getElementById('ag_edit_cliente');
  selClienteEdit.innerHTML = `<option value="">(nenhum)</option>` + clientes.map(c=>`<option value="${escaparHtml(c.nome)}">${escaparHtml(c.nome)}</option>`).join('');

  const atendentesNomes = contas.filter(c=>c.perfil==='ATENDENTE').map(c=>c.nome);
  const isAdmin = ehAdminEfetivo(conta);
  document.getElementById('campoAgendaAtendente').style.display = isAdmin ? '' : 'none';
  document.getElementById('campoAgendaEditAtendente').style.display = isAdmin ? '' : 'none';
  document.getElementById('campoAgendaFiltroAtendente').style.display = isAdmin ? '' : 'none';
  if(isAdmin){
    document.getElementById('ag_atendente').innerHTML = atendentesNomes.map(n=>`<option value="${escaparHtml(n)}">${escaparHtml(n)}</option>`).join('');
    document.getElementById('ag_edit_atendente').innerHTML = atendentesNomes.map(n=>`<option value="${escaparHtml(n)}">${escaparHtml(n)}</option>`).join('');
    document.getElementById('ag_filtro_atendente').innerHTML = `<option value="TODOS">Todos os atendentes</option>` + atendentesNomes.map(n=>`<option value="${escaparHtml(n)}">${escaparHtml(n)}</option>`).join('');
  }

  // só admin/atendente criam agendamento — usuário administrador do
  // cliente só consulta a própria agenda
  const podeGerenciar = conta && (conta.perfil === 'ADMIN' || conta.perfil === 'ATENDENTE');
  document.getElementById('cardNovoAgendamento').style.display = podeGerenciar ? '' : 'none';
}

function agendamentosFiltrados(){
  let itens = agendamentosCache.slice();
  if(agFiltroAtendente !== 'TODOS') itens = itens.filter(a=>a.atendente===agFiltroAtendente);
  return itens;
}

function atualizarLabelPeriodo(){
  const label = document.getElementById('agPeriodoLabel');
  if(agModo === 'dia'){
    label.textContent = agDataRef.toLocaleDateString('pt-BR', { weekday:'long', day:'2-digit', month:'long', year:'numeric' });
  }else if(agModo === 'semana'){
    const ini = agInicioSemana(agDataRef);
    const fim = new Date(ini); fim.setDate(fim.getDate()+6);
    label.textContent = `${ini.toLocaleDateString('pt-BR')} — ${fim.toLocaleDateString('pt-BR')}`;
  }else{
    label.textContent = agDataRef.toLocaleDateString('pt-BR', { month:'long', year:'numeric' });
  }
}

// monta o link do "Google Agenda" que, ao clicar, abre a tela de criar
// evento do Google já preenchida com os dados desse agendamento — não
// precisa de login/API do Google, é só uma URL com os parâmetros certos
function linkGoogleAgenda(a){
  const soDigitos = s => String(s || '').replace(/\D/g, '');
  const inicio = `${soDigitos(a.data)}T${soDigitos(a.horaInicio)}00`;
  const fim = `${soDigitos(a.data)}T${soDigitos(a.horaFim)}00`;
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: a.titulo || 'Compromisso',
    dates: `${inicio}/${fim}`,
    details: stripHtml(a.descricao || ''),
    location: a.cliente || '',
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/* ---------- grade de horários (visões Dia e Semana, estilo Google) ---------- */
const AG_PX_HORA = 48;
const AG_PALETA_CORES = ['#3B82F6','#F97316','#10B981','#8B5CF6','#EC4899','#14B8A6','#EF4444','#6366F1'];
let agGradeHoraMin = 7, agGradeHoraMax = 20;

function minutosDoDia(horaStr){
  const [h,m] = String(horaStr||'00:00').split(':').map(Number);
  return (h||0)*60 + (m||0);
}
function corDoEvento(a){
  if(a.cor) return a.cor; // cor escolhida manualmente tem prioridade
  const chave = a.atendente || a.cliente || a.titulo || '';
  let hash = 0;
  for(let i=0;i<chave.length;i++) hash = (hash*31 + chave.charCodeAt(i)) % 997;
  return AG_PALETA_CORES[Math.abs(hash) % AG_PALETA_CORES.length];
}

// as mesmas 11 cores que o Google Agenda oferece pra escolher manualmente
const AG_PALETA_ESCOLHA = [
  { nome:'Tomate', valor:'#D50000' }, { nome:'Flamingo', valor:'#E67C73' },
  { nome:'Tangerina', valor:'#F4511E' }, { nome:'Banana', valor:'#F6BF26' },
  { nome:'Sálvia', valor:'#33B679' }, { nome:'Manjericão', valor:'#0B8043' },
  { nome:'Pavão', valor:'#039BE5' }, { nome:'Mirtilo', valor:'#3F51B5' },
  { nome:'Lavanda', valor:'#7986CB' }, { nome:'Uva', valor:'#8E24AA' },
  { nome:'Grafite', valor:'#616161' },
];

function renderSeletorCores(containerId, corSelecionada){
  const cont = document.getElementById(containerId);
  const automaticaHtml = `<div class="ag-cor-opcao automatica ${!corSelecionada?'selecionada':''}" data-cor="" title="Automática (pelo atendente)"></div>`;
  cont.innerHTML = automaticaHtml + AG_PALETA_ESCOLHA.map(c=>`
    <div class="ag-cor-opcao ${corSelecionada===c.valor?'selecionada':''}" data-cor="${c.valor}" title="${c.nome}" style="background:${c.valor};"></div>
  `).join('');
}

// agrupa só os compromissos que realmente se sobrepõem no tempo — o
// resto do dia continua em largura cheia, igual o Google faz
function agGruposSobrepostos(eventos){
  const ordenado = eventos.slice().sort((a,b)=>minutosDoDia(a.horaInicio)-minutosDoDia(b.horaInicio));
  const grupos = [];
  let atual = [], fimAtual = -1;
  for(const ev of ordenado){
    const ini = minutosDoDia(ev.horaInicio);
    const fim = Math.max(ini+15, minutosDoDia(ev.horaFim));
    if(atual.length && ini >= fimAtual){ grupos.push(atual); atual = []; fimAtual = -1; }
    atual.push(ev);
    fimAtual = Math.max(fimAtual, fim);
  }
  if(atual.length) grupos.push(atual);
  return grupos;
}

// dentro de um grupo sobreposto, distribui em colunas lado a lado (o
// clássico algoritmo de "interval partitioning" que agendas usam)
function agPosicionarColunas(grupo){
  const ordenado = grupo.slice().sort((a,b)=>minutosDoDia(a.horaInicio)-minutosDoDia(b.horaInicio));
  const finsColuna = [];
  const posicoes = [];
  for(const ev of ordenado){
    const ini = minutosDoDia(ev.horaInicio);
    const fim = Math.max(ini+15, minutosDoDia(ev.horaFim));
    let col = finsColuna.findIndex(f=>f<=ini);
    if(col === -1){ col = finsColuna.length; finsColuna.push(fim); }
    else finsColuna[col] = fim;
    posicoes.push({ ev, col, ini, fim });
  }
  const totalColunas = finsColuna.length;
  return posicoes.map(p=>({...p, totalColunas}));
}

function agRenderBloco(p){
  const { ev, col, ini, fim, totalColunas } = p;
  const top = (ini - agGradeHoraMin*60) / 60 * AG_PX_HORA;
  const altura = Math.max(18, (fim - ini) / 60 * AG_PX_HORA - 2);
  const largura = 100/totalColunas;
  const esquerda = largura*col;
  const cor = corDoEvento(ev);
  return `<div class="ag-bloco-evento" style="top:${top}px;height:${altura}px;left:calc(${esquerda}% + 1px);width:calc(${largura}% - 2px);background:${cor};" onclick="abrirEditarAgendamento('${ev.id}')" title="${escaparHtml(ev.titulo)} · ${ev.horaInicio}–${ev.horaFim}">
    <div class="ag-bloco-titulo">${escaparHtml(ev.titulo)}</div>
    <div class="ag-bloco-hora">${ev.horaInicio}–${ev.horaFim}${ev.cliente ? ' · '+escaparHtml(ev.cliente) : ''}</div>
  </div>`;
}

// dias: [{ label, eventos }] — usada tanto pela visão Dia (1 coluna)
// quanto pela Semana (7 colunas)
function renderGradeHoraria(dias){
  let minHora = 7, maxHora = 20;
  dias.forEach(d=>d.eventos.forEach(ev=>{
    const hIni = Math.floor(minutosDoDia(ev.horaInicio)/60);
    const hFim = Math.ceil(minutosDoDia(ev.horaFim)/60);
    if(hIni < minHora) minHora = hIni;
    if(hFim > maxHora) maxHora = hFim;
  }));
  agGradeHoraMin = minHora; agGradeHoraMax = maxHora;
  const totalHoras = maxHora - minHora;
  const alturaTotal = totalHoras * AG_PX_HORA;

  const marcasHora = [];
  const linhasHora = [];
  for(let h=minHora; h<=maxHora; h++){
    marcasHora.push(`<div class="ag-hora-marca" style="top:${(h-minHora)*AG_PX_HORA}px;">${String(h).padStart(2,'0')}:00</div>`);
    linhasHora.push(`<div class="ag-linha-hora" style="top:${(h-minHora)*AG_PX_HORA}px;"></div>`);
  }

  const colunasDias = dias.map(d=>{
    const grupos = agGruposSobrepostos(d.eventos);
    const blocos = grupos.flatMap(g=>agPosicionarColunas(g).map(agRenderBloco)).join('');
    return `<div class="ag-coluna-dia" style="height:${alturaTotal}px;">${linhasHora.join('')}${blocos}</div>`;
  }).join('');

  const cabecalhoDias = dias.map(d=>`<div class="ag-grade-dia-cab">${d.label}</div>`).join('');
  const totalTemCompromisso = dias.some(d=>d.eventos.length>0);

  return `<div class="ag-grade-wrap">
    <div class="ag-grade-cabecalho-linha" style="grid-template-columns:52px repeat(${dias.length},1fr);">
      <div></div>${cabecalhoDias}
    </div>
    <div class="ag-grade-corpo" style="grid-template-columns:52px repeat(${dias.length},1fr);height:${alturaTotal}px;">
      <div class="ag-eixo-horas" style="height:${alturaTotal}px;">${marcasHora.join('')}</div>
      ${colunasDias}
    </div>
    ${totalTemCompromisso ? '' : `<div class="empty" style="padding:14px;"><div class="big">📅</div>Nenhum compromisso nesse período.</div>`}
  </div>`;
}

function renderAgendaDia(itens){
  const dataStr = agIsoLocal(agDataRef);
  const doDia = itens.filter(a=>a.data===dataStr);
  const label = agDataRef.toLocaleDateString('pt-BR',{weekday:'short',day:'2-digit'});
  return renderGradeHoraria([{ label, eventos: doDia }]);
}

function renderAgendaSemana(itens){
  const ini = agInicioSemana(agDataRef);
  const dias = [];
  for(let i=0;i<7;i++){
    const d = new Date(ini); d.setDate(d.getDate()+i);
    const dataStr = agIsoLocal(d);
    dias.push({
      label: `${d.toLocaleDateString('pt-BR',{weekday:'short'}).toUpperCase()} ${d.getDate()}`,
      eventos: itens.filter(a=>a.data===dataStr),
    });
  }
  return renderGradeHoraria(dias);
}

function renderAgendaMes(itens){
  const ano = agDataRef.getFullYear(), mes = agDataRef.getMonth();
  const primeiroDiaMes = new Date(ano, mes, 1);
  const inicioGrade = agInicioSemana(primeiroDiaMes);
  const hojeStr = agIsoLocal(new Date());

  const cabecalho = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'].map(d=>`<div class="ag-mes-cabecalho">${d}</div>`).join('');
  let celulas = '';
  for(let i=0;i<42;i++){
    const d = new Date(inicioGrade); d.setDate(d.getDate()+i);
    const dataStr = agIsoLocal(d);
    const doDia = itens.filter(a=>a.data===dataStr).sort((a,b)=>a.horaInicio.localeCompare(b.horaInicio));
    const foraDoMes = d.getMonth() !== mes;
    celulas += `<div class="ag-mes-dia ${foraDoMes?'fora-do-mes':''} ${dataStr===hojeStr?'hoje':''}">
      <div class="ag-mes-numero">${d.getDate()}</div>
      ${doDia.slice(0,3).map(a=>`<div class="ag-mes-item" onclick="abrirEditarAgendamento('${a.id}')" title="${escaparHtml(a.titulo)}" style="background:${corDoEvento(a)};color:#fff;">${a.horaInicio} ${escaparHtml(a.titulo)}</div>`).join('')}
      ${doDia.length>3 ? `<div style="color:var(--muted);font-size:9.5px;">+${doDia.length-3} mais</div>` : ''}
    </div>`;
  }
  return `<div class="ag-mes-grid">${cabecalho}${celulas}</div>`;
}

function renderAgenda(){
  atualizarLabelPeriodo();
  const itens = agendamentosFiltrados();
  const cont = document.getElementById('agendaConteudo');
  if(agModo === 'dia') cont.innerHTML = renderAgendaDia(itens);
  else if(agModo === 'semana') cont.innerHTML = renderAgendaSemana(itens);
  else cont.innerHTML = renderAgendaMes(itens);
}

function agNavegar(direcao){
  if(agModo === 'dia') agDataRef.setDate(agDataRef.getDate() + direcao);
  else if(agModo === 'semana') agDataRef.setDate(agDataRef.getDate() + direcao*7);
  else agDataRef.setMonth(agDataRef.getMonth() + direcao);
  renderAgenda();
}

function proximaDataRepeticao(dataAtual, tipo){
  const d = new Date(dataAtual+'T00:00:00');
  if(tipo === 'diaria') d.setDate(d.getDate()+1);
  else if(tipo === 'semanal') d.setDate(d.getDate()+7);
  else if(tipo === 'mensal') d.setMonth(d.getMonth()+1);
  return agIsoLocal(d);
}

async function criarAgendamento(){
  const conta = contaAtual();
  const titulo = document.getElementById('ag_titulo').value.trim();
  const dataInicial = document.getElementById('ag_data').value;
  const horaInicio = document.getElementById('ag_hora_inicio').value;
  const horaFim = document.getElementById('ag_hora_fim').value;
  if(!titulo || !dataInicial || !horaInicio || !horaFim){ toast('Preencha título, data e os dois horários'); return; }

  const isAdmin = ehAdminEfetivo(conta);
  const cliente = document.getElementById('ag_cliente').value;
  const atendente = isAdmin ? document.getElementById('ag_atendente').value : conta.nome;
  const descricao = sanitizarHtml(document.getElementById('ag_descricao').innerHTML.trim());
  const cor = document.getElementById('ag_cor_selecionada').value;

  const tipoRepeticao = document.getElementById('ag_repetir').value;
  const repetirAte = document.getElementById('ag_repetir_ate').value;

  // antes essas duas condições faziam a repetição ser ignorada em
  // silêncio (só criava 1 agendamento, sem avisar nada) — agora avisa
  // exatamente o que falta, em vez de parecer que "repetir não funciona"
  if(tipoRepeticao !== 'nao' && !repetirAte){ toast('Preencha "Repetir até" pra criar os agendamentos repetidos'); return; }
  if(tipoRepeticao !== 'nao' && repetirAte <= dataInicial){ toast('"Repetir até" precisa ser uma data depois da Data inicial'); return; }

  // monta a lista de datas: só a data escolhida (sem repetição), ou uma
  // por ocorrência até "repetir até" — com um teto de segurança (200)
  // pra nunca criar uma quantidade absurda de agendamentos sem querer
  const datas = [dataInicial];
  if(tipoRepeticao !== 'nao' && repetirAte && repetirAte > dataInicial){
    let atual = dataInicial;
    let seguranca = 0;
    while(seguranca < 200){
      atual = proximaDataRepeticao(atual, tipoRepeticao);
      if(atual > repetirAte) break;
      datas.push(atual);
      seguranca++;
    }
  }

  const btn = document.getElementById('btnCriarAgendamento');
  btn.disabled = true;
  try{
    let falhas = 0;
    for(const data of datas){
      const r = await api('criarAgendamento', { contaId: conta.id, titulo, data, horaInicio, horaFim, cliente, atendente, descricao, cor });
      if(!r.ok) falhas++;
    }
    document.getElementById('ag_titulo').value = '';
    document.getElementById('ag_descricao').innerHTML = '';
    document.getElementById('ag_repetir').value = 'nao';
    document.getElementById('ag_repetir_ate').value = '';
    document.getElementById('campoAgendaRepetirAte').style.display = 'none';
    document.getElementById('ag_cor_selecionada').value = '';
    renderSeletorCores('ag_cores', '');
    await carregarAgendamentos();
    renderAgenda();
    goAgSub('calendario');
    if(falhas > 0) toast(`${datas.length - falhas} de ${datas.length} agendamento(s) criado(s) — ${falhas} falharam`);
    else toast(datas.length > 1 ? `${datas.length} agendamentos criados` : 'Agendamento criado');
  } finally {
    btn.disabled = false;
  }
}

function abrirEditarAgendamento(id){
  const conta = contaAtual();
  const podeGerenciar = conta && (conta.perfil === 'ADMIN' || conta.perfil === 'ATENDENTE');
  if(!podeGerenciar) return; // usuário administrador do cliente só consulta
  const a = agendamentosCache.find(x=>x.id===id);
  if(!a) return;
  agEditandoId = id;
  document.getElementById('ag_edit_titulo').value = a.titulo;
  document.getElementById('ag_edit_data').value = a.data;
  document.getElementById('ag_edit_cliente').value = a.cliente || '';
  document.getElementById('ag_edit_hora_inicio').value = a.horaInicio;
  document.getElementById('ag_edit_hora_fim').value = a.horaFim;
  document.getElementById('ag_edit_descricao').innerHTML = sanitizarHtml(a.descricao || '');
  document.getElementById('ag_editar_google').href = linkGoogleAgenda(a);
  document.getElementById('ag_edit_cor').value = a.cor || '';
  renderSeletorCores('ag_cores_edit', a.cor || '');
  if(ehAdminEfetivo(conta)) document.getElementById('ag_edit_atendente').value = a.atendente || '';
  document.getElementById('editarAgendamentoModal').classList.add('show');
}
function fecharEditarAgendamento(){
  document.getElementById('editarAgendamentoModal').classList.remove('show');
  agEditandoId = null;
}
async function confirmarEdicaoAgendamento(){
  const conta = contaAtual();
  const r = await api('atualizarAgendamento', {
    contaId: conta.id, id: agEditandoId,
    titulo: document.getElementById('ag_edit_titulo').value.trim(),
    data: document.getElementById('ag_edit_data').value,
    cliente: document.getElementById('ag_edit_cliente').value,
    horaInicio: document.getElementById('ag_edit_hora_inicio').value,
    horaFim: document.getElementById('ag_edit_hora_fim').value,
    descricao: sanitizarHtml(document.getElementById('ag_edit_descricao').innerHTML.trim()),
    cor: document.getElementById('ag_edit_cor').value,
    ...(ehAdminEfetivo(conta) ? { atendente: document.getElementById('ag_edit_atendente').value } : {}),
  });
  if(!r.ok){ toast(r.erro || 'Não foi possível salvar.'); return; }
  fecharEditarAgendamento();
  await carregarAgendamentos();
  renderAgenda();
  toast('Agendamento atualizado');
}
async function excluirAgendamento(id){
  const conta = contaAtual();
  const r = await api('removerAgendamento', { contaId: conta.id, id });
  if(!r.ok){ toast(r.erro || 'Não foi possível excluir.'); return; }
  await carregarAgendamentos();
  renderAgenda();
  toast('Agendamento excluído');
}

function exportarCsv(){
  const mes = document.getElementById('r_mes').value;
  const conta = contaAtual();
  const isAdmin = ehAdminEfetivo(conta);
  const isAtendente = conta && conta.perfil === 'ATENDENTE';

  // mesmos filtros aplicados na tela do Resumo — senão o CSV sai com tudo,
  // ignorando o que a pessoa filtrou antes de exportar
  let itens = atendimentos.filter(r=>r.mes===mes);
  if(isAdmin){
    if(filtroResumoAtendente !== 'TODOS') itens = itens.filter(r=>r.atendente === filtroResumoAtendente || r.atendente2 === filtroResumoAtendente);
  }else if(isAtendente){
    itens = itens.filter(r=>r.atendente === conta.nome || r.atendente2 === conta.nome);
  }
  if((isAdmin || isAtendente) && filtroResumoCliente.size > 0) itens = itens.filter(r=>filtroResumoCliente.has(r.cliente));

  itens = itens.slice().sort((a,b)=>String(a.data).localeCompare(String(b.data)));
  if(itens.length===0){ toast('Nada para exportar com esse filtro'); return; }
  const header = ['DATA','MES','CLIENTE','USUARIO','MODULO','SUBMODULO','TIPO ATENDIMENTO','ATENDENTE','ASSUNTO','DETALHE','SOLUCAO','HI','INTER','HF','QTD','VALOR ATENDENTE/H','TOTAL ATENDENTE','2º ATENDENTE','HORAS 2º ATENDENTE','VALOR 2º ATENDENTE/H','TOTAL 2º ATENDENTE','STATUS','VHR','TOTAL REAL','ANEXO'];
  const rows = itens.map(r=>{
    const [y,m,d]=String(r.data).split('-');
    return [`${d}/${m}/${y}`, r.mes, r.cliente, r.usuario, r.modulo||'', r.submodulo||'', r.tipo, r.atendente, (r.assunto||'').replace(/;/g,','), stripHtml(r.detalhe).replace(/;/g,','), stripHtml(r.solucao).replace(/;/g,','), r.hi, r.inter, r.hf,
      Number(r.qtd).toFixed(2), r.vha, Number(r.totalAnanda).toFixed(2), r.atendente2||'', Number(r.horasAtendente2||0).toFixed(2), r.vha2||0, Number(r.totalAnanda2||0).toFixed(2), r.status, r.vhr, Number(r.totalReal).toFixed(2), r.anexoUrl||''];
  });
  const csv = [header, ...rows].map(row=>row.join(';')).join('\n');
  const blob = new Blob(['\uFEFF'+csv], {type:'text/csv;charset=utf-8;'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href=url; a.download=`atendimentos_${mes.replace('/','-')}.csv`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
  toast('CSV exportado');
}

/* ================= CADASTROS (somente ADMIN) ================= */
function renderCadastrosTudo(){
  renderListAtendentes(); renderListClientes(); renderListTipos(); renderListModulos(); renderListSubModulos(); renderListStatus(); renderValoresForm(); renderTabelaValores(); renderListUsuarios(); renderListPerfisAcesso(); renderListEmpresas();
  renderPerfisAcessoCheckboxes('at_perfis_acesso', editandoAtendenteId ? (contas.find(c=>String(c.id)===String(editandoAtendenteId))?.perfisAcessoIds||[]) : []);
  renderPerfisAcessoCheckboxes('us_perfis_acesso', editandoUsuarioId ? (contas.find(c=>String(c.id)===String(editandoUsuarioId))?.perfisAcessoIds||[]) : []);
  renderEmpresasCheckboxes('at_empresas', editandoAtendenteId ? (contas.find(c=>String(c.id)===String(editandoAtendenteId))?.empresaIds||[]) : (empresaAtual ? [empresaAtual.id] : []));
}

/* ---------- perfis de acesso (menus x visualizar/editar/excluir/inserir) ---------- */
function linhaMatrizPerfil(chave, label, perm, submenu){
  const p = perm[chave] || {};
  const cel = (campo)=>`<td><input type="checkbox" data-menu="${chave}" data-campo="${campo}" ${p[campo]?'checked':''}></td>`;
  return `<tr class="${submenu ? 'pa-submenu' : 'pa-menu'}"><td>${escaparHtml(label)}</td>${cel('visualizar')}${cel('editar')}${cel('excluir')}${cel('inserir')}</tr>`;
}
function renderMatrizPerfil(permissoesAtuais){
  const tbody = document.querySelector('#pa_matriz tbody');
  const perm = permissoesAtuais || {};
  tbody.innerHTML = MENUS_PERFIL_ACESSO.map(m=>{
    let html = linhaMatrizPerfil(m.chave, m.label, perm, false);
    if(m.submenus) html += m.submenus.map(s=>linhaMatrizPerfil(`${m.chave}.${s.chave}`, s.label, perm, true)).join('');
    return html;
  }).join('');
}
function lerMatrizPerfil(){
  const permissoes = {};
  const vazio = ()=>({visualizar:false, editar:false, excluir:false, inserir:false});
  MENUS_PERFIL_ACESSO.forEach(m=>{
    permissoes[m.chave] = vazio();
    (m.submenus||[]).forEach(s=>{ permissoes[`${m.chave}.${s.chave}`] = vazio(); });
  });
  document.querySelectorAll('#pa_matriz input[type=checkbox]').forEach(chk=>{
    permissoes[chk.dataset.menu][chk.dataset.campo] = chk.checked;
  });
  return permissoes;
}
function renderListPerfisAcesso(){
  const el = document.getElementById('listPerfisAcesso');
  if(!el) return;
  if(perfisAcesso.length === 0){ el.innerHTML = `<div class="empty">Nenhum perfil de acesso cadastrado.</div>`; return; }
  el.innerHTML = perfisAcesso.map(p=>{
    const qtdContas = contas.filter(c=>(c.perfisAcessoIds||[]).includes(p.id)).length;
    return `
    <div class="cad-item" style="cursor:pointer;" onclick="editarPerfilAcesso('${p.id}')">
      <div class="info"><b>${escaparHtml(p.nome)}</b><span>${qtdContas} conta${qtdContas===1?'':'s'} vinculada${qtdContas===1?'':'s'}</span></div>
      <div class="acts"><button class="danger" onclick="event.stopPropagation();pedirConfirmacao('Remover perfil de acesso?','As contas vinculadas a ele voltam ao acesso padrão do perfil (Atendente/Usuário).', ()=>removerPerfilAcessoUi('${p.id}'))">Remover</button></div>
    </div>`;
  }).join('');
}
function limparFormPerfilAcesso(){
  editandoPerfilAcessoId = null;
  document.getElementById('pa_tituloForm').textContent = 'Novo perfil de acesso';
  document.getElementById('pa_nome').value = '';
  renderMatrizPerfil({});
  document.getElementById('btnAddPerfilAcesso').textContent = 'Adicionar perfil';
  document.getElementById('btnCancelarEdicaoPerfilAcesso').style.display = 'none';
}
function editarPerfilAcesso(id){
  const p = perfisAcesso.find(x=>String(x.id)===String(id));
  if(!p) return;
  editandoPerfilAcessoId = id;
  document.getElementById('pa_tituloForm').textContent = `Editando: ${p.nome}`;
  document.getElementById('pa_nome').value = p.nome;
  renderMatrizPerfil(p.permissoes);
  document.getElementById('btnAddPerfilAcesso').textContent = 'Salvar alterações';
  document.getElementById('btnCancelarEdicaoPerfilAcesso').style.display = '';
  document.getElementById('pa_nome').scrollIntoView({behavior:'smooth', block:'start'});
}
async function removerPerfilAcessoUi(id){
  const conta = contaAtual();
  const r = await api('removerPerfilAcesso', { contaId: conta.id, id });
  if(!r.ok){ toast(r.erro || 'Não foi possível remover.'); return; }
  if(editandoPerfilAcessoId === id) limparFormPerfilAcesso();
  await carregarTudo();
  renderListPerfisAcesso();
  renderPerfisAcessoCheckboxes('at_perfis_acesso', editandoAtendenteId ? (contas.find(c=>String(c.id)===String(editandoAtendenteId))?.perfisAcessoIds||[]) : []);
  renderPerfisAcessoCheckboxes('us_perfis_acesso', editandoUsuarioId ? (contas.find(c=>String(c.id)===String(editandoUsuarioId))?.perfisAcessoIds||[]) : []);
  toast('Perfil removido');
}

// checkboxes de perfis de acesso usados nos formulários de Atendente/Usuário
function renderPerfisAcessoCheckboxes(containerId, idsMarcados){
  const el = document.getElementById(containerId);
  if(!el) return;
  const marcados = new Set(idsMarcados || []);
  if(perfisAcesso.length === 0){ el.innerHTML = `<div class="empty">Nenhum perfil de acesso cadastrado ainda — crie um na aba "Perfis de Acesso".</div>`; return; }
  el.innerHTML = perfisAcesso.map(p=>`
    <label><input type="checkbox" value="${p.id}" ${marcados.has(p.id)?'checked':''}> ${escaparHtml(p.nome)}</label>
  `).join('');
}
function lerPerfisAcessoMarcados(containerId){
  return [...document.querySelectorAll(`#${containerId} input[type=checkbox]:checked`)].map(c=>c.value);
}

// mesmo padrão acima, pra empresas vinculadas ao atendente/admin
function renderEmpresasCheckboxes(containerId, idsMarcados){
  const el = document.getElementById(containerId);
  if(!el) return;
  const marcados = new Set(idsMarcados || []);
  if(empresas.length === 0){ el.innerHTML = `<div class="empty">Nenhuma empresa cadastrada ainda — crie uma na aba "Empresas".</div>`; return; }
  el.innerHTML = empresas.map(e=>`
    <label><input type="checkbox" value="${e.id}" ${marcados.has(e.id)?'checked':''}> ${escaparHtml(e.nome)}</label>
  `).join('');
}
function lerEmpresasMarcadas(containerId){
  return [...document.querySelectorAll(`#${containerId} input[type=checkbox]:checked`)].map(c=>c.value);
}

/* ---------- empresas (multi-empresa) ---------- */
function renderListEmpresas(){
  const el = document.getElementById('listEmpresas');
  if(!el) return;
  if(empresas.length === 0){ el.innerHTML = `<div class="empty">Nenhuma empresa cadastrada.</div>`; return; }
  el.innerHTML = empresas.map(e=>{
    const selo = e.padrao ? ` <span class="tag" style="color:var(--accent);">padrão</span>` : '';
    const logo = e.logoUrl ? `<img src="${e.logoUrl}" style="width:28px;height:28px;border-radius:7px;object-fit:contain;background:var(--panel-2);margin-right:8px;vertical-align:middle;">` : '';
    return `
    <div class="cad-item" style="cursor:pointer;" onclick="editarEmpresa('${e.id}')">
      <div class="info">${logo}<b>${escaparHtml(e.nome)}</b>${selo}${e.cnpj?`<span>${escaparHtml(e.cnpj)}</span>`:''}</div>
      <div class="acts"><button class="danger" onclick="event.stopPropagation();pedirConfirmacao('Remover empresa?','Só é possível remover uma empresa sem clientes vinculados.', ()=>removerEmpresaUi('${e.id}'))">Remover</button></div>
    </div>`;
  }).join('');
}
function limparFormEmpresa(){
  editandoEmpresaId = null;
  document.getElementById('emp_tituloForm').textContent = 'Nova empresa';
  ['emp_nome','emp_nome_fantasia','emp_cnpj','emp_endereco','emp_telefone','emp_email','emp_cnae','emp_inscricao_municipal','emp_inscricao_estadual'].forEach(id=>document.getElementById(id).value='');
  document.getElementById('emp_horas_validacao').value = 48;
  document.getElementById('emp_padrao').checked = false;
  document.getElementById('emp_logo_arquivo').value = '';
  empresaLogoArquivoSelecionado = null;
  document.getElementById('emp_logo_preview').innerHTML = `<span style="font-size:11px;color:var(--muted);">sem logo</span>`;
  document.getElementById('emp_logo_preview').dataset.url = '';
  document.getElementById('btnAddEmpresa').textContent = 'Adicionar empresa';
  document.getElementById('btnCancelarEdicaoEmpresa').style.display = 'none';
}
function editarEmpresa(id){
  const e = empresas.find(x=>String(x.id)===String(id));
  if(!e) return;
  editandoEmpresaId = id;
  document.getElementById('emp_tituloForm').textContent = `Editando: ${e.nome}`;
  document.getElementById('emp_nome').value = e.nome;
  document.getElementById('emp_nome_fantasia').value = e.nomeFantasia || '';
  document.getElementById('emp_cnpj').value = e.cnpj || '';
  document.getElementById('emp_endereco').value = e.endereco || '';
  document.getElementById('emp_telefone').value = e.telefone || '';
  document.getElementById('emp_email').value = e.email || '';
  document.getElementById('emp_cnae').value = e.cnae || '';
  document.getElementById('emp_inscricao_municipal').value = e.inscricaoMunicipal || '';
  document.getElementById('emp_inscricao_estadual').value = e.inscricaoEstadual || '';
  document.getElementById('emp_horas_validacao').value = e.horasValidacaoAutomatica || 48;
  document.getElementById('emp_padrao').checked = !!e.padrao;
  document.getElementById('emp_logo_arquivo').value = '';
  empresaLogoArquivoSelecionado = null;
  const preview = document.getElementById('emp_logo_preview');
  preview.innerHTML = e.logoUrl ? `<img src="${e.logoUrl}" style="width:100%;height:100%;object-fit:contain;">` : `<span style="font-size:11px;color:var(--muted);">sem logo</span>`;
  preview.dataset.url = e.logoUrl || '';
  document.getElementById('btnAddEmpresa').textContent = 'Salvar alterações';
  document.getElementById('btnCancelarEdicaoEmpresa').style.display = '';
  document.getElementById('emp_nome').scrollIntoView({behavior:'smooth', block:'start'});
}
async function removerEmpresaUi(id){
  const conta = contaAtual();
  const r = await api('removerEmpresa', { contaId: conta.id, id });
  if(!r.ok){ toast(r.erro || 'Não foi possível remover.'); return; }
  if(editandoEmpresaId === id) limparFormEmpresa();
  await carregarTudo();
  renderCadastrosTudo();
  toast('Empresa removida');
}

function renderListAtendentes(){
  const lista = contas.filter(c=>c.perfil==='ATENDENTE');
  const el = document.getElementById('listAtendentes');
  if(lista.length===0){ el.innerHTML = `<div class="empty">Nenhum atendente cadastrado.</div>`; return; }
  el.innerHTML = lista.map(a=>{
    const contatos = linhaContatos(a.email, a.telefone);
    const selo = a.ehAdministrador ? ` <span class="tag" style="color:var(--accent);">administrador</span>` : '';
    return `
    <div class="cad-item" style="cursor:pointer;" onclick="editarAtendente('${a.id}')">
      <div class="info"><b>${a.nome}</b>${selo}<span>login: ${a.login}</span>${contatos}</div>
      <div class="acts"><button class="danger" onclick="event.stopPropagation();pedirConfirmacao('Remover atendente?','${a.nome} perderá acesso ao sistema.', ()=>removerConta('${a.id}'))">Remover</button></div>
    </div>`;
  }).join('');
}

function linhaContatos(email, telefone){
  const linkWpp = linkWhatsapp(telefone);
  const partes = [
    email ? `<a href="mailto:${email}" style="color:var(--muted);" onclick="event.stopPropagation();">${email}</a>` : '',
    linkWpp ? `<a href="${linkWpp}" target="_blank" style="color:var(--ok);" onclick="event.stopPropagation();">📱 WhatsApp</a>` : ''
  ].filter(Boolean).join(' · ');
  return partes ? `<span style="display:block;margin-top:2px;">${partes}</span>` : '';
}

function editarAtendente(id){
  const a = contas.find(c=>String(c.id)===String(id));
  if(!a) return;
  editandoAtendenteId = id;
  document.getElementById('at_tituloForm').textContent = `Editando: ${a.nome}`;
  document.getElementById('at_nome').value = a.nome;
  document.getElementById('at_login').value = a.login;
  document.getElementById('at_senha').value = '';
  document.getElementById('at_senha_hint').style.display = '';
  document.getElementById('at_email').value = a.email || '';
  document.getElementById('at_telefone').value = a.telefone || '';
  document.getElementById('at_administrador').checked = !!a.ehAdministrador;
  renderPerfisAcessoCheckboxes('at_perfis_acesso', a.perfisAcessoIds||[]);
  renderEmpresasCheckboxes('at_empresas', a.empresaIds||[]);
  document.getElementById('btnAddAtendente').textContent = 'Salvar alterações';
  document.getElementById('btnCancelarEdicaoAtendente').style.display = '';
  document.getElementById('at_nome').scrollIntoView({behavior:'smooth', block:'start'});
}

function cancelarEdicaoAtendente(){
  editandoAtendenteId = null;
  document.getElementById('at_tituloForm').textContent = 'Novo atendente';
  document.getElementById('at_nome').value = '';
  document.getElementById('at_login').value = '';
  document.getElementById('at_senha').value = '';
  document.getElementById('at_senha_hint').style.display = 'none';
  document.getElementById('at_email').value = '';
  document.getElementById('at_telefone').value = '';
  document.getElementById('at_administrador').checked = false;
  renderPerfisAcessoCheckboxes('at_perfis_acesso', []);
  renderEmpresasCheckboxes('at_empresas', empresaAtual ? [empresaAtual.id] : []);
  document.getElementById('btnAddAtendente').textContent = 'Adicionar atendente';
  document.getElementById('btnCancelarEdicaoAtendente').style.display = 'none';
}
async function removerConta(id){
  const r = await api('removerConta', { id });
  if(!r.ok) return;
  if(editandoAtendenteId === id) cancelarEdicaoAtendente();
  if(editandoUsuarioId === id) cancelarEdicaoUsuario();
  await carregarTudo(); renderCadastrosTudo(); popularSelects();
  toast('Removido');
}

function renderListClientes(){
  const el = document.getElementById('listClientes');
  // campo Empresa só aparece quando a conta enxerga a lista de empresas
  // (admin) — pra atendente/perfil sem isso, o cliente cadastrado herda a
  // empresa ativa da sessão em silêncio, igual já era antes desse campo existir
  const campoEmpresa = document.getElementById('campoClienteEmpresa');
  campoEmpresa.style.display = empresas.length > 0 ? '' : 'none';
  if(empresas.length > 0){
    document.getElementById('cl_empresa').innerHTML = empresas.map(e=>`<option value="${e.id}">${escaparHtml(e.nome)}</option>`).join('');
    document.getElementById('cl_empresa').value = empresaAtual ? empresaAtual.id : '';
  }
  if(clientes.length===0){ el.innerHTML = `<div class="empty">Nenhum cliente cadastrado.</div>`; return; }
  const mostrarEmpresa = empresas.length > 1;
  el.innerHTML = clientes.map(c=>{
    const nomeEmpresa = mostrarEmpresa ? empresas.find(e=>String(e.id)===String(c.empresaId))?.nome : '';
    return `
    <div class="cad-item"><div class="info"><b>${escaparHtml(c.nome)}</b>
      ${c.nomeFantasia ? `<span>${escaparHtml(c.nomeFantasia)}</span>` : ''}
      ${c.cnpj ? `<span>CNPJ: ${escaparHtml(c.cnpj)}</span>` : `<span style="color:var(--bad);">Sem CNPJ cadastrado</span>`}
      ${nomeEmpresa ? `<span>Empresa: ${escaparHtml(nomeEmpresa)}</span>` : ''}
      ${c.metaMensal ? `<span>Meta mensal: ${fmtMoeda(c.metaMensal)}</span>` : ''}
    </div>
    <div class="acts">
      <button class="ghost" onclick="editarCliente('${c.id}')">Editar</button>
      <button class="danger" onclick="pedirConfirmacao('Remover cliente?','Isso não apaga lançamentos já salvos, mas remove das opções futuras.', ()=>removerCliente('${c.id}'))">Remover</button>
    </div></div>`;
  }).join('');
}
function editarCliente(id){
  const c = clientes.find(x=>String(x.id)===String(id));
  if(!c) return;
  editandoClienteId = id;
  document.getElementById('cl_nome').value = c.nome;
  document.getElementById('cl_cnpj').value = c.cnpj || '';
  document.getElementById('cl_nome_fantasia').value = c.nomeFantasia || '';
  document.getElementById('cl_meta_mensal').value = c.metaMensal ? c.metaMensal : '';
  if(empresas.length > 0) document.getElementById('cl_empresa').value = c.empresaId || (empresaAtual ? empresaAtual.id : '');
  document.getElementById('btnAddCliente').textContent = 'Salvar alterações';
  document.getElementById('btnCancelarEdicaoCliente').style.display = '';
  document.getElementById('cl_nome').scrollIntoView({ behavior:'smooth', block:'center' });
}
function cancelarEdicaoCliente(){
  editandoClienteId = null;
  document.getElementById('cl_nome').value = '';
  document.getElementById('cl_cnpj').value = '';
  document.getElementById('cl_nome_fantasia').value = '';
  document.getElementById('cl_meta_mensal').value = '';
  if(empresas.length > 0) document.getElementById('cl_empresa').value = empresaAtual ? empresaAtual.id : '';
  document.getElementById('btnAddCliente').textContent = 'Adicionar cliente';
  document.getElementById('btnCancelarEdicaoCliente').style.display = 'none';
}
async function removerCliente(id){
  const r = await api('removerCliente', { id });
  if(!r.ok) return;
  await carregarTudo(); renderCadastrosTudo(); popularSelects(); renderFiltros();
  toast('Cliente removido');
}

/* ---------- vídeos / tutoriais ---------- */
let videosCache = [];
let editandoVideoId = null;
let vidFiltroModulo = 'TODOS';
let vidSelecionadoId = null; // aula em destaque no player, na visão "Vídeos"

function extrairIdYoutube(url){
  if(!url) return '';
  const m = String(url).match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : '';
}

function popularSelectsVideo(){
  const selCliente = document.getElementById('vid_cliente');
  const atual = selCliente.value;
  selCliente.innerHTML = `<option value="">Todos os clientes</option>` + clientes.map(c=>`<option value="${escaparHtml(c.nome)}">${escaparHtml(c.nome)}</option>`).join('');
  if([...selCliente.options].some(o=>o.value===atual)) selCliente.value = atual;

  const selModulo = document.getElementById('vid_modulo');
  const atualMod = selModulo.value;
  selModulo.innerHTML = `<option value="">(nenhum)</option>` + modulos.map(m=>`<option value="${escaparHtml(m.nome)}">${escaparHtml(m.nome)}</option>`).join('');
  if([...selModulo.options].some(o=>o.value===atualMod)) selModulo.value = atualMod;
}

function renderFiltroModuloVideo(){
  const modulosComVideo = [...new Set(videosCache.map(v=>v.modulo).filter(Boolean))];
  const cont = document.getElementById('vidFiltroModulo');
  if(modulosComVideo.length === 0){ document.getElementById('cardFiltroVideoModulo').style.display = 'none'; return; }
  document.getElementById('cardFiltroVideoModulo').style.display = '';
  cont.innerHTML = `<div class="chip ${vidFiltroModulo==='TODOS'?'on':''}" data-valor="TODOS">Todos</div>` +
    modulosComVideo.map(m=>`<div class="chip ${vidFiltroModulo===m?'on':''}" data-valor="${escaparHtml(m)}">${escaparHtml(m)}</div>`).join('');
}

async function carregarVideos(){
  const conta = contaAtual();
  if(!conta) return;
  const cont = document.getElementById('listaVideos');
  cont.innerHTML = `<div class="empty" style="padding:14px;">Carregando…</div>`;
  try{
    const r = await api('listarVideos', { contaId: conta.id, empresaId: empresaAtual ? empresaAtual.id : '' });
    if(!r.ok){ cont.innerHTML = `<div class="empty">${r.erro || 'Não foi possível carregar.'}</div>`; return; }
    videosCache = r.videos || [];
    renderFiltroModuloVideo();
    renderListaVideos();
  }catch(e){
    cont.innerHTML = `<div class="empty">Não foi possível carregar os vídeos.</div>`;
  }
}

function renderListaVideos(){
  const conta = contaAtual();
  const isAdmin = ehAdminEfetivo(conta);
  const cont = document.getElementById('listaVideos');
  let itens = videosCache.slice();
  if(vidFiltroModulo !== 'TODOS') itens = itens.filter(v=>v.modulo === vidFiltroModulo);

  if(itens.length === 0){
    vidSelecionadoId = null;
    cont.innerHTML = `<div class="empty"><div class="big">🎬</div>Nenhum vídeo disponível ainda.</div>`;
    return;
  }

  // mantém a aula em destaque se ela ainda estiver visível (ex: depois de
  // recarregar); senão, cai pra primeira da lista
  if(!itens.some(v=>v.id===vidSelecionadoId)) vidSelecionadoId = itens[0].id;

  cont.innerHTML = `<div id="vidPlayerArea"></div><div id="vidAulasLista"></div>`;
  renderVidPlayer(isAdmin);
  renderVidAulasLista(itens, isAdmin);
}

// player grande com a aula em destaque no topo — igual a tela de "assistir
// aula" de um site de cursos, com os detalhes/comentários logo abaixo
function renderVidPlayer(isAdmin){
  const wrap = document.getElementById('vidPlayerArea');
  if(!wrap) return;
  const v = videosCache.find(x=>x.id===vidSelecionadoId);
  if(!v){ wrap.innerHTML = ''; return; }
  const videoId = extrairIdYoutube(v.urlYoutube);
  // o parâmetro "origin" evita o Erro 153 do player em vários casos —
  // sem ele, alguns navegadores/domínios têm o embed recusado mesmo
  // com o vídeo liberado pra incorporação
  const origem = encodeURIComponent(window.location.origin);
  const embed = videoId
    ? `<iframe class="vid-embed" src="https://www.youtube.com/embed/${videoId}?rel=0&origin=${origem}" title="${escaparHtml(v.titulo)}" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen loading="lazy"></iframe>`
    : `<div class="empty" style="padding:10px 0;font-size:12px;">Link do YouTube parece inválido.</div>`;
  const linkOriginal = videoId ? `https://www.youtube.com/watch?v=${videoId}` : v.urlYoutube;
  const perfisTexto = (v.visivelPerfis||[]).map(p=>p==='ATENDENTE'?'Atendentes':p==='USUARIO'?'Usuários':p).join(', ');
  wrap.innerHTML = `<div class="card vid-player-card">
      ${embed}
      ${videoId ? `<a href="${linkOriginal}" target="_blank" rel="noopener" class="vid-link-alternativo">▶ Não carregou? Assistir direto no YouTube</a>` : ''}
      <div class="vid-titulo">${escaparHtml(v.titulo)}</div>
      ${v.descricao ? `<div class="vid-descricao">${escaparHtml(v.descricao)}</div>` : ''}
      <div class="vid-meta">${v.cliente ? escaparHtml(v.cliente) : 'Todos os clientes'}${v.modulo ? ' · '+escaparHtml(v.modulo) : ''}${isAdmin ? ' · Visível pra: '+escaparHtml(perfisTexto) : ''}</div>
      ${isAdmin ? `<div class="vid-acoes">
        <button class="ghost" onclick="editarVideoUi('${v.id}')">Editar</button>
        <button class="ghost" onclick="pedirConfirmacao('Remover vídeo?','Isso não pode ser desfeito.', ()=>removerVideoUi('${v.id}'))">Excluir</button>
      </div>` : ''}
      <div class="vid-comentarios" id="vidComentarios_${v.id}"></div>
    </div>`;
  carregarComentariosVideo(v.id);
}

// lista de "aulas" agrupada por módulo, abaixo/ao lado do player — clicar
// numa aula troca o vídeo em destaque sem recarregar a página
function renderVidAulasLista(itens, isAdmin){
  const cont = document.getElementById('vidAulasLista');
  if(!cont) return;
  const porModulo = new Map();
  const ordemGrupos = [];
  itens.forEach(v=>{
    const chave = v.modulo || '';
    if(!porModulo.has(chave)){ porModulo.set(chave, []); ordemGrupos.push(chave); }
    porModulo.get(chave).push(v);
  });
  // módulos de verdade primeiro, na ordem em que aparecem; vídeo sem
  // módulo cadastrado cai num grupo "Outros vídeos" no final
  ordemGrupos.sort((a,b)=> (a===''?1:0) - (b===''?1:0));

  cont.innerHTML = ordemGrupos.map(chave=>{
    const lista = porModulo.get(chave);
    const titulo = chave || 'Outros vídeos';
    const linhas = lista.map((v,i)=>renderVidAulaLinha(v, i+1, isAdmin)).join('');
    return `<div class="vid-modulo-grupo">
      <div class="vid-modulo-titulo">${escaparHtml(titulo)}<span class="vid-modulo-contagem">${lista.length}</span></div>
      <div class="vid-aulas-lista">${linhas}</div>
    </div>`;
  }).join('');
}

function renderVidAulaLinha(v, numero, isAdmin){
  const videoId = extrairIdYoutube(v.urlYoutube);
  const thumb = videoId ? `https://img.youtube.com/vi/${videoId}/mqdefault.jpg` : '';
  const ativo = v.id === vidSelecionadoId;
  return `<div class="vid-aula-item${ativo?' ativo':''}" data-id="${escaparHtml(v.id)}" onclick="selecionarVideoUi('${v.id}')">
    <div class="vid-aula-thumb">${thumb ? `<img src="${thumb}" alt="" loading="lazy">` : '🎬'}${ativo ? '<span class="vid-aula-play">▶</span>' : ''}</div>
    <div class="vid-aula-info">
      <div class="vid-aula-titulo">${numero}. ${escaparHtml(v.titulo)}</div>
      ${v.descricao ? `<div class="vid-aula-desc">${escaparHtml(v.descricao)}</div>` : ''}
    </div>
    ${isAdmin ? `<div class="vid-aula-acoes" onclick="event.stopPropagation();">
      <button class="ghost" onclick="editarVideoUi('${v.id}')" title="Editar">✎</button>
      <button class="ghost" onclick="pedirConfirmacao('Remover vídeo?','Isso não pode ser desfeito.', ()=>removerVideoUi('${v.id}'))" title="Excluir">🗑</button>
    </div>` : ''}
  </div>`;
}

// troca só o destaque (classe "ativo" + player), sem re-renderizar a lista
// inteira — evita perder a posição do scroll ao clicar numa aula
function selecionarVideoUi(id){
  if(vidSelecionadoId === id) return;
  vidSelecionadoId = id;
  document.querySelectorAll('#vidAulasLista .vid-aula-item.ativo').forEach(el=>{
    el.classList.remove('ativo');
    const play = el.querySelector('.vid-aula-play');
    if(play) play.remove();
  });
  const linha = document.querySelector(`#vidAulasLista .vid-aula-item[data-id="${CSS.escape(id)}"]`);
  if(linha){
    linha.classList.add('ativo');
    linha.querySelector('.vid-aula-thumb')?.insertAdjacentHTML('beforeend', '<span class="vid-aula-play">▶</span>');
  }
  renderVidPlayer(ehAdminEfetivo(contaAtual()));
  document.getElementById('vidPlayerArea')?.scrollIntoView({ behavior:'smooth', block:'start' });
}

function limparFormVideo(){
  editandoVideoId = null;
  document.getElementById('vid_titulo').value = '';
  document.getElementById('vid_url').value = '';
  document.getElementById('vid_descricao').value = '';
  document.getElementById('vid_cliente').value = '';
  document.getElementById('vid_modulo').value = '';
  document.getElementById('vid_perfil_atendente').checked = true;
  document.getElementById('vid_perfil_usuario').checked = true;
  document.getElementById('tituloFormVideo').textContent = 'Novo vídeo/tutorial';
  document.getElementById('btnAddVideo').textContent = 'Adicionar vídeo';
  document.getElementById('btnCancelarEdicaoVideo').style.display = 'none';
}

function editarVideoUi(id){
  const v = videosCache.find(x=>x.id===id);
  if(!v) return;
  editandoVideoId = id;
  document.getElementById('vid_titulo').value = v.titulo;
  document.getElementById('vid_url').value = v.urlYoutube;
  document.getElementById('vid_descricao').value = v.descricao || '';
  document.getElementById('vid_cliente').value = v.cliente || '';
  document.getElementById('vid_modulo').value = v.modulo || '';
  document.getElementById('vid_perfil_atendente').checked = (v.visivelPerfis||[]).includes('ATENDENTE');
  document.getElementById('vid_perfil_usuario').checked = (v.visivelPerfis||[]).includes('USUARIO');
  document.getElementById('tituloFormVideo').textContent = 'Editar vídeo/tutorial';
  document.getElementById('btnAddVideo').textContent = 'Salvar alterações';
  document.getElementById('btnCancelarEdicaoVideo').style.display = '';
  goVidSub('novo');
}

async function salvarVideoUi(){
  const conta = contaAtual();
  const titulo = document.getElementById('vid_titulo').value.trim();
  const urlYoutube = document.getElementById('vid_url').value.trim();
  if(!titulo || !urlYoutube){ toast('Preencha o título e o link do YouTube'); return; }
  if(!extrairIdYoutube(urlYoutube)){ toast('Não consegui reconhecer esse link como um vídeo do YouTube'); return; }

  const visivelPerfis = [];
  if(document.getElementById('vid_perfil_atendente').checked) visivelPerfis.push('ATENDENTE');
  if(document.getElementById('vid_perfil_usuario').checked) visivelPerfis.push('USUARIO');
  if(visivelPerfis.length === 0){ toast('Marque pelo menos um perfil que pode ver esse vídeo'); return; }

  const payload = {
    contaId: conta.id, titulo, urlYoutube,
    descricao: document.getElementById('vid_descricao').value.trim(),
    cliente: document.getElementById('vid_cliente').value,
    modulo: document.getElementById('vid_modulo').value,
    visivelPerfis, empresaId: empresaAtual ? empresaAtual.id : '',
  };
  const editando = !!editandoVideoId;
  const idEditado = editandoVideoId;
  const btn = document.getElementById('btnAddVideo');
  btn.disabled = true;
  try{
    const r = editando
      ? await api('atualizarVideo', { ...payload, id: editandoVideoId })
      : await api('criarVideo', payload);
    if(!r.ok){ toast(r.erro || 'Não foi possível salvar.'); return; }
    limparFormVideo();
    vidSelecionadoId = editando ? idEditado : r.id; // já deixa a aula salva em destaque no player
    await carregarVideos();
    goVidSub('lista');
    toast(editando ? 'Vídeo atualizado' : 'Vídeo adicionado');
  }catch(e){
    toast(e && e.message ? e.message : 'Não foi possível salvar.');
  } finally {
    btn.disabled = false;
  }
}

async function removerVideoUi(id){
  const conta = contaAtual();
  const r = await api('removerVideo', { contaId: conta.id, id });
  if(!r.ok){ toast(r.erro || 'Não foi possível remover.'); return; }
  await carregarVideos();
  toast('Vídeo removido');
}

/* ---------- comentários de vídeo ---------- */
let comentariosVideoCache = {}; // videoId -> lista de comentários

function fmtDataComentario(iso){
  if(!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', {hour:'2-digit',minute:'2-digit'});
}

async function carregarComentariosVideo(videoId){
  const conta = contaAtual();
  if(!conta) return;
  const cont = document.getElementById(`vidComentarios_${videoId}`);
  if(!cont) return;
  try{
    const r = await api('listarComentariosVideo', { contaId: conta.id, videoId });
    if(!r.ok){ cont.innerHTML = ''; return; }
    comentariosVideoCache[videoId] = r.comentarios || [];
    renderComentariosVideo(videoId);
  }catch(e){ /* silencioso */ }
}

function renderComentariosVideo(videoId){
  const conta = contaAtual();
  const cont = document.getElementById(`vidComentarios_${videoId}`);
  if(!cont) return;
  const comentarios = comentariosVideoCache[videoId] || [];
  const listaHtml = comentarios.length === 0
    ? `<div style="color:var(--muted);font-size:11.5px;">Nenhum comentário ainda.</div>`
    : comentarios.map(c=>{
        const podeExcluir = conta && (ehAdminEfetivo(conta) || conta.nome === c.autorNome);
        return `<div class="vid-comentario-item">
          <div class="vid-comentario-topo">
            <span class="vid-comentario-nome">${escaparHtml(c.autorNome)}</span>
            <span class="vid-comentario-data">${fmtDataComentario(c.criadoEm)}</span>
          </div>
          <div>${escaparHtml(c.texto)}</div>
          ${podeExcluir ? `<button type="button" class="vid-comentario-excluir" onclick="removerComentarioVideoUi('${c.id}','${videoId}')">Excluir</button>` : ''}
        </div>`;
      }).join('');
  cont.innerHTML = `
    <div class="vid-comentarios-titulo">💬 Comentários (${comentarios.length})</div>
    ${listaHtml}
    <div class="vid-comentario-add">
      <textarea id="vidComentarioTexto_${videoId}" placeholder="Escreva um comentário…"></textarea>
      <button type="button" onclick="enviarComentarioVideo('${videoId}')">Enviar</button>
    </div>
  `;
}

async function enviarComentarioVideo(videoId){
  const conta = contaAtual();
  const campo = document.getElementById(`vidComentarioTexto_${videoId}`);
  const texto = campo.value.trim();
  if(!texto){ toast('Escreva um comentário'); return; }
  const r = await api('criarComentarioVideo', { contaId: conta.id, videoId, texto });
  if(!r.ok){ toast(r.erro || 'Não foi possível comentar.'); return; }
  await carregarComentariosVideo(videoId);
}

async function removerComentarioVideoUi(id, videoId){
  const conta = contaAtual();
  const r = await api('removerComentarioVideo', { contaId: conta.id, id });
  if(!r.ok){ toast(r.erro || 'Não foi possível excluir.'); return; }
  await carregarComentariosVideo(videoId);
}

function renderListTipos(){
  const el = document.getElementById('listTipos');
  if(tipos.length===0){ el.innerHTML = `<div class="empty">Nenhum tipo cadastrado.</div>`; return; }
  el.innerHTML = tipos.map(t=>`
    <div class="cad-item"><div class="info"><b>${t.nome}</b></div>
    <div class="acts"><button class="danger" onclick="pedirConfirmacao('Remover tipo?','Remove das opções futuras de lançamento.', ()=>removerTipo('${t.id}'))">Remover</button></div></div>`).join('');
}
async function removerTipo(id){
  const r = await api('removerTipo', { id });
  if(!r.ok) return;
  await carregarTudo(); renderCadastrosTudo(); popularSelects();
  toast('Tipo removido');
}

function renderListModulos(){
  const el = document.getElementById('listModulos');
  if(modulos.length===0){ el.innerHTML = `<div class="empty">Nenhum módulo cadastrado.</div>`; return; }
  el.innerHTML = modulos.map(m=>`
    <div class="cad-item"><div class="info"><b>${m.nome}</b></div>
    <div class="acts"><button class="danger" onclick="pedirConfirmacao('Remover módulo?','Remove das opções futuras de lançamento.', ()=>removerModulo('${m.id}'))">Remover</button></div></div>`).join('');
}
async function removerModulo(id){
  const r = await api('removerModulo', { id });
  if(!r.ok) return;
  await carregarTudo(); renderCadastrosTudo(); popularSelects();
  toast('Módulo removido');
}

function renderListSubModulos(){
  const el = document.getElementById('listSubModulos');
  if(submodulos.length===0){ el.innerHTML = `<div class="empty">Nenhum sub módulo cadastrado.</div>`; return; }
  el.innerHTML = submodulos.map(s=>`
    <div class="cad-item"><div class="info"><b>${s.nome}</b></div>
    <div class="acts"><button class="danger" onclick="pedirConfirmacao('Remover sub módulo?','Remove das opções futuras de lançamento.', ()=>removerSubModulo('${s.id}'))">Remover</button></div></div>`).join('');
}
async function removerSubModulo(id){
  const r = await api('removerSubModulo', { id });
  if(!r.ok) return;
  await carregarTudo(); renderCadastrosTudo(); popularSelects();
  toast('Sub módulo removido');
}

function renderListStatus(){
  const el = document.getElementById('listStatus');
  if(statusList.length===0){ el.innerHTML = `<div class="empty">Nenhum status cadastrado.</div>`; return; }
  el.innerHTML = statusList.map((s,i)=>`
    <div class="cad-item">
      <div class="info" style="display:flex;align-items:center;gap:10px;">
        <div style="display:flex;flex-direction:column;gap:2px;">
          <button class="ghost" style="padding:2px 8px;" ${i===0?'disabled':''} onclick="moverStatus('${s.id}',-1)">▲</button>
          <button class="ghost" style="padding:2px 8px;" ${i===statusList.length-1?'disabled':''} onclick="moverStatus('${s.id}',1)">▼</button>
        </div>
        <b>${escaparHtml(s.nome)}</b>
      </div>
      <div class="acts"><button class="danger" onclick="pedirConfirmacao('Remover status?','Remove das opções futuras de lançamento.', ()=>removerStatus('${s.id}'))">Remover</button></div>
    </div>`).join('');
}
async function moverStatus(id, direcao){
  const i = statusList.findIndex(s=>String(s.id)===String(id));
  const j = i + direcao;
  if(i<0 || j<0 || j>=statusList.length) return;
  const novaOrdem = statusList.slice();
  [novaOrdem[i], novaOrdem[j]] = [novaOrdem[j], novaOrdem[i]];
  statusList = novaOrdem;
  renderListStatus(); // resposta visual imediata, antes mesmo do servidor confirmar
  const conta = contaAtual();
  const r = await api('reordenarStatus', { contaId: conta.id, ids: novaOrdem.map(s=>s.id) });
  if(!r.ok){ toast(r.erro || 'Não foi possível reordenar.'); await carregarTudo(); renderListStatus(); return; }
  await carregarTudo();
  renderCadastrosTudo();
  renderFiltrosStatus();
}
async function removerStatus(id){
  const r = await api('removerStatus', { id });
  if(!r.ok) return;
  await carregarTudo(); renderCadastrosTudo(); popularSelects();
  toast('Status removido');
}

let filtroValoresAtendenteId = 'TODOS';
let filtroGanttCliente = new Set();
let filtroGanttTipo = new Set();
let filtroGanttStatus = new Set();

/* ---------- Cubo de Atendimentos (tabela cruzada — só admin) ---------- */
const CUBO_DIMENSOES = {
  cliente: r => r.cliente || '(sem cliente)',
  usuario: r => r.usuario || '(sem usuário)',
  atendente: r => r.atendente || '(a definir)',
  tipo: r => labelTipo(r.tipo),
  status: r => r.status,
  modulo: r => r.modulo || '(sem módulo)',
  mes: r => r.mes || '(sem mês)',
};
const CUBO_DIMENSOES_LABEL = { cliente:'Cliente', usuario:'Usuário solicitante', atendente:'Atendente', tipo:'Tipo', status:'Status', modulo:'Módulo', mes:'Mês' };
const CUBO_MEDIDAS = {
  qtd_chamados: { label:'Qtd. de chamados', valor: () => 1, formatar: v => String(v) },
  soma_horas: { label:'Horas', valor: r => Number(r.qtd) || 0, formatar: v => v.toFixed(2).replace('.', ',') + 'h' },
  soma_real: { label:'Valor Real (R$)', valor: r => Number(r.totalReal) || 0, formatar: v => fmtMoeda(v) },
  soma_ananda: { label:'Valor Atendente (R$)', valor: r => Number(r.totalAnanda) || 0, formatar: v => fmtMoeda(v) },
};
const CUBO_MEDIDAS_LABEL = Object.fromEntries(Object.entries(CUBO_MEDIDAS).map(([k,v])=>[k,v.label]));

// ordem de seleção importa pra Linhas/Colunas — vira a ordem dos
// níveis/subníveis (primeiro = nível mais de fora); dá pra reordenar
// depois com as setas ‹ › em cada tag
let cuboLinhasSelecionadas = ['atendente'];
let cuboColunasSelecionadas = ['mes'];
let cuboMedidasSelecionadas = ['qtd_chamados'];
// grupos de linha recolhidos (guarda o "caminho" de valores, tipo
// "Camila|||08/2026" — não o objeto, porque a árvore é recalculada do
// zero a cada render)
let cuboLinhasColapsadas = new Set();

const CUBO_TIPO_INFO = {
  linhas: { tagsId:'cuboLinhasTags', opcoesId:'cuboLinhasOpcoes', labels:CUBO_DIMENSOES_LABEL, lista:()=>cuboLinhasSelecionadas, minimoUm:true },
  colunas: { tagsId:'cuboColunasTags', opcoesId:'cuboColunasOpcoes', labels:CUBO_DIMENSOES_LABEL, lista:()=>cuboColunasSelecionadas, minimoUm:false },
  medidas: { tagsId:'cuboMedidasTags', opcoesId:'cuboMedidasOpcoes', labels:CUBO_MEDIDAS_LABEL, lista:()=>cuboMedidasSelecionadas, minimoUm:true },
};

function renderCuboSeletor(tipo){
  const info = CUBO_TIPO_INFO[tipo];
  const selecionadas = info.lista();
  document.getElementById(info.tagsId).innerHTML = selecionadas.map((chave,i)=>`
    <div class="lookup-tag">
      ${i>0 ? `<button type="button" data-cubo-mover="${tipo}:${i}:-1" title="Mover pra esquerda" style="background:none;border:none;color:inherit;cursor:pointer;padding:0;font-weight:700;">‹</button>` : ''}
      ${escaparHtml(info.labels[chave])}
      ${i<selecionadas.length-1 ? `<button type="button" data-cubo-mover="${tipo}:${i}:1" title="Mover pra direita" style="background:none;border:none;color:inherit;cursor:pointer;padding:0;font-weight:700;">›</button>` : ''}
      <button type="button" data-cubo-remover="${tipo}:${chave}">×</button>
    </div>`
  ).join('');
  const disponiveis = Object.keys(info.labels).filter(chave=>!selecionadas.includes(chave));
  document.getElementById(info.opcoesId).innerHTML = disponiveis.map(chave=>
    `<button type="button" class="chip" data-cubo-adicionar="${tipo}:${chave}">+ ${escaparHtml(info.labels[chave])}</button>`
  ).join('');
}

function renderTodosSeletoresCubo(){
  renderCuboSeletor('linhas'); renderCuboSeletor('colunas'); renderCuboSeletor('medidas');
}

// perfis de visualização do Cubo — guarda linhas/colunas/medidas escolhidas
// com um nome, pra não ter que remontar toda vez; fica salvo só nesse
// navegador (localStorage), não é compartilhado com outras contas/telas
const CUBO_PERFIS_CHAVE = 'teaatend_cubo_perfis';

function cuboPerfisSalvos(){
  try{ return JSON.parse(localStorage.getItem(CUBO_PERFIS_CHAVE) || '[]'); }catch(e){ return []; }
}
function cuboGravarPerfis(perfis){
  try{ localStorage.setItem(CUBO_PERFIS_CHAVE, JSON.stringify(perfis)); }catch(e){ /* localStorage indisponível — perfil simplesmente não persiste */ }
}

function renderCuboPerfilSelect(){
  const perfis = cuboPerfisSalvos();
  const sel = document.getElementById('cuboPerfilSelect');
  sel.innerHTML = `<option value="">Selecione um perfil salvo…</option>` + perfis.map((p,i)=>`<option value="${i}">${escaparHtml(p.nome)}</option>`).join('');
}

function cuboSalvarPerfilAtual(){
  const nome = document.getElementById('cuboNovoPerfilNome').value.trim();
  if(!nome){ toast('Digite um nome pro perfil'); return; }
  const perfis = cuboPerfisSalvos();
  const idxExistente = perfis.findIndex(p=>p.nome.toLowerCase()===nome.toLowerCase());
  const perfil = { nome, linhas: [...cuboLinhasSelecionadas], colunas: [...cuboColunasSelecionadas], medidas: [...cuboMedidasSelecionadas] };
  const idx = idxExistente >= 0 ? idxExistente : perfis.length;
  if(idxExistente >= 0) perfis[idxExistente] = perfil; else perfis.push(perfil);
  cuboGravarPerfis(perfis);
  document.getElementById('cuboNovoPerfilNome').value = '';
  renderCuboPerfilSelect();
  document.getElementById('cuboPerfilSelect').value = String(idx);
  toast(idxExistente >= 0 ? 'Perfil atualizado' : 'Perfil salvo');
}

function cuboCarregarPerfilSelecionado(){
  const idx = document.getElementById('cuboPerfilSelect').value;
  if(idx === '') return;
  const perfil = cuboPerfisSalvos()[Number(idx)];
  if(!perfil) return;
  cuboLinhasSelecionadas = perfil.linhas.length ? [...perfil.linhas] : ['atendente'];
  cuboColunasSelecionadas = [...perfil.colunas];
  cuboMedidasSelecionadas = perfil.medidas.length ? [...perfil.medidas] : ['qtd_chamados'];
  cuboLinhasColapsadas.clear();
  renderTodosSeletoresCubo();
  renderCubo();
}

function cuboRemoverPerfilSelecionado(){
  const sel = document.getElementById('cuboPerfilSelect');
  if(sel.value === ''){ toast('Escolha um perfil pra remover'); return; }
  const perfis = cuboPerfisSalvos();
  perfis.splice(Number(sel.value), 1);
  cuboGravarPerfis(perfis);
  renderCuboPerfilSelect();
  toast('Perfil removido');
}

function itensCuboFiltrados(){
  let itens = atendimentos.slice();
  const de = document.getElementById('cubo_periodo_de').value;
  const ate = document.getElementById('cubo_periodo_ate').value;
  if(de) itens = itens.filter(r=>String(r.data) >= de);
  if(ate) itens = itens.filter(r=>String(r.data) <= ate);
  return itens;
}

// agrupa itens recursivamente por uma sequência de dimensões — cada nível
// vira um nó com os próprios itens (pra calcular o subtotal daquele grupo)
// e os filhos do próximo nível, se sobrar mais alguma dimensão na lista
function cuboAgrupar(itens, chaves, nivel){
  if(chaves.length === 0) return null;
  const extrair = CUBO_DIMENSOES[chaves[0]];
  const grupos = new Map();
  itens.forEach(r=>{
    const v = extrair(r);
    if(!grupos.has(v)) grupos.set(v, []);
    grupos.get(v).push(r);
  });
  const restante = chaves.slice(1);
  return [...grupos.keys()].sort((a,b)=>String(a).localeCompare(String(b))).map(valor=>{
    const itensGrupo = grupos.get(valor);
    return { valor, itens: itensGrupo, filhos: cuboAgrupar(itensGrupo, restante, nivel+1) };
  });
}

// combinações de coluna que realmente ocorrem nos dados (evita coluna
// vazia pra uma combinação de valores que nunca aconteceu junta)
function cuboCombinacoesColuna(itens, chaves){
  if(chaves.length === 0) return [[]];
  const extrair = CUBO_DIMENSOES[chaves[0]];
  const restante = chaves.slice(1);
  const valores = [...new Set(itens.map(extrair))].sort((a,b)=>String(a).localeCompare(String(b)));
  const combos = [];
  valores.forEach(v=>{
    const itensDoValor = itens.filter(r=>extrair(r)===v);
    cuboCombinacoesColuna(itensDoValor, restante).forEach(resto=> combos.push([v, ...resto]));
  });
  return combos;
}

function cuboItensNaColuna(itens, colunaChaves, colunaPath){
  if(colunaChaves.length === 0) return itens;
  return itens.filter(r=> colunaChaves.every((chave,i)=> CUBO_DIMENSOES[chave](r) === colunaPath[i]));
}

// uma linha de cabeçalho por nível de coluna (colspan agrupa combinações
// com o mesmo prefixo) + uma linha extra com o nome da medida quando tem
// mais de uma escolhida (ou "Total" quando não tem dimensão de coluna
// nenhuma e só uma medida)
function cuboLinhasCabecalho(colunaPaths, colunaChaves, medidaChaves){
  const numMedidas = medidaChaves.length;
  const linhas = [];
  colunaChaves.forEach((_,nivel)=>{
    const celulas = [];
    let i = 0;
    while(i < colunaPaths.length){
      const prefixo = colunaPaths[i].slice(0, nivel+1).join('|||');
      let j = i;
      while(j < colunaPaths.length && colunaPaths[j].slice(0, nivel+1).join('|||') === prefixo) j++;
      celulas.push({ texto: colunaPaths[i][nivel], colspan: (j - i) * numMedidas });
      i = j;
    }
    linhas.push(celulas);
  });
  if(numMedidas > 1){
    const celulas = [];
    colunaPaths.forEach(()=> medidaChaves.forEach(mk=> celulas.push({ texto: CUBO_MEDIDAS[mk].label, colspan: 1 })));
    linhas.push(celulas);
  }else if(colunaChaves.length === 0){
    linhas.push([{ texto: 'Total', colspan: 1 }]);
  }
  return linhas;
}

function cuboRenderLinhas(nos, colunaPaths, colunaChaves, medidaChaves, nivel, caminhoPai){
  // com nenhuma dimensão de coluna escolhida, colunaPaths já É a única
  // coluna que existe — repetir uma coluna "Total" ao lado seria mostrar
  // o mesmo número duas vezes; a coluna extra de Total só faz sentido
  // quando tem dimensão de coluna de verdade pra somar através dela
  const mostrarColunaTotal = colunaChaves.length > 0;
  return nos.map(no=>{
    const caminho = caminhoPai ? caminhoPai + '|||' + no.valor : String(no.valor);
    const celulas = colunaPaths.map(path=>{
      const itensColuna = cuboItensNaColuna(no.itens, colunaChaves, path);
      return medidaChaves.map(mk=>{
        const total = itensColuna.reduce((soma,r)=> soma + CUBO_MEDIDAS[mk].valor(r), 0);
        return `<td style="text-align:right;padding:6px 10px;white-space:nowrap;">${total ? CUBO_MEDIDAS[mk].formatar(total) : '—'}</td>`;
      }).join('');
    }).join('');
    const totalLinha = mostrarColunaTotal ? medidaChaves.map(mk=>{
      const total = no.itens.reduce((soma,r)=> soma + CUBO_MEDIDAS[mk].valor(r), 0);
      return `<td style="text-align:right;padding:6px 10px;font-weight:700;white-space:nowrap;">${CUBO_MEDIDAS[mk].formatar(total)}</td>`;
    }).join('') : '';
    const colapsado = cuboLinhasColapsadas.has(caminho);
    const toggle = no.filhos
      ? `<button type="button" data-cubo-toggle-linha="${escaparHtml(caminho)}" title="${colapsado?'Expandir':'Recolher'}" style="background:none;border:none;cursor:pointer;color:inherit;padding:0;font-size:10px;width:14px;">${colapsado?'▸':'▾'}</button>`
      : `<span style="display:inline-block;width:14px;"></span>`;
    const linhaAtual = `<tr><td style="padding:6px 10px;padding-left:${nivel*18}px;font-weight:${no.filhos?700:600};white-space:nowrap;">${toggle}${escaparHtml(String(no.valor))}</td>${celulas}${totalLinha}</tr>`;
    const linhasFilhas = (no.filhos && !colapsado) ? cuboRenderLinhas(no.filhos, colunaPaths, colunaChaves, medidaChaves, nivel+1, caminho) : '';
    return linhaAtual + linhasFilhas;
  }).join('');
}

function renderCubo(){
  const cont = document.getElementById('cuboTabela');
  const itens = itensCuboFiltrados();
  if(itens.length === 0){ cont.innerHTML = `<div class="empty">Nenhum atendimento encontrado nesse período.</div>`; return; }

  const linhaChaves = cuboLinhasSelecionadas;
  const colunaChaves = cuboColunasSelecionadas;
  const medidaChaves = cuboMedidasSelecionadas;

  const arvoreLinhas = cuboAgrupar(itens, linhaChaves, 0);
  const colunaPaths = cuboCombinacoesColuna(itens, colunaChaves);
  const linhasCabecalho = cuboLinhasCabecalho(colunaPaths, colunaChaves, medidaChaves);

  // a coluna extra de "Total" (soma através de todas as combinações de
  // coluna) só faz sentido quando existe alguma dimensão de coluna de
  // verdade — sem isso, colunaPaths já É a única coluna, e repetir um
  // "Total" do lado mostraria o mesmo número de novo
  const mostrarColunaTotal = colunaChaves.length > 0;

  // a linha de rótulos de medida (quando tem mais de uma escolhida) é
  // sempre a última — "Total" só ocupa as linhas de dimensão de coluna
  // acima dela (rowspan), e ganha seus próprios rótulos de medida nessa
  // última linha, igual qualquer outro grupo de coluna
  const temLinhaDeMedida = medidaChaves.length > 1;
  const cabecalhoHtml = linhasCabecalho.map((celulas, i)=>{
    const ehUltimaLinha = i === linhasCabecalho.length - 1;
    const bordaCelulaVazia = i===0 ? `<th rowspan="${linhasCabecalho.length}" style="text-align:left;padding:6px 10px;border-bottom:2px solid var(--line);"></th>` : '';
    const meio = celulas.map(c=>`<th colspan="${c.colspan}" style="text-align:right;padding:6px 10px;border-bottom:2px solid var(--line);white-space:nowrap;">${escaparHtml(String(c.texto))}</th>`).join('');
    let celulaTotal = '';
    if(mostrarColunaTotal){
      if(i === 0 && !(temLinhaDeMedida && ehUltimaLinha)){
        celulaTotal = `<th rowspan="${temLinhaDeMedida ? linhasCabecalho.length-1 : linhasCabecalho.length}" colspan="${medidaChaves.length}" style="text-align:right;padding:6px 10px;border-bottom:2px solid var(--line);">Total</th>`;
      }else if(temLinhaDeMedida && ehUltimaLinha){
        celulaTotal = medidaChaves.map(mk=>`<th style="text-align:right;padding:6px 10px;border-bottom:2px solid var(--line);white-space:nowrap;">${escaparHtml(CUBO_MEDIDAS[mk].label)}</th>`).join('');
      }
    }
    return `<tr>${bordaCelulaVazia}${meio}${celulaTotal}</tr>`;
  }).join('');

  const linhasHtml = cuboRenderLinhas(arvoreLinhas, colunaPaths, colunaChaves, medidaChaves, 0, null);

  const totaisColuna = colunaPaths.map(path=>{
    const itensColuna = cuboItensNaColuna(itens, colunaChaves, path);
    return medidaChaves.map(mk=>{
      const total = itensColuna.reduce((soma,r)=> soma + CUBO_MEDIDAS[mk].valor(r), 0);
      return `<td style="text-align:right;padding:6px 10px;font-weight:700;white-space:nowrap;">${CUBO_MEDIDAS[mk].formatar(total)}</td>`;
    }).join('');
  }).join('');
  const totalGeral = mostrarColunaTotal ? medidaChaves.map(mk=>{
    const total = itens.reduce((soma,r)=> soma + CUBO_MEDIDAS[mk].valor(r), 0);
    return `<td style="text-align:right;padding:6px 10px;font-weight:700;white-space:nowrap;">${CUBO_MEDIDAS[mk].formatar(total)}</td>`;
  }).join('') : '';

  cont.innerHTML = `
    <div style="overflow-x:auto;">
      <table style="width:100%;border-collapse:collapse;font-size:12.5px;">
        <thead>${cabecalhoHtml}</thead>
        <tbody>
          ${linhasHtml}
          <tr class="cubo-total" style="border-top:2px solid var(--line);">
            <td style="padding:6px 10px;font-weight:700;">Total</td>
            ${totaisColuna}
            ${totalGeral}
          </tr>
        </tbody>
      </table>
    </div>`;
}

// junta numa lista só (respeitando o que está recolhido/expandido — só
// exporta o que a pessoa está vendo na tela) pra gerar o Excel/CSV
function cuboColetarLinhasVisiveis(nos, colunaPaths, colunaChaves, medidaChaves, nivel, caminhoPai, saida){
  const mostrarColunaTotal = colunaChaves.length > 0;
  nos.forEach(no=>{
    const caminho = caminhoPai ? caminhoPai + '|||' + no.valor : String(no.valor);
    const valores = [];
    colunaPaths.forEach(path=>{
      const itensColuna = cuboItensNaColuna(no.itens, colunaChaves, path);
      medidaChaves.forEach(mk=> valores.push(itensColuna.reduce((soma,r)=> soma + CUBO_MEDIDAS[mk].valor(r), 0)));
    });
    if(mostrarColunaTotal) medidaChaves.forEach(mk=> valores.push(no.itens.reduce((soma,r)=> soma + CUBO_MEDIDAS[mk].valor(r), 0)));
    saida.push({ label: no.valor, nivel, valores });
    const colapsado = cuboLinhasColapsadas.has(caminho);
    if(no.filhos && !colapsado) cuboColetarLinhasVisiveis(no.filhos, colunaPaths, colunaChaves, medidaChaves, nivel+1, caminho, saida);
  });
}

// mesmo padrão de exportação em Excel de verdade usado no resto do
// sistema (XLSX + salvarWorkbook) — um Blob com <a download> direto não
// funciona dentro do app Android (WebView do Capacitor não salva sozinha)
async function exportarCuboExcel(){
  const itens = itensCuboFiltrados();
  if(itens.length === 0){ toast('Nada para exportar com esse período'); return; }

  const linhaChaves = cuboLinhasSelecionadas, colunaChaves = cuboColunasSelecionadas, medidaChaves = cuboMedidasSelecionadas;
  const mostrarColunaTotal = colunaChaves.length > 0;
  const arvoreLinhas = cuboAgrupar(itens, linhaChaves, 0);
  const colunaPaths = cuboCombinacoesColuna(itens, colunaChaves);

  const cabecalhosColuna = [];
  colunaPaths.forEach(path=> medidaChaves.forEach(mk=> cabecalhosColuna.push([...path, CUBO_MEDIDAS[mk].label].join(' - '))));
  if(mostrarColunaTotal) medidaChaves.forEach(mk=> cabecalhosColuna.push('Total - ' + CUBO_MEDIDAS[mk].label));
  const cabecalho = [linhaChaves.map(k=>CUBO_DIMENSOES_LABEL[k]).join(' / ') || 'Item', ...cabecalhosColuna];

  const linhasVisiveis = [];
  cuboColetarLinhasVisiveis(arvoreLinhas, colunaPaths, colunaChaves, medidaChaves, 0, null, linhasVisiveis);
  const linhas = linhasVisiveis.map(l=> [
    '  '.repeat(l.nivel) + String(l.label),
    ...l.valores.map(v=> Number(v.toFixed(2))),
  ]);

  const totalGeralValores = [];
  colunaPaths.forEach(path=>{
    const itensColuna = cuboItensNaColuna(itens, colunaChaves, path);
    medidaChaves.forEach(mk=> totalGeralValores.push(itensColuna.reduce((soma,r)=> soma + CUBO_MEDIDAS[mk].valor(r), 0)));
  });
  if(mostrarColunaTotal) medidaChaves.forEach(mk=> totalGeralValores.push(itens.reduce((soma,r)=> soma + CUBO_MEDIDAS[mk].valor(r), 0)));
  linhas.push(['Total', ...totalGeralValores.map(v=>Number(v.toFixed(2)))]);

  const livro = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(livro, XLSX.utils.aoa_to_sheet([cabecalho, ...linhas]), 'Cubo');
  await salvarWorkbook(livro, `cubo-atendimentos-${hojeLocalISO()}.xlsx`);
  toast('Excel exportado');
}

/* ---------- construtor de relatório ---------- */
let relFiltroCliente = new Set();
let relFiltroTipo = new Set();
let relFiltroStatus = new Set();
let relColunas = ['data','cliente','usuario','atendente','tipo','detalhe','horario','qtd','status']; // array — mantém a ordem escolhida
let relAgrupar = 'nenhum';
let relTipoVisualizacao = 'tabela'; // 'tabela' ou 'ficha' (detalhado, com fotos)
let relEditandoId = null; // id do relatório salvo sendo editado (null = novo)

const COLUNAS_RELATORIO = [
  { key:'id', label:'Nº do Atendimento', formatar:r=>r.id },
  { key:'data', label:'Data', formatar:r=>{ const [y,m,d]=String(r.data).split('-'); return `${d}/${m}/${y}`; } },
  { key:'mes', label:'Mês de Referência', formatar:r=>r.mes||'' },
  { key:'cliente', label:'Cliente', formatar:r=>r.cliente },
  { key:'usuario', label:'Usuário', formatar:r=>r.usuario },
  { key:'atendente', label:'Atendente', formatar:r=>r.atendente || '(a definir)' },
  { key:'tipo', label:'Tipo', formatar:r=>labelTipo(r.tipo) },
  { key:'modulo', label:'Módulo', formatar:r=>r.modulo||'' },
  { key:'submodulo', label:'Sub Módulo', formatar:r=>r.submodulo||'' },
  { key:'assunto', label:'Assunto', formatar:r=>r.assunto||'' },
  { key:'detalhe', label:'Detalhe', formatar:r=>stripHtml(r.detalhe||'') },
  { key:'solucao', label:'Solução', formatar:r=>stripHtml(r.solucao||'') },
  { key:'horario', label:'Horário (Inicial–Final)', formatar:r=>`${r.hi}–${r.hf}` },
  { key:'hi', label:'Hora Inicial', formatar:r=>r.hi },
  { key:'inter', label:'Intervalo', formatar:r=>r.inter },
  { key:'hf', label:'Hora Final', formatar:r=>r.hf },
  { key:'qtd', label:'Qtd Horas', formatar:r=>Number(r.qtd).toFixed(2).replace('.',',')+'h', numerica:true, valorBruto:r=>Number(r.qtd)||0, ehHoras:true },
  { key:'status', label:'Status', formatar:r=>r.status },
  { key:'dataPrevista', label:'Data Prevista', formatar:r=>{ if(!r.dataPrevista) return ''; const [y,m,d]=String(r.dataPrevista).split('-'); return `${d}/${m}/${y}`; } },
  { key:'situacaoPrazo', label:'Situação do Prazo', formatar:r=>{
      if(!r.dataPrevista || r.status === 'VALIDADO') return '';
      return hojeLocalISO() > r.dataPrevista ? 'Atrasado' : 'Em dia';
    } },
  { key:'anexo', label:'Anexo', formatar:r=>r.anexoNome || '' },
  { key:'vhr', label:'Valor Real/h', formatar:r=>fmtMoeda(Number(r.vhr)||0) },
  { key:'totalReal', label:'Total Real', formatar:r=>fmtMoeda(Number(r.totalReal)||0), numerica:true, valorBruto:r=>Number(r.totalReal)||0 },
  { key:'vha', label:'Valor Atendente/h', formatar:r=>fmtMoeda(Number(r.vha)||0) },
  { key:'totalAnanda', label:'Total Atendente', formatar:r=>fmtMoeda(Number(r.totalAnanda)||0), numerica:true, valorBruto:r=>Number(r.totalAnanda)||0 },
  { key:'atendente2', label:'2º Atendente', formatar:r=>r.atendente2 || '' },
  { key:'horasAtendente2', label:'Horas (2º Atendente)', formatar:r=>Number(r.horasAtendente2||0).toFixed(2).replace('.',',')+'h', numerica:true, valorBruto:r=>Number(r.horasAtendente2)||0, ehHoras:true },
  { key:'vha2', label:'Valor 2º Atendente/h', formatar:r=>fmtMoeda(Number(r.vha2)||0) },
  { key:'totalAnanda2', label:'Total 2º Atendente', formatar:r=>fmtMoeda(Number(r.totalAnanda2)||0), numerica:true, valorBruto:r=>Number(r.totalAnanda2)||0 },
];
function colunaInfo(key){ return COLUNAS_RELATORIO.find(c=>c.key===key); }

function renderValoresForm(){
  document.getElementById('vl_atendente').innerHTML = contas.filter(c=>c.perfil==='ATENDENTE').map(a=>`<option value="${a.id}">${a.nome}</option>`).join('');
  document.getElementById('vl_cliente').innerHTML = clientes.map(c=>`<option value="${c.id}">${c.nome}</option>`).join('');
  document.getElementById('vl_tipo').innerHTML = tipos.map(t=>`<option value="${t.id}">${t.nome}</option>`).join('');

  const atendentes = contas.filter(c=>c.perfil==='ATENDENTE');
  const filtroEl = document.getElementById('filtroValoresAtendente');
  filtroEl.innerHTML = `<div class="chip ${filtroValoresAtendenteId==='TODOS'?'on':''}" data-atendente="TODOS">Todos</div>` +
    atendentes.map(a=>`<div class="chip ${filtroValoresAtendenteId===a.id?'on':''}" data-atendente="${a.id}">${a.nome}</div>`).join('');
}
function renderTabelaValores(){
  const el = document.getElementById('tabelaValores');
  let itens = valores.slice();
  if(filtroValoresAtendenteId !== 'TODOS') itens = itens.filter(v=>String(v.atendenteId)===String(filtroValoresAtendenteId));
  if(itens.length===0){ el.innerHTML = `<tr><td>Nenhum valor definido.</td></tr>`; return; }
  const linhas = itens.map(v=>{
    const atendente = contas.find(c=>String(c.id)===String(v.atendenteId))?.nome || '—';
    const cliente = clientes.find(c=>String(c.id)===String(v.clienteId))?.nome || '—';
    const tipo = tipos.find(t=>String(t.id)===String(v.tipoId))?.nome || '—';
    return `<tr><td>${atendente}</td><td>${cliente}</td><td>${labelTipo(tipo)}</td><td>${fmtMoeda(Number(v.real))}</td><td>${fmtMoeda(Number(v.ananda))}</td><td>${fmtMoeda(Number(v.valorSegundoAtend)||0)}</td>
      <td><button class="danger" onclick="pedirConfirmacao('Remover valor?','', ()=>removerValor('${v.id}'))">✕</button></td></tr>`;
  }).join('');
  el.innerHTML = `<tr><th>Atendente</th><th>Cliente</th><th>Tipo</th><th>Real/h</th><th>Valor Atendente/h</th><th>Valor 2º Atendente/h</th><th></th></tr>${linhas}`;
}
async function removerValor(id){
  const r = await api('removerValor', { id });
  if(!r.ok) return;
  await carregarTudo(); renderTabelaValores();
  toast('Valor removido');
}

async function recalcularValores(){
  const btn = document.getElementById('btnRecalcularValores');
  btn.disabled = true;
  btn.textContent = 'Recalculando…';
  try{
    const conta = contaAtual();
    const r = await api('recalcularValores', { contaId: conta.id, empresaId: empresaAtual ? empresaAtual.id : '' });
    if(!r.ok){ toast(r.erro || 'Não foi possível recalcular.'); return; }
    await carregarTudo();
    renderLista(); renderResumo();
    toast(`${r.atualizados} atualizados, ${r.semCorrespondencia||0} sem valor cadastrado (não mexidos), de ${r.total} no total`);
  }catch(e){
    toast(e && e.message ? e.message : 'Não foi possível recalcular.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Recalcular valores de todos os atendimentos';
  }
}

function renderListUsuarios(){
  document.getElementById('us_cliente').innerHTML = clientes.map(c=>`<option value="${c.id}">${c.nome}</option>`).join('');
  const lista = contas.filter(c=>c.perfil==='USUARIO');
  const el = document.getElementById('listUsuarios');
  if(lista.length===0){ el.innerHTML = `<div class="empty">Nenhum usuário cadastrado.</div>`; return; }
  el.innerHTML = lista.map(u=>{
    const cliente = clientes.find(c=>String(c.id)===String(u.clienteId))?.nome || '—';
    const contatos = linhaContatos(u.email, u.telefone);
    const selo = u.adminCliente ? ` <span class="tag" style="color:var(--accent);">admin do cliente</span>` : '';
    return `<div class="cad-item" style="cursor:pointer;" onclick="editarUsuario('${u.id}')">
      <div class="info"><b>${u.nome}${selo}</b><span>${cliente} · login: ${u.login}</span>${contatos}</div>
      <div class="acts"><button class="danger" onclick="event.stopPropagation();pedirConfirmacao('Remover usuário?','${u.nome} perderá acesso ao sistema.', ()=>removerConta('${u.id}'))">Remover</button></div>
    </div>`;
  }).join('');
}

function editarUsuario(id){
  const u = contas.find(c=>String(c.id)===String(id));
  if(!u) return;
  editandoUsuarioId = id;
  document.getElementById('us_tituloForm').textContent = `Editando: ${u.nome}`;
  document.getElementById('us_cliente').value = u.clienteId;
  document.getElementById('us_nome').value = u.nome;
  document.getElementById('us_login').value = u.login;
  document.getElementById('us_senha').value = '';
  document.getElementById('us_senha_hint').style.display = '';
  document.getElementById('us_email').value = u.email || '';
  document.getElementById('us_telefone').value = u.telefone || '';
  document.getElementById('us_admin_cliente').checked = !!u.adminCliente;
  renderPerfisAcessoCheckboxes('us_perfis_acesso', u.perfisAcessoIds||[]);
  document.getElementById('btnAddUsuario').textContent = 'Salvar alterações';
  document.getElementById('btnCancelarEdicaoUsuario').style.display = '';

  const historico = atendimentos.filter(a=>a.usuario === u.nome).slice().sort((a,b)=>String(b.data).localeCompare(String(a.data)));
  const cardHist = document.getElementById('historicoUsuarioCard');
  const contHist = document.getElementById('historicoUsuario');
  if(historico.length === 0){
    contHist.innerHTML = `<div class="empty">Nenhum atendimento registrado ainda.</div>`;
  }else{
    contHist.innerHTML = historico.map(r=>{
      const [y,m,d] = String(r.data).split('-');
      return `<div class="cad-item" style="cursor:default;">
        <div class="info"><b>${d}/${m}/${y} · ${labelTipo(r.tipo)}</b><span>${r.atendente} · ${r.qtd ? Number(r.qtd).toFixed(2).replace('.',',')+'h' : ''}</span></div>
        <span class="tag status-${statusSlug(r.status)}">${r.status}</span>
      </div>`;
    }).join('');
  }
  cardHist.style.display = '';
  document.getElementById('us_nome').scrollIntoView({behavior:'smooth', block:'start'});
}

function cancelarEdicaoUsuario(){
  editandoUsuarioId = null;
  document.getElementById('us_tituloForm').textContent = 'Novo usuário solicitante (login)';
  document.getElementById('us_nome').value = '';
  document.getElementById('us_login').value = '';
  document.getElementById('us_senha').value = '';
  document.getElementById('us_senha_hint').style.display = 'none';
  document.getElementById('us_email').value = '';
  document.getElementById('us_telefone').value = '';
  document.getElementById('us_admin_cliente').checked = false;
  renderPerfisAcessoCheckboxes('us_perfis_acesso', []);
  document.getElementById('btnAddUsuario').textContent = 'Adicionar usuário';
  document.getElementById('btnCancelarEdicaoUsuario').style.display = 'none';
  document.getElementById('historicoUsuarioCard').style.display = 'none';
}

function linkWhatsapp(telefone){
  if(!telefone) return '';
  let digitos = String(telefone).replace(/\D/g,'');
  if(!digitos) return '';
  if(digitos.length <= 11) digitos = '55' + digitos; // assume Brasil quando não vem com DDI
  return `https://wa.me/${digitos}`;
}

// texto de aviso do prazo de validação automática (some quando falta o
// dado de quando entrou em validação, ex: registro antigo)
function textoPrazoValidacao(r){
  if(!r.emValidacaoDesde || !empresaAtual) return '';
  const horas = Number(empresaAtual.horasValidacaoAutomatica) || 48;
  const prazo = new Date(r.emValidacaoDesde);
  prazo.setHours(prazo.getHours() + horas);
  const dd = String(prazo.getDate()).padStart(2,'0'), mm = String(prazo.getMonth()+1).padStart(2,'0');
  const hh = String(prazo.getHours()).padStart(2,'0'), mi = String(prazo.getMinutes()).padStart(2,'0');
  return `<br><span style="color:var(--muted);">Se ninguém aprovar até ${dd}/${mm} às ${hh}:${mi}, ele é validado automaticamente.</span>`;
}

async function aprovarValidacaoUi(id){
  const conta = contaAtual();
  const r = await api('aprovarValidacao', { contaId: conta.id, id });
  if(!r.ok){ toast(r.erro || 'Não foi possível aprovar a validação.'); return; }
  toast('Validação aprovada — chamado encerrado');
  await carregarTudo();
  renderLista();
  fecharChat();
}

async function rejeitarValidacaoUi(id){
  const motivo = document.getElementById('chatMotivoRejeicao').value.trim();
  const conta = contaAtual();
  const r = await api('rejeitarValidacao', { contaId: conta.id, id, motivo });
  if(!r.ok){ toast(r.erro || 'Não foi possível rejeitar a validação.'); return; }
  toast('Validação rejeitada — o atendente vai revisar');
  await carregarTudo();
  renderLista();
  fecharChat();
}

/* ---------- bate-papo por atendimento ---------- */
let chatAtendimentoId = null;
let chatPodeRemoverVinculo = false;
let movimentacoesCache = [];

async function abrirDetalhe(atendimentoId){
  const r = atendimentos.find(x=>String(x.id)===String(atendimentoId));
  if(!r || !podeUsarChat(r)) return;
  chatAtendimentoId = atendimentoId;
  const [y,m,d] = String(r.data).split('-');
  const modSub = [r.modulo, r.submodulo].filter(Boolean).join(' · ');
  const conta = contaAtual();
  const isUsuario = conta && conta.perfil === 'USUARIO';

  document.getElementById('chatTitulo').textContent = `${r.cliente} · ${r.usuario}`;
  document.getElementById('chatSub').textContent = `#${r.id} · Atendente: ${r.atendente || '(a definir)'}${r.atendente2 ? ' + '+r.atendente2+' (2º)' : ''} · ${d}/${m}/${y} · ${r.status}`;
  const horario = `${r.hi}–${r.hf}${r.inter && r.inter!=='00:00' ? ' (intervalo '+r.inter+')' : ''}`;
  let dataPrevistaTexto = '';
  if(r.dataPrevista){
    const [py,pm,pd] = String(r.dataPrevista).split('-');
    dataPrevistaTexto = `${pd}/${pm}/${py}`;
  }
  document.getElementById('chatResumo').innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px 14px;font-size:12.5px;margin-bottom:10px;">
      <div><span style="color:var(--muted);">Tipo</span><br>${labelTipo(r.tipo)}</div>
      <div><span style="color:var(--muted);">Horário</span><br>${horario}</div>
      ${dataPrevistaTexto ? `<div><span style="color:var(--muted);">Previsão de conclusão</span><br>${dataPrevistaTexto} ${flagPrazo(r)}</div>` : ''}
    </div>
    ${modSub ? `<div style="color:var(--accent);font-weight:600;font-size:12.5px;margin-bottom:4px;">${modSub}</div>` : ''}
    ${r.assunto ? `<div style="font-weight:600;font-size:13px;margin-bottom:4px;">${escaparHtml(r.assunto)}</div>` : ''}
    ${r.detalhe ? `<div class="rt-content" style="font-size:12.5px;color:var(--muted);margin-top:2px;">${sanitizarHtml(r.detalhe)}</div>` : ''}
    ${r.solucao ? `<div style="font-size:12.5px;margin-top:8px;padding:8px 10px;background:var(--panel-2);border-radius:8px;"><b style="color:var(--ok);display:block;margin-bottom:4px;">Solução:</b><div class="rt-content">${sanitizarHtml(r.solucao)}</div></div>` : ''}
    ${(isUsuario && r.status === 'EM VALIDAÇÃO') ? `
      <div style="font-size:12.5px;margin-top:8px;padding:10px;background:var(--panel-2);border-radius:8px;">
        <b>Esse chamado está em validação.</b> Confirma que ficou tudo certo?
        ${textoPrazoValidacao(r)}
        <textarea id="chatMotivoRejeicao" placeholder="Se for rejeitar, explique o motivo (opcional)" style="width:100%;margin-top:8px;min-height:50px;font-size:12.5px;padding:8px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:inherit;box-sizing:border-box;"></textarea>
        <div style="display:flex;gap:8px;margin-top:8px;">
          <button class="primary" style="flex:1;margin-top:0;" onclick="aprovarValidacaoUi('${r.id}')">✓ Aprovar</button>
          <button class="danger" style="flex:1;" onclick="rejeitarValidacaoUi('${r.id}')">✗ Rejeitar</button>
        </div>
      </div>` : ''}
  `;
  document.getElementById('chatVinculosWrap').style.display = 'none';
  document.getElementById('chatVideosWrap').style.display = 'none';
  document.getElementById('chatAnexosLista').innerHTML = `<div class="empty" style="padding:8px 0;font-size:12.5px;">Carregando…</div>`;
  document.getElementById('chatHistorico').innerHTML = `<div class="chat-empty">Carregando…</div>`;
  document.getElementById('movLista').innerHTML = `<div class="chat-empty">Carregando…</div>`;
  movLimparComposer('');
  document.getElementById('chatModal').classList.add('show');
  if(!isUsuario) carregarVideosCacheParaVinculo();
  await Promise.all([
    carregarHistorico(),
    carregarMovimentacoes(atendimentoId, ''),
    carregarAnexosDetalhe(atendimentoId, !isUsuario),
    carregarVinculosDetalhe(atendimentoId, !isUsuario),
    carregarVideosDetalhe(atendimentoId, !isUsuario),
  ]);
}

async function carregarAnexosDetalhe(atendimentoId, podeRemover){
  try{
    const r = await api('listarAnexos', { atendimentoId });
    if(!r.ok){ document.getElementById('chatAnexosLista').innerHTML = `<div class="empty" style="padding:8px 0;font-size:12.5px;">${r.erro||'Não foi possível carregar os anexos.'}</div>`; return; }
    renderAnexosGenerico('chatAnexosLista', r.anexos, atendimentoId, podeRemover);
  }catch(e){
    document.getElementById('chatAnexosLista').innerHTML = `<div class="empty" style="padding:8px 0;font-size:12.5px;">Não foi possível carregar os anexos.</div>`;
  }
}

async function carregarVinculosDetalhe(atendimentoId, podeGerenciar){
  const wrap = document.getElementById('chatVinculosWrap');
  document.getElementById('chatVinculoAdd').style.display = podeGerenciar ? '' : 'none';
  chatPodeRemoverVinculo = podeGerenciar;
  try{
    const r = await recarregarVinculos(atendimentoId, 'chatVinculos', podeGerenciar);
    if(!r) { wrap.style.display = podeGerenciar ? '' : 'none'; return; }
    const temVinculos = r.vinculados && r.vinculados.length > 0;
    // sem gerência (usuário) e sem nenhum vínculo, não mostra a seção — pra quem gerencia, mostra sempre (pra poder adicionar)
    wrap.style.display = (podeGerenciar || temVinculos) ? '' : 'none';
    if(temVinculos){
      const totalEl = document.createElement('div');
      totalEl.style.cssText = 'text-align:right;font-size:12.5px;margin-top:6px;color:var(--accent);font-weight:600;';
      totalEl.textContent = `Total de horas (com vinculados): ${r.horasTotais.toFixed(2).replace('.',',')}h`;
      document.getElementById('chatVinculos').appendChild(totalEl);
    }
  }catch(e){ /* silencioso — vínculo é informação complementar */ }
}

async function carregarVideosDetalhe(atendimentoId, podeGerenciar){
  const wrap = document.getElementById('chatVideosWrap');
  document.getElementById('chatVideoVinculoAdd').style.display = podeGerenciar ? '' : 'none';
  try{
    const r = await recarregarVideosVinculados(atendimentoId, 'chatVideosVinculo', podeGerenciar);
    if(!r) { wrap.style.display = podeGerenciar ? '' : 'none'; return; }
    const temVideos = r.videos && r.videos.length > 0;
    // sem gerência (usuário) e sem nenhum vídeo, não mostra a seção — pra quem gerencia, mostra sempre (pra poder adicionar)
    wrap.style.display = (podeGerenciar || temVideos) ? '' : 'none';
  }catch(e){ /* silencioso — vídeo vinculado é informação complementar */ }
}

function fecharChat(){
  chatAtendimentoId = null;
  document.getElementById('chatModal').classList.remove('show');
}

async function carregarHistorico(){
  if(!chatAtendimentoId) return;
  const cont = document.getElementById('chatHistorico');
  let r;
  try{
    r = await api('listarHistorico', { atendimentoId: chatAtendimentoId });
  }catch(e){
    cont.innerHTML = `<div class="chat-empty">Não foi possível carregar o histórico.</div>`;
    return;
  }
  if(!r.ok){
    cont.innerHTML = `<div class="chat-empty">${r.erro || 'Não foi possível carregar o histórico.'}</div>`;
    return;
  }
  if(r.historico.length === 0){
    cont.innerHTML = `<div class="chat-empty">Sem ocorrências ainda.</div>`;
    return;
  }
  cont.innerHTML = r.historico.map(h=>`
    <div style="font-size:11.5px;color:var(--muted);padding:4px 0;border-bottom:1px dashed var(--line);">
      ${escaparHtml(h.descricao)} <span style="opacity:.6;">· ${String(h.dataHora||'').slice(0,16)}</span>
    </div>`).join('');
}

let movEstado = {
  '': { atendimentoId: null, cache: [], respondendoId: null, editandoId: null, anexoArquivo: null },
  '_ed': { atendimentoId: null, cache: [], respondendoId: null, editandoId: null, anexoArquivo: null },
};
// os dois lugares onde as movimentações aparecem (modal de detalhes e a
// tela de editar atendimento) usam nomes de campo ligeiramente
// diferentes — esse mapa resolve pra cada sufixo
function movIds(sufixo){
  return sufixo === '_ed' ? {
    lista:'movLista_ed', composer:'movComposerWrap_ed', respWrap:'movRespondendoWrap_ed', respTexto:'movRespondendoTexto_ed',
    respCancelar:'movCancelarResposta_ed', texto:'mov_texto_ed', anexo:'mov_anexo_ed', anexoNome:'mov_anexo_ed_nome',
    btnEnviar:'btnEnviarMovimentacao_ed', bloqueado:'movBloqueadoAviso_ed',
  } : {
    lista:'movLista', composer:'movComposerWrap', respWrap:'movRespondendoWrap', respTexto:'movRespondendoTexto',
    respCancelar:'movCancelarResposta', texto:'mov_texto', anexo:'mov_anexo', anexoNome:'mov_anexo_nome',
    btnEnviar:'btnEnviarMovimentacao', bloqueado:'movBloqueadoAviso',
  };
}

function movLabelPerfil(perfil){
  return perfil === 'USUARIO' ? 'Cliente' : perfil === 'ATENDENTE' ? 'Atendente' : 'Admin';
}
function movIniciais(nome){
  const partes = String(nome||'').trim().split(/\s+/);
  return ((partes[0]?.[0]||'') + (partes[1]?.[0]||'')).toUpperCase();
}
function movFmtDataHora(iso){
  if(!iso) return '';
  const d = new Date(iso);
  // fixa o fuso de Fortaleza em vez de confiar no fuso do aparelho —
  // um dispositivo com fuso mal configurado mostrava o horário em UTC (3h adiantado)
  return d.toLocaleDateString('pt-BR', {timeZone:'America/Fortaleza'}) + ' ' + d.toLocaleTimeString('pt-BR', {hour:'2-digit',minute:'2-digit',timeZone:'America/Fortaleza'});
}
async function carregarMovimentacoes(atendimentoId, sufixo){
  sufixo = sufixo || '';
  const ids = movIds(sufixo);
  const estado = movEstado[sufixo];
  estado.atendimentoId = atendimentoId;
  if(!atendimentoId) return;
  const cont = document.getElementById(ids.lista);
  const r = atendimentos.find(x=>String(x.id)===String(atendimentoId));
  const bloqueado = r && r.status === 'VALIDADO';
  document.getElementById(ids.composer).style.display = bloqueado ? 'none' : '';
  document.getElementById(ids.bloqueado).style.display = bloqueado ? '' : 'none';

  let resp;
  try{
    const conta = contaAtual();
    resp = await api('listarMovimentacoes', { atendimentoId, contaId: conta ? conta.id : '' });
  }catch(e){
    cont.innerHTML = `<div class="chat-empty">Não foi possível carregar as movimentações.</div>`;
    return;
  }
  if(!resp.ok){ cont.innerHTML = `<div class="chat-empty">${resp.erro || 'Não foi possível carregar as movimentações.'}</div>`; return; }
  // abrir a lista já marca como "vista" no servidor — reflete isso na hora
  // na tela também (bolinha do card e do menu), sem esperar o próximo
  // carregarTudo() apagar tudo
  if(r && r.naoLidas){
    r.naoLidas = false;
    atualizarBadgeAtendimentos();
    if(document.getElementById('view-lista').classList.contains('active')) renderLista();
  }

  estado.cache = resp.movimentacoes || [];
  if(estado.cache.length === 0){
    cont.innerHTML = `<div class="chat-empty">Nenhuma movimentação ainda.</div>`;
    return;
  }
  const conta = contaAtual();
  cont.innerHTML = estado.cache.map(m=>{
    const citada = m.respondendoA ? estado.cache.find(x=>x.id===m.respondendoA) : null;
    const podeGerenciar = !bloqueado && conta && (ehAdminEfetivo(conta) || conta.nome === m.autorNome);
    return `<div class="mov-item">
      ${citada ? `<div class="mov-respondendo-item">Em resposta a <b>${escaparHtml(citada.autorNome)}</b>: "${escaparHtml(stripHtml(citada.texto).slice(0,60))}"</div>` : ''}
      <div class="mov-topo">
        <div class="mov-autor">
          <div class="mov-avatar">${movIniciais(m.autorNome)}</div>
          <div><span class="mov-nome">${escaparHtml(m.autorNome)}</span><span class="mov-perfil ${m.autorPerfil}">${movLabelPerfil(m.autorPerfil)}</span></div>
        </div>
        <div class="mov-data">${movFmtDataHora(m.criadoEm)}</div>
      </div>
      <div class="mov-conteudo rt-content">${sanitizarHtml(m.texto)}</div>
      ${(m.anexos && m.anexos.length>0) ? m.anexos.map(a=>`<div class="mov-anexo-item">📎 <a href="${a.url}" target="_blank">${escaparHtml(a.nome)}</a> · <a href="${urlDownloadAnexo(a.url, a.nome)}" title="Baixar arquivo original">⬇ Baixar</a></div>`).join('') : ''}
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:2px;">
        ${!bloqueado ? `<button type="button" class="mov-btn-responder" onclick="responderMovimentacao('${m.id}','${sufixo}')">↩ Responder</button>` : ''}
        ${podeGerenciar ? `<button type="button" class="mov-btn-responder" onclick="editarMovimentacaoUi('${m.id}','${sufixo}')">✎ Editar</button>` : ''}
        ${podeGerenciar ? `<button type="button" class="mov-btn-responder" onclick="excluirMovimentacaoUi('${m.id}','${sufixo}')">🗑 Excluir</button>` : ''}
      </div>
    </div>`;
  }).join('');
}

function movLimparComposer(sufixo){
  const ids = movIds(sufixo);
  const estado = movEstado[sufixo];
  document.getElementById(ids.texto).innerHTML = '';
  document.getElementById(ids.anexo).value = '';
  document.getElementById(ids.anexoNome).textContent = '';
  document.getElementById(ids.respWrap).style.display = 'none';
  estado.respondendoId = null;
  estado.editandoId = null;
  estado.anexoArquivo = null;
  document.getElementById(ids.btnEnviar).textContent = 'Enviar';
}

function responderMovimentacao(id, sufixo){
  sufixo = sufixo || '';
  const ids = movIds(sufixo);
  const estado = movEstado[sufixo];
  const m = estado.cache.find(x=>x.id===id);
  if(!m) return;
  estado.editandoId = null;
  estado.respondendoId = id;
  document.getElementById(ids.respTexto).textContent = `Respondendo a ${m.autorNome}: "${stripHtml(m.texto).slice(0,60)}"`;
  document.getElementById(ids.respWrap).style.display = 'flex';
  document.getElementById(ids.btnEnviar).textContent = 'Enviar';
  document.getElementById(ids.texto).focus();
}

function editarMovimentacaoUi(id, sufixo){
  sufixo = sufixo || '';
  const ids = movIds(sufixo);
  const estado = movEstado[sufixo];
  const m = estado.cache.find(x=>x.id===id);
  if(!m) return;
  estado.respondendoId = null;
  estado.editandoId = id;
  document.getElementById(ids.texto).innerHTML = sanitizarHtml(m.texto || '');
  document.getElementById(ids.respTexto).textContent = `Editando a movimentação de ${m.autorNome}`;
  document.getElementById(ids.respWrap).style.display = 'flex';
  document.getElementById(ids.btnEnviar).textContent = 'Salvar edição';
  document.getElementById(ids.texto).focus();
}

function cancelarRespostaMovimentacao(sufixo){
  sufixo = sufixo || '';
  const ids = movIds(sufixo);
  const estado = movEstado[sufixo];
  estado.respondendoId = null;
  estado.editandoId = null;
  document.getElementById(ids.respWrap).style.display = 'none';
  document.getElementById(ids.btnEnviar).textContent = 'Enviar';
}

async function excluirMovimentacaoUi(id, sufixo){
  sufixo = sufixo || '';
  const estado = movEstado[sufixo];
  pedirConfirmacao('Excluir movimentação?', 'Essa ação não pode ser desfeita.', async ()=>{
    const conta = contaAtual();
    const r = await api('removerMovimentacao', { contaId: conta.id, id });
    if(!r.ok){ toast(r.erro || 'Não foi possível excluir.'); return; }
    await carregarMovimentacoes(estado.atendimentoId, sufixo);
    toast('Movimentação excluída');
  });
}

async function enviarMovimentacao(sufixo){
  sufixo = sufixo || '';
  const ids = movIds(sufixo);
  const estado = movEstado[sufixo];
  if(!estado.atendimentoId) return;
  const conta = contaAtual();
  const textoHtml = sanitizarHtml(document.getElementById(ids.texto).innerHTML.trim());
  const textoLimpo = stripHtml(textoHtml).trim();
  if(!textoLimpo && !estado.anexoArquivo){ toast('Escreva algo ou anexe um arquivo'); return; }

  const btn = document.getElementById(ids.btnEnviar);
  const editando = !!estado.editandoId;
  btn.disabled = true;
  btn.textContent = editando ? 'Salvando…' : 'Enviando…';
  try{
    let r;
    if(editando){
      r = await api('atualizarMovimentacao', { contaId: conta.id, id: estado.editandoId, texto: textoHtml });
    }else{
      const payload = {
        atendimentoId: estado.atendimentoId, texto: textoHtml, autorNome: conta.nome, autorPerfil: conta.perfil,
        respondendoA: estado.respondendoId, contaId: conta.id,
      };
      if(estado.anexoArquivo){
        payload.anexoBase64 = await lerArquivoBase64(estado.anexoArquivo);
        payload.anexoTipo = estado.anexoArquivo.type;
        payload.anexoNome = estado.anexoArquivo.name;
      }
      r = await api('criarMovimentacao', payload);
    }
    if(!r.ok){ toast(r.erro || 'Não foi possível salvar.'); return; }
    movLimparComposer(sufixo);
    await carregarMovimentacoes(estado.atendimentoId, sufixo);
    if(editando) toast('Movimentação atualizada');
  }catch(e){
    toast(e && e.message ? e.message : 'Não foi possível salvar.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Enviar';
  }
}

function escaparHtml(s){
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

/* ---------- texto rico (Solução) ---------- */
// remove o que pode ser perigoso (script, iframe, atributos on*, links javascript:)
// mantendo formatação (negrito, listas, imagens) — é um filtro simples, suficiente
// pra um app interno onde só admin/atendente escrevem nesse campo
function sanitizarHtml(html){
  const div = document.createElement('div');
  div.innerHTML = html || '';
  div.querySelectorAll('script,style,iframe,object,embed,link,meta').forEach(el=>el.remove());
  div.querySelectorAll('*').forEach(el=>{
    [...el.attributes].forEach(attr=>{
      const nome = attr.name.toLowerCase();
      if(nome.startsWith('on')) el.removeAttribute(attr.name);
      if((nome==='href' || nome==='src') && /^\s*javascript:/i.test(attr.value)) el.removeAttribute(attr.name);
    });
  });
  return div.innerHTML;
}
function stripHtml(html){
  const d = document.createElement('div');
  d.innerHTML = html || '';
  return (d.textContent || d.innerText || '').replace(/\s+/g,' ').trim();
}

// redimensionar imagem dentro dos editores de texto rico — via um "puxador" fixo
// que segue a imagem selecionada, funciona tanto no mouse quanto no toque (app Android),
// diferente do resize nativo do CSS que não responde a toque
let rtImgSelecionada = null;
let rtImgHandle = null;
function rtImgHandleEl(){
  if(!rtImgHandle){
    rtImgHandle = document.createElement('div');
    rtImgHandle.className = 'rt-img-handle';
    document.body.appendChild(rtImgHandle);
    rtImgHandle.addEventListener('pointerdown', rtIniciarRedimensionamento);
  }
  return rtImgHandle;
}
function rtPosicionarHandle(){
  if(!rtImgSelecionada) return;
  const r = rtImgSelecionada.getBoundingClientRect();
  const h = rtImgHandleEl();
  h.style.left = (r.right - 10) + 'px';
  h.style.top = (r.bottom - 10) + 'px';
}
function rtSelecionarImagem(img){
  if(rtImgSelecionada && rtImgSelecionada !== img) rtImgSelecionada.classList.remove('rt-img-sel');
  rtImgSelecionada = img;
  img.classList.add('rt-img-sel');
  rtImgHandleEl().style.display = 'block';
  rtPosicionarHandle();
}
function rtDeselecionarImagem(){
  if(rtImgSelecionada) rtImgSelecionada.classList.remove('rt-img-sel');
  rtImgSelecionada = null;
  if(rtImgHandle) rtImgHandle.style.display = 'none';
}
function rtIniciarRedimensionamento(e){
  if(!rtImgSelecionada) return;
  e.preventDefault();
  const handle = e.currentTarget;
  const img = rtImgSelecionada;
  const editor = img.closest('.rt-editor');
  const larguraMax = editor ? editor.clientWidth - 20 : 2000;
  const startX = e.clientX;
  const startWidth = img.getBoundingClientRect().width;
  if(handle.setPointerCapture) handle.setPointerCapture(e.pointerId);
  function mover(ev){
    const delta = ev.clientX - startX;
    let nova = Math.round(startWidth + delta);
    nova = Math.max(40, Math.min(nova, larguraMax));
    img.style.width = nova + 'px';
    img.style.height = 'auto';
    rtPosicionarHandle();
  }
  function soltar(ev){
    handle.removeEventListener('pointermove', mover);
    handle.removeEventListener('pointerup', soltar);
    handle.removeEventListener('pointercancel', soltar);
    if(handle.releasePointerCapture) handle.releasePointerCapture(ev.pointerId);
  }
  handle.addEventListener('pointermove', mover);
  handle.addEventListener('pointerup', soltar);
  handle.addEventListener('pointercancel', soltar);
}
document.addEventListener('click', (e)=>{
  if(rtImgSelecionada && e.target !== rtImgSelecionada && e.target !== rtImgHandle) rtDeselecionarImagem();
});
window.addEventListener('resize', rtPosicionarHandle);

// funciona pra qualquer editor de texto rico da tela (Detalhe, Solução...) —
// cada toolbar sabe qual editor controla via data-editor no próprio toolbar
function configurarEditorRico(){
  document.querySelectorAll('.rt-toolbar').forEach(toolbar=>{
    const editorId = toolbar.dataset.editor;
    toolbar.querySelectorAll('button[data-cmd]').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        document.getElementById(editorId).focus();
        document.execCommand(btn.dataset.cmd, false);
      });
    });
    const btnImagem = toolbar.querySelector('button[data-cmd-imagem]');
    if(btnImagem){
      const inputImagem = toolbar.querySelector('input[type=file]');
      btnImagem.addEventListener('click', ()=> inputImagem.click());
      inputImagem.addEventListener('change', async (e)=>{
        const arquivo = e.target.files[0];
        e.target.value = '';
        if(!arquivo) return;
        if(arquivo.size > 5 * 1024 * 1024){ toast('Imagem muito grande (máx. 5MB)'); return; }
        toast('Enviando imagem…');
        try{
          const base64 = await lerArquivoBase64(arquivo);
          const r = await api('uploadImagem', { base64, tipo: arquivo.type, nome: arquivo.name });
          if(!r.ok){ toast(r.erro || 'Não foi possível enviar a imagem.'); return; }
          document.getElementById(editorId).focus();
          document.execCommand('insertHTML', false, `<img src="${r.url}" alt="${escaparHtml(r.nome||'')}" title="Toque na imagem e arraste o puxador para redimensionar. Duplo toque para restaurar o tamanho original.">`);
        }catch(err){
          toast(err && err.message ? err.message : 'Não foi possível enviar a imagem.');
        }
      });
    }
    const editorEl = document.getElementById(editorId);
    if(editorEl){
      editorEl.addEventListener('click', (e)=>{
        if(e.target.tagName === 'IMG') rtSelecionarImagem(e.target);
      });
      editorEl.addEventListener('dblclick', (e)=>{
        if(e.target.tagName === 'IMG'){
          e.preventDefault();
          e.target.removeAttribute('style');
          if(rtImgSelecionada === e.target) rtPosicionarHandle();
        }
      });
      editorEl.addEventListener('scroll', rtPosicionarHandle);
    }
  });
}

/* ---------- anexos múltiplos (só disponível ao editar um atendimento já existente) ---------- */
async function carregarAnexosMultiplos(atendimentoId){
  const cont = document.getElementById('listaAnexos');
  cont.innerHTML = `<div class="empty" style="padding:14px;">Carregando…</div>`;
  try{
    const r = await api('listarAnexos', { atendimentoId });
    if(!r.ok){ cont.innerHTML = `<div class="empty" style="padding:14px;">${r.erro||'Não foi possível carregar os anexos.'}</div>`; return; }
    renderAnexosGenerico('listaAnexos', r.anexos, atendimentoId, true);
  }catch(e){
    cont.innerHTML = `<div class="empty" style="padding:14px;">Não foi possível carregar os anexos.</div>`;
  }
}
// usado tanto pela lista de anexos do formulário de edição (admin/atendente)
// quanto pela tela de visualização do chamado (usuário/atendente/admin)
function renderAnexosGenerico(containerId, lista, atendimentoId, podeRemover){
  const cont = document.getElementById(containerId);
  if(!lista || lista.length === 0){ cont.innerHTML = `<div class="empty" style="padding:10px 0;font-size:12.5px;">Nenhum anexo ainda.</div>`; return; }
  cont.innerHTML = lista.map(a=>`
    <div class="anexo-item">
      <a href="${a.url}" target="_blank">📎 ${escaparHtml(a.nome||'anexo')}</a>
      <a href="${urlDownloadAnexo(a.url, a.nome)}" title="Baixar arquivo original">⬇ Baixar</a>
      ${podeRemover ? `<button type="button" onclick="removerAnexoGenerico('${a.id}','${containerId}','${atendimentoId}',${podeRemover})">remover</button>` : ''}
    </div>`).join('');
}
async function adicionarAnexoGenerico(atendimentoId, arquivo, containerId, podeRemover){
  if(!atendimentoId){ toast('Salve o atendimento antes de anexar arquivos.'); return; }
  if(arquivo.size > 8 * 1024 * 1024){ toast('Anexo muito grande (máx. 8MB)'); return; }
  toast('Enviando anexo…');
  try{
    const base64 = await lerArquivoBase64(arquivo);
    const r = await api('adicionarAnexo', { atendimentoId, base64, tipo: arquivo.type, nome: arquivo.name });
    if(!r.ok){ toast(r.erro || 'Não foi possível enviar o anexo.'); return; }
    const rl = await api('listarAnexos', { atendimentoId });
    if(rl.ok) renderAnexosGenerico(containerId, rl.anexos, atendimentoId, podeRemover);
    toast('Anexo adicionado');
  }catch(e){
    toast(e && e.message ? e.message : 'Não foi possível enviar o anexo.');
  }
}
async function removerAnexoGenerico(id, containerId, atendimentoId, podeRemover){
  const r = await api('removerAnexo', { id });
  if(!r.ok){ toast(r.erro || 'Não foi possível remover.'); return; }
  const rl = await api('listarAnexos', { atendimentoId });
  if(rl.ok) renderAnexosGenerico(containerId, rl.anexos, atendimentoId, podeRemover);
  toast('Anexo removido');
}

/* ---------- navegação ---------- */
function goView(name){
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  document.getElementById('view-'+name).classList.add('active');
  document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('active', t.dataset.view===name));
  document.querySelectorAll('.navbtn').forEach(t=>t.classList.toggle('active', t.dataset.view===name));
  if(name==='lista') renderLista();
  if(name==='resumo') renderResumo();
  if(name==='dashboard') renderDashboard();
  if(name==='gantt'){ renderFiltrosGantt(); renderGantt(); }
  if(name==='relatorio'){
    renderRelatorioFiltros(); renderRelatorioColunas(); renderRelatorioPreview();
    carregarRelatoriosSalvos().then(renderListaRelatoriosSalvos);
  }
  if(name==='relatoriospub'){
    document.getElementById('cardPreviewRelatoriosPub').style.display = 'none';
    carregarRelatoriosPublicados();
  }
  if(name==='cubo'){ renderTodosSeletoresCubo(); renderCuboPerfilSelect(); renderCubo(); }
  if(name==='financeiro'){
    goFinSub(primeiraSubAbaVisivel('financeiro', finAba));
    popularClientesFinanceiro();
    popularMesesFinanceiro();
    renderFinAtendimentosLista();
    renderFinFiltros();
    carregarLancamentos().then(renderListaLancamentos);
    carregarNotasImportadas().then(renderListaNotasImportadas);
    document.getElementById('fin_xml_preview').style.display = 'none';
    document.getElementById('fin_xml_arquivo').value = '';
  }
  if(name==='agenda'){
    goAgSub(primeiraSubAbaVisivel('agenda', agAba));
    popularSelectsAgenda();
    renderSeletorCores('ag_cores', document.getElementById('ag_cor_selecionada').value);
    carregarAgendamentos().then(renderAgenda);
  }
  if(name==='videos'){
    const contaVid = contaAtual();
    const permVid = permissaoMenu(contaVid, 'videos');
    const podeInserirVidPadrao = permVid ? permVid.inserir : ehAdminEfetivo(contaVid);
    const podeInserirVid = menuVisivel(contaVid, 'videos.novo', podeInserirVidPadrao);
    if(podeInserirVid){ popularSelectsVideo(); limparFormVideo(); }
    goVidSub(primeiraSubAbaVisivel('videos', vidAba));
    vidFiltroModulo = 'TODOS';
    vidSelecionadoId = null;
    carregarVideos();
  }
  if(name==='cadastros') goCadSub(primeiraSubAbaVisivel('cadastros', cadAba));
  if(name==='utilitarios') resetUtilitarios();
}
function goCadSub(sub){
  cadAba = sub;
  document.querySelectorAll('.subtab').forEach(t=>t.classList.toggle('active', t.dataset.sub===sub));
  document.querySelectorAll('.cad-view').forEach(v=>{ v.style.display = (v.id === 'cad-'+sub) ? '' : 'none'; });
}

/* ---------- relógio ---------- */
function tickClock(){ document.getElementById('clock').textContent = new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}); }

/* ---------- puxar do topo pra atualizar (tipo o F5 do navegador) — o app
   Android roda numa WebView que não tem esse gesto nativo ---------- */
function configurarPullParaAtualizar(){
  const indicador = document.getElementById('pullRefreshIndicator');
  const texto = document.getElementById('pullRefreshTexto');
  const spinner = document.getElementById('pullRefreshSpinner');
  const LIMITE = 70;
  let inicioY = 0, puxando = false, distancia = 0, disparado = false;

  function podeComecar(alvo){
    if(disparado) return false;
    if(document.getElementById('app').style.display === 'none') return false; // ainda na tela de login
    if(document.querySelector('.modal-bg.show')) return false; // não atrapalha quem está usando um modal
    if(alvo && alvo.closest('.rt-editor, .lookup-dropdown, table')) return false; // tem rolagem própria — não brigar com ela
    return window.scrollY <= 0;
  }
  function atualizarVisual(d){
    indicador.style.height = Math.min(d, LIMITE + 20) + 'px';
    indicador.classList.toggle('com-borda', d > 4);
    spinner.style.display = 'none';
    texto.style.display = '';
    texto.textContent = d >= LIMITE ? '↑ Solte para atualizar' : '↓ Puxe para atualizar';
  }

  document.addEventListener('touchstart', e=>{
    if(!podeComecar(e.target)){ puxando = false; return; }
    inicioY = e.touches[0].clientY;
    puxando = true;
    distancia = 0;
  }, {passive:true});

  document.addEventListener('touchmove', e=>{
    if(!puxando || disparado) return;
    const dy = e.touches[0].clientY - inicioY;
    if(dy <= 0 || window.scrollY > 0){ puxando = false; atualizarVisual(0); return; }
    distancia = Math.min(dy * 0.5, LIMITE + 20); // resistência, igual apps nativos
    atualizarVisual(distancia);
    e.preventDefault(); // evita o overscroll/pull-to-refresh nativo do navegador brigando com o nosso
  }, {passive:false});

  document.addEventListener('touchend', ()=>{
    if(puxando && distancia >= LIMITE){
      disparado = true;
      indicador.style.height = LIMITE + 'px';
      indicador.classList.add('com-borda');
      spinner.style.display = '';
      texto.textContent = 'Atualizando…';
      setTimeout(()=>location.reload(), 200);
    } else if(puxando){
      atualizarVisual(0);
    }
    puxando = false;
  });
}

/* ---------- init ---------- */
window.addEventListener('DOMContentLoaded', async ()=>{
  wireLookupSingle('f_tipo', atualizarPreview);
  wireLookupSingle('f_atendente', atualizarPreview);
  wireLookupSingle('f_atendente2', ()=>{ atualizarVisibilidadeHoras2(); atualizarPreview(); });
  configurarEditorRico();
  configurarPullParaAtualizar();
  document.addEventListener('click', e=>{ if(!e.target.closest('.acoes-wrap')) fecharAcoesMenu(); });

  document.getElementById('f_novo_anexo').addEventListener('change', e=>{
    const arquivo = e.target.files[0];
    e.target.value = '';
    if(arquivo) adicionarAnexoGenerico(anexoAtendimentoId, arquivo, 'listaAnexos', true);
  });
  document.getElementById('f_anexo_detalhe').addEventListener('change', e=>{
    const arquivo = e.target.files[0];
    e.target.value = '';
    const conta = contaAtual();
    const podeRemover = !(conta && conta.perfil === 'USUARIO');
    if(arquivo) adicionarAnexoGenerico(chatAtendimentoId, arquivo, 'chatAnexosLista', podeRemover);
  });

  configurarBuscaVinculo('f_vinculo_busca', 'vinculoResultados', ()=>editandoId, (outroId)=>{
    adicionarVinculoAgora(editandoId, outroId, 'listaVinculos', true);
  });
  configurarBuscaVinculo('f_vinculo_busca_detalhe', 'vinculoResultadosDetalhe', ()=>chatAtendimentoId, (outroId)=>{
    adicionarVinculoAgora(chatAtendimentoId, outroId, 'chatVinculos', chatPodeRemoverVinculo);
  });
  configurarBuscaVideo('f_video_busca', 'videoVinculoResultados', ()=>videosVinculadosPorContainer['listaVideosVinculo']||[], (videoId)=>{
    adicionarVideoVinculoAgora(editandoId, videoId, 'listaVideosVinculo', true);
  });
  configurarBuscaVideo('f_video_busca_detalhe', 'videoVinculoResultadosDetalhe', ()=>videosVinculadosPorContainer['chatVideosVinculo']||[], (videoId)=>{
    adicionarVideoVinculoAgora(chatAtendimentoId, videoId, 'chatVideosVinculo', chatPodeRemoverVinculo);
  });

  document.getElementById('f_cliente').addEventListener('change', ()=>{ popularUsuariosSolicitantes(); atualizarPreview(); });
  document.getElementById('f_hi').addEventListener('change', atualizarPreview);
  document.getElementById('f_hf').addEventListener('change', atualizarPreview);
  document.getElementById('f_inter').addEventListener('change', atualizarPreview);
  document.getElementById('f_qtd_manual').addEventListener('input', atualizarPreview);
  document.getElementById('f_horas_atendente2').addEventListener('input', atualizarPreview);
  document.getElementById('btnSalvar').addEventListener('click', salvarRegistro);
  document.getElementById('btnExportar').addEventListener('click', exportarCsv);
  document.getElementById('btnExportarGantt').addEventListener('click', exportarCsvGantt);
  document.getElementById('btnPdfResumo').addEventListener('click', gerarPdfResumo);
  document.getElementById('btnPdfLista').addEventListener('click', gerarPdfLista);
  document.getElementById('btnPdfGantt').addEventListener('click', gerarPdfGantt);
  document.getElementById('btnPdfAtendimento').addEventListener('click', gerarPdfAtendimento);

  document.querySelector('[data-util-cat="esocial"]').addEventListener('click', ()=>{
    document.getElementById('utilCategorias').style.display = 'none';
    document.getElementById('utilEsocial').style.display = '';
  });
  document.getElementById('btnUtilEsocialVoltar').addEventListener('click', ()=>{
    document.getElementById('utilEsocial').style.display = 'none';
    document.getElementById('utilCategorias').style.display = '';
  });
  document.querySelector('[data-util-cat="tomticket"]').addEventListener('click', ()=>{
    document.getElementById('utilCategorias').style.display = 'none';
    document.getElementById('utilTomticket').style.display = '';
    renderUtilTomticketLista();
  });
  document.getElementById('btnUtilTomticketVoltar').addEventListener('click', ()=>{
    document.getElementById('utilTomticket').style.display = 'none';
    document.getElementById('utilCategorias').style.display = '';
  });
  document.querySelector('[data-util-ferr="evento1200"]').addEventListener('click', ()=>{
    document.getElementById('utilEsocial').style.display = 'none';
    document.getElementById('utilEvento1200').style.display = '';
  });
  document.getElementById('btnUtilEvento1200Voltar').addEventListener('click', ()=>{
    document.getElementById('utilEvento1200').style.display = 'none';
    document.getElementById('utilEsocial').style.display = '';
  });
  document.getElementById('btnGerarEvento1200').addEventListener('click', gerarConferenciaEvento1200);

  document.querySelector('[data-util-ferr="evento1200retorno"]').addEventListener('click', ()=>{
    document.getElementById('utilEsocial').style.display = 'none';
    document.getElementById('utilEvento1200Retorno').style.display = '';
  });
  document.getElementById('btnUtilEvento1200RetornoVoltar').addEventListener('click', ()=>{
    document.getElementById('utilEvento1200Retorno').style.display = 'none';
    document.getElementById('utilEsocial').style.display = '';
  });
  document.getElementById('btnGerarEvento1200Retorno').addEventListener('click', gerarRetornoEvento1200);

  document.querySelector('[data-util-ferr="evento1210"]').addEventListener('click', ()=>{
    abrirUtilXmlGenerico({
      titulo: 'Evento 1210 — Pagamentos',
      descricao: 'Envie um ou mais XMLs do evento 1210 (evtPgtos) — sai um Excel com todos os pagamentos de rendimentos do trabalho.',
      processar: gerarEvento1210Pagamentos,
    });
  });
  document.querySelector('[data-util-ferr="evento1210retorno"]').addEventListener('click', ()=>{
    abrirUtilXmlGenerico({
      titulo: 'Evento 1210 — Retorno',
      descricao: 'Envie um ou mais XMLs de retorno do evento 1210 — o Excel sai com o protocolo/recibo, as rubricas confirmadas e o IRRF por trabalhador (S-5002).',
      processar: gerarEvento1210Retorno,
    });
  });
  document.querySelector('[data-util-ferr="s5011"]').addEventListener('click', ()=>{
    abrirUtilXmlGenerico({
      titulo: 'S-5011 — Contribuições Sociais Consolidadas',
      descricao: 'Envie vários XMLs de retorno do evento evtCS (S-5011) — o Excel sai com o resumo mensal, a base por categoria de trabalhador, o 13º salário anual e o total por estabelecimento. Arquivos repetidos (mesmo Id) não contam em dobro.',
      processar: gerarS5011,
    });
  });
  document.querySelector('[data-util-ferr="s5012"]').addEventListener('click', ()=>{
    abrirUtilXmlGenerico({
      titulo: 'S-5012 — IRRF Consolidado',
      descricao: 'Envie vários XMLs de retorno do evento evtIrrf (S-5012) — o Excel sai com o resumo mensal de IRRF por código de receita. Arquivos repetidos (mesmo Id) não contam em dobro.',
      processar: gerarS5012,
    });
  });
  document.querySelector('[data-util-ferr="s5013"]').addEventListener('click', ()=>{
    abrirUtilXmlGenerico({
      titulo: 'S-5013 — FGTS Consolidado',
      descricao: 'Envie vários XMLs de retorno do evento evtFGTS (S-5013) — o Excel sai com o resumo mensal por tipo de base, o 13º salário anual e o total por estabelecimento. Arquivos repetidos (mesmo Id) não contam em dobro.',
      processar: gerarS5013,
    });
  });
  document.getElementById('btnUtilXmlGenericoVoltar').addEventListener('click', ()=>{
    document.getElementById('utilXmlGenerico').style.display = 'none';
    document.getElementById('utilEsocial').style.display = '';
  });
  document.getElementById('btnUtilXmlGenericoGerar').addEventListener('click', gerarUtilXmlGenerico);

  document.getElementById('btnPresetAtendimentos').addEventListener('click', ()=>aplicarPresetRelatorio('atendimentos'));
  document.getElementById('btnPresetFinanceiro').addEventListener('click', ()=>aplicarPresetRelatorio('financeiro'));
  document.getElementById('btnPresetDetalhado').addEventListener('click', ()=>aplicarPresetRelatorio('detalhado'));
  document.getElementById('relFiltroCliente').addEventListener('click', e=>{
    const chip = e.target.closest('.chip'); if(!chip) return;
    toggleFiltroMultiplo(relFiltroCliente, chip.dataset.valor);
    renderRelatorioFiltros(); renderRelatorioPreview();
  });
  document.getElementById('relFiltroTipo').addEventListener('click', e=>{
    const chip = e.target.closest('.chip'); if(!chip) return;
    toggleFiltroMultiplo(relFiltroTipo, chip.dataset.valor);
    renderRelatorioFiltros(); renderRelatorioPreview();
  });
  document.getElementById('relFiltroStatus').addEventListener('click', e=>{
    const chip = e.target.closest('.chip'); if(!chip) return;
    toggleFiltroMultiplo(relFiltroStatus, chip.dataset.valor);
    renderRelatorioFiltros(); renderRelatorioPreview();
  });
  document.getElementById('rel_de').addEventListener('change', renderRelatorioPreview);
  document.getElementById('rel_ate').addEventListener('change', renderRelatorioPreview);
  document.getElementById('rel_agrupar').addEventListener('change', e=>{ relAgrupar = e.target.value; renderRelatorioPreview(); });
  document.getElementById('relatorioColunasOrdem').addEventListener('click', e=>{
    const btn = e.target.closest('button[data-acao]'); if(!btn) return;
    const key = btn.dataset.key;
    if(btn.dataset.acao === 'remover'){
      relColunas = relColunas.filter(k=>k!==key);
      renderRelatorioColunas(); renderRelatorioPreview();
    }else{
      moverColunaRelatorio(key, btn.dataset.acao);
    }
  });
  document.getElementById('relatorioColunasDisponiveis').addEventListener('change', e=>{
    if(!e.target.classList.contains('rel-coluna-add')) return;
    const key = e.target.dataset.key;
    if(e.target.checked && !relColunas.includes(key)) relColunas.push(key);
    renderRelatorioColunas();
    renderRelatorioPreview();
  });
  document.getElementById('btnPdfRelatorio').addEventListener('click', gerarPdfRelatorio);
  document.getElementById('btnExcelRelatorio').addEventListener('click', gerarExcelRelatorio);
  document.getElementById('btnPdfRelatorioPub').addEventListener('click', gerarPdfRelatorio);
  document.getElementById('btnExcelRelatorioPub').addEventListener('click', gerarExcelRelatorio);
  document.getElementById('btnAbrirSalvarRelatorio').addEventListener('click', abrirModalSalvarRelatorio);
  document.getElementById('rel_salvar_cancelar').addEventListener('click', fecharModalSalvarRelatorio);
  document.getElementById('rel_salvar_confirmar').addEventListener('click', confirmarSalvarRelatorio);

  document.getElementById('fin_cliente').addEventListener('change', renderFinAtendimentosLista);
  document.getElementById('fin_mes').addEventListener('change', renderFinAtendimentosLista);
  document.getElementById('finAtendimentosLista').addEventListener('change', e=>{
    if(!e.target.classList.contains('fin-check-item')) return;
    const id = e.target.dataset.id;
    if(e.target.checked) finAtendimentosSelecionados.add(id); else finAtendimentosSelecionados.delete(id);
    atualizarValorTotalFin();
  });
  document.getElementById('btnGerarLancamento').addEventListener('click', gerarLancamento);
  document.getElementById('finFiltroCliente').addEventListener('click', e=>{
    const chip = e.target.closest('.chip'); if(!chip) return;
    toggleFiltroMultiplo(finFiltroCliente, chip.dataset.valor);
    renderFinFiltros(); renderListaLancamentos();
  });
  document.getElementById('finFiltroStatus').addEventListener('click', e=>{
    const chip = e.target.closest('.chip'); if(!chip) return;
    toggleFiltroMultiplo(finFiltroStatus, chip.dataset.valor);
    renderFinFiltros(); renderListaLancamentos();
  });
  document.getElementById('fin_baixar_cancelar').addEventListener('click', fecharModalBaixar);
  document.getElementById('fin_baixar_confirmar').addEventListener('click', confirmarBaixaLancamento);
  document.getElementById('fin_editar_cancelar').addEventListener('click', fecharModalEditarLancamento);
  document.getElementById('fin_editar_confirmar').addEventListener('click', confirmarEdicaoLancamento);
  document.getElementById('fin_xml_arquivo').addEventListener('change', aoEscolherArquivoXml);
  document.getElementById('btnSalvarNotaImportada').addEventListener('click', salvarNotaImportada);

  document.getElementById('finSubtabs').addEventListener('click', e=>{
    const tab = e.target.closest('.subtab'); if(!tab) return;
    goFinSub(tab.dataset.finsub);
  });
  document.getElementById('agSubtabs').addEventListener('click', e=>{
    const tab = e.target.closest('.subtab'); if(!tab) return;
    goAgSub(tab.dataset.agsub);
  });
  document.getElementById('vidSubtabs').addEventListener('click', e=>{
    const tab = e.target.closest('.subtab'); if(!tab) return;
    goVidSub(tab.dataset.vidsub);
  });
  document.getElementById('verNota_fechar').addEventListener('click', ()=>{
    document.getElementById('verNotaModal').classList.remove('show');
  });
  document.getElementById('finResumoFiltroCliente').addEventListener('click', e=>{
    const chip = e.target.closest('.chip'); if(!chip) return;
    toggleFiltroMultiplo(finResumoFiltroCliente, chip.dataset.valor);
    renderResumoFinanceiro();
  });
  document.getElementById('fin_resumo_de').addEventListener('change', renderResumoFinanceiro);
  document.getElementById('fin_resumo_ate').addEventListener('change', renderResumoFinanceiro);
  document.getElementById('fin_lista_de').addEventListener('change', renderListaLancamentos);
  document.getElementById('fin_lista_ate').addEventListener('change', renderListaLancamentos);

  // agenda
  document.querySelectorAll('.ag-modo-btn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      agModo = btn.dataset.modo;
      document.querySelectorAll('.ag-modo-btn').forEach(b=>b.classList.toggle('active', b===btn));
      renderAgenda();
    });
  });
  document.getElementById('agAnterior').addEventListener('click', ()=>agNavegar(-1));
  document.getElementById('agProximo').addEventListener('click', ()=>agNavegar(1));
  document.getElementById('agHoje').addEventListener('click', ()=>{ agDataRef = new Date(); renderAgenda(); });
  document.getElementById('ag_filtro_atendente').addEventListener('change', e=>{ agFiltroAtendente = e.target.value; renderAgenda(); });
  document.getElementById('ag_repetir').addEventListener('change', e=>{
    document.getElementById('campoAgendaRepetirAte').style.display = e.target.value === 'nao' ? 'none' : '';
  });
  document.getElementById('ag_cores').addEventListener('click', e=>{
    const op = e.target.closest('.ag-cor-opcao'); if(!op) return;
    document.getElementById('ag_cor_selecionada').value = op.dataset.cor;
    renderSeletorCores('ag_cores', op.dataset.cor);
  });
  document.getElementById('ag_cores_edit').addEventListener('click', e=>{
    const op = e.target.closest('.ag-cor-opcao'); if(!op) return;
    document.getElementById('ag_edit_cor').value = op.dataset.cor;
    renderSeletorCores('ag_cores_edit', op.dataset.cor);
  });
  document.getElementById('btnCriarAgendamento').addEventListener('click', criarAgendamento);
  document.getElementById('ag_editar_cancelar').addEventListener('click', fecharEditarAgendamento);
  document.getElementById('ag_editar_confirmar').addEventListener('click', confirmarEdicaoAgendamento);
  document.getElementById('ag_editar_excluir').addEventListener('click', ()=>{
    const idParaExcluir = agEditandoId;
    fecharEditarAgendamento();
    pedirConfirmacao('Excluir agendamento?', 'Essa ação não pode ser desfeita.', ()=>excluirAgendamento(idParaExcluir));
  });

  document.getElementById('r_mes').addEventListener('change', renderResumo);
  document.getElementById('r_atendente').addEventListener('change', e=>{ filtroResumoAtendente = e.target.value; renderResumo(); });

  document.getElementById('filtros').addEventListener('mousedown', e=>{
    // evita que o clique num item/remover tire o foco do input antes da
    // hora — sem isso, o "focusout" já esconderia o dropdown a cada
    // seleção, impedindo escolher mais de um cliente em sequência
    if(e.target.closest('.lookup-dropdown-item') || e.target.closest('[data-remover]')) e.preventDefault();
  });
  document.getElementById('filtros').addEventListener('click', e=>{
    const item = e.target.closest('.lookup-dropdown-item');
    if(item){
      const nome = item.dataset.cliente;
      if(filtroCliente.has(nome)) filtroCliente.delete(nome); else filtroCliente.add(nome);
      renderFiltroClienteTags();
      renderFiltroClienteDropdown(document.getElementById('filtroClienteBusca').value);
      renderLista();
      return;
    }
    const btnRemover = e.target.closest('[data-remover]');
    if(btnRemover){
      filtroCliente.delete(btnRemover.dataset.remover);
      renderFiltroClienteTags();
      renderFiltroClienteDropdown(document.getElementById('filtroClienteBusca')?.value || '');
      renderLista();
    }
  });
  document.getElementById('filtros').addEventListener('input', e=>{
    if(e.target.id === 'filtroClienteBusca') renderFiltroClienteDropdown(e.target.value);
    if(e.target.id === 'filtroIdBusca'){ filtroId = e.target.value; renderLista(); }
  });
  document.getElementById('filtros').addEventListener('focusin', e=>{
    if(e.target.id !== 'filtroClienteBusca') return;
    renderFiltroClienteDropdown(e.target.value);
    document.getElementById('filtroClienteDropdown').classList.add('show');
  });
  document.getElementById('filtros').addEventListener('focusout', e=>{
    if(e.target.id !== 'filtroClienteBusca') return;
    // atraso pequeno pra dar tempo do clique num item do dropdown ser
    // processado antes dele sumir (senão o blur esconde antes do click)
    setTimeout(()=>{ const dd = document.getElementById('filtroClienteDropdown'); if(dd) dd.classList.remove('show'); }, 150);
  });
  document.getElementById('filtrosStatus').addEventListener('mousedown', e=>{
    if(e.target.closest('.lookup-dropdown-item') || e.target.closest('[data-remover-status]')) e.preventDefault();
  });
  document.getElementById('filtrosStatus').addEventListener('click', e=>{
    const item = e.target.closest('.lookup-dropdown-item');
    if(item){
      const nome = item.dataset.statusOpcao;
      if(filtroStatus.has(nome)) filtroStatus.delete(nome); else filtroStatus.add(nome);
      renderFiltroStatusTags();
      renderFiltroStatusDropdown(document.getElementById('filtroStatusBusca').value);
      renderLista();
      return;
    }
    const btnRemover = e.target.closest('[data-remover-status]');
    if(btnRemover){
      filtroStatus.delete(btnRemover.dataset.removerStatus);
      renderFiltroStatusTags();
      renderFiltroStatusDropdown(document.getElementById('filtroStatusBusca')?.value || '');
      renderLista();
    }
  });
  document.getElementById('filtrosStatus').addEventListener('input', e=>{
    if(e.target.id === 'filtroStatusBusca') renderFiltroStatusDropdown(e.target.value);
  });
  document.getElementById('filtrosStatus').addEventListener('focusin', e=>{
    if(e.target.id !== 'filtroStatusBusca') return;
    renderFiltroStatusDropdown(e.target.value);
    document.getElementById('filtroStatusDropdown').classList.add('show');
  });
  document.getElementById('filtrosStatus').addEventListener('focusout', e=>{
    if(e.target.id !== 'filtroStatusBusca') return;
    setTimeout(()=>{ const dd = document.getElementById('filtroStatusDropdown'); if(dd) dd.classList.remove('show'); }, 150);
  });
  document.getElementById('r_cliente_chips').addEventListener('click', e=>{
    const chip = e.target.closest('.chip'); if(!chip) return;
    if(chip.dataset.cliente === 'TODOS'){ filtroResumoCliente.clear(); }
    else{ if(filtroResumoCliente.has(chip.dataset.cliente)) filtroResumoCliente.delete(chip.dataset.cliente); else filtroResumoCliente.add(chip.dataset.cliente); }
    renderResumo();
  });
  document.getElementById('periodo_de').addEventListener('change', renderLista);
  document.getElementById('periodo_ate').addEventListener('change', renderLista);
  document.getElementById('fin_notas_periodo_de').addEventListener('change', renderListaNotasImportadas);
  document.getElementById('fin_notas_periodo_ate').addEventListener('change', renderListaNotasImportadas);
  document.getElementById('cubo_periodo_de').addEventListener('change', renderCubo);
  document.getElementById('cubo_periodo_ate').addEventListener('change', renderCubo);
  document.getElementById('view-cubo').addEventListener('click', e=>{
    const btnAdd = e.target.closest('[data-cubo-adicionar]');
    if(btnAdd){
      const [tipo, chave] = btnAdd.dataset.cuboAdicionar.split(':');
      CUBO_TIPO_INFO[tipo].lista().push(chave);
      if(tipo === 'linhas') cuboLinhasColapsadas.clear();
      renderCuboSeletor(tipo);
      renderCubo();
      return;
    }
    const btnRem = e.target.closest('[data-cubo-remover]');
    if(btnRem){
      const [tipo, chave] = btnRem.dataset.cuboRemover.split(':');
      const info = CUBO_TIPO_INFO[tipo];
      const lista = info.lista();
      if(info.minimoUm && lista.length <= 1){ toast('Escolha pelo menos um(a)'); return; }
      const idx = lista.indexOf(chave);
      if(idx >= 0) lista.splice(idx, 1);
      if(tipo === 'linhas') cuboLinhasColapsadas.clear();
      renderCuboSeletor(tipo);
      renderCubo();
      return;
    }
    const btnMover = e.target.closest('[data-cubo-mover]');
    if(btnMover){
      const [tipo, indiceStr, direcaoStr] = btnMover.dataset.cuboMover.split(':');
      const lista = CUBO_TIPO_INFO[tipo].lista();
      const indice = Number(indiceStr), novoIndice = indice + Number(direcaoStr);
      if(novoIndice < 0 || novoIndice >= lista.length) return;
      [lista[indice], lista[novoIndice]] = [lista[novoIndice], lista[indice]];
      if(tipo === 'linhas') cuboLinhasColapsadas.clear();
      renderCuboSeletor(tipo);
      renderCubo();
      return;
    }
    const btnToggle = e.target.closest('[data-cubo-toggle-linha]');
    if(btnToggle){
      const caminho = btnToggle.dataset.cuboToggleLinha;
      if(cuboLinhasColapsadas.has(caminho)) cuboLinhasColapsadas.delete(caminho); else cuboLinhasColapsadas.add(caminho);
      renderCubo();
    }
  });
  document.getElementById('btnExportarCubo').addEventListener('click', exportarCuboExcel);
  document.getElementById('cuboPerfilSelect').addEventListener('change', cuboCarregarPerfilSelecionado);
  document.getElementById('btnCuboSalvarPerfil').addEventListener('click', cuboSalvarPerfilAtual);
  document.getElementById('btnCuboRemoverPerfil').addEventListener('click', cuboRemoverPerfilSelecionado);

  segmentedSetup('listaVisualizacaoToggle', ()=>{
    visualizacaoAtendimentos = getSegSel('listaVisualizacaoToggle');
    renderLista();
  });
  document.getElementById('kanbanBoard').addEventListener('pointerdown', e=>{
    const handle = e.target.closest('.kanban-card-handle');
    if(!handle) return;
    iniciarDragKanban(e, handle);
  });
  document.getElementById('listaItens').addEventListener('pointerdown', e=>{
    if(e.target.closest('.lista-th-filtro-wrap')) return; // clique no ▾ de filtro não inicia ordenar/arrastar
    const th = e.target.closest('.lista-th-arrastavel');
    if(!th) return;
    iniciarPossivelDragColunaLista(e, th);
  });
  document.getElementById('listaItens').addEventListener('click', e=>{
    const toggleGrupo = e.target.closest('.lista-grupo-toggle');
    if(toggleGrupo){ toggleGrupoListaColapsado(toggleGrupo.dataset.caminho); return; }
    const item = e.target.closest('.lista-filtro-coluna-item');
    if(!item) return;
    const campo = item.dataset.campo;
    const valor = item.dataset.valor;
    const set = filtroColunaAtivo(campo);
    if(valor === '') set.clear();
    else if(set.has(valor)) set.delete(valor);
    else set.add(valor);
    renderLista();
  });
  document.addEventListener('click', e=>{ if(!e.target.closest('.lista-th-filtro-wrap')) fecharFiltroColunaLista(); });
  document.getElementById('kanbanBoard').addEventListener('click', e=>{
    if(kanbanAcabouDeArrastar) return;
    const card = e.target.closest('.kanban-card');
    if(!card) return;
    abrirDetalhe(card.dataset.id); // a própria função já checa se a conta pode ver esse atendimento
  });

  document.getElementById('ganttFiltroCliente').addEventListener('click', e=>{
    const chip = e.target.closest('.chip'); if(!chip) return;
    toggleFiltroMultiplo(filtroGanttCliente, chip.dataset.valor);
    renderFiltrosGantt(); renderGantt();
  });
  document.getElementById('ganttFiltroTipo').addEventListener('click', e=>{
    const chip = e.target.closest('.chip'); if(!chip) return;
    toggleFiltroMultiplo(filtroGanttTipo, chip.dataset.valor);
    renderFiltrosGantt(); renderGantt();
  });
  document.getElementById('ganttFiltroStatus').addEventListener('click', e=>{
    const chip = e.target.closest('.chip'); if(!chip) return;
    toggleFiltroMultiplo(filtroGanttStatus, chip.dataset.valor);
    renderFiltrosGantt(); renderGantt();
  });
  document.getElementById('gantt_de').addEventListener('change', renderGantt);
  document.getElementById('gantt_ate').addEventListener('change', renderGantt);

  document.getElementById('dash_de').addEventListener('change', renderDashboard);
  document.getElementById('dash_ate').addEventListener('change', renderDashboard);
  document.getElementById('dashFiltroCliente').addEventListener('click', e=>{
    const chip = e.target.closest('.chip'); if(!chip) return;
    toggleFiltroMultiplo(dashFiltroCliente, chip.dataset.valor);
    renderDashboard();
  });
  document.getElementById('dashFiltroAtendente').addEventListener('click', e=>{
    const chip = e.target.closest('.chip'); if(!chip) return;
    toggleFiltroMultiplo(dashFiltroAtendente, chip.dataset.valor);
    renderDashboard();
  });
  document.getElementById('dashFiltroStatus').addEventListener('click', e=>{
    const chip = e.target.closest('.chip'); if(!chip) return;
    toggleFiltroMultiplo(dashFiltroStatus, chip.dataset.valor);
    renderDashboard();
  });
  document.getElementById('dashSubtabs').addEventListener('click', e=>{
    const t = e.target.closest('.subtab'); if(!t) return;
    goDashSub(t.dataset.dashsub);
  });

  document.querySelectorAll('.tab').forEach(t=>t.addEventListener('click', ()=>{
    if(t.dataset.view === 'novo') resetForm(); // clicar em "Novo" sempre começa um formulário limpo — sem isso, editandoId ficava "grudado" no último atendimento editado e o Salvar sobrescrevia ele em vez de criar um novo
    goView(t.dataset.view);
  }));
  document.querySelectorAll('.navbtn').forEach(t=>t.addEventListener('click', ()=>{
    if(t.dataset.view === 'novo') resetForm();
    goView(t.dataset.view);
  }));
  document.querySelectorAll('.subtab').forEach(t=>t.addEventListener('click', ()=>goCadSub(t.dataset.sub)));

  document.getElementById('btnLogin').addEventListener('click', tentarLogin);
  document.getElementById('listaEmpresasEscolha').addEventListener('click', async e=>{
    const btn = e.target.closest('.empresa-opcao'); if(!btn) return;
    empresaAtual = empresasParaEscolher[Number(btn.dataset.idx)];
    await finalizarLoginComEmpresa();
  });
  document.getElementById('btnCancelarEscolhaEmpresa').addEventListener('click', ()=>{
    document.getElementById('screen-empresa').style.display = 'none';
    if(trocandoEmpresa){
      document.getElementById('app').style.display = 'block';
    }else{
      sessaoConta = null; limparSessao();
      document.getElementById('screen-login').style.display = 'flex';
    }
  });
  document.getElementById('btnEmpresaAtual').addEventListener('click', abrirTrocaDeEmpresa);
  document.getElementById('loginPass').addEventListener('keydown', e=>{ if(e.key==='Enter') tentarLogin(); });
  document.getElementById('toggleSenha').addEventListener('click', ()=>{
    const campo = document.getElementById('loginPass'); const btn = document.getElementById('toggleSenha');
    if(campo.type === 'password'){ campo.type = 'text'; btn.textContent = 'OCULTAR'; } else { campo.type = 'password'; btn.textContent = 'MOSTRAR'; }
  });
  document.getElementById('btnLogout').addEventListener('click', ()=>pedirConfirmacao('Sair da conta?','Você poderá entrar novamente quando quiser.', sair, 'Sair'));
  document.getElementById('btnTema').addEventListener('click', alternarTema);
  document.getElementById('btnMinhaSenha').addEventListener('click', abrirModalSenha);
  document.getElementById('btnNotificacoes').addEventListener('click', alternarNotificacoes);
  document.getElementById('senhaCancelar').addEventListener('click', fecharModalSenha);
  document.getElementById('senhaConfirmar').addEventListener('click', salvarNovaSenha);

  document.getElementById('btnFecharChat').addEventListener('click', fecharChat);

  document.getElementById('chkSelecionarTodos').addEventListener('change', e=>{
    const idsVisiveis = [...document.querySelectorAll('.chk-item')].map(c=>c.dataset.id);
    if(e.target.checked){ idsVisiveis.forEach(id=>selecionados.add(id)); }
    else{ idsVisiveis.forEach(id=>selecionados.delete(id)); }
    renderLista();
  });
  document.getElementById('btnLimparSelecao').addEventListener('click', limparSelecao);
  document.getElementById('btnAlterarStatusMassa').addEventListener('click', abrirModalStatusMassa);
  document.getElementById('statusMassaCancelar').addEventListener('click', fecharModalStatusMassa);
  document.getElementById('statusMassaConfirmar').addEventListener('click', aplicarStatusMassa);
  document.getElementById('btnEnviarMovimentacao').addEventListener('click', ()=>enviarMovimentacao(''));
  document.getElementById('movCancelarResposta').addEventListener('click', ()=>cancelarRespostaMovimentacao(''));
  document.getElementById('mov_anexo').addEventListener('change', e=>{
    const arquivo = e.target.files[0];
    movEstado[''].anexoArquivo = arquivo || null;
    document.getElementById('mov_anexo_nome').textContent = arquivo ? `📎 ${arquivo.name}` : '';
  });
  document.getElementById('btnEnviarMovimentacao_ed').addEventListener('click', ()=>enviarMovimentacao('_ed'));
  document.getElementById('movCancelarResposta_ed').addEventListener('click', ()=>cancelarRespostaMovimentacao('_ed'));
  document.getElementById('mov_anexo_ed').addEventListener('change', e=>{
    const arquivo = e.target.files[0];
    movEstado['_ed'].anexoArquivo = arquivo || null;
    document.getElementById('mov_anexo_ed_nome').textContent = arquivo ? `📎 ${arquivo.name}` : '';
  });

  document.getElementById('btnAddAtendente').addEventListener('click', async ()=>{
    const nome = document.getElementById('at_nome').value.trim();
    const login = document.getElementById('at_login').value.trim();
    const senha = document.getElementById('at_senha').value;
    const email = document.getElementById('at_email').value.trim();
    const telefone = document.getElementById('at_telefone').value.trim();
    const ehAdministrador = document.getElementById('at_administrador').checked;
    const perfisMarcados = lerPerfisAcessoMarcados('at_perfis_acesso');
    const empresasMarcadas = lerEmpresasMarcadas('at_empresas');
    if(!nome || !login){ toast('Preencha nome e login'); return; }
    if(!editandoAtendenteId && !senha){ toast('Informe uma senha'); return; }

    let r;
    const editando = !!editandoAtendenteId;
    if(editando){
      r = await api('atualizarConta', { id: editandoAtendenteId, nome: nome.toUpperCase(), login, senha, email, telefone, ehAdministrador });
    }else{
      r = await api('addAtendente', { nome: nome.toUpperCase(), login, senha, email, telefone, ehAdministrador });
    }
    if(!r.ok) return;
    const contaAlvoId = editando ? editandoAtendenteId : r.conta.id;
    const conta = contaAtual();
    await api('vincularPerfisConta', { contaId: conta.id, contaAlvoId, perfilIds: perfisMarcados });
    await api('vincularEmpresasConta', { contaId: conta.id, contaAlvoId, empresaIds: empresasMarcadas });
    cancelarEdicaoAtendente();
    await carregarTudo(); renderListAtendentes(); popularSelects();
    toast(editando ? 'Atendente atualizado' : 'Atendente adicionado');
  });
  document.getElementById('btnCancelarEdicaoAtendente').addEventListener('click', cancelarEdicaoAtendente);

  document.getElementById('emp_logo_arquivo').addEventListener('change', e=>{
    const arquivo = e.target.files[0];
    if(!arquivo) return;
    empresaLogoArquivoSelecionado = arquivo;
    const preview = document.getElementById('emp_logo_preview');
    const leitor = new FileReader();
    leitor.onload = ()=>{ preview.innerHTML = `<img src="${leitor.result}" style="width:100%;height:100%;object-fit:contain;">`; };
    leitor.readAsDataURL(arquivo);
  });
  document.getElementById('btnAddEmpresa').addEventListener('click', async ()=>{
    const nome = document.getElementById('emp_nome').value.trim();
    if(!nome){ toast('Preencha a razão social'); return; }
    const conta = contaAtual();
    let logoUrl = document.getElementById('emp_logo_preview').dataset.url || '';
    if(empresaLogoArquivoSelecionado){
      const base64 = await lerArquivoBase64(empresaLogoArquivoSelecionado);
      const rUpload = await api('uploadImagem', { base64, tipo: empresaLogoArquivoSelecionado.type, nome: empresaLogoArquivoSelecionado.name });
      if(!rUpload.ok){ toast('Não foi possível enviar o logo.'); return; }
      logoUrl = rUpload.url;
    }
    const payload = {
      contaId: conta.id, id: editandoEmpresaId,
      nome, nomeFantasia: document.getElementById('emp_nome_fantasia').value.trim(),
      cnpj: document.getElementById('emp_cnpj').value.trim(),
      endereco: document.getElementById('emp_endereco').value.trim(),
      telefone: document.getElementById('emp_telefone').value.trim(),
      email: document.getElementById('emp_email').value.trim(),
      cnae: document.getElementById('emp_cnae').value.trim(),
      inscricaoMunicipal: document.getElementById('emp_inscricao_municipal').value.trim(),
      inscricaoEstadual: document.getElementById('emp_inscricao_estadual').value.trim(),
      horasValidacaoAutomatica: Number(document.getElementById('emp_horas_validacao').value) || 48,
      logoUrl, padrao: document.getElementById('emp_padrao').checked,
    };
    const editando = !!editandoEmpresaId;
    const r = await api('salvarEmpresa', payload);
    if(!r.ok){ toast(r.erro || 'Não foi possível salvar.'); return; }
    limparFormEmpresa();
    await carregarTudo();
    renderCadastrosTudo();
    toast(editando ? 'Empresa atualizada' : 'Empresa adicionada');
  });
  document.getElementById('btnCancelarEdicaoEmpresa').addEventListener('click', limparFormEmpresa);

  document.getElementById('btnAddVideo').addEventListener('click', salvarVideoUi);
  document.getElementById('btnCancelarEdicaoVideo').addEventListener('click', ()=>{ limparFormVideo(); goVidSub('lista'); });
  document.getElementById('vidFiltroModulo').addEventListener('click', e=>{
    const chip = e.target.closest('.chip'); if(!chip) return;
    vidFiltroModulo = chip.dataset.valor;
    renderFiltroModuloVideo();
    renderListaVideos();
  });

  document.getElementById('btnAddCliente').addEventListener('click', async ()=>{
    const nome = document.getElementById('cl_nome').value.trim();
    const cnpj = document.getElementById('cl_cnpj').value.trim();
    const nomeFantasia = document.getElementById('cl_nome_fantasia').value.trim();
    const metaMensal = Number(document.getElementById('cl_meta_mensal').value) || 0;
    const empresaId = empresas.length > 0 ? document.getElementById('cl_empresa').value : (empresaAtual ? empresaAtual.id : '');
    if(!nome){ toast('Informe o nome do cliente'); return; }
    const editando = !!editandoClienteId;
    const r = editando
      ? await api('atualizarCliente', { id: editandoClienteId, nome: nome.toUpperCase(), cnpj, nomeFantasia, metaMensal, empresaId })
      : await api('addCliente', { nome: nome.toUpperCase(), cnpj, nomeFantasia, metaMensal, empresaId });
    if(!r.ok){ toast(r.erro || 'Não foi possível salvar.'); return; }
    cancelarEdicaoCliente();
    await carregarTudo(); renderListClientes(); popularSelects(); renderValoresForm(); renderFiltros();
    toast(editando ? 'Cliente atualizado' : 'Cliente adicionado');
  });
  document.getElementById('btnCancelarEdicaoCliente').addEventListener('click', cancelarEdicaoCliente);

  document.getElementById('btnAddTipo').addEventListener('click', async ()=>{
    const nome = document.getElementById('tp_nome').value.trim();
    if(!nome){ toast('Informe o nome do tipo'); return; }
    const r = await api('addTipo', { nome: nome.toUpperCase() });
    if(!r.ok) return;
    document.getElementById('tp_nome').value='';
    await carregarTudo(); renderListTipos(); popularSelects(); renderValoresForm();
    toast('Tipo adicionado');
  });

  document.getElementById('btnAddModulo').addEventListener('click', async ()=>{
    const nome = document.getElementById('md_nome').value.trim();
    if(!nome){ toast('Informe o nome do módulo'); return; }
    const r = await api('addModulo', { nome });
    if(!r.ok) return;
    document.getElementById('md_nome').value='';
    await carregarTudo(); renderListModulos(); popularSelects();
    toast('Módulo adicionado');
  });

  document.getElementById('btnAddSubModulo').addEventListener('click', async ()=>{
    const nome = document.getElementById('sm_nome').value.trim();
    if(!nome){ toast('Informe o nome do sub módulo'); return; }
    const r = await api('addSubModulo', { nome });
    if(!r.ok) return;
    document.getElementById('sm_nome').value='';
    await carregarTudo(); renderListSubModulos(); popularSelects();
    toast('Sub módulo adicionado');
  });

  document.getElementById('btnAddStatus').addEventListener('click', async ()=>{
    const nome = document.getElementById('st_nome').value.trim();
    if(!nome){ toast('Informe o nome do status'); return; }
    const r = await api('addStatus', { nome: nome.toUpperCase() });
    if(!r.ok) return;
    document.getElementById('st_nome').value='';
    await carregarTudo(); renderListStatus(); popularSelects();
    toast('Status adicionado');
  });

  document.getElementById('btnAddValor').addEventListener('click', async ()=>{
    const atendenteId = document.getElementById('vl_atendente').value;
    const clienteId = document.getElementById('vl_cliente').value;
    const tipoId = document.getElementById('vl_tipo').value;
    const real = parseFloat(document.getElementById('vl_real').value);
    const ananda = parseFloat(document.getElementById('vl_ananda').value);
    const valorSegundoAtendStr = document.getElementById('vl_valor_segundo_atend').value;
    const valorSegundoAtend = valorSegundoAtendStr !== '' ? parseFloat(valorSegundoAtendStr) : 0;
    if(!atendenteId || !clienteId || !tipoId || isNaN(real) || isNaN(ananda)){ toast('Preencha todos os campos, incluindo o atendente'); return; }
    const r = await api('salvarValor', { atendenteId, clienteId, tipoId, real, ananda, valorSegundoAtend, empresaId: empresaAtual ? empresaAtual.id : '' });
    if(!r.ok) return;
    document.getElementById('vl_real').value=''; document.getElementById('vl_ananda').value=''; document.getElementById('vl_valor_segundo_atend').value='';
    await carregarTudo(); renderTabelaValores();
    toast('Valores salvos');
  });

  document.getElementById('filtroValoresAtendente').addEventListener('click', e=>{
    const chip = e.target.closest('.chip'); if(!chip) return;
    filtroValoresAtendenteId = chip.dataset.atendente;
    document.querySelectorAll('#filtroValoresAtendente .chip').forEach(c=>c.classList.remove('on'));
    chip.classList.add('on');
    renderTabelaValores();
  });

  document.getElementById('btnRecalcularValores').addEventListener('click', ()=>{
    pedirConfirmacao(
      'Recalcular valores de todos os atendimentos?',
      'Vai buscar o valor certo (por atendente + cliente + tipo) pra cada atendimento salvo e atualizar só os campos em R$. Pode levar alguns segundos se houver muitos atendimentos.',
      recalcularValores,
      'Recalcular'
    );
  });

  document.getElementById('btnAddUsuario').addEventListener('click', async ()=>{
    const clienteId = document.getElementById('us_cliente').value;
    const nome = document.getElementById('us_nome').value.trim();
    const login = document.getElementById('us_login').value.trim();
    const senha = document.getElementById('us_senha').value;
    const email = document.getElementById('us_email').value.trim();
    const telefone = document.getElementById('us_telefone').value.trim();
    const adminCliente = document.getElementById('us_admin_cliente').checked;
    const perfisMarcados = lerPerfisAcessoMarcados('us_perfis_acesso');
    if(!clienteId || !nome || !login){ toast('Preencha todos os campos'); return; }
    if(!editandoUsuarioId && !senha){ toast('Informe uma senha'); return; }

    const editando = !!editandoUsuarioId;
    let r;
    if(editando){
      r = await api('atualizarConta', { id: editandoUsuarioId, nome: nome.toUpperCase(), login, senha, clienteId, email, telefone, adminCliente });
    }else{
      r = await api('addUsuario', { nome: nome.toUpperCase(), login, senha, clienteId, email, telefone, adminCliente });
    }
    if(!r.ok) return;
    const contaAlvoId = editando ? editandoUsuarioId : r.conta.id;
    const conta = contaAtual();
    await api('vincularPerfisConta', { contaId: conta.id, contaAlvoId, perfilIds: perfisMarcados });
    cancelarEdicaoUsuario();
    await carregarTudo(); renderListUsuarios(); popularSelects();
    toast(editando ? 'Usuário atualizado' : 'Usuário adicionado');
  });
  document.getElementById('btnCancelarEdicaoUsuario').addEventListener('click', cancelarEdicaoUsuario);

  limparFormPerfilAcesso();
  document.getElementById('btnAddPerfilAcesso').addEventListener('click', async ()=>{
    const nome = document.getElementById('pa_nome').value.trim();
    if(!nome){ toast('Dê um nome ao perfil'); return; }
    const permissoes = lerMatrizPerfil();
    const conta = contaAtual();
    const editando = !!editandoPerfilAcessoId;
    const r = await api('salvarPerfilAcesso', { contaId: conta.id, id: editandoPerfilAcessoId, nome, permissoes });
    if(!r.ok){ toast(r.erro || 'Não foi possível salvar.'); return; }
    limparFormPerfilAcesso();
    await carregarTudo(); renderCadastrosTudo();
    toast(editando ? 'Perfil atualizado' : 'Perfil criado');
  });
  document.getElementById('btnCancelarEdicaoPerfilAcesso').addEventListener('click', limparFormPerfilAcesso);

  document.getElementById('modalCancel').addEventListener('click', ()=>{ document.getElementById('modalBg').classList.remove('show'); excluindoAcao=null; });
  document.getElementById('modalConfirm').addEventListener('click', async ()=>{
    if(excluindoAcao) await excluindoAcao();
    document.getElementById('modalBg').classList.remove('show');
    excluindoAcao = null;
  });

  tickClock();
  setInterval(tickClock, 30000);

  if('serviceWorker' in navigator){ navigator.serviceWorker.register('sw.js').catch(()=>{}); }

  const sessaoSalva = lerSessao();
  const empresaSalva = lerEmpresaSalva();
  if(sessaoSalva && empresaSalva){
    sessaoConta = sessaoSalva;
    empresaAtual = empresaSalva;
    mostrarCarregando(true);
    try{
      const ok = await carregarTudo();
      mostrarCarregando(false);
      if(ok) entrarNoApp(); else sair();
    }catch(e){ mostrarCarregando(false); sair(); }
  }else{
    // sessão sem empresa salva (ex: conta antiga de antes desse recurso
    // existir) — mais simples e seguro pedir login de novo do que tentar
    // adivinhar qual empresa usar
    if(sessaoSalva) limparSessao();
    carregarLogoLogin();
    document.getElementById('screen-login').style.display = 'flex';
  }
});

// logo/nome mostrados na tela de login, antes de qualquer autenticação —
// pega a empresa marcada como "padrão" (ação pública, sem contaId)
async function carregarLogoLogin(){
  try{
    const r = await api('empresaPadrao', {});
    if(r.ok && r.empresa){
      document.getElementById('loginEmpresaNome').textContent = r.empresa.nome;
      if(r.empresa.logoUrl) document.getElementById('loginLogoBox').innerHTML = `<img src="${r.empresa.logoUrl}" alt="${escaparHtml(r.empresa.nome)}">`;
    }
  }catch(e){ /* sem empresa padrão configurada ainda — mantém o logo genérico */ }
}
