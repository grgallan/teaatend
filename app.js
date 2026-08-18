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
  ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InByY2htb2pwZmdlcWJub2lpc3lmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY5NjMzMDYsImV4cCI6MjEwMjUzOTMwNn0.BnkW_pMECVDuV-bIjVJ0mpkmQhdTyty_2ityu7gyy80'
};

const SESSAO_KEY = 'sessao_v4';

let contas = [], clientes = [], tipos = [], modulos = [], submodulos = [], statusList = [], valores = [], atendimentos = [];
let sessaoConta = null; // conta logada (sem senha), guardada após login
let editandoId = null;
let anexoAtual = { url: '', nome: '' };
let editandoAtendenteId = null;
let editandoUsuarioId = null;
let excluindoAcao = null;
let filtroCliente = 'TODOS';
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

function contaAtual(){ return sessaoConta; }

function entrarNoApp(){
  const conta = contaAtual();
  if(!conta){ sair(); return; }
  if(!contas.find(c=>String(c.id)===String(conta.id))){ toast('Sua conta não existe mais.'); sair(); return; }

  document.getElementById('screen-login').style.display = 'none';
  document.getElementById('app').style.display = 'block';
  document.getElementById('whoName').textContent = conta.nome;
  document.getElementById('avatarIni').textContent = conta.nome.slice(0,2).toUpperCase();

  const isAdmin = conta.perfil === 'ADMIN';
  const isUsuario = conta.perfil === 'USUARIO';

  document.getElementById('tabCadastros').style.display = isAdmin ? '' : 'none';
  document.getElementById('navCadastros').style.display = isAdmin ? '' : 'none';
  document.querySelectorAll('#mainTabs .tab[data-view="resumo"], #bottomNav .navbtn[data-view="resumo"]').forEach(el=>{ el.style.display = isUsuario ? 'none' : ''; });

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
  renderSegmentado('f_tipo', tipos.map(t=>t.nome), tipos[0]?.nome);
  renderSegmentado('f_atendente', contas.filter(c=>c.perfil==='ATENDENTE').map(a=>a.nome), null);

  // usuário solicitante não escolhe o atendente — um atendente qualquer assume o chamado
  const isUsuario = conta && conta.perfil === 'USUARIO';
  document.getElementById('campoAtendente').style.display = isUsuario ? 'none' : '';
  document.getElementById('campoAtendenteInfo').style.display = isUsuario ? '' : 'none';

  // usuário não preenche horário trabalhado — isso é registrado por quem atende
  document.getElementById('campoHorarios').style.display = isUsuario ? 'none' : '';

  // ajuste manual de horas — só o admin tem esse campo
  const isAdmin = conta && conta.perfil === 'ADMIN';
  document.getElementById('campoQtdManual').style.display = isAdmin ? '' : 'none';
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
  document.getElementById('f_detalhe').value = '';
  document.getElementById('f_solucao').value = '';
  const conta = contaAtual();
  const isUsuario = conta && conta.perfil === 'USUARIO';
  document.getElementById('f_hi').value = isUsuario ? '00:00' : '08:00';
  document.getElementById('f_inter').value = '00:00';
  document.getElementById('f_hf').value = isUsuario ? '00:00' : '09:00';
  document.getElementById('f_status').value = 'PENDENTE';
  document.getElementById('f_qtd_manual').value = '';
  document.getElementById('f_anexo').value = '';
  document.getElementById('anexoAtualInfo').style.display = 'none';
  anexoAtual = { url: '', nome: '' };

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
  const detalhe = document.getElementById('f_detalhe').value.trim();
  const solucao = document.getElementById('f_solucao').value.trim();
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
    const payload = { id: editandoId, data, cliente, usuario, modulo, submodulo, tipo, atendente, detalhe, solucao, hi, inter, hf, status,
      qtdManual: qtdManualStr !== '' ? Number(qtdManualStr) : undefined,
      anexoUrlExistente: anexoAtual.url, anexoNomeExistente: anexoAtual.nome };

    const arquivo = document.getElementById('f_anexo').files[0];
    if(arquivo){
      if(arquivo.size > 8 * 1024 * 1024){ toast('Anexo muito grande (máx. 8MB)'); btn.disabled = false; btn.textContent = editandoId ? 'Atualizar atendimento' : 'Salvar atendimento'; return; }
      payload.anexoBase64 = await lerArquivoBase64(arquivo);
      payload.anexoTipo = arquivo.type;
      payload.anexoNome = arquivo.name;
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
  document.getElementById('f_detalhe').value = r.detalhe || '';
  document.getElementById('f_solucao').value = r.solucao || '';
  document.getElementById('f_hi').value = r.hi;
  document.getElementById('f_inter').value = r.inter;
  document.getElementById('f_hf').value = r.hf;
  document.getElementById('f_status').value = r.status;
  document.getElementById('f_qtd_manual').value = '';
  document.getElementById('f_qtd_manual').placeholder = `Atual: ${Number(r.qtd).toFixed(2).replace('.',',')}h — deixe em branco pra manter`;
  document.getElementById('f_anexo').value = '';
  anexoAtual = { url: r.anexoUrl || '', nome: r.anexoNome || '' };
  const infoEl = document.getElementById('anexoAtualInfo');
  if(anexoAtual.url){
    infoEl.style.display = '';
    document.getElementById('anexoAtualLink').href = anexoAtual.url;
    document.getElementById('anexoAtualLink').textContent = anexoAtual.nome || 'ver';
  }else{
    infoEl.style.display = 'none';
  }
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
  document.getElementById('f_detalhe').value = r.detalhe || '';
  document.getElementById('f_solucao').value = '';
  document.getElementById('f_hi').value = r.hi;
  document.getElementById('f_inter').value = r.inter;
  document.getElementById('f_hf').value = r.hf;
  document.getElementById('f_qtd_manual').value = '';
  document.getElementById('f_qtd_manual').placeholder = 'Deixe em branco pra calcular pelo horário acima';
  // anexo não é copiado — cada atendimento tem o seu
  document.getElementById('f_anexo').value = '';
  anexoAtual = { url: '', nome: '' };
  document.getElementById('anexoAtualInfo').style.display = 'none';
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
  if(conta && conta.perfil === 'USUARIO'){ el.innerHTML=''; return; }
  el.innerHTML = `<div class="chip on" data-cliente="TODOS">Todos</div>` + clientes.map(c=>`<div class="chip" data-cliente="${c.nome}">${c.nome}</div>`).join('');
  el.addEventListener('click', e=>{
    const chip = e.target.closest('.chip'); if(!chip) return;
    el.querySelectorAll('.chip').forEach(c=>c.classList.remove('on'));
    chip.classList.add('on');
    filtroCliente = chip.dataset.cliente;
    renderLista();
  });
  renderFiltrosStatus();
}

function renderFiltrosStatus(){
  const el = document.getElementById('filtrosStatus');
  const conta = contaAtual();
  if(conta && conta.perfil === 'USUARIO'){ el.innerHTML=''; return; }
  el.innerHTML = `<div class="chip on" data-status="TODOS">Todos status</div>` +
    statusList.map(s=>`<div class="chip" data-status="${s.nome}">${s.nome}</div>`).join('');
  el.addEventListener('click', e=>{
    const chip = e.target.closest('.chip'); if(!chip) return;
    el.querySelectorAll('.chip').forEach(c=>c.classList.remove('on'));
    chip.classList.add('on');
    filtroStatus = chip.dataset.status;
    renderLista();
  });
}

function renderLista(){
  const cont = document.getElementById('listaItens');
  const conta = contaAtual();
  const podeEditar = conta && conta.perfil !== 'USUARIO';
  let itens = atendimentos.slice();
  if(conta && conta.perfil === 'USUARIO'){
    itens = itens.filter(r=>r.usuario === conta.nome);
  }else{
    if(filtroCliente !== 'TODOS') itens = itens.filter(r=>r.cliente===filtroCliente);
    if(filtroStatus !== 'TODOS') itens = itens.filter(r=>r.status===filtroStatus);
    const de = document.getElementById('periodo_de').value;
    const ate = document.getElementById('periodo_ate').value;
    if(de) itens = itens.filter(r=>String(r.data) >= de);
    if(ate) itens = itens.filter(r=>String(r.data) <= ate);
  }
  itens.sort((a,b)=> String(b.data).localeCompare(String(a.data)));

  document.getElementById('filtroPeriodo').style.display = podeEditar ? 'grid' : 'none';
  const verValores = podeVerValores();
  const isUsuario = conta && conta.perfil === 'USUARIO';
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
      ${r.detalhe ? `<div class="detalhe">${r.detalhe}</div>` : ''}
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
let filtroResumoCliente = 'TODOS';

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
    const selCli = document.getElementById('r_cliente');
    selCli.innerHTML = `<option value="TODOS">Todos os clientes</option>` + clientes.map(c=>`<option value="${c.nome}">${c.nome}</option>`).join('');
    selCli.value = filtroResumoCliente;
    if(filtroResumoCliente !== 'TODOS') itens = itens.filter(r=>r.cliente === filtroResumoCliente);
  }else{
    campoFiltroCliente.style.display = 'none';
  }

  const totalHoras = itens.reduce((s,r)=>s+Number(r.qtd),0);
  const verValoresReal = podeVerValores();               // Valor Real — só admin
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

function exportarCsv(){
  const mes = document.getElementById('r_mes').value;
  const itens = atendimentos.filter(r=>r.mes===mes).slice().sort((a,b)=>String(a.data).localeCompare(String(b.data)));
  if(itens.length===0){ toast('Nada para exportar neste mês'); return; }
  const header = ['DATA','MES','CLIENTE','USUARIO','MODULO','SUBMODULO','TIPO ATENDIMENTO','ATENDENTE','DETALHE','SOLUCAO','HI','INTER','HF','QTD','VALOR ATENDENTE/H','TOTAL ATENDENTE','STATUS','VHR','TOTAL REAL','ANEXO'];
  const rows = itens.map(r=>{
    const [y,m,d]=String(r.data).split('-');
    return [`${d}/${m}/${y}`, r.mes, r.cliente, r.usuario, r.modulo||'', r.submodulo||'', r.tipo, r.atendente, (r.detalhe||'').replace(/;/g,','), (r.solucao||'').replace(/;/g,','), r.hi, r.inter, r.hf,
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
    return `<div class="cad-item" style="cursor:pointer;" onclick="editarUsuario('${u.id}')">
      <div class="info"><b>${u.nome}</b><span>${cliente} · login: ${u.login}</span>${contatos}</div>
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

async function abrirDetalhe(atendimentoId){
  const r = atendimentos.find(x=>String(x.id)===String(atendimentoId));
  if(!r || !podeUsarChat(r)) return;
  chatAtendimentoId = atendimentoId;
  const [y,m,d] = String(r.data).split('-');
  const modSub = [r.modulo, r.submodulo].filter(Boolean).join(' · ');

  document.getElementById('chatTitulo').textContent = `${r.cliente} · ${r.usuario}`;
  document.getElementById('chatSub').textContent = `Atendente: ${r.atendente || '(a definir)'} · ${d}/${m}/${y} · ${r.status}`;
  document.getElementById('chatResumo').innerHTML = `
    ${modSub ? `<div style="color:var(--accent);font-weight:600;font-size:12.5px;">${modSub}</div>` : ''}
    ${r.detalhe ? `<div style="font-size:12.5px;color:var(--muted);margin-top:2px;">${escaparHtml(r.detalhe)}</div>` : ''}
    ${r.solucao ? `<div style="font-size:12.5px;margin-top:8px;padding:8px 10px;background:var(--panel-2);border-radius:8px;"><b style="color:var(--ok);">Solução:</b> ${escaparHtml(r.solucao)}</div>` : ''}
    ${r.anexoUrl ? `<a href="${r.anexoUrl}" target="_blank" style="font-size:12px;color:var(--accent);">📎 ${r.anexoNome||'anexo'}</a>` : ''}
  `;
  document.getElementById('chatHistorico').innerHTML = `<div class="chat-empty">Carregando…</div>`;
  document.getElementById('chatMensagens').innerHTML = `<div class="chat-empty">Carregando…</div>`;
  document.getElementById('chatTexto').value = '';
  document.getElementById('chatModal').classList.add('show');
  await Promise.all([carregarHistorico(), carregarMensagens()]);
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

/* ---------- navegação ---------- */
function goView(name){
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  document.getElementById('view-'+name).classList.add('active');
  document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('active', t.dataset.view===name));
  document.querySelectorAll('.navbtn').forEach(t=>t.classList.toggle('active', t.dataset.view===name));
  if(name==='lista') renderLista();
  if(name==='resumo') renderResumo();
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

  document.getElementById('f_cliente').addEventListener('change', ()=>{ popularUsuariosSolicitantes(); atualizarPreview(); });
  document.getElementById('f_hi').addEventListener('change', atualizarPreview);
  document.getElementById('f_hf').addEventListener('change', atualizarPreview);
  document.getElementById('f_inter').addEventListener('change', atualizarPreview);
  document.getElementById('f_qtd_manual').addEventListener('input', atualizarPreview);
  document.getElementById('btnSalvar').addEventListener('click', salvarRegistro);
  document.getElementById('btnExportar').addEventListener('click', exportarCsv);
  document.getElementById('r_mes').addEventListener('change', renderResumo);
  document.getElementById('r_atendente').addEventListener('change', e=>{ filtroResumoAtendente = e.target.value; renderResumo(); });
  document.getElementById('r_cliente').addEventListener('change', e=>{ filtroResumoCliente = e.target.value; renderResumo(); });
  document.getElementById('periodo_de').addEventListener('change', renderLista);
  document.getElementById('periodo_ate').addEventListener('change', renderLista);

  document.querySelectorAll('.tab').forEach(t=>t.addEventListener('click', ()=>goView(t.dataset.view)));
  document.querySelectorAll('.navbtn').forEach(t=>t.addEventListener('click', ()=>goView(t.dataset.view)));
  document.querySelectorAll('.subtab').forEach(t=>t.addEventListener('click', ()=>goCadSub(t.dataset.sub)));

  document.getElementById('btnLogin').addEventListener('click', tentarLogin);
  document.getElementById('loginPass').addEventListener('keydown', e=>{ if(e.key==='Enter') tentarLogin(); });
  document.getElementById('toggleSenha').addEventListener('click', ()=>{
    const campo = document.getElementById('loginPass'); const btn = document.getElementById('toggleSenha');
    if(campo.type === 'password'){ campo.type = 'text'; btn.textContent = 'OCULTAR'; } else { campo.type = 'password'; btn.textContent = 'MOSTRAR'; }
  });
  document.getElementById('btnLogout').addEventListener('click', ()=>pedirConfirmacao('Sair da conta?','Você poderá entrar novamente quando quiser.', sair, 'Sair'));

  document.getElementById('btnRemoverAnexoAtual').addEventListener('click', ()=>{
    anexoAtual = { url: '', nome: '' };
    document.getElementById('anexoAtualInfo').style.display = 'none';
  });

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
    if(!clienteId || !nome || !login){ toast('Preencha todos os campos'); return; }
    if(!editandoUsuarioId && !senha){ toast('Informe uma senha'); return; }

    const editando = !!editandoUsuarioId;
    let r;
    if(editando){
      r = await api('atualizarConta', { id: editandoUsuarioId, nome: nome.toUpperCase(), login, senha, clienteId, email, telefone });
    }else{
      r = await api('addUsuario', { nome: nome.toUpperCase(), login, senha, clienteId, email, telefone });
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
