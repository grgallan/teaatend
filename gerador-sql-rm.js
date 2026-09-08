/* =========================================================
   Gerador SQL RM — página separada, sem login e sem acesso ao resto do
   sistema (Controle de Atendimentos). Fala com a MESMA Edge Function, mas
   só através das ações "rmPublico*" — que nunca leem/gravam nada fora do
   dicionário do RM (rm_tabelas/rm_campos/rm_relacionamentos/
   rm_consultas_salvas). Link pra compartilhar: esta própria página.
   ========================================================= */

const CONFIG = {
  API_URL: 'https://prchmojpfgeqbnoiisyf.supabase.co/functions/v1/super-function',
  ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InByY2htb2pwZmdlcWJub2lpc3lmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY5NjMzMDYsImV4cCI6MjEwMjUzOTMwNn0.BnkW_pMECVDuV-bIjVJ0mpkmQhdTyty_2ityu7gyy80',
};

async function api(action, payload = {}){
  let resp;
  try{
    resp = await fetch(CONFIG.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': CONFIG.ANON_KEY, 'Authorization': `Bearer ${CONFIG.ANON_KEY}` },
      body: JSON.stringify({ action, ...payload }),
    });
  }catch(e){
    toast('Não foi possível conectar. Verifique sua internet e tente novamente.');
    return { ok: false, erro: 'erro de rede' };
  }
  let json;
  try{ json = await resp.json(); }catch(e){ return { ok: false, erro: 'resposta inválida do servidor' }; }
  return json;
}

function toast(msg){
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'), 2200);
}

function escaparHtml(s){
  return String(s == null ? '' : s).replace(/[&<>"']/g, c=>({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

// normaliza texto pra busca — minúsculas e sem acento
function normalizarBuscaTextoRm(s){
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}
// mesma normalização usada no backend pra chave composta ("CODCOLIGADA,
// CHAPA" -> "CODCOLIGADA,CHAPA") — aplicada só na hora de gerar o SQL
function normalizarCamposRmTexto(s){
  return String(s || '').split(',').map(x=>x.trim().toUpperCase()).filter(Boolean).join(',');
}

let rmTabelasTodas = null;
let rmBuilder = { tabelaPrincipal: null, camposPrincipal: new Set(), relacionamentosDisponiveis: [], tabelasRelacionadas: new Map(), ordem: [] };

// carrega TODAS as tabelas cadastradas (pagina de 1000 em 1000)
async function carregarTabelasRMTodas(forcar){
  if(rmTabelasTodas && !forcar) return rmTabelasTodas;
  const TAM_PAGINA = 1000;
  let tudo = [], offset = 0;
  while(true){
    const r = await api('rmPublicoListarTabelas', { limit: TAM_PAGINA, offset });
    if(!r.ok){ toast(r.erro || 'Erro ao carregar tabelas do RM'); break; }
    tudo = tudo.concat(r.tabelas || []);
    if(!r.tabelas || r.tabelas.length < TAM_PAGINA) break;
    offset += TAM_PAGINA;
  }
  rmTabelasTodas = tudo;
  return rmTabelasTodas;
}

async function iniciarGeradorSqlRm(){
  document.getElementById('rmBdCardCampos').style.display = 'none';
  document.getElementById('rmBdCardRelacionadas').style.display = 'none';
  document.getElementById('rmBdCardFiltros').style.display = 'none';
  document.getElementById('rmBdCardOrdem').style.display = 'none';
  document.getElementById('rmBdCardSql').style.display = 'none';
  document.getElementById('rm_bd_busca_campos_principal').value = '';
  document.getElementById('rm_bd_busca_relacionadas').value = '';
  document.getElementById('rm_bd_busca_tabela_principal').value = '';
  document.getElementById('rmBdResultadosTabelaPrincipal').innerHTML = '';
  await carregarTabelasRMTodas();
  await carregarTabelaPrincipalRM(null);
}

/* ---------- Etapa 1: tabela principal (lookup) ---------- */
function renderRmBdResultadosTabelaPrincipal(termo){
  const el = document.getElementById('rmBdResultadosTabelaPrincipal');
  const t = normalizarBuscaTextoRm(termo).trim();
  if(!t){ el.innerHTML = ''; return; }
  const resultados = (rmTabelasTodas || [])
    .filter(x=>normalizarBuscaTextoRm(`${x.nome} ${x.apelido || ''}`).includes(t))
    .sort((a,b)=>a.nome.localeCompare(b.nome, 'pt-BR'))
    .slice(0, 100);
  if(resultados.length === 0){ el.innerHTML = `<div class="empty">Nenhuma tabela encontrada.</div>`; return; }
  el.innerHTML = resultados.map(x=>`<div class="rm-lookup-item" onclick="selecionarTabelaPrincipalRM('${x.id}')">${escaparHtml(x.nome)}${x.apelido && x.apelido !== x.nome ? ' — '+escaparHtml(x.apelido) : ''}</div>`).join('');
}
function renderRmBdTabelaPrincipalSelecionada(){
  const el = document.getElementById('rmBdTabelaPrincipalSelecionada');
  const t = rmBuilder.tabelaPrincipal;
  el.innerHTML = t
    ? `<div class="chip on" onclick="selecionarTabelaPrincipalRM(null)">${escaparHtml(t.nome)}${t.apelido && t.apelido !== t.nome ? ' — '+escaparHtml(t.apelido) : ''} ✕</div>`
    : `<span class="rm-hint-inline">Nenhuma tabela escolhida ainda.</span>`;
}
async function selecionarTabelaPrincipalRM(tabelaId){
  document.getElementById('rm_bd_busca_tabela_principal').value = '';
  document.getElementById('rmBdResultadosTabelaPrincipal').innerHTML = '';
  await carregarTabelaPrincipalRM(tabelaId);
}
async function carregarTabelaPrincipalRM(tabelaId){
  rmBuilder = { tabelaPrincipal: null, camposPrincipal: new Set(), camposDisponiveisPrincipal: [], relacionamentosDisponiveis: [], tabelasRelacionadas: new Map(), filtros: [], ordem: [] };
  document.getElementById('rmBdCardFiltros').style.display = 'none';
  document.getElementById('rmBdCardOrdem').style.display = 'none';
  document.getElementById('rmBdCardSql').style.display = 'none';
  renderRmBdTabelaPrincipalSelecionada();
  if(!tabelaId){
    document.getElementById('rmBdCardCampos').style.display = 'none';
    document.getElementById('rmBdCardRelacionadas').style.display = 'none';
    renderRmBdDiagrama();
    return;
  }
  const tabela = (rmTabelasTodas || []).find(t=>t.id === tabelaId);
  rmBuilder.tabelaPrincipal = tabela;
  renderRmBdTabelaPrincipalSelecionada();
  const [rCampos, rRel] = await Promise.all([
    api('rmPublicoListarCampos', { tabelaId }),
    api('rmPublicoListarRelacionamentosDe', { tabelaId }),
  ]);
  document.getElementById('rm_bd_busca_relacionadas').value = '';
  document.getElementById('rmBdCardCampos').style.display = '';
  renderRmBdCamposPrincipal(rCampos.ok ? rCampos.campos : []);
  document.getElementById('rmBdCardRelacionadas').style.display = '';
  rmBuilder.relacionamentosDisponiveis = rRel.ok ? rRel.relacionamentos : [];
  renderRmBdChipsRelacionadas();
  atualizarRmBdFiltroCampoSelect();
  renderRmBdDiagrama();
}

/* ---------- lookups de campo (principal e cada relacionada) ---------- */
function filtrarPorBuscaRm(containerId, termo, seletorLinha){
  const t = normalizarBuscaTextoRm(termo).trim();
  document.querySelectorAll(`#${containerId} ${seletorLinha}`).forEach(linha=>{
    linha.hidden = !!t && !(linha.dataset.busca || '').includes(t);
  });
}
function renderCamposLookupRm(containerId, chipsContainerId, campos, selecionados, montarChamada){
  renderChipsCamposSelecionadosRm(chipsContainerId, campos, selecionados, montarChamada);
  const el = document.getElementById(containerId);
  if(!campos || campos.length === 0){ el.innerHTML = `<div class="empty">Essa tabela ainda não tem campos cadastrados.</div>`; return; }
  el.innerHTML = campos.slice().sort((a,b)=>(a.rotulo || a.nome).localeCompare(b.rotulo || b.nome, 'pt-BR')).map(c=>{
    const busca = normalizarBuscaTextoRm(`${c.nome} ${c.rotulo || ''}`);
    const rotulo = c.rotulo ? `${escaparHtml(c.rotulo)}<span class="mono-sub">${escaparHtml(c.nome)}</span>` : `<span class="mono-sub">${escaparHtml(c.nome)}</span>`;
    return `<label class="rm-campo-row" data-busca="${escaparHtml(busca)}"><input type="checkbox" data-campo="${escaparHtml(c.nome)}" ${selecionados.has(c.nome)?'checked':''} onchange="${montarChamada(c.nome,'this.checked')}"> ${rotulo}${c.tipo ? ` <span class="tipo">${escaparHtml(c.tipo)}</span>` : ''}</label>`;
  }).join('');
}
function renderChipsCamposSelecionadosRm(chipsContainerId, campos, selecionados, montarChamada){
  const chipsEl = document.getElementById(chipsContainerId);
  if(!chipsEl) return;
  const escolhidos = campos.filter(c=>selecionados.has(c.nome));
  chipsEl.innerHTML = escolhidos.length
    ? escolhidos.map(c=>`<div class="chip on" onclick="${montarChamada(c.nome,'false')}">${escaparHtml(c.rotulo || c.nome)} ✕</div>`).join('')
    : `<span class="rm-hint-inline">Nenhum campo selecionado ainda.</span>`;
}
function sincronizarCheckboxCampoRm(containerId, nome, marcado){
  const el = document.querySelector(`#${containerId} input[data-campo="${CSS.escape(nome)}"]`);
  if(el) el.checked = marcado;
}
function renderRmBdCamposPrincipal(campos){
  rmBuilder.camposDisponiveisPrincipal = campos || [];
  const busca = document.getElementById('rm_bd_busca_campos_principal');
  if(busca) busca.value = '';
  renderCamposLookupRm('rmBdCamposPrincipal', 'rmBdChipsCamposPrincipalSelecionados', rmBuilder.camposDisponiveisPrincipal, rmBuilder.camposPrincipal,
    (nome, estado)=>`toggleRmBdCampoPrincipal('${nome}', ${estado})`);
}
function toggleRmBdCampoPrincipal(nome, marcado){
  if(marcado) rmBuilder.camposPrincipal.add(nome); else rmBuilder.camposPrincipal.delete(nome);
  sincronizarCheckboxCampoRm('rmBdCamposPrincipal', nome, marcado);
  renderChipsCamposSelecionadosRm('rmBdChipsCamposPrincipalSelecionados', rmBuilder.camposDisponiveisPrincipal, rmBuilder.camposPrincipal,
    (n, estado)=>`toggleRmBdCampoPrincipal('${n}', ${estado})`);
  atualizarRmBdOrdemDisponiveis();
}

/* ---------- Etapa 3: tabelas relacionadas (lookup) ---------- */
function renderRmBdChipsRelacionadas(){
  const el = document.getElementById('rmBdChipsRelacionadas');
  const rels = rmBuilder.relacionamentosDisponiveis || [];
  document.getElementById('rmBdRelacionadasTotal').textContent = rels.length;
  if(rels.length === 0){
    el.innerHTML = `<div class="empty">Nenhuma tabela relacionada com essa.</div>`;
    document.getElementById('rmBdChipsRelacionadasSelecionadas').innerHTML = '';
    document.getElementById('rmBdSecoesRelacionadas').innerHTML = '';
    return;
  }
  el.innerHTML = rels
    .slice()
    .sort((a,b)=>(a.outraTabelaApelido || a.outraTabelaNome).localeCompare(b.outraTabelaApelido || b.outraTabelaNome, 'pt-BR'))
    .map(r=>{
      const buscaTxt = normalizarBuscaTextoRm(`${r.outraTabelaNome} ${r.outraTabelaApelido || ''}`);
      return `<div class="rm-lookup-item rm-rel-chip" data-tabela="${r.outraTabelaId}" data-busca="${escaparHtml(buscaTxt)}" onclick="toggleRmBdTabelaRelacionada('${r.outraTabelaId}')">${escaparHtml(r.outraTabelaApelido || r.outraTabelaNome)}</div>`;
    }).join('');
  renderChipsRelacionadasSelecionadasRm();
  const busca = document.getElementById('rm_bd_busca_relacionadas');
  filtrarTabelasRelacionadasRm(busca ? busca.value : '');
}
function renderChipsRelacionadasSelecionadasRm(){
  const chipsEl = document.getElementById('rmBdChipsRelacionadasSelecionadas');
  const escolhidas = [...rmBuilder.tabelasRelacionadas.values()];
  chipsEl.innerHTML = escolhidas.length
    ? escolhidas.map(s=>`<div class="chip on" onclick="toggleRmBdTabelaRelacionada('${s.tabelaId}')">${escaparHtml(s.tabelaApelido || s.tabelaNome)} ✕</div>`).join('')
    : `<span class="rm-hint-inline">Nenhuma tabela relacionada selecionada ainda.</span>`;
}
function filtrarTabelasRelacionadasRm(termo){
  const t = normalizarBuscaTextoRm(termo).trim();
  document.querySelectorAll('#rmBdChipsRelacionadas .rm-rel-chip').forEach(chip=>{
    chip.hidden = !t || !(chip.dataset.busca || '').includes(t);
    chip.classList.toggle('on', rmBuilder.tabelasRelacionadas.has(chip.dataset.tabela));
  });
}
async function toggleRmBdTabelaRelacionada(tabelaId){
  if(rmBuilder.tabelasRelacionadas.has(tabelaId)){
    rmBuilder.tabelasRelacionadas.delete(tabelaId);
    renderRmBdChipsRelacionadas();
    renderRmBdSecoesRelacionadas();
    atualizarRmBdOrdemDisponiveis();
    atualizarRmBdFiltroCampoSelect();
    return;
  }
  const rel = rmBuilder.relacionamentosDisponiveis.find(r=>r.outraTabelaId === tabelaId);
  if(!rel) return;
  const r = await api('rmPublicoListarCampos', { tabelaId });
  rmBuilder.tabelasRelacionadas.set(tabelaId, {
    tabelaId, tabelaNome: rel.outraTabelaNome, tabelaApelido: rel.outraTabelaApelido,
    relacionamento: rel, campos: new Set(), camposDisponiveis: r.ok ? r.campos : [],
    tipoJoin: rel.tipoJoin === 'INNER' ? 'INNER' : 'LEFT',
    meuCampo: rel.meuCampo, campoOutraTabela: rel.campoOutraTabela,
  });
  renderRmBdChipsRelacionadas();
  renderRmBdSecoesRelacionadas();
  atualizarRmBdFiltroCampoSelect();
}
function renderRmBdSecoesRelacionadas(){
  const el = document.getElementById('rmBdSecoesRelacionadas');
  const secoes = [...rmBuilder.tabelasRelacionadas.values()];
  const principal = rmBuilder.tabelaPrincipal;
  el.innerHTML = secoes.map(s=>`
    <div class="rm-secao-relacionada" id="rmBdSecaoRel_${s.tabelaId}">
      <h3>${escaparHtml(s.tabelaApelido || s.tabelaNome)}</h3>
      <div class="row">
        <div class="field"><label>Campo em ${escaparHtml(principal.apelido || principal.nome)}</label><input type="text" class="mono" data-join="meuCampo" data-tabela="${s.tabelaId}" value="${escaparHtml(s.meuCampo)}"></div>
        <div class="field"><label>Campo em ${escaparHtml(s.tabelaApelido || s.tabelaNome)}</label><input type="text" class="mono" data-join="campoOutraTabela" data-tabela="${s.tabelaId}" value="${escaparHtml(s.campoOutraTabela)}"></div>
      </div>
      <div class="field">
        <label>Tipo de junção</label>
        <select data-join="tipoJoin" data-tabela="${s.tabelaId}">
          <option value="LEFT" ${s.tipoJoin !== 'INNER' ? 'selected' : ''}>LEFT JOIN (traz mesmo sem correspondência)</option>
          <option value="INNER" ${s.tipoJoin === 'INNER' ? 'selected' : ''}>INNER JOIN (precisa existir dos dois lados)</option>
        </select>
      </div>
      <p class="rm-hint">Ajuste aqui se o campo tiver nomes diferentes nas duas tabelas (ex: CHAPA numa, CHAPAU noutra) — vale só pra essa consulta. Chave composta: separe por vírgula, na mesma ordem dos dois lados.</p>
      <input type="text" id="rm_bd_busca_campos_${s.tabelaId}" placeholder="Buscar campo por nome ou descrição...">
      <div class="rm-chips-selecionados" id="rmBdChipsSel_${s.tabelaId}"></div>
      <div class="rm-campos-grid" id="rmBdCampos_${s.tabelaId}"></div>
    </div>`).join('');
  secoes.forEach(s=>{
    renderCamposLookupRm(`rmBdCampos_${s.tabelaId}`, `rmBdChipsSel_${s.tabelaId}`, s.camposDisponiveis, s.campos,
      (nome, estado)=>`toggleRmBdCampoRelacionado('${s.tabelaId}','${nome}', ${estado})`);
    const buscaEl = document.getElementById(`rm_bd_busca_campos_${s.tabelaId}`);
    if(buscaEl) buscaEl.addEventListener('input', e=>filtrarPorBuscaRm(`rmBdCampos_${s.tabelaId}`, e.target.value, '.rm-campo-row'));
  });
  renderRmBdDiagrama();
}
function tratarEdicaoJoinRm(e){
  const campo = e.target.closest('[data-join]'); if(!campo) return;
  const secao = rmBuilder.tabelasRelacionadas.get(campo.dataset.tabela); if(!secao) return;
  secao[campo.dataset.join] = campo.value;
  renderRmBdDiagrama();
  gerarSqlRm();
}
// desenha um SVG simples com a tabela principal à esquerda e cada tabela
// relacionada à direita, ligadas por uma curva rotulada com o tipo de
// junção (LEFT tracejado, INNER sólido) e o par de campos usado — clicar
// num nó de tabela relacionada rola até a seção onde dá pra editar aquele
// relacionamento
function truncarTextoRm(s, max){
  s = String(s || '');
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
function renderRmBdDiagrama(){
  const wrap = document.getElementById('rmBdDiagramaWrap');
  const principal = rmBuilder.tabelaPrincipal;
  if(!principal){ wrap.style.display = 'none'; wrap.innerHTML = ''; return; }
  wrap.style.display = '';
  const secoes = [...rmBuilder.tabelasRelacionadas.values()];
  const nodeW = 168, nodeH = 44, rowH = 78, width = 620;
  const xPrincipal = 96, xRel = width - 116;
  if(secoes.length === 0){
    const yUnica = 55;
    wrap.innerHTML = `<svg viewBox="0 0 ${width} 110" class="rm-diagrama-svg">
      <rect x="${xPrincipal-nodeW/2}" y="${yUnica-nodeH/2}" width="${nodeW}" height="${nodeH}" rx="10" class="rm-diagrama-no rm-diagrama-no-principal"/>
      <text x="${xPrincipal}" y="${yUnica+4}" text-anchor="middle" class="rm-diagrama-no-texto">${escaparHtml(truncarTextoRm(principal.apelido || principal.nome, 22))}</text>
    </svg>`;
    return;
  }
  const height = secoes.length * rowH + 20;
  const yPrincipal = height / 2;
  const nos = secoes.map((s, i) => ({ s, y: 20 + i * rowH + nodeH / 2 }));
  const midX = (xPrincipal + xRel) / 2;
  const linhas = nos.map(n=>{
    const inner = n.s.tipoJoin === 'INNER';
    const cor = inner ? 'var(--ok)' : 'var(--accent)';
    const tracejado = inner ? '' : `stroke-dasharray="5,4"`;
    const labelY = (yPrincipal + n.y) / 2;
    const rotulo = `${truncarTextoRm(n.s.meuCampo, 16)} = ${truncarTextoRm(n.s.campoOutraTabela, 16)}`;
    return `
      <path d="M ${xPrincipal + nodeW/2} ${yPrincipal} C ${midX} ${yPrincipal}, ${midX} ${n.y}, ${xRel - nodeW/2} ${n.y}" fill="none" stroke="${cor}" stroke-width="2" ${tracejado}/>
      <text x="${midX}" y="${labelY - 5}" text-anchor="middle" class="rm-diagrama-label-join" style="fill:${cor}">${n.s.tipoJoin}</text>
      <text x="${midX}" y="${labelY + 9}" text-anchor="middle" class="rm-diagrama-label-campo">${escaparHtml(rotulo)}</text>
    `;
  }).join('');
  const nodePrincipal = `
    <rect x="${xPrincipal-nodeW/2}" y="${yPrincipal-nodeH/2}" width="${nodeW}" height="${nodeH}" rx="10" class="rm-diagrama-no rm-diagrama-no-principal"/>
    <text x="${xPrincipal}" y="${yPrincipal+4}" text-anchor="middle" class="rm-diagrama-no-texto">${escaparHtml(truncarTextoRm(principal.apelido || principal.nome, 20))}</text>
  `;
  const nosRelSvg = nos.map(n=>`
    <rect x="${xRel-nodeW/2}" y="${n.y-nodeH/2}" width="${nodeW}" height="${nodeH}" rx="10" class="rm-diagrama-no" onclick="document.getElementById('rmBdSecaoRel_${n.s.tabelaId}').scrollIntoView({behavior:'smooth',block:'center'})"><title>${escaparHtml(n.s.tabelaApelido || n.s.tabelaNome)}</title></rect>
    <text x="${xRel}" y="${n.y+4}" text-anchor="middle" class="rm-diagrama-no-texto" style="pointer-events:none;">${escaparHtml(truncarTextoRm(n.s.tabelaApelido || n.s.tabelaNome, 20))}</text>
  `).join('');
  wrap.innerHTML = `<svg viewBox="0 0 ${width} ${height}" class="rm-diagrama-svg">${linhas}${nodePrincipal}${nosRelSvg}</svg>`;
}
function toggleRmBdCampoRelacionado(tabelaId, nome, marcado){
  const secao = rmBuilder.tabelasRelacionadas.get(tabelaId); if(!secao) return;
  if(marcado) secao.campos.add(nome); else secao.campos.delete(nome);
  sincronizarCheckboxCampoRm(`rmBdCampos_${tabelaId}`, nome, marcado);
  renderChipsCamposSelecionadosRm(`rmBdChipsSel_${tabelaId}`, secao.camposDisponiveis, secao.campos,
    (n, estado)=>`toggleRmBdCampoRelacionado('${tabelaId}','${n}', ${estado})`);
  atualizarRmBdOrdemDisponiveis();
}

/* ---------- Etapa 4: ordem ---------- */
function camposEscolhidosRmBd(){
  const lista = [];
  if(rmBuilder.tabelaPrincipal){
    rmBuilder.camposPrincipal.forEach(nome=>lista.push({ tabelaId: rmBuilder.tabelaPrincipal.id, tabelaNomeReal: rmBuilder.tabelaPrincipal.nome, tabelaLabel: rmBuilder.tabelaPrincipal.apelido || rmBuilder.tabelaPrincipal.nome, campo: nome }));
  }
  rmBuilder.tabelasRelacionadas.forEach(s=>{
    s.campos.forEach(nome=>lista.push({ tabelaId: s.tabelaId, tabelaNomeReal: s.tabelaNome, tabelaLabel: s.tabelaApelido || s.tabelaNome, campo: nome }));
  });
  return lista;
}
function atualizarRmBdOrdemDisponiveis(){
  const disponiveis = camposEscolhidosRmBd();
  document.getElementById('rmBdCardOrdem').style.display = disponiveis.length ? '' : 'none';
  const sel = document.getElementById('rm_bd_ordem_add');
  const jaEscolhidos = new Set(rmBuilder.ordem.map(o=>o.tabelaId+'|'+o.campo));
  const restantes = disponiveis.filter(c=>!jaEscolhidos.has(c.tabelaId+'|'+c.campo));
  sel.innerHTML = `<option value="">Escolha um campo...</option>` + restantes.map((c,i)=>`<option value="${i}">${escaparHtml(c.tabelaLabel)} · ${escaparHtml(c.campo)}</option>`).join('');
  sel.dataset.restantes = JSON.stringify(restantes);
  renderRmBdOrdemLista();
  gerarSqlRm();
}
function adicionarRmBdOrdem(){
  const sel = document.getElementById('rm_bd_ordem_add');
  const idx = sel.value;
  if(idx === '') return;
  const restantes = JSON.parse(sel.dataset.restantes || '[]');
  const campo = restantes[Number(idx)];
  if(!campo) return;
  rmBuilder.ordem.push({ tabelaId: campo.tabelaId, tabelaNomeReal: campo.tabelaNomeReal, tabelaLabel: campo.tabelaLabel, campo: campo.campo, direcao: 'ASC' });
  atualizarRmBdOrdemDisponiveis();
}
function removerRmBdOrdem(i){
  rmBuilder.ordem.splice(i, 1);
  atualizarRmBdOrdemDisponiveis();
}
function moverRmBdOrdem(i, dir){
  const novoIndex = i + dir;
  if(novoIndex < 0 || novoIndex >= rmBuilder.ordem.length) return;
  const [item] = rmBuilder.ordem.splice(i, 1);
  rmBuilder.ordem.splice(novoIndex, 0, item);
  renderRmBdOrdemLista();
  gerarSqlRm();
}
function alternarDirecaoRmBdOrdem(i){
  rmBuilder.ordem[i].direcao = rmBuilder.ordem[i].direcao === 'ASC' ? 'DESC' : 'ASC';
  renderRmBdOrdemLista();
  gerarSqlRm();
}
function renderRmBdOrdemLista(){
  const el = document.getElementById('rmBdOrdemLista');
  if(rmBuilder.ordem.length === 0){ el.innerHTML = `<div class="empty">Nenhum campo na ordenação ainda.</div>`; return; }
  el.innerHTML = rmBuilder.ordem.map((o,i)=>`
    <div class="rm-ordem-item">
      <span class="rm-ordem-nome">${escaparHtml(o.tabelaLabel)} · ${escaparHtml(o.campo)}</span>
      <button onclick="alternarDirecaoRmBdOrdem(${i})">${o.direcao}</button>
      <button onclick="moverRmBdOrdem(${i},-1)" ${i===0?'disabled':''}>↑</button>
      <button onclick="moverRmBdOrdem(${i},1)" ${i===rmBuilder.ordem.length-1?'disabled':''}>↓</button>
      <button onclick="removerRmBdOrdem(${i})">✕</button>
    </div>`).join('');
}

/* ---------- Etapa 4: filtros (WHERE) ---------- */
function todosCamposDisponiveisRmBd(){
  const lista = [];
  if(rmBuilder.tabelaPrincipal){
    (rmBuilder.camposDisponiveisPrincipal || []).forEach(c=>lista.push({ tabelaId: rmBuilder.tabelaPrincipal.id, tabelaNomeReal: rmBuilder.tabelaPrincipal.nome, tabelaLabel: rmBuilder.tabelaPrincipal.apelido || rmBuilder.tabelaPrincipal.nome, campo: c.nome, rotulo: c.rotulo }));
  }
  rmBuilder.tabelasRelacionadas.forEach(s=>{
    (s.camposDisponiveis || []).forEach(c=>lista.push({ tabelaId: s.tabelaId, tabelaNomeReal: s.tabelaNome, tabelaLabel: s.tabelaApelido || s.tabelaNome, campo: c.nome, rotulo: c.rotulo }));
  });
  return lista;
}
function atualizarRmBdFiltroCampoSelect(){
  const disponiveis = todosCamposDisponiveisRmBd();
  document.getElementById('rmBdCardFiltros').style.display = disponiveis.length ? '' : 'none';
  const sel = document.getElementById('rm_bd_filtro_campo');
  sel.innerHTML = disponiveis.map((c,i)=>`<option value="${i}">${escaparHtml(c.tabelaLabel)} · ${escaparHtml(c.rotulo || c.campo)}</option>`).join('');
  sel.dataset.disponiveis = JSON.stringify(disponiveis);
  renderRmBdFiltrosLista();
}
function atualizarRmBdFiltroValorVisibilidade(){
  const op = document.getElementById('rm_bd_filtro_operador').value;
  document.getElementById('rmBdFiltroValorCampo').style.display = (op === 'IS NULL' || op === 'IS NOT NULL') ? 'none' : '';
}
function adicionarRmBdFiltro(){
  const sel = document.getElementById('rm_bd_filtro_campo');
  const disponiveis = JSON.parse(sel.dataset.disponiveis || '[]');
  const campo = disponiveis[Number(sel.value)];
  if(!campo){ toast('Escolha um campo para filtrar'); return; }
  const operador = document.getElementById('rm_bd_filtro_operador').value;
  const valorEl = document.getElementById('rm_bd_filtro_valor');
  const valor = valorEl.value;
  if(operador !== 'IS NULL' && operador !== 'IS NOT NULL' && !valor.trim()){ toast('Informe um valor para o filtro'); return; }
  rmBuilder.filtros.push({ tabelaId: campo.tabelaId, tabelaNomeReal: campo.tabelaNomeReal, tabelaLabel: campo.tabelaLabel, campo: campo.campo, rotulo: campo.rotulo, operador, valor: valor.trim() });
  valorEl.value = '';
  renderRmBdFiltrosLista();
  gerarSqlRm();
}
function removerRmBdFiltro(i){
  rmBuilder.filtros.splice(i, 1);
  renderRmBdFiltrosLista();
  gerarSqlRm();
}
function renderRmBdFiltrosLista(){
  const el = document.getElementById('rmBdFiltrosLista');
  document.getElementById('rmBdFiltrosTotal').textContent = rmBuilder.filtros.length;
  if(rmBuilder.filtros.length === 0){ el.innerHTML = `<div class="empty">Nenhum filtro adicionado ainda.</div>`; return; }
  el.innerHTML = rmBuilder.filtros.map((f,i)=>`
    <div class="rm-ordem-item">
      <span class="rm-ordem-nome">${escaparHtml(f.tabelaLabel)} · ${escaparHtml(f.rotulo || f.campo)} ${escaparHtml(f.operador)}${f.valor ? ' '+escaparHtml(f.valor) : ''}</span>
      <button onclick="removerRmBdFiltro(${i})">✕</button>
    </div>`).join('');
}

/* ---------- Etapa 5: gerar/baixar/salvar SQL ---------- */
function gerarSqlRm(){
  const s = rmBuilder;
  document.getElementById('rmBdCardSql').style.display = s.tabelaPrincipal ? '' : 'none';
  if(!s.tabelaPrincipal) return '';
  const aliasDe = (nome)=>'['+nome+']';
  const linhasSelect = [];
  s.camposPrincipal.forEach(campo=>linhasSelect.push(`${aliasDe(s.tabelaPrincipal.nome)}.${aliasDe(campo)} AS ${aliasDe(s.tabelaPrincipal.nome+'_'+campo)}`));
  s.tabelasRelacionadas.forEach(sec=>{
    sec.campos.forEach(campo=>linhasSelect.push(`${aliasDe(sec.tabelaNome)}.${aliasDe(campo)} AS ${aliasDe(sec.tabelaNome+'_'+campo)}`));
  });
  if(linhasSelect.length === 0) linhasSelect.push('*');
  const joins = [...s.tabelasRelacionadas.values()].map(sec=>{
    const camposMeu = normalizarCamposRmTexto(sec.meuCampo).split(',');
    const camposOutro = normalizarCamposRmTexto(sec.campoOutraTabela).split(',');
    const condicoes = camposMeu.map((c,i)=>`${aliasDe(s.tabelaPrincipal.nome)}.${aliasDe(c)} = ${aliasDe(sec.tabelaNome)}.${aliasDe(camposOutro[i]||camposOutro[0])}`);
    return `${sec.tipoJoin === 'INNER' ? 'INNER' : 'LEFT'} JOIN ${aliasDe(sec.tabelaNome)} ON ${condicoes.join(' AND ')}`;
  });
  const condicoes = (s.filtros || []).map(f=>{
    const expr = `${aliasDe(f.tabelaNomeReal)}.${aliasDe(f.campo)}`;
    if(f.operador === 'IS NULL' || f.operador === 'IS NOT NULL') return `${expr} ${f.operador}`;
    const numerico = /^-?\d+(\.\d+)?$/.test(String(f.valor).trim());
    const valorSql = numerico ? String(f.valor).trim() : `'${String(f.valor).replace(/'/g, "''")}'`;
    return `${expr} ${f.operador} ${valorSql}`;
  });
  const orderBy = s.ordem.map(o=>`${aliasDe(o.tabelaNomeReal)}.${aliasDe(o.campo)} ${o.direcao}`);
  let texto = `SELECT TOP 100\n  ${linhasSelect.join(',\n  ')}\nFROM ${aliasDe(s.tabelaPrincipal.nome)}`;
  if(joins.length) texto += '\n' + joins.join('\n');
  if(condicoes.length) texto += '\nWHERE ' + condicoes.join('\n  AND ');
  if(orderBy.length) texto += '\nORDER BY ' + orderBy.join(', ');
  texto += ';';
  document.getElementById('rmBdSqlPreview').textContent = texto;
  return texto;
}
function baixarSqlRm(){
  const sql = gerarSqlRm();
  if(!sql){ toast('Escolha uma tabela principal primeiro'); return; }
  const blob = new Blob([sql], { type: 'text/plain;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = `consulta_rm_${(rmBuilder.tabelaPrincipal.nome||'consulta').toLowerCase()}.sql`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
}
document.addEventListener('DOMContentLoaded', ()=>{
  document.getElementById('rm_bd_busca_tabela_principal').addEventListener('input', e=>renderRmBdResultadosTabelaPrincipal(e.target.value));
  document.getElementById('rm_bd_busca_campos_principal').addEventListener('input', e=>filtrarPorBuscaRm('rmBdCamposPrincipal', e.target.value, '.rm-campo-row'));
  document.getElementById('rm_bd_busca_relacionadas').addEventListener('input', e=>filtrarTabelasRelacionadasRm(e.target.value));
  document.getElementById('rm_bd_filtro_operador').addEventListener('change', atualizarRmBdFiltroValorVisibilidade);
  document.getElementById('btnRmBdAdicionarFiltro').addEventListener('click', adicionarRmBdFiltro);
  document.getElementById('rm_bd_ordem_add').addEventListener('change', adicionarRmBdOrdem);
  document.getElementById('rmBdSecoesRelacionadas').addEventListener('input', tratarEdicaoJoinRm);
  document.getElementById('rmBdSecoesRelacionadas').addEventListener('change', tratarEdicaoJoinRm);
  document.getElementById('btnRmBdBaixarSql').addEventListener('click', baixarSqlRm);
  iniciarGeradorSqlRm();
});
