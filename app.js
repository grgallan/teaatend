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
  API_URL: 'https://prchmojpfgeqbnoiisyf.supabase.co/functions/v1/super-function'',
  // Cole aqui a chave "anon public" do seu projeto Supabase
  // (Project Settings → API Keys). Essa chave é segura pra expor
  // no código do site — ela sozinha não dá acesso ao banco.
  ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InByY2htb2pwZmdlcWJub2lpc3lmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY5NjMzMDYsImV4cCI6MjEwMjUzOTMwNn0.BnkW_pMECVDuV-bIjVJ0mpkmQhdTyty_2ityu7gyy80',
  // Chave pública VAPID (notificações push) — veja o LEIA-ME.md.
  // Deixe vazio ('') se não quiser usar notificações push.
  VAPID_PUBLIC_KEY: 'BISfjGp1ZksMHOnvGJmSGk4vP8khf8H6tCcSUywhXaL6Fwl0CGML4yEROkJ_VAsH0z2AmmStgODOBOo2O_Oe5oY'
};

const SESSAO_KEY = 'sessao_v4';

let contas = [], clientes = [], tipos = [], modulos = [], submodulos = [], statusList = [], valores = [], atendimentos = [];
let sessaoConta = null; // conta logada (sem senha), guardada após login
let editandoId = null;
let anexoAtendimentoId = null; // atendimento cujos anexos múltiplos estão sendo geridos ao editar
let editandoAtendenteId = null;
let editandoUsuarioId = null;
let excluindoAcao = null;
let filtroCliente = new Set(); // vazio = todos
let filtroStatus = 'TODOS';
let selecionados = new Set();
let cadAba = 'atendentes';

/* ---------- utilidades ---------- */
function fmtMoeda(v){ return 'R$ ' + (v||0).toLocaleString('pt-BR',{minimumFractionDigits:2, maximumFractionDigits:2}); }
function timeToHours(t){ if(!t) return 0; const [h,m]=t.split(':').map(Number); return h + m/60; }
function calcQtd(hi,hf){ let q = timeToHours(hf) - timeToHours(hi); if(q<0) q += 24; return q; }
function mesFromData(dataStr){ if(!dataStr) return ''; const [y,m]=dataStr.split('-'); return `${m}/${y}`; }
function toast(msg){ const t=document.getElementById('toast'); t.textContent=msg; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),2200); }
function labelTipo(nome){ if(nome==='ATENDIMENTO ONLINE') return 'Online'; if(nome==='VISITA TECNICA') return 'Visita técnica'; return nome; }
function podeVerValores(){ const c = contaAtual(); return c && c.perfil === 'ADMIN'; }
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
        <span>${escaparHtml(v.usuario)} · ${Number(v.qtd).toFixed(2).replace('.',',')}h · <span class="tag status-${v.status}">${v.status}</span></span>
      </div>
      ${podeRemover ? `<div class="acts"><button class="danger" onclick="removerVinculoAgora('${v.vinculoId}','${atendimentoId}','${containerId}',true)">Remover</button></div>` : ''}
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
  if(c.perfil === 'ADMIN') return true;
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
  btn.disabled = true;
  try{
    const permissao = await Notification.requestPermission();
    if(permissao !== 'granted'){ toast('Permissão não concedida'); return; }
    const reg = await navigator.serviceWorker.ready;
    const inscricao = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(CONFIG.VAPID_PUBLIC_KEY)
    });
    const conta = contaAtual();
    const json = inscricao.toJSON();
    const r = await api('salvarInscricaoPush', {
      contaId: conta.id, endpoint: json.endpoint, p256dh: json.keys.p256dh, auth: json.keys.auth
    });
    if(!r.ok){ toast(r.erro || 'Não foi possível ativar as notificações'); return; }
    toast('Notificações ativadas');
  }catch(e){
    toast('Não foi possível ativar as notificações');
  } finally {
    btn.disabled = false;
    atualizarBotaoNotificacoes();
  }
}

function entrarNoApp(){
  const conta = contaAtual();
  if(!conta){ sair(); return; }
  if(!contas.find(c=>String(c.id)===String(conta.id))){ toast('Sua conta não existe mais.'); sair(); return; }

  document.getElementById('screen-login').style.display = 'none';
  document.getElementById('app').style.display = 'block';
  document.getElementById('whoName').textContent = conta.nome;
  document.getElementById('avatarIni').textContent = conta.nome.slice(0,2).toUpperCase();
  atualizarBotaoNotificacoes();

  const isAdmin = conta.perfil === 'ADMIN';
  const isUsuario = conta.perfil === 'USUARIO';
  const podeVerResumo = !isUsuario || conta.adminCliente; // usuário comum não vê; administrador do cliente vê

  document.getElementById('tabCadastros').style.display = isAdmin ? '' : 'none';
  document.getElementById('navCadastros').style.display = isAdmin ? '' : 'none';
  document.querySelectorAll('#mainTabs .tab[data-view="resumo"], #bottomNav .navbtn[data-view="resumo"]').forEach(el=>{ el.style.display = podeVerResumo ? '' : 'none'; });
  // Cronograma fica disponível pra todo mundo — usuário e atendente veem
  // só os próprios atendimentos (ou os do cliente, se marcado como admin
  // do cliente), o filtro é feito dentro de renderGantt()

  // valores/hora (R$) só aparecem para o admin — atendentes veem só a quantidade de horas
  document.getElementById('stat_ananda').style.display = isAdmin ? '' : 'none';
  document.getElementById('stat_real').style.display = isAdmin ? '' : 'none';
  document.getElementById('btnExportar').style.display = isAdmin ? '' : 'none';

  popularSelects();
  renderCadastrosTudo();
  resetForm();
  renderFiltros();
  goView(isUsuario ? 'lista' : 'novo');
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

  // usuário solicitante não escolhe o atendente — um atendente qualquer assume o chamado
  document.getElementById('campoAtendente').style.display = isUsuario ? 'none' : '';
  document.getElementById('campoAtendenteInfo').style.display = isUsuario ? '' : 'none';

  // usuário não preenche horário trabalhado — isso é registrado por quem atende
  document.getElementById('campoHorarios').style.display = isUsuario ? 'none' : '';

  // ajuste manual de horas — só o admin tem esse campo
  const isAdmin = conta && conta.perfil === 'ADMIN';
  document.getElementById('campoQtdManual').style.display = isAdmin ? '' : 'none';

  // data prevista e vínculo com outro chamado — quem está atendendo é quem define isso
  document.getElementById('campoDataPrevista').style.display = isUsuario ? 'none' : '';
  if(isUsuario){
    document.getElementById('campoVinculo').style.display = 'none';
    document.getElementById('campoVinculoNovo').style.display = 'none';
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
  if(!cliente || !tipo || !atendenteConta) return {real:0, ananda:0};
  const v = valores.find(v=>String(v.atendenteId)===String(atendenteConta.id) && String(v.clienteId)===String(cliente.id) && String(v.tipoId)===String(tipo.id));
  return v ? {real:Number(v.real), ananda:Number(v.ananda)} : {real:0, ananda:0};
}

function atualizarPreview(){
  const clienteId = document.getElementById('f_cliente').value;
  const clienteNome = clientes.find(c=>String(c.id)===String(clienteId))?.nome;
  const tipoNome = getSegSel('f_tipo');
  const atendenteNome = getSegSel('f_atendente');
  const hi = document.getElementById('f_hi').value;
  const hf = document.getElementById('f_hf').value;
  const qtdManualStr = document.getElementById('f_qtd_manual').value;
  const qtd = qtdManualStr !== '' ? Number(qtdManualStr) : calcQtd(hi, hf);
  const vals = valoresPara(clienteNome, tipoNome, atendenteNome);
  document.getElementById('p_qtd').textContent = qtd.toFixed(2).replace('.',',') + 'h';
  document.getElementById('p_ananda').textContent = fmtMoeda(qtd * vals.ananda);
  document.getElementById('p_real').textContent = fmtMoeda(qtd * vals.real);
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

  // todo chamado novo abre como PENDENTE e não é escolhível — só aparece
  // o seletor de status quando editando um atendimento já existente
  document.getElementById('campoStatusSelect').style.display = 'none';
  document.getElementById('campoStatusFixo').style.display = '';
  // "Solução" só faz sentido pra quem está atendendo o chamado — some
  // na criação (ninguém resolveu nada ainda) e aparece ao editar
  document.getElementById('campoSolucao').style.display = 'none';

  if(conta && conta.perfil === 'ATENDENTE'){
    const btn = document.querySelector(`#f_atendente button[data-val="${conta.nome}"]`);
    if(btn){ document.querySelectorAll('#f_atendente button').forEach(b=>b.classList.remove('sel')); btn.classList.add('sel'); }
  }
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
  const detalhe = sanitizarHtml(document.getElementById('f_detalhe').innerHTML.trim());
  const solucao = sanitizarHtml(document.getElementById('f_solucao').innerHTML.trim());
  const hi = document.getElementById('f_hi').value;
  const inter = document.getElementById('f_inter').value;
  const hf = document.getElementById('f_hf').value;
  const status = document.getElementById('f_status').value;
  const isAdmin = conta && conta.perfil === 'ADMIN';
  const qtdManualStr = isAdmin ? document.getElementById('f_qtd_manual').value : '';

  const btn = document.getElementById('btnSalvar');
  btn.disabled = true;
  btn.textContent = 'Salvando…';
  try{
    const dataPrevista = isUsuario ? '' : document.getElementById('f_data_prevista').value;
    const payload = { id: editandoId, data, cliente, usuario, modulo, submodulo, tipo, atendente, detalhe, solucao, hi, inter, hf, status,
      dataPrevista,
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

/* ---------- lista de lançamentos ---------- */
function renderFiltros(){
  const el = document.getElementById('filtros');
  const conta = contaAtual();
  // usuário não filtra por cliente (só vê o próprio cliente mesmo) — mas
  // status e período são liberados abaixo
  if(conta && conta.perfil === 'USUARIO'){ el.innerHTML=''; renderFiltrosStatus(); return; }
  el.innerHTML = `<div class="chip ${filtroCliente.size===0?'on':''}" data-cliente="TODOS">Todos</div>` +
    clientes.map(c=>`<div class="chip ${filtroCliente.has(c.nome)?'on':''}" data-cliente="${c.nome}">${c.nome}</div>`).join('');
  renderFiltrosStatus();
}

function renderFiltrosStatus(){
  const el = document.getElementById('filtrosStatus');
  el.innerHTML = `<div class="chip ${filtroStatus==='TODOS'?'on':''}" data-status="TODOS">Todos status</div>` +
    statusList.map(s=>`<div class="chip ${filtroStatus===s.nome?'on':''}" data-status="${s.nome}">${s.nome}</div>`).join('');
}

function renderLista(){
  const cont = document.getElementById('listaItens');
  const conta = contaAtual();
  const podeEditar = conta && conta.perfil !== 'USUARIO';
  const isUsuario = conta && conta.perfil === 'USUARIO';
  let itens = atendimentos.slice();
  // usuário: o servidor já manda só o que ele pode ver (os próprios, ou
  // todos do cliente se for "administrador do cliente") — não filtra por
  // cliente aqui, senão descarta os atendimentos dos outros do mesmo
  // cliente; mas status e período valem pra ele também
  if(!isUsuario && filtroCliente.size > 0) itens = itens.filter(r=>filtroCliente.has(r.cliente));
  if(filtroStatus !== 'TODOS') itens = itens.filter(r=>r.status===filtroStatus);
  const de = document.getElementById('periodo_de').value;
  const ate = document.getElementById('periodo_ate').value;
  if(de) itens = itens.filter(r=>String(r.data) >= de);
  if(ate) itens = itens.filter(r=>String(r.data) <= ate);
  itens.sort((a,b)=> String(b.data).localeCompare(String(a.data)));

  document.getElementById('filtroPeriodo').style.display = 'grid';
  const verValores = podeVerValores();
  const isAdmin = conta && conta.perfil === 'ADMIN';

  document.getElementById('linhaSelecionarTodos').style.display = podeEditar ? 'flex' : 'none';
  if(!podeEditar){ selecionados.clear(); }
  atualizarBarraSelecao();

  if(itens.length===0){ cont.innerHTML = `<div class="empty"><div class="big">🗂️</div>Nenhum atendimento encontrado.</div>`; return; }

  cont.innerHTML = itens.map(r=>{
    const [y,m,d] = String(r.data).split('-');
    const dataFmt = `${d}/${m}/${y}`;
    const qtdNum = Number(r.qtd);
    const modSub = [r.modulo, r.submodulo].filter(Boolean).join(' · ');
    const contatoAtendente = isUsuario ? contatoDoAtendente(r.atendente) : '';
    const clicavel = podeUsarChat(r);
    const checkbox = podeEditar ? `<input type="checkbox" class="chk-item" data-id="${r.id}" ${selecionados.has(r.id)?'checked':''} onclick="event.stopPropagation();toggleSelecao('${r.id}', this.checked)" style="width:18px;height:18px;flex-shrink:0;margin-top:2px;">` : '';
    return `
    <div class="item" ${clicavel ? `style="cursor:pointer;" onclick="abrirDetalhe('${r.id}')"` : ''}>
      <div class="top">
        ${checkbox ? `<div style="display:flex;gap:10px;">${checkbox}<div>` : '<div>'}
        <div><div class="cliente">${r.cliente} · ${r.usuario}</div>
        <div class="data">${dataFmt} · ${r.hi}–${r.hf}${r.inter && r.inter!=='00:00' ? ' (int. '+r.inter+')' : ''}</div></div>
        ${checkbox ? `</div></div>` : '</div>'}
        <span class="tag status-${r.status}">${r.status}</span>
      </div>
      ${modSub ? `<div class="detalhe" style="color:var(--accent);font-weight:600;">${modSub}</div>` : ''}
      ${r.detalhe ? `<div class="detalhe">${escaparHtml(stripHtml(r.detalhe).slice(0,140))}${stripHtml(r.detalhe).length>140?'…':''}</div>` : ''}
      <div class="meta">
        <span class="tag">${labelTipo(r.tipo)}</span>
        <span class="tag">${r.atendente || 'A definir'}</span>
        <span class="tag">${qtdNum.toFixed(2).replace('.',',')}h</span>
        ${r.solucao ? `<span class="tag" style="color:var(--ok);">✓ Solucionado</span>` : ''}
        ${r.anexoUrl ? `<a class="tag" style="color:var(--accent);" href="${r.anexoUrl}" target="_blank" onclick="event.stopPropagation();">📎 ${r.anexoNome||'anexo'}</a>` : ''}
      </div>
      ${contatoAtendente ? `<div style="margin-top:8px;font-size:12px;" onclick="event.stopPropagation();">Contato do atendente: ${contatoAtendente}</div>` : ''}
      ${verValores ? `
      <div class="valores">
        <span class="v1">Atendente: ${fmtMoeda(Number(r.totalAnanda))}</span>
        <span class="v2">${fmtMoeda(Number(r.totalReal))}</span>
      </div>` : ''}
      ${podeEditar ? `
      <div class="item-actions">
        <button class="ghost" onclick="event.stopPropagation();editar('${r.id}')">Editar</button>
        <button class="ghost" onclick="event.stopPropagation();pedirConfirmacao('Excluir lançamento?','Essa ação não pode ser desfeita.', ()=>excluirAtendimento('${r.id}'))">Excluir</button>
        ${isAdmin ? `<button class="ghost" onclick="event.stopPropagation();copiarAtendimento('${r.id}')">Copiar</button>` : ''}
        ${clicavel ? `<button class="ghost chatbtn" onclick="event.stopPropagation();abrirDetalhe('${r.id}')">👁 Detalhes</button>` : ''}
      </div>` : (clicavel ? `
      <div class="item-actions">
        <button class="ghost chatbtn" onclick="event.stopPropagation();abrirDetalhe('${r.id}')">👁 Ver atendimento</button>
      </div>` : '')}
    </div>`;
  }).join('');
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

function renderResumo(){
  popularMeses();
  const mes = document.getElementById('r_mes').value;
  const conta = contaAtual();
  const isAdmin = conta && conta.perfil === 'ADMIN';
  const isAtendente = conta && conta.perfil === 'ATENDENTE';
  let itens = atendimentos.filter(r=>r.mes===mes);

  // admin pode filtrar o resumo por um atendente específico; atendente só vê o próprio
  const campoFiltro = document.getElementById('campoFiltroAtendenteResumo');
  if(isAdmin){
    campoFiltro.style.display = '';
    const selAt = document.getElementById('r_atendente');
    const nomesAtendentes = contas.filter(c=>c.perfil==='ATENDENTE').map(a=>a.nome);
    selAt.innerHTML = `<option value="TODOS">Todos os atendentes</option>` + nomesAtendentes.map(n=>`<option value="${n}">${n}</option>`).join('');
    selAt.value = filtroResumoAtendente;
    if(filtroResumoAtendente !== 'TODOS') itens = itens.filter(r=>r.atendente === filtroResumoAtendente);
  }else{
    campoFiltro.style.display = 'none';
    if(isAtendente){
      itens = itens.filter(r=>r.atendente === conta.nome);
    }
  }

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

  const totalHoras = itens.reduce((s,r)=>s+Number(r.qtd),0);
  const verValoresReal = isAdmin || (conta && conta.perfil === 'USUARIO' && conta.adminCliente); // Valor Real — admin e o usuário administrador do cliente
  const verValorAtendente = isAdmin || (conta && conta.perfil === 'ATENDENTE'); // Valor Atendente — admin e o próprio atendente

  if(verValoresReal || verValorAtendente){
    const totalAnanda = itens.reduce((s,r)=>s+Number(r.totalAnanda||0),0);
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
      porCliente[r.cliente].horas += Number(r.qtd);
      porCliente[r.cliente].real += Number(r.totalReal)||0;
      porCliente[r.cliente].ananda += Number(r.totalAnanda)||0;
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
    return `<tr><td><span class="tag status-${k}">${k}</span></td><td>${v}</td><td>${pct}%</td></tr>`;
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
        <div class="gantt-bar status-${r.status} ${semPrevisao?'gantt-bar-sem-previsao':''}" style="left:${left}%;width:${width}%;" title="${escaparHtml(tituloBarra)}" onclick="abrirDetalhe('${r.id}')"></div>
      </div>
    </div>`;
  }).join('');

  cont.innerHTML = `
    <div class="gantt-header"><div class="gantt-label-col"></div><div class="gantt-days">${headerDias}</div></div>
    ${linhas}
  `;
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

function exportarCsv(){
  const mes = document.getElementById('r_mes').value;
  const conta = contaAtual();
  const isAdmin = conta && conta.perfil === 'ADMIN';
  const isAtendente = conta && conta.perfil === 'ATENDENTE';

  // mesmos filtros aplicados na tela do Resumo — senão o CSV sai com tudo,
  // ignorando o que a pessoa filtrou antes de exportar
  let itens = atendimentos.filter(r=>r.mes===mes);
  if(isAdmin){
    if(filtroResumoAtendente !== 'TODOS') itens = itens.filter(r=>r.atendente === filtroResumoAtendente);
  }else if(isAtendente){
    itens = itens.filter(r=>r.atendente === conta.nome);
  }
  if((isAdmin || isAtendente) && filtroResumoCliente.size > 0) itens = itens.filter(r=>filtroResumoCliente.has(r.cliente));

  itens = itens.slice().sort((a,b)=>String(a.data).localeCompare(String(b.data)));
  if(itens.length===0){ toast('Nada para exportar com esse filtro'); return; }
  const header = ['DATA','MES','CLIENTE','USUARIO','MODULO','SUBMODULO','TIPO ATENDIMENTO','ATENDENTE','DETALHE','SOLUCAO','HI','INTER','HF','QTD','VALOR ATENDENTE/H','TOTAL ATENDENTE','STATUS','VHR','TOTAL REAL','ANEXO'];
  const rows = itens.map(r=>{
    const [y,m,d]=String(r.data).split('-');
    return [`${d}/${m}/${y}`, r.mes, r.cliente, r.usuario, r.modulo||'', r.submodulo||'', r.tipo, r.atendente, stripHtml(r.detalhe).replace(/;/g,','), stripHtml(r.solucao).replace(/;/g,','), r.hi, r.inter, r.hf,
      Number(r.qtd).toFixed(2), r.vha, Number(r.totalAnanda).toFixed(2), r.status, r.vhr, Number(r.totalReal).toFixed(2), r.anexoUrl||''];
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
  renderListAtendentes(); renderListClientes(); renderListTipos(); renderListModulos(); renderListSubModulos(); renderListStatus(); renderValoresForm(); renderTabelaValores(); renderListUsuarios();
}

function renderListAtendentes(){
  const lista = contas.filter(c=>c.perfil==='ATENDENTE');
  const el = document.getElementById('listAtendentes');
  if(lista.length===0){ el.innerHTML = `<div class="empty">Nenhum atendente cadastrado.</div>`; return; }
  el.innerHTML = lista.map(a=>{
    const contatos = linhaContatos(a.email, a.telefone);
    return `
    <div class="cad-item" style="cursor:pointer;" onclick="editarAtendente('${a.id}')">
      <div class="info"><b>${a.nome}</b><span>login: ${a.login}</span>${contatos}</div>
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
    <div class="cad-item"><div class="info"><b>${c.nome}</b></div>
    <div class="acts"><button class="danger" onclick="pedirConfirmacao('Remover cliente?','Isso não apaga lançamentos já salvos, mas remove das opções futuras.', ()=>removerCliente('${c.id}'))">Remover</button></div></div>`).join('');
}
async function removerCliente(id){
  const r = await api('removerCliente', { id });
  if(!r.ok) return;
  await carregarTudo(); renderCadastrosTudo(); popularSelects(); renderFiltros();
  toast('Cliente removido');
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
  el.innerHTML = statusList.map(s=>`
    <div class="cad-item"><div class="info"><b>${s.nome}</b></div>
    <div class="acts"><button class="danger" onclick="pedirConfirmacao('Remover status?','Remove das opções futuras de lançamento.', ()=>removerStatus('${s.id}'))">Remover</button></div></div>`).join('');
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
    return `<tr><td>${atendente}</td><td>${cliente}</td><td>${labelTipo(tipo)}</td><td>${fmtMoeda(Number(v.real))}</td><td>${fmtMoeda(Number(v.ananda))}</td>
      <td><button class="danger" onclick="pedirConfirmacao('Remover valor?','', ()=>removerValor('${v.id}'))">✕</button></td></tr>`;
  }).join('');
  el.innerHTML = `<tr><th>Atendente</th><th>Cliente</th><th>Tipo</th><th>Real/h</th><th>Valor Atendente/h</th><th></th></tr>${linhas}`;
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
        <span class="tag status-${r.status}">${r.status}</span>
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

async function abrirDetalhe(atendimentoId){
  const r = atendimentos.find(x=>String(x.id)===String(atendimentoId));
  if(!r || !podeUsarChat(r)) return;
  chatAtendimentoId = atendimentoId;
  const [y,m,d] = String(r.data).split('-');
  const modSub = [r.modulo, r.submodulo].filter(Boolean).join(' · ');
  const conta = contaAtual();
  const isUsuario = conta && conta.perfil === 'USUARIO';

  document.getElementById('chatTitulo').textContent = `${r.cliente} · ${r.usuario}`;
  document.getElementById('chatSub').textContent = `Atendente: ${r.atendente || '(a definir)'} · ${d}/${m}/${y} · ${r.status}`;
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
      ${dataPrevistaTexto ? `<div><span style="color:var(--muted);">Previsão de conclusão</span><br>${dataPrevistaTexto}</div>` : ''}
    </div>
    ${modSub ? `<div style="color:var(--accent);font-weight:600;font-size:12.5px;margin-bottom:4px;">${modSub}</div>` : ''}
    ${r.detalhe ? `<div class="rt-content" style="font-size:12.5px;color:var(--muted);margin-top:2px;">${sanitizarHtml(r.detalhe)}</div>` : ''}
    ${r.solucao ? `<div style="font-size:12.5px;margin-top:8px;padding:8px 10px;background:var(--panel-2);border-radius:8px;"><b style="color:var(--ok);display:block;margin-bottom:4px;">Solução:</b><div class="rt-content">${sanitizarHtml(r.solucao)}</div></div>` : ''}
  `;
  document.getElementById('chatVinculosWrap').style.display = 'none';
  document.getElementById('chatAnexosLista').innerHTML = `<div class="empty" style="padding:8px 0;font-size:12.5px;">Carregando…</div>`;
  document.getElementById('chatHistorico').innerHTML = `<div class="chat-empty">Carregando…</div>`;
  document.getElementById('chatMensagens').innerHTML = `<div class="chat-empty">Carregando…</div>`;
  document.getElementById('chatTexto').value = '';
  document.getElementById('chatModal').classList.add('show');
  await Promise.all([
    carregarHistorico(),
    carregarMensagens(),
    carregarAnexosDetalhe(atendimentoId, !isUsuario),
    carregarVinculosDetalhe(atendimentoId, !isUsuario),
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

async function carregarMensagens(){
  if(!chatAtendimentoId) return;
  const cont = document.getElementById('chatMensagens');
  let r;
  try{
    r = await api('listarMensagens', { atendimentoId: chatAtendimentoId });
  }catch(e){
    cont.innerHTML = `<div class="chat-empty">Não foi possível carregar as mensagens. ${e && e.message ? e.message : 'Tente novamente.'}</div>`;
    return;
  }
  if(!r.ok){
    cont.innerHTML = `<div class="chat-empty">${r.erro || 'Não foi possível carregar as mensagens.'}</div>`;
    return;
  }
  const conta = contaAtual();
  if(r.mensagens.length === 0){
    cont.innerHTML = `<div class="chat-empty">Nenhuma mensagem ainda. Escreva a primeira!</div>`;
  }else{
    cont.innerHTML = r.mensagens.map(m=>{
      const minha = conta && m.autorNome === conta.nome;
      const hora = String(m.dataHora||'').slice(11,16) || '';
      return `<div class="msg ${minha?'mine':'theirs'}">
        ${!minha ? `<div class="autor">${m.autorNome}</div>` : ''}
        <div>${escaparHtml(m.texto)}</div>
        <div class="hora">${hora}</div>
      </div>`;
    }).join('');
  }
  cont.scrollTop = cont.scrollHeight;
}

async function enviarMensagem(){
  const texto = document.getElementById('chatTexto').value.trim();
  if(!texto || !chatAtendimentoId) return;
  const conta = contaAtual();
  const btn = document.getElementById('btnEnviarMensagem');
  btn.disabled = true;
  btn.textContent = 'Enviando…';
  try{
    const r = await api('enviarMensagem', { atendimentoId: chatAtendimentoId, texto, autorNome: conta.nome, autorPerfil: conta.perfil });
    if(!r.ok){ toast(r.erro || 'Não foi possível enviar a mensagem.'); return; }
    document.getElementById('chatTexto').value = '';
    await carregarMensagens();
  }catch(e){
    // antes essa falha ficava sem nenhum aviso — o botão só voltava ao normal
    // e parecia que a mensagem tinha "sumido" sem enviar
    toast(e && e.message ? e.message : 'Não foi possível enviar a mensagem.');
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
  if(name==='cadastros') goCadSub(cadAba);
}
function goCadSub(sub){
  cadAba = sub;
  document.querySelectorAll('.subtab').forEach(t=>t.classList.toggle('active', t.dataset.sub===sub));
  document.querySelectorAll('.cad-view').forEach(v=>{ v.style.display = (v.id === 'cad-'+sub) ? '' : 'none'; });
}

/* ---------- relógio ---------- */
function tickClock(){ document.getElementById('clock').textContent = new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}); }

/* ---------- init ---------- */
window.addEventListener('DOMContentLoaded', async ()=>{
  segmentedSetup('f_tipo', atualizarPreview);
  segmentedSetup('f_atendente', atualizarPreview);
  configurarEditorRico();

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

  document.getElementById('f_cliente').addEventListener('change', ()=>{ popularUsuariosSolicitantes(); atualizarPreview(); });
  document.getElementById('f_hi').addEventListener('change', atualizarPreview);
  document.getElementById('f_hf').addEventListener('change', atualizarPreview);
  document.getElementById('f_inter').addEventListener('change', atualizarPreview);
  document.getElementById('f_qtd_manual').addEventListener('input', atualizarPreview);
  document.getElementById('btnSalvar').addEventListener('click', salvarRegistro);
  document.getElementById('btnExportar').addEventListener('click', exportarCsv);
  document.getElementById('btnExportarGantt').addEventListener('click', exportarCsvGantt);
  document.getElementById('r_mes').addEventListener('change', renderResumo);
  document.getElementById('r_atendente').addEventListener('change', e=>{ filtroResumoAtendente = e.target.value; renderResumo(); });

  document.getElementById('filtros').addEventListener('click', e=>{
    const chip = e.target.closest('.chip'); if(!chip) return;
    if(chip.dataset.cliente === 'TODOS'){ filtroCliente.clear(); }
    else{ if(filtroCliente.has(chip.dataset.cliente)) filtroCliente.delete(chip.dataset.cliente); else filtroCliente.add(chip.dataset.cliente); }
    renderFiltros();
    renderLista();
  });
  document.getElementById('filtrosStatus').addEventListener('click', e=>{
    const chip = e.target.closest('.chip'); if(!chip) return;
    filtroStatus = chip.dataset.status;
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
  document.getElementById('btnEnviarMensagem').addEventListener('click', enviarMensagem);
  document.getElementById('chatTexto').addEventListener('keydown', e=>{
    if(e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); enviarMensagem(); }
  });

  document.getElementById('btnAddAtendente').addEventListener('click', async ()=>{
    const nome = document.getElementById('at_nome').value.trim();
    const login = document.getElementById('at_login').value.trim();
    const senha = document.getElementById('at_senha').value;
    const email = document.getElementById('at_email').value.trim();
    const telefone = document.getElementById('at_telefone').value.trim();
    if(!nome || !login){ toast('Preencha nome e login'); return; }
    if(!editandoAtendenteId && !senha){ toast('Informe uma senha'); return; }

    let r;
    const editando = !!editandoAtendenteId;
    if(editando){
      r = await api('atualizarConta', { id: editandoAtendenteId, nome: nome.toUpperCase(), login, senha, email, telefone });
    }else{
      r = await api('addAtendente', { nome: nome.toUpperCase(), login, senha, email, telefone });
    }
    if(!r.ok) return;
    cancelarEdicaoAtendente();
    await carregarTudo(); renderListAtendentes(); popularSelects();
    toast(editando ? 'Atendente atualizado' : 'Atendente adicionado');
  });
  document.getElementById('btnCancelarEdicaoAtendente').addEventListener('click', cancelarEdicaoAtendente);

  document.getElementById('btnAddCliente').addEventListener('click', async ()=>{
    const nome = document.getElementById('cl_nome').value.trim();
    if(!nome){ toast('Informe o nome do cliente'); return; }
    const r = await api('addCliente', { nome: nome.toUpperCase() });
    if(!r.ok) return;
    document.getElementById('cl_nome').value='';
    await carregarTudo(); renderListClientes(); popularSelects(); renderValoresForm(); renderFiltros();
    toast('Cliente adicionado');
  });

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
    if(!atendenteId || !clienteId || !tipoId || isNaN(real) || isNaN(ananda)){ toast('Preencha todos os campos, incluindo o atendente'); return; }
    const r = await api('salvarValor', { atendenteId, clienteId, tipoId, real, ananda });
    if(!r.ok) return;
    document.getElementById('vl_real').value=''; document.getElementById('vl_ananda').value='';
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
    cancelarEdicaoUsuario();
    await carregarTudo(); renderListUsuarios(); popularSelects();
    toast(editando ? 'Usuário atualizado' : 'Usuário adicionado');
  });
  document.getElementById('btnCancelarEdicaoUsuario').addEventListener('click', cancelarEdicaoUsuario);

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
