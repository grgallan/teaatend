// Copia os arquivos públicos (index.html, app.js, manifest.json, sw.js) daqui
// pro repositório ControlMov (https://github.com/grgallan/ControlMov),
// reaplicando as pequenas diferenças de marca/escopo desse app (só
// Movimentos fica visível) por cima — nunca sobrescreve essas diferenças
// com o conteúdo original do teaatend. Chamado pelo workflow
// ".github/workflows/sync-controlmov.yml", com os dois checkouts (teaatend
// e ControlMov) já prontos; não precisa rodar isso manualmente, mas pode:
//   node scripts/sync-controlmov.js <pasta-teaatend> <pasta-controlmov>
const fs = require('fs');
const path = require('path');

const origemDir = path.resolve(process.argv[2] || '.');
const destinoDir = path.resolve(process.argv[3] || '../controlmov');

function lerArquivo(dir, nome) {
  return fs.readFileSync(path.join(dir, nome), 'utf8');
}
function escreverArquivo(dir, nome, conteudo) {
  fs.writeFileSync(path.join(dir, nome), conteudo, 'utf8');
}

/* ---------- app.js: cópia direta, sem nenhuma diferença ---------- */
fs.copyFileSync(path.join(origemDir, 'app.js'), path.join(destinoDir, 'app.js'));

/* ---------- icons/: ícones do PWA (não o ícone/splash do app Android,
   esses ficam em assets/, próprios do ControlMov) ---------- */
fs.mkdirSync(path.join(destinoDir, 'icons'), { recursive: true });
for (const nome of fs.readdirSync(path.join(origemDir, 'icons'))) {
  fs.copyFileSync(path.join(origemDir, 'icons', nome), path.join(destinoDir, 'icons', nome));
}

/* ---------- index.html: título, marca do login e o bloco de
   override (só Movimentos visível) — tudo reaplicado por cima do
   HTML do teaatend, nunca perdido numa sincronização futura ---------- */
let html = lerArquivo(origemDir, 'index.html');

html = html.replace(/<title>[^<]*<\/title>/, '<title>ControlMov</title>');
html = html.replace(
  /(<div class="empresa" id="loginEmpresaNome">)[^<]*(<\/div>)/,
  '$1ControlMov$2',
);
html = html.replace(
  /(<div class="sistema">)[^<]*(<\/div>)/,
  '$1ControlMov$2',
);
html = html.replace(
  /(<div class="login-logo" id="loginLogoBox">[^<]*<\/div>\s*<h1>)[^<]*(<\/h1>)/,
  '$1ControlMov$2',
);

// bloco de override entre marcadores — qualquer versão anterior (de uma
// sincronização passada) é removida e trocada por essa, sempre a mais nova
const INICIO_OVERRIDE = '<!-- CONTROLMOV:OVERRIDE:START (gerado por scripts/sync-controlmov.js — não editar à mão) -->';
const FIM_OVERRIDE = '<!-- CONTROLMOV:OVERRIDE:END -->';
const blocoOverride = `${INICIO_OVERRIDE}
<script>
// ControlMov é o mesmo app/backend do Controle de Atendimentos, só que
// restrito a Movimentos (RM) — ao entrar no app, depois que entrarNoApp()
// já aplicou a visibilidade normal de menus (por perfil de acesso), esconde
// TUDO que não for Movimentos e já abre direto nessa tela. Não duplica nem
// reescreve nada do app.js original; só limita o que aparece por cima.
// Importante: isso é separação de PRODUTO/UI, não uma trava de segurança —
// os dados continuam protegidos pelas mesmas permissões já checadas no
// backend (podeAgir), independente do que esse app mostra ou esconde.
(function(){
  const entrarNoAppOriginal = window.entrarNoApp;
  window.entrarNoApp = function(){
    entrarNoAppOriginal.apply(this, arguments);
    document.querySelectorAll('[data-view]').forEach(el=>{
      el.style.display = el.dataset.view === 'movimentos' ? '' : 'none';
    });
    if(typeof atualizarGruposSidebarVisiveis === 'function') atualizarGruposSidebarVisiveis();
    goView('movimentos');
  };
})();
</script>
${FIM_OVERRIDE}`;

const marcadorRegex = new RegExp(
  `${INICIO_OVERRIDE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${FIM_OVERRIDE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
);
if (marcadorRegex.test(html)) {
  html = html.replace(marcadorRegex, blocoOverride);
} else {
  html = html.replace(/<\/body>/, `${blocoOverride}\n</body>`);
}

escreverArquivo(destinoDir, 'index.html', html);

/* ---------- sw.js: nome do cache e título padrão da notificação
   continuam próprios do ControlMov; o resto (lógica de verdade) vem
   igual do teaatend ---------- */
let sw = lerArquivo(origemDir, 'sw.js');
sw = sw.replace(/const CACHE = '[^']*';/, "const CACHE = 'controlmov-supabase-v1';");
sw = sw.replace(
  /const titulo = dados\.title \|\| '[^']*';/,
  "const titulo = dados.title || 'ControlMov';",
);
escreverArquivo(destinoDir, 'sw.js', sw);

/* ---------- manifest.json: mantém name/short_name/description do
   ControlMov, traz o resto (ícones, cores, orientação, etc.) do
   teaatend, caso mude ---------- */
const manifestOrigem = JSON.parse(lerArquivo(origemDir, 'manifest.json'));
const manifestDestinoPath = path.join(destinoDir, 'manifest.json');
const manifestDestinoAtual = fs.existsSync(manifestDestinoPath)
  ? JSON.parse(fs.readFileSync(manifestDestinoPath, 'utf8'))
  : {};
const manifestNovo = {
  ...manifestOrigem,
  name: manifestDestinoAtual.name || 'ControlMov',
  short_name: manifestDestinoAtual.short_name || 'ControlMov',
  description: manifestDestinoAtual.description || 'Gestão de Movimentações TOTVS RM',
};
escreverArquivo(destinoDir, 'manifest.json', JSON.stringify(manifestNovo, null, 2) + '\n');

console.log('ControlMov sincronizado a partir de', origemDir, 'para', destinoDir);
