# Controle de Atendimentos — versão Supabase (Postgres)

Essa versão troca a planilha Google por um banco Postgres de verdade
(Supabase), mantendo a mesma arquitetura de antes: o site (estático, no
GitHub Pages) fala com uma função de backend (agora chamada "Edge
Function", equivalente ao antigo `Code.gs`), que é quem realmente lê e
grava no banco. O banco nunca é acessado direto pelo site.

**Ganho principal:** elimina de vez os bugs de conversão automática de
data/hora que davam trabalho no Google Sheets (data em branco ao editar,
mês de referência errado, status "undefined", etc.) — um banco de verdade
não "adivinha" o tipo do dado que você grava.

## Passo 1 — criar o projeto Supabase

1. Crie uma conta em [supabase.com](https://supabase.com) (gratuito, sem
   cartão de crédito).
2. "New Project" → escolha um nome, uma senha de banco (guarde essa senha
   em lugar seguro, mas você não vai precisar dela no dia a dia) e a região
   mais próxima (ex: South America).
3. Espere uns 2 minutos o projeto terminar de provisionar.

## Passo 2 — criar as tabelas

1. No painel do projeto, menu lateral → **SQL Editor** → **New query**.
2. Abra o arquivo `supabase/schema.sql` (nesta pasta), copie tudo, cole no
   editor, e clique em **Run**.
3. Isso cria todas as tabelas, já populadas com os dados de exemplo (login
   `admin` / `admin123`, clientes FUJICOM/T&A/REGINA, etc. — os mesmos da
   versão anterior).

## Passo 3 — criar o bucket de anexos

1. Menu lateral → **Storage** → **New bucket**.
2. Nome: `anexos`. Marque **Public bucket** (assim os links de anexo
   funcionam sem login extra). Criar.

## Passo 4 — instalar a CLI do Supabase e implantar a Edge Function

A forma mais simples é pelo terminal do seu computador (precisa ter
[Node.js](https://nodejs.org) instalado):

```bash
npm install -g supabase
supabase login
supabase link --project-ref SEU-PROJECT-REF
```

(`SEU-PROJECT-REF` está na URL do painel do projeto, algo como
`abcdefghijklmnop` — ou em Project Settings → General.)

Depois, de dentro da pasta deste projeto (onde está a pasta `supabase/`):

```bash
supabase functions deploy api --no-verify-jwt
```

Isso publica a função. A URL dela vai ser:
`https://SEU-PROJECT-REF.supabase.co/functions/v1/api`

**Alternativa sem terminal:** o painel do Supabase também permite criar e
colar o código de uma Edge Function direto pelo navegador, em **Edge
Functions** → **Deploy a new function**. Cole o conteúdo de
`supabase/functions/api/index.ts`.

## Passo 5 — pegar as chaves e configurar o app.js

1. No painel → **Project Settings** → **API Keys**. Copie a chave
   **anon public** (não a `service_role` — essa nunca deve ir pro site).
2. Abra `app.js` (pasta raiz deste projeto) e preencha no topo:
   ```js
   API_URL: 'https://SEU-PROJECT-REF.supabase.co/functions/v1/api',
   ANON_KEY: 'a-chave-anon-que-voce-copiou'
   ```

## Passo 6 (opcional) — e-mail automático de "chamado aberto"

O Supabase não tem um "enviar e-mail em meu nome" pronto como o Google
tinha. Pra manter essa funcionalidade, use o [Resend](https://resend.com)
(tem plano gratuito, 3.000 e-mails/mês, sem cartão):

1. Crie conta no Resend, gere uma **API Key**.
2. No terminal, dentro do projeto Supabase:
   ```bash
   supabase secrets set RESEND_API_KEY=sua-chave-do-resend
   ```
3. Sem verificar um domínio próprio no Resend, os e-mails saem de
   `onboarding@resend.dev` — funciona, mas pode cair em spam. Se quiser um
   remetente com seu domínio, verifique-o no Resend e defina:
   ```bash
   supabase secrets set RESEND_FROM=atendimento@seudominio.com.br
   ```
4. Sem configurar isso, o app funciona normalmente — só não manda e-mail.

## Passo 7 (opcional) — notificações push

Sem configurar nada disso o app funciona normalmente — só não manda avisos
quando abre um chamado, muda o status ou chega mensagem nova. Tem dois
canais independentes; pode ativar um, os dois, ou nenhum.

### Web Push (navegador / PWA instalado)

Usado quando alguém clica em "🔔 Avisos" pelo navegador (Chrome/Edge no
computador ou celular, ou o site instalado como PWA).

1. Gere um par de chaves VAPID. O jeito mais fácil é rodar, com o Node
   instalado:
   ```bash
   npx web-push generate-vapid-keys
   ```
2. Cole a **chave pública** em `CONFIG.VAPID_PUBLIC_KEY`, no topo do
   `app.js`.
3. Configure as duas chaves como secrets da Edge Function:
   ```bash
   supabase secrets set VAPID_PUBLIC_KEY=sua-chave-publica
   supabase secrets set VAPID_PRIVATE_KEY=sua-chave-privada
   supabase secrets set VAPID_SUBJECT=mailto:seu-email@exemplo.com
   ```
4. Reimplante a função (`supabase functions deploy api`).

### Notificações nativas no app Android (FCM)

O app Android é uma casca Capacitor que abre o site publicado — Web Push
não é confiável dentro dela (sem um app rodando em segundo plano de verdade
não há garantia de entrega com o app fechado). Por isso o app usa o
Firebase Cloud Messaging (FCM) nativo, através do plugin
`@capacitor/push-notifications`, em paralelo ao Web Push acima.

1. Crie um projeto no [Firebase Console](https://console.firebase.google.com/)
   (pode ser gratuito, plano Spark).
2. Adicione um app Android ao projeto com o pacote
   **`com.teaatend.atendimentos`** (tem que ser exatamente esse, é o
   `applicationId` do `android/app/build.gradle`).
3. Baixe o arquivo `google-services.json` gerado e coloque em
   `android/app/google-services.json` (a build do Gradle já detecta esse
   arquivo sozinha e ativa o plugin do Google Services — sem ele, o app
   compila normalmente, só que sem push nativo).
4. No Firebase Console, vá em **Configurações do projeto → Contas de
   serviço** e clique em **Gerar nova chave privada** — isso baixa um JSON
   com a credencial da conta de serviço.
5. Configure esse JSON inteiro (o arquivo baixado, sem editar nada) como
   secret da Edge Function:
   ```bash
   supabase secrets set FCM_SERVICE_ACCOUNT_JSON="$(cat caminho/do/arquivo-baixado.json)"
   ```
6. Reimplante a função (`supabase functions deploy api`).
7. (Opcional, só se compilar o APK pelo GitHub Actions) cadastre o conteúdo
   do `google-services.json` como secret do repositório
   **`GOOGLE_SERVICES_JSON`** (Settings → Secrets and variables → Actions) —
   o workflow `.github/workflows/android-build.yml` escreve esse secret no
   arquivo automaticamente antes de compilar, se ele existir.
8. Rode `npm run cap:sync` e recompile o app (`npm run android:open` ou
   pelo GitHub Actions) pra levar o `google-services.json` pro APK.

Depois de configurado, o botão "🔔 Avisos" dentro do app Android pede a
permissão do sistema (Android 13+ exige isso explicitamente) e registra o
aparelho sozinho — não precisa mexer em mais nada no site.

## Passo 8 — publicar o site

Igual à versão anterior: suba `index.html`, `app.js`, `manifest.json`,
`sw.js` e a pasta `icons/` pro seu repositório GitHub (pode ser o mesmo
`controle-atendimentos` que você já tem — só substitua os arquivos).

## Login de exemplo

- Admin: `admin` / `admin123`
- Atendente: `allan` / `123456` ou `ananda` / `123456`
- Usuário solicitante: `rayane` / `123456` (FUJICOM), entre outros — veja
  o `supabase/schema.sql` pra lista completa.

## O que muda em relação à versão Google Sheets

- **Sem mais bugs de conversão de data.** As colunas de data/hora no
  Postgres são texto de verdade, sempre.
- **Sem mais "esqueci de publicar nova versão".** Quando você reimplanta a
  Edge Function (`supabase functions deploy api`), a URL já publicada
  passa a rodar o código novo na hora — não tem passo extra de "nova
  versão" como tinha no Apps Script.
- **Anexos** ficam no Supabase Storage em vez do Google Drive — mesmo
  comportamento pro usuário (upload no formulário, link "📎" na lista).
- **E-mail** precisa do Resend configurado (passo 6) — no Apps Script
  vinha "de graça" via `MailApp`.
- Toda a lógica de permissões (só admin vê valores, usuário não escolhe
  atendente, chamado sempre abre PENDENTE, etc.) continua igual, agora
  dentro da Edge Function em vez do `Code.gs`.

## Solução de problemas

- **"Configure a URL e a chave da API"** — falta preencher `API_URL` e/ou
  `ANON_KEY` no `app.js`.
- **Erro 401 / não autorizado** — confira se está mandando a chave
  **anon**, não a `service_role`, e se a função foi implantada com
  `--no-verify-jwt` (ou que a chave anon realmente corresponde ao projeto).
- **CORS bloqueado** — a Edge Function já responde com os cabeçalhos
  certos; se aparecer erro de CORS mesmo assim, confirme que a URL em
  `API_URL` está exatamente igual à da função implantada (sem barra
  sobrando no final, por exemplo).
- Pra ver logs de erro do backend: painel do Supabase → **Edge Functions**
  → clique na função → aba **Logs**.
- **Notificação não chega no navegador/PWA** — confira se `VAPID_PUBLIC_KEY`
  está preenchida no `app.js` e se as duas chaves VAPID foram configuradas
  como secrets da função (passo 7); veja os logs `[push]` na Edge Function.
- **Notificação não chega no app Android** — confira, nessa ordem: (1) se
  `android/app/google-services.json` existe e é do projeto Firebase certo
  (pacote `com.teaatend.atendimentos`); (2) se o secret
  `FCM_SERVICE_ACCOUNT_JSON` foi configurado na Edge Function; (3) se a
  pessoa concedeu a permissão de notificação pelo botão "🔔 Avisos" dentro
  do app; (4) os logs `[push-fcm]` na Edge Function.
