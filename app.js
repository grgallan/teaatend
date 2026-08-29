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

let contas = [], clientes = [], tipos = [], modulos = [], submodulos = [], statusList = [], valores = [], atendimentos = [], vinculos = [], perfisAcesso = [];
let sessaoConta = null; // conta logada (sem senha), guardada após login
let editandoId = null;
let anexoAtendimentoId = null; // atendimento cujos anexos múltiplos estão sendo geridos ao editar
let editandoAtendenteId = null;
let editandoUsuarioId = null;
let editandoClienteId = null;
let excluindoAcao = null;
let filtroCliente = new Set(); // vazio = todos
let filtroStatus = new Set(); // vazio = todos
let visualizacaoAtendimentos = 'lista'; // 'lista' | 'cards'
let vinculosExpandidos = new Set(); // ids de atendimento com as linhas-filha de vínculo visíveis — vazio por padrão (tudo recolhido)
let selecionados = new Set();
let cadAba = 'atendentes';
let editandoPerfilAcessoId = null;
const MENUS_PERFIL_ACESSO = [
  { chave:'atendimentos', label:'Atendimentos' },
  { chave:'resumo', label:'Resumo' },
  { chave:'cronograma', label:'Cronograma' },
  { chave:'construtor_relatorios', label:'Construtor de Relatórios' },
  { chave:'relatorios', label:'Relatórios' },
  { chave:'financeiro', label:'Financeiro' },
  { chave:'agenda', label:'Agenda' },
  { chave:'videos', label:'Vídeos' },
  { chave:'cadastros', label:'Cadastros' },
];

/* ---------- utilidades ---------- */
function fmtMoeda(v){ return 'R$ ' + (v||0).toLocaleString('pt-BR',{minimumFractionDigits:2, maximumFractionDigits:2}); }
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
      .filter(r => `${r.cliente} ${r.usuario} ${stripHtml(r.detalhe||'')} ${r.tipo}`.toLowerCase().includes(termo))
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
    const r = await api('listarVideos', { contaId: conta.id });
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
  const r = await api('dados', { contaId });
  if(!r.ok) return false;
  contas = r.contas; clientes = r.clientes; tipos = r.tipos; modulos = r.modulos||[]; submodulos = r.submodulos||[]; statusList = r.statusList||[]; valores = r.valores; atendimentos = r.atendimentos;
  vinculos = r.vinculos||[];
  perfisAcesso = r.perfisAcesso||[];
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
    mostrarCarregando(true);
    const carregou = await carregarTudo();
    mostrarCarregando(false);
    if(!carregou){
      err.textContent = 'Login certo, mas não consegui carregar os dados. Tente novamente.';
      err.classList.add('show');
      return;
    }
    entrarNoApp();
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

function sair(){
  sessaoConta = null;
  limparSessao();
  document.getElementById('app').style.display = 'none';
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
  aplicarVisibilidadeMenu('gantt', menuVisivel(conta, 'cronograma', true));
  aplicarVisibilidadeMenu('relatorio', menuVisivel(conta, 'construtor_relatorios', isAdmin));
  aplicarVisibilidadeMenu('relatoriospub', menuVisivel(conta, 'relatorios', true));
  aplicarVisibilidadeMenu('financeiro', menuVisivel(conta, 'financeiro', isAdmin));
  aplicarVisibilidadeMenu('agenda', menuVisivel(conta, 'agenda', podeVerAgenda));
  aplicarVisibilidadeMenu('videos', menuVisivel(conta, 'videos', true));
  aplicarVisibilidadeMenu('cadastros', menuVisivel(conta, 'cadastros', isAdmin));
  // Cronograma: usuário e atendente veem só os próprios atendimentos (ou
  // os do cliente, se marcado como admin do cliente) — filtro feito dentro
  // de renderGantt()

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
    renderSegmentado('f_tipo', tipos.map(t=>t.nome), tipoOnline.nome);
  }else{
    document.getElementById('campoTipo').style.display = '';
    document.getElementById('campoTipoFixo').style.display = 'none';
    renderSegmentado('f_tipo', tipos.map(t=>t.nome), tipos[0]?.nome);
  }
  renderSegmentado('f_atendente', contas.filter(c=>c.perfil==='ATENDENTE').map(a=>a.nome), null);
  renderSegmentado('f_atendente2', ['Nenhum', ...contas.filter(c=>c.perfil==='ATENDENTE').map(a=>a.nome)], 'Nenhum');

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
  const atendente2Nome = getSegSel('f_atendente2');
  const tem2 = atendente2Nome && atendente2Nome !== 'Nenhum';
  document.getElementById('campoHorasAtendente2').style.display = tem2 ? '' : 'none';
  if(!tem2) document.getElementById('f_horas_atendente2').value = '';
}

function atualizarPreview(){
  const clienteId = document.getElementById('f_cliente').value;
  const clienteNome = clientes.find(c=>String(c.id)===String(clienteId))?.nome;
  const tipoNome = getSegSel('f_tipo');
  const atendenteNome = getSegSel('f_atendente');
  const hi = document.getElementById('f_hi').value;
  const hf = document.getElementById('f_hf').value;
  const inter = document.getElementById('f_inter').value;
  const qtdManualStr = document.getElementById('f_qtd_manual').value;
  const qtd = qtdManualStr !== '' ? Number(qtdManualStr) : calcQtd(hi, hf, inter);
  const vals = valoresPara(clienteNome, tipoNome, atendenteNome);
  document.getElementById('p_qtd').textContent = qtd.toFixed(2).replace('.',',') + 'h';
  document.getElementById('p_ananda').textContent = fmtMoeda(qtd * vals.ananda);
  document.getElementById('p_real').textContent = fmtMoeda(qtd * vals.real);

  const atendente2Nome = getSegSel('f_atendente2');
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
    const btn = document.querySelector(`#f_atendente button[data-val="${conta.nome}"]`);
    if(btn){ document.querySelectorAll('#f_atendente button').forEach(b=>b.classList.remove('sel')); btn.classList.add('sel'); }
  }
  const at2Btn = document.querySelector(`#f_atendente2 button[data-val="Nenhum"]`);
  if(at2Btn){ document.querySelectorAll('#f_atendente2 button').forEach(b=>b.classList.remove('sel')); at2Btn.classList.add('sel'); }
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
  const tipo = getSegSel('f_tipo');
  const conta = contaAtual();
  const isUsuario = conta && conta.perfil === 'USUARIO';
  const atendente = isUsuario ? '' : getSegSel('f_atendente');
  if(!tipo || (!isUsuario && !atendente)){ toast('Cadastre ao menos um tipo e um atendente'); return; }
  const at2Sel = isUsuario ? 'Nenhum' : getSegSel('f_atendente2');
  const atendente2 = at2Sel && at2Sel !== 'Nenhum' ? at2Sel : '';
  if(atendente2 && atendente2 === atendente){ toast('O segundo atendente não pode ser o mesmo que o atendente principal'); return; }
  const horasAtendente2 = atendente2 ? (Number(document.getElementById('f_horas_atendente2').value) || 0) : 0;
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
    const payload = { id: editandoId, data, cliente, usuario, modulo, submodulo, tipo, atendente, detalhe, solucao, hi, inter, hf, status,
      dataPrevista, atendente2, horasAtendente2,
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
  const tipoBtn = document.querySelector(`#f_tipo button[data-val="${r.tipo}"]`);
  if(tipoBtn){ document.querySelectorAll('#f_tipo button').forEach(b=>b.classList.remove('sel')); tipoBtn.classList.add('sel'); }
  const atBtn = document.querySelector(`#f_atendente button[data-val="${r.atendente}"]`);
  if(atBtn){ document.querySelectorAll('#f_atendente button').forEach(b=>b.classList.remove('sel')); atBtn.classList.add('sel'); }
  const at2Val = r.atendente2 || 'Nenhum';
  const at2Btn = document.querySelector(`#f_atendente2 button[data-val="${at2Val}"]`);
  document.querySelectorAll('#f_atendente2 button').forEach(b=>b.classList.remove('sel'));
  (at2Btn || document.querySelector(`#f_atendente2 button[data-val="Nenhum"]`))?.classList.add('sel');
  document.getElementById('f_horas_atendente2').value = r.atendente2 ? Number(r.horasAtendente2||0) : '';
  atualizarVisibilidadeHoras2();
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
  const tipoBtn = document.querySelector(`#f_tipo button[data-val="${r.tipo}"]`);
  if(tipoBtn){ document.querySelectorAll('#f_tipo button').forEach(b=>b.classList.remove('sel')); tipoBtn.classList.add('sel'); }
  const atBtn = document.querySelector(`#f_atendente button[data-val="${r.atendente}"]`);
  if(atBtn){ document.querySelectorAll('#f_atendente button').forEach(b=>b.classList.remove('sel')); atBtn.classList.add('sel'); }
  const at2Val = r.atendente2 || 'Nenhum';
  const at2Btn = document.querySelector(`#f_atendente2 button[data-val="${at2Val}"]`);
  document.querySelectorAll('#f_atendente2 button').forEach(b=>b.classList.remove('sel'));
  (at2Btn || document.querySelector(`#f_atendente2 button[data-val="Nenhum"]`))?.classList.add('sel');
  document.getElementById('f_horas_atendente2').value = r.atendente2 ? Number(r.horasAtendente2||0) : '';
  atualizarVisibilidadeHoras2();
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
  // usuário não filtra por cliente (só vê o próprio cliente mesmo) — mas
  // status e período são liberados abaixo
  if(conta && conta.perfil === 'USUARIO'){ el.innerHTML=''; renderFiltrosStatus(); return; }
  el.innerHTML = `
    <div class="lookup-multi">
      <div class="lookup-tags" id="filtroClienteTags"></div>
      <input type="text" id="filtroClienteBusca" placeholder="Filtrar por cliente…" autocomplete="off">
      <div class="lookup-dropdown" id="filtroClienteDropdown"></div>
    </div>`;
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

function renderFiltrosStatus(){
  const el = document.getElementById('filtrosStatus');
  el.innerHTML = `<div class="chip ${filtroStatus.size===0?'on':''}" data-status="TODOS">Todos status</div>` +
    statusList.map(s=>`<div class="chip ${filtroStatus.has(s.nome)?'on':''}" data-status="${s.nome}">${s.nome}</div>`).join('');
}

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
  const de = document.getElementById('periodo_de').value;
  const ate = document.getElementById('periodo_ate').value;
  if(de) itens = itens.filter(r=>String(r.data) >= de);
  if(ate) itens = itens.filter(r=>String(r.data) <= ate);
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
  cont.innerHTML = itens.map(r => renderLinhaComVinculos(r, ctx)).join('');
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
        <div><div class="cliente">${clienteTexto}</div>
        <div class="data">${dataFmt} · ${r.hi}–${r.hf}${r.inter && r.inter!=='00:00' ? ' (int. '+r.inter+')' : ''}</div></div>
        ${(toggleVinculos || checkbox) ? `</div></div>` : '</div>'}
        <div style="display:flex;flex-direction:column;gap:4px;align-items:flex-end;">
          <span class="tag status-${statusSlug(r.status)}">${r.status}</span>
          ${flagPrazo(r)}
        </div>
      </div>
      ${modSub ? `<div class="detalhe" style="color:var(--accent);font-weight:600;">${modSub}</div>` : ''}
      ${r.detalhe ? `<div class="detalhe">${escaparHtml(stripHtml(r.detalhe).slice(0,140))}${stripHtml(r.detalhe).length>140?'…':''}</div>` : ''}
      <div class="meta">
        <span class="tag">${labelTipo(r.tipo)}</span>
        <span class="tag">${r.atendente || 'A definir'}</span>
        <span class="tag">${qtdNum.toFixed(2).replace('.',',')}h</span>
        ${r.atendente2 ? `<span class="tag">+2º: ${r.atendente2} (${Number(r.horasAtendente2||0).toFixed(2).replace('.',',')}h)</span>` : ''}
        ${r.solucao ? `<span class="tag" style="color:var(--ok);">✓ Solucionado</span>` : ''}
        ${r.anexoUrl ? `<a class="tag" style="color:var(--accent);" href="${r.anexoUrl}" target="_blank" onclick="event.stopPropagation();">📎 ${r.anexoNome||'anexo'}</a>` : ''}
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
        <div class="cliente">${escaparHtml(r.cliente)} · ${escaparHtml(r.usuario)}</div>
        <div class="data">${dataFmt} · ${Number(r.qtd).toFixed(2).replace('.',',')}h</div>
        ${r.detalhe ? `<div class="detalhe">${escaparHtml(stripHtml(r.detalhe))}</div>` : ''}
        <div class="meta">
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
    const colunasExtra = (v) => [
      verValoresReal ? `<td>${fmtMoeda(v.real)}</td>` : '',
      verValorAtendente ? `<td>${fmtMoeda(v.ananda)}</td>` : '',
    ].join('');
    const linhasCliente = Object.entries(porCliente)
      .sort((a,b)=>b[1].horas-a[1].horas)
      .map(([nome,v])=>`<tr><td>${nome}</td><td>${v.horas.toFixed(2).replace('.',',')}h</td><td>${v.qtd}</td>${colunasExtra(v)}</tr>`)
      .join('');
    document.getElementById('resumoPorCliente').innerHTML =
      `<tr><th>Cliente</th><th>Horas</th><th>Atend.</th>${verValoresReal?'<th>Real</th>':''}${verValorAtendente?'<th>Atendente</th>':''}</tr>${linhasCliente}`;
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
function prepararImpressao(titulo, filtrosTexto){
  const agora = new Date();
  const dataHora = agora.toLocaleDateString('pt-BR') + ' às ' + agora.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
  document.getElementById('printHeader').innerHTML = `
    <div class="print-empresa">T&A Tecnologia</div>
    <h1>${escaparHtml(titulo)}</h1>
    ${filtrosTexto ? `<div class="print-filtros">${escaparHtml(filtrosTexto)}</div>` : ''}
    <div class="print-data">Gerado em ${dataHora}</div>
  `;
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

function gerarExcelRelatorio(){
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
  XLSX.writeFile(livro, `${titulo.replace(/[^a-zA-Z0-9 ]/g,'').trim() || 'relatorio'}.xlsx`);
  toast('Excel gerado');
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
    const r = await api('listarLancamentos', { contaId: conta.id });
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
    const r = await api('listarNotasImportadas', { contaId: conta.id });
    if(r.ok) notasImportadasCache = r.notas || [];
  }catch(e){ /* silencioso */ }
}

function renderListaNotasImportadas(){
  const cont = document.getElementById('listaNotasImportadas');
  if(notasImportadasCache.length === 0){ cont.innerHTML = `<div class="empty" style="padding:10px 0;font-size:12.5px;">Nenhuma nota importada ainda.</div>`; return; }
  const fmtData = s => { if(!s) return '—'; const [y,m,d]=s.split('-'); return `${d}/${m}/${y}`; };
  cont.innerHTML = notasImportadasCache.map(n=>`
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
  const header = ['DATA','MES','CLIENTE','USUARIO','MODULO','SUBMODULO','TIPO ATENDIMENTO','ATENDENTE','DETALHE','SOLUCAO','HI','INTER','HF','QTD','VALOR ATENDENTE/H','TOTAL ATENDENTE','2º ATENDENTE','HORAS 2º ATENDENTE','VALOR 2º ATENDENTE/H','TOTAL 2º ATENDENTE','STATUS','VHR','TOTAL REAL','ANEXO'];
  const rows = itens.map(r=>{
    const [y,m,d]=String(r.data).split('-');
    return [`${d}/${m}/${y}`, r.mes, r.cliente, r.usuario, r.modulo||'', r.submodulo||'', r.tipo, r.atendente, stripHtml(r.detalhe).replace(/;/g,','), stripHtml(r.solucao).replace(/;/g,','), r.hi, r.inter, r.hf,
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
  renderListAtendentes(); renderListClientes(); renderListTipos(); renderListModulos(); renderListSubModulos(); renderListStatus(); renderValoresForm(); renderTabelaValores(); renderListUsuarios(); renderListPerfisAcesso();
  renderPerfisAcessoCheckboxes('at_perfis_acesso', editandoAtendenteId ? (contas.find(c=>String(c.id)===String(editandoAtendenteId))?.perfisAcessoIds||[]) : []);
  renderPerfisAcessoCheckboxes('us_perfis_acesso', editandoUsuarioId ? (contas.find(c=>String(c.id)===String(editandoUsuarioId))?.perfisAcessoIds||[]) : []);
}

/* ---------- perfis de acesso (menus x visualizar/editar/excluir/inserir) ---------- */
function renderMatrizPerfil(permissoesAtuais){
  const tbody = document.querySelector('#pa_matriz tbody');
  const perm = permissoesAtuais || {};
  tbody.innerHTML = MENUS_PERFIL_ACESSO.map(({chave,label})=>{
    const p = perm[chave] || {};
    const cel = (campo)=>`<td><input type="checkbox" data-menu="${chave}" data-campo="${campo}" ${p[campo]?'checked':''}></td>`;
    return `<tr><td>${label}</td>${cel('visualizar')}${cel('editar')}${cel('excluir')}${cel('inserir')}</tr>`;
  }).join('');
}
function lerMatrizPerfil(){
  const permissoes = {};
  MENUS_PERFIL_ACESSO.forEach(({chave})=>{ permissoes[chave] = {visualizar:false, editar:false, excluir:false, inserir:false}; });
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
  if(clientes.length===0){ el.innerHTML = `<div class="empty">Nenhum cliente cadastrado.</div>`; return; }
  el.innerHTML = clientes.map(c=>`
    <div class="cad-item"><div class="info"><b>${escaparHtml(c.nome)}</b>
      ${c.nomeFantasia ? `<span>${escaparHtml(c.nomeFantasia)}</span>` : ''}
      ${c.cnpj ? `<span>CNPJ: ${escaparHtml(c.cnpj)}</span>` : `<span style="color:var(--bad);">Sem CNPJ cadastrado</span>`}
    </div>
    <div class="acts">
      <button class="ghost" onclick="editarCliente('${c.id}')">Editar</button>
      <button class="danger" onclick="pedirConfirmacao('Remover cliente?','Isso não apaga lançamentos já salvos, mas remove das opções futuras.', ()=>removerCliente('${c.id}'))">Remover</button>
    </div></div>`).join('');
}
function editarCliente(id){
  const c = clientes.find(x=>String(x.id)===String(id));
  if(!c) return;
  editandoClienteId = id;
  document.getElementById('cl_nome').value = c.nome;
  document.getElementById('cl_cnpj').value = c.cnpj || '';
  document.getElementById('cl_nome_fantasia').value = c.nomeFantasia || '';
  document.getElementById('btnAddCliente').textContent = 'Salvar alterações';
  document.getElementById('btnCancelarEdicaoCliente').style.display = '';
  document.getElementById('cl_nome').scrollIntoView({ behavior:'smooth', block:'center' });
}
function cancelarEdicaoCliente(){
  editandoClienteId = null;
  document.getElementById('cl_nome').value = '';
  document.getElementById('cl_cnpj').value = '';
  document.getElementById('cl_nome_fantasia').value = '';
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
    const r = await api('listarVideos', { contaId: conta.id });
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

  if(itens.length === 0){ cont.innerHTML = `<div class="empty"><div class="big">🎬</div>Nenhum vídeo disponível ainda.</div>`; return; }

  cont.innerHTML = itens.map(v=>{
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
    return `<div class="card">
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
  }).join('');
  itens.forEach(v => carregarComentariosVideo(v.id));
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
  document.getElementById('cardNovoVideo').scrollIntoView({ behavior:'smooth', block:'center' });
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
    visivelPerfis,
  };
  const editando = !!editandoVideoId;
  const btn = document.getElementById('btnAddVideo');
  btn.disabled = true;
  try{
    const r = editando
      ? await api('atualizarVideo', { ...payload, id: editandoVideoId })
      : await api('criarVideo', payload);
    if(!r.ok){ toast(r.erro || 'Não foi possível salvar.'); return; }
    limparFormVideo();
    await carregarVideos();
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
    const r = await api('recalcularValores', { contaId: conta.id });
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
  document.getElementById('chatSub').textContent = `Atendente: ${r.atendente || '(a definir)'}${r.atendente2 ? ' + '+r.atendente2+' (2º)' : ''} · ${d}/${m}/${y} · ${r.status}`;
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
    ${r.detalhe ? `<div class="rt-content" style="font-size:12.5px;color:var(--muted);margin-top:2px;">${sanitizarHtml(r.detalhe)}</div>` : ''}
    ${r.solucao ? `<div style="font-size:12.5px;margin-top:8px;padding:8px 10px;background:var(--panel-2);border-radius:8px;"><b style="color:var(--ok);display:block;margin-bottom:4px;">Solução:</b><div class="rt-content">${sanitizarHtml(r.solucao)}</div></div>` : ''}
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
  return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', {hour:'2-digit',minute:'2-digit'});
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
    resp = await api('listarMovimentacoes', { atendimentoId });
  }catch(e){
    cont.innerHTML = `<div class="chat-empty">Não foi possível carregar as movimentações.</div>`;
    return;
  }
  if(!resp.ok){ cont.innerHTML = `<div class="chat-empty">${resp.erro || 'Não foi possível carregar as movimentações.'}</div>`; return; }

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
      ${(m.anexos && m.anexos.length>0) ? m.anexos.map(a=>`<div class="mov-anexo-item">📎 <a href="${a.url}" target="_blank">${escaparHtml(a.nome)}</a></div>`).join('') : ''}
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
        respondendoA: estado.respondendoId,
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
          document.execCommand('insertHTML', false, `<img src="${r.url}" alt="${escaparHtml(r.nome||'')}">`);
        }catch(err){
          toast(err && err.message ? err.message : 'Não foi possível enviar a imagem.');
        }
      });
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
  if(name==='gantt'){ renderFiltrosGantt(); renderGantt(); }
  if(name==='relatorio'){
    renderRelatorioFiltros(); renderRelatorioColunas(); renderRelatorioPreview();
    carregarRelatoriosSalvos().then(renderListaRelatoriosSalvos);
  }
  if(name==='relatoriospub'){
    document.getElementById('cardPreviewRelatoriosPub').style.display = 'none';
    carregarRelatoriosPublicados();
  }
  if(name==='financeiro'){
    goFinSub(finAba);
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
    const contaAg = contaAtual();
    const podeGerenciarAg = contaAg && (contaAg.perfil === 'ADMIN' || contaAg.perfil === 'ATENDENTE');
    document.querySelector('#agSubtabs .subtab[data-agsub="novo"]').style.display = podeGerenciarAg ? '' : 'none';
    goAgSub(podeGerenciarAg ? agAba : 'calendario');
    popularSelectsAgenda();
    renderSeletorCores('ag_cores', document.getElementById('ag_cor_selecionada').value);
    carregarAgendamentos().then(renderAgenda);
  }
  if(name==='videos'){
    const contaVid = contaAtual();
    const isAdminVid = ehAdminEfetivo(contaVid);
    const permVid = permissaoMenu(contaVid, 'videos');
    const podeInserirVid = permVid ? permVid.inserir : isAdminVid;
    document.getElementById('cardNovoVideo').style.display = podeInserirVid ? '' : 'none';
    if(podeInserirVid){ popularSelectsVideo(); limparFormVideo(); }
    vidFiltroModulo = 'TODOS';
    carregarVideos();
  }
  if(name==='cadastros') goCadSub(cadAba);
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
  segmentedSetup('f_tipo', atualizarPreview);
  segmentedSetup('f_atendente', atualizarPreview);
  segmentedSetup('f_atendente2', ()=>{ atualizarVisibilidadeHoras2(); atualizarPreview(); });
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
  document.getElementById('filtrosStatus').addEventListener('click', e=>{
    const chip = e.target.closest('.chip'); if(!chip) return;
    toggleFiltroMultiplo(filtroStatus, chip.dataset.status);
    renderFiltrosStatus();
    renderLista();
  });
  document.getElementById('r_cliente_chips').addEventListener('click', e=>{
    const chip = e.target.closest('.chip'); if(!chip) return;
    if(chip.dataset.cliente === 'TODOS'){ filtroResumoCliente.clear(); }
    else{ if(filtroResumoCliente.has(chip.dataset.cliente)) filtroResumoCliente.delete(chip.dataset.cliente); else filtroResumoCliente.add(chip.dataset.cliente); }
    renderResumo();
  });
  document.getElementById('periodo_de').addEventListener('change', renderLista);
  document.getElementById('periodo_ate').addEventListener('change', renderLista);

  segmentedSetup('listaVisualizacaoToggle', ()=>{
    visualizacaoAtendimentos = getSegSel('listaVisualizacaoToggle');
    renderLista();
  });
  document.getElementById('kanbanBoard').addEventListener('pointerdown', e=>{
    const handle = e.target.closest('.kanban-card-handle');
    if(!handle) return;
    iniciarDragKanban(e, handle);
  });
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
  document.getElementById('loginPass').addEventListener('keydown', e=>{ if(e.key==='Enter') tentarLogin(); });
  document.getElementById('toggleSenha').addEventListener('click', ()=>{
    const campo = document.getElementById('loginPass'); const btn = document.getElementById('toggleSenha');
    if(campo.type === 'password'){ campo.type = 'text'; btn.textContent = 'OCULTAR'; } else { campo.type = 'password'; btn.textContent = 'MOSTRAR'; }
  });
  document.getElementById('btnLogout').addEventListener('click', ()=>pedirConfirmacao('Sair da conta?','Você poderá entrar novamente quando quiser.', sair, 'Sair'));
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
    cancelarEdicaoAtendente();
    await carregarTudo(); renderListAtendentes(); popularSelects();
    toast(editando ? 'Atendente atualizado' : 'Atendente adicionado');
  });
  document.getElementById('btnCancelarEdicaoAtendente').addEventListener('click', cancelarEdicaoAtendente);

  document.getElementById('btnAddVideo').addEventListener('click', salvarVideoUi);
  document.getElementById('btnCancelarEdicaoVideo').addEventListener('click', limparFormVideo);
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
    if(!nome){ toast('Informe o nome do cliente'); return; }
    const editando = !!editandoClienteId;
    const r = editando
      ? await api('atualizarCliente', { id: editandoClienteId, nome: nome.toUpperCase(), cnpj, nomeFantasia })
      : await api('addCliente', { nome: nome.toUpperCase(), cnpj, nomeFantasia });
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
    const r = await api('salvarValor', { atendenteId, clienteId, tipoId, real, ananda, valorSegundoAtend });
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
  if(sessaoSalva){
    sessaoConta = sessaoSalva;
    mostrarCarregando(true);
    try{
      const ok = await carregarTudo();
      mostrarCarregando(false);
      if(ok) entrarNoApp(); else sair();
    }catch(e){ mostrarCarregando(false); sair(); }
  }else{
    document.getElementById('screen-login').style.display = 'flex';
  }
});
