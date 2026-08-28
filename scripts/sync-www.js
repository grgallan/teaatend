// Copia os arquivos estáticos do site (raiz do projeto) para www/, que é o
// webDir empacotado dentro do app Android pelo Capacitor. Isso NÃO inclui a
// pasta supabase/ (código de backend) — só o que já é servido publicamente
// pelo GitHub Pages hoje. Rodar antes de "npx cap sync android"
// (já embutido em "npm run cap:sync").
const fs = require('fs');
const path = require('path');

const raiz = path.join(__dirname, '..');
const destino = path.join(raiz, 'www');

const arquivos = ['index.html', 'app.js', 'manifest.json', 'sw.js'];
const pastas = ['icons'];

fs.rmSync(destino, { recursive: true, force: true });
fs.mkdirSync(destino, { recursive: true });

for (const nome of arquivos) {
  const origem = path.join(raiz, nome);
  if (fs.existsSync(origem)) fs.copyFileSync(origem, path.join(destino, nome));
}
for (const pasta of pastas) {
  const origem = path.join(raiz, pasta);
  if (fs.existsSync(origem)) fs.cpSync(origem, path.join(destino, pasta), { recursive: true });
}

console.log('www/ atualizado a partir da raiz do projeto.');
