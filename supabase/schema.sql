-- =========================================================
-- Controle de Atendimentos — schema Postgres (Supabase)
-- =========================================================
-- Como usar:
-- 1. Crie um projeto em https://supabase.com (gratuito, sem cartão).
-- 2. No painel do projeto, vá em "SQL Editor" → "New query".
-- 3. Cole TODO este arquivo e clique em "Run".
--
-- Isso cria todas as tabelas e já deixa o RLS (Row Level Security) ligado
-- SEM nenhuma política de acesso — ou seja, ninguém consegue ler/gravar
-- essas tabelas direto (nem com a chave pública "anon"). Só a Edge Function
-- (que usa a chave "service_role", secreta) consegue. Isso é proposital:
-- toda a lógica de permissão (quem vê o quê) fica centralizada no código da
-- Edge Function, do mesmo jeito que já era no Code.gs — o banco em si nunca
-- é acessado diretamente pelo site.

create table if not exists contas (
  id text primary key,
  nome text not null,
  login text not null unique,
  senha text not null,
  perfil text not null check (perfil in ('ADMIN','ATENDENTE','USUARIO')),
  cliente_id text,
  email text,
  telefone text
);

create table if not exists clientes (
  id text primary key,
  nome text not null
);
-- CNPJ e Nome Fantasia — usados pra casar automaticamente o cliente
-- cadastrado com o tomador de uma nota fiscal importada (por CNPJ)
alter table clientes add column if not exists cnpj text;
alter table clientes add column if not exists nome_fantasia text;

create table if not exists tipos (
  id text primary key,
  nome text not null
);

create table if not exists modulos (
  id text primary key,
  nome text not null
);

create table if not exists submodulos (
  id text primary key,
  nome text not null
);

create table if not exists status_list (
  id text primary key,
  nome text not null
);
-- ordem de exibição nos filtros e no quadro Kanban (Cards) — menor primeiro
alter table status_list add column if not exists ordem integer not null default 0;

create table if not exists valores (
  id text primary key,
  atendente_id text,
  cliente_id text,
  tipo_id text,
  real numeric not null default 0,
  ananda numeric not null default 0
);

create table if not exists atendimentos (
  id text primary key,
  data text not null,        -- yyyy-MM-dd (texto — sem risco de conversão automática, diferente do Sheets)
  mes text not null,         -- MM/yyyy
  cliente text not null,
  usuario text not null,
  tipo text not null,
  modulo text default '',
  submodulo text default '',
  atendente text default '',
  detalhe text default '',
  hi text default '00:00',
  inter text default '00:00',
  hf text default '00:00',
  qtd numeric default 0,
  vha numeric default 0,
  total_ananda numeric default 0,
  vhr numeric default 0,
  total_real numeric default 0,
  status text not null default 'PENDENTE',
  anexo_url text default '',
  anexo_nome text default '',
  solucao text default '',
  criado_em timestamptz default now()
);

create table if not exists mensagens (
  id text primary key,
  atendimento_id text not null,
  autor_nome text not null,
  autor_perfil text not null,
  texto text not null,
  data_hora timestamptz default now()
);

create table if not exists historico (
  id text primary key,
  atendimento_id text not null,
  descricao text not null,
  data_hora timestamptz default now()
);

-- migração segura pra quem já tinha a tabela criada antes da coluna "solucao"
-- existir — "add column if not exists" não faz nada se a coluna já existe,
-- então rodar este arquivo de novo (mesmo em produção) não tem risco.
alter table atendimentos add column if not exists solucao text default '';

-- remove linhas duplicadas em "valores" (mesma combinação atendente+cliente+
-- tipo aparecendo mais de uma vez — causa real de valores gravando R$0,00 ao
-- salvar um atendimento, porque a busca esperava encontrar exatamente 1
-- resultado e quebrava silenciosamente ao achar 2). Mantém uma linha por
-- combinação, apaga as demais. Seguro rodar de novo — não faz nada se não
-- houver duplicatas.
delete from valores a using valores b
where a.ctid < b.ctid
  and a.atendente_id is not distinct from b.atendente_id
  and a.cliente_id is not distinct from b.cliente_id
  and a.tipo_id is not distinct from b.tipo_id;

-- trava pra essa duplicação nunca mais poder acontecer, nem por clique duplo
-- no botão de salvar nem por nenhum outro motivo
alter table valores drop constraint if exists valores_unico;
alter table valores add constraint valores_unico unique (atendente_id, cliente_id, tipo_id);

-- taxa paga a QUEM AJUDAR como segundo atendente nessa mesma combinação
-- de atendente principal + cliente + tipo (não é uma taxa própria de um
-- atendente específico atuando como segundo — é "quanto se paga o
-- ajudante" nesse contexto). Antes o segundo atendente ganhava o mesmo
-- "Valor Atendente/h" do principal; agora cada linha carrega os três
-- valores lado a lado: real (cliente), ananda (principal) e este aqui.
alter table valores add column if not exists valor_segundo_atend numeric not null default 0;

-- múltiplos anexos por atendimento (antes só cabia um, guardado em
-- atendimentos.anexo_url/anexo_nome — essas duas colunas continuam
-- existindo por compatibilidade, mas os anexos novos vão pra cá)
create table if not exists anexos (
  id text primary key,
  atendimento_id text not null,
  nome text not null,
  url text not null,
  criado_em timestamptz default now()
);
alter table anexos enable row level security;
create index if not exists idx_anexos_atendimento on anexos (atendimento_id);
-- quando o anexo pertence a uma movimentação específica (não ao
-- atendimento como um todo), guarda o vínculo aqui
alter table anexos add column if not exists movimentacao_id text;

-- movimentações — substitui a "Conversa" simples (tabela mensagens,
-- que continua existindo no banco por segurança, só não é mais usada):
-- texto em formato rico (igual ao Detalhe), pode ter anexo de arquivo
-- de verdade, pode ser resposta a outra movimentação, e o
-- atendente/admin pode registrar um período de "tempo de trabalho"
create table if not exists movimentacoes (
  id text primary key,
  atendimento_id text not null,
  autor_nome text not null,
  autor_perfil text not null,
  texto text not null,
  tempo_inicio text,
  tempo_fim text,
  respondendo_a text,
  criado_em timestamptz default now()
);
alter table movimentacoes enable row level security;
create index if not exists idx_movimentacoes_atendimento on movimentacoes (atendimento_id);

-- migra o anexo único que já existia em cada atendimento pra essa tabela
-- nova (idempotente — não duplica se você rodar de novo)
insert into anexos (id, atendimento_id, nome, url)
select 'id-' || substr(md5(random()::text || atendimentos.id), 1, 10), atendimentos.id, atendimentos.anexo_nome, atendimentos.anexo_url
from atendimentos
where atendimentos.anexo_url is not null and atendimentos.anexo_url <> ''
  and not exists (
    select 1 from anexos a2 where a2.atendimento_id = atendimentos.id and a2.url = atendimentos.anexo_url
  );

-- índices úteis para os filtros mais comuns
create index if not exists idx_atendimentos_mes on atendimentos (mes);
create index if not exists idx_atendimentos_usuario on atendimentos (usuario);

-- Data Final (Prevista) — texto, mesmo padrão das outras datas desse
-- sistema (evita o Postgres tentar converter sozinho)
alter table atendimentos add column if not exists data_prevista text default '';

-- Vínculo entre chamados — cada linha é uma ligação entre dois
-- atendimentos (não importa qual é "pai" e qual é "filho", a ligação vale
-- pros dois lados). Um atendimento pode ter QUANTOS vínculos forem
-- necessários, cada um numa linha própria, então adicionar um novo nunca
-- substitui os que já existiam. As horas de todos os vinculados aparecem
-- somadas na tela do chamado (calculado na hora, não fica gravado em
-- lugar nenhum).
create table if not exists vinculos (
  id text primary key,
  atendimento_a text not null,
  atendimento_b text not null,
  criado_em timestamptz default now()
);
alter table vinculos enable row level security;
create index if not exists idx_vinculos_a on vinculos (atendimento_a);
create index if not exists idx_vinculos_b on vinculos (atendimento_b);

-- migra o vínculo único que existia antes (coluna vinculado_a) pra essa
-- tabela nova — idempotente, não duplica se rodar de novo
insert into vinculos (id, atendimento_a, atendimento_b)
select 'id-' || substr(md5(random()::text || atendimentos.id), 1, 10), atendimentos.id, atendimentos.vinculado_a
from atendimentos
where atendimentos.vinculado_a is not null and atendimentos.vinculado_a <> ''
  and not exists (
    select 1 from vinculos v
    where (v.atendimento_a = atendimentos.id and v.atendimento_b = atendimentos.vinculado_a)
       or (v.atendimento_b = atendimentos.id and v.atendimento_a = atendimentos.vinculado_a)
  );

create index if not exists idx_atendimentos_atendente on atendimentos (atendente);
create index if not exists idx_mensagens_atendimento on mensagens (atendimento_id);
create index if not exists idx_historico_atendimento on historico (atendimento_id);

-- "administrador do cliente": usuário solicitante com essa marcação vê
-- TODOS os atendimentos do cliente ao qual pertence, não só os próprios
alter table contas add column if not exists admin_cliente boolean default false;

-- atendente marcado como "administrador" passa a ter os mesmos privilégios
-- de um ADMIN (cadastros, financeiro, relatórios, ver valor cobrado do
-- cliente, gerenciar vídeos, etc.), sem deixar de aparecer como atendente
-- nos chamados. Não se aplica a USUARIO (que já tem o admin_cliente acima).
alter table contas add column if not exists eh_administrador boolean default false;

-- inscrições de notificação push (uma por navegador/aparelho que ativou);
-- uma conta pode ter várias, se usar o app em mais de um aparelho
create table if not exists push_inscricoes (
  id text primary key,
  conta_id text not null,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  criado_em timestamptz default now()
);
alter table push_inscricoes enable row level security;
create index if not exists idx_push_conta on push_inscricoes (conta_id);

-- tokens de notificação nativa (FCM) do app Android — mesma ideia da tabela
-- acima, mas pro app empacotado (Capacitor), que usa Firebase em vez do
-- PushManager do navegador
create table if not exists push_fcm_tokens (
  id text primary key,
  conta_id text not null,
  token text not null unique,
  criado_em timestamptz default now()
);
alter table push_fcm_tokens enable row level security;
create index if not exists idx_push_fcm_conta on push_fcm_tokens (conta_id);

-- segundo atendente (opcional) — quando mais de uma pessoa trabalha no
-- mesmo chamado, registra as horas dela à parte e calcula o quanto ela
-- ganha, do mesmo jeito que já é feito pro atendente principal (vha/
-- total_ananda). Não afeta o valor cobrado do cliente (vhr/total_real
-- continuam baseados só no atendente principal).
alter table atendimentos add column if not exists atendente2 text default '';
alter table atendimentos add column if not exists horas_atendente2 numeric default 0;
alter table atendimentos add column if not exists vha2 numeric default 0;
alter table atendimentos add column if not exists total_ananda2 numeric default 0;

-- relatórios personalizados que o admin monta, salva e publica — quem
-- pode ver cada um é controlado por "visivel_perfis" (lista de perfis:
-- ADMIN/ATENDENTE/USUARIO). "config" guarda tudo que define o relatório
-- (colunas na ordem escolhida, agrupamento, tipo de visualização, filtros
-- padrão) — assim não precisa de uma coluna pra cada detalhe.
create table if not exists relatorios_salvos (
  id text primary key,
  nome text not null,
  config jsonb not null,
  visivel_perfis jsonb not null default '["ADMIN"]',
  publicado boolean not null default false,
  criado_por text,
  criado_em timestamptz default now(),
  atualizado_em timestamptz default now()
);
alter table relatorios_salvos enable row level security;

-- lançamentos financeiros (faturas/cobranças) — cada um representa o
-- valor a receber de um cliente num mês/ano, somado a partir do Total
-- Real dos atendimentos escolhidos. "atendimento_ids" guarda quais
-- atendimentos compõem esse valor, só pra referência/conferência —
-- não trava nada se um desses atendimentos for editado depois.
create table if not exists lancamentos_financeiros (
  id text primary key,
  cliente text not null,
  mes_referencia text not null,
  valor_total numeric not null default 0,
  atendimento_ids jsonb not null default '[]',
  data_vencimento text,
  data_baixa text,
  data_previsao_baixa text,
  numero_nota_fiscal text default '',
  status text not null default 'ABERTO' check (status in ('ABERTO','BAIXADO','CANCELADO')),
  historico text default '',
  criado_por text,
  criado_em timestamptz default now(),
  atualizado_em timestamptz default now()
);
alter table lancamentos_financeiros enable row level security;
create index if not exists idx_lancamentos_cliente on lancamentos_financeiros (cliente);
create index if not exists idx_lancamentos_mes on lancamentos_financeiros (mes_referencia);
create index if not exists idx_lancamentos_status on lancamentos_financeiros (status);

-- notas fiscais de serviço importadas via arquivo XML (emitidas fora do
-- sistema, ex: direto no portal da prefeitura) — guarda os dados extraídos
-- do XML e o XML original por completo, pra conferência futura
create table if not exists notas_fiscais_importadas (
  id text primary key,
  numero_nota text,
  codigo_verificacao text,
  data_emissao text,
  cliente text,
  cnpj_cpf_tomador text,
  valor_servicos numeric default 0,
  valor_iss numeric default 0,
  valor_liquido numeric default 0,
  discriminacao text default '',
  xml_original text,
  lancamento_gerado_id text,
  importado_por text,
  importado_em timestamptz default now()
);
alter table notas_fiscais_importadas enable row level security;
create index if not exists idx_notas_importadas_cliente on notas_fiscais_importadas (cliente);
-- quando o CNPJ do tomador bate com um cliente cadastrado, guarda o id
-- dele aqui — assim a nota fica de fato vinculada ao cadastro, não só
-- ao nome de texto que veio no XML
alter table notas_fiscais_importadas add column if not exists cliente_id text;

-- agenda / agendamentos (visitas, atendimentos com hora marcada)
create table if not exists agendamentos (
  id text primary key,
  titulo text not null,
  descricao text default '',
  cliente text,
  atendente text,
  data date not null,
  hora_inicio text not null,
  hora_fim text not null,
  criado_por text,
  criado_em timestamptz default now(),
  atualizado_em timestamptz default now()
);
alter table agendamentos enable row level security;
-- cor escolhida manualmente pra esse agendamento (ex: "#D50000"); vazio
-- = cor automática (calculada a partir do atendente)
alter table agendamentos add column if not exists cor text;
create index if not exists idx_agendamentos_data on agendamentos (data);
create index if not exists idx_agendamentos_atendente on agendamentos (atendente);
create index if not exists idx_agendamentos_cliente on agendamentos (cliente);

-- vídeos/tutoriais (aba visível pra todo mundo, só o admin cadastra) —
-- cada vídeo pode ser geral (cliente vazio = "Todos") ou de um cliente
-- específico, marcado com um módulo pra organizar, e liberado só pra
-- atendente e/ou usuário (admin sempre vê tudo, pra gerenciar)
create table if not exists videos_tutoriais (
  id text primary key,
  titulo text not null,
  descricao text default '',
  url_youtube text not null,
  cliente text,
  modulo text,
  visivel_perfis jsonb not null default '["ATENDENTE","USUARIO"]',
  ordem integer default 0,
  criado_por text,
  criado_em timestamptz default now()
);
alter table videos_tutoriais enable row level security;
create index if not exists idx_videos_ordem on videos_tutoriais (ordem);
create index if not exists idx_videos_cliente on videos_tutoriais (cliente);

-- Perfis de acesso: templates de permissão configuráveis pelo admin, com
-- flags de Visualizar/Editar/Excluir/Inserir por menu do sistema. Um
-- perfil pode ser vinculado a quantas contas (atendente/usuário) fizer
-- sentido (conta_perfis_acesso, N:N). Uma conta ADMIN (ou atendente
-- marcado como administrador) sempre tem acesso total, independente de
-- qualquer perfil vinculado. Uma conta sem NENHUM perfil vinculado
-- continua com o comportamento padrão de hoje (baseado só no perfil
-- ATENDENTE/USUARIO) — isso é o que garante que contas já existentes
-- continuem funcionando sem precisar configurar nada.
create table if not exists perfis_acesso (
  id text primary key,
  nome text not null,
  criado_em timestamptz default now()
);
alter table perfis_acesso enable row level security;

-- um menu válido por linha: atendimentos, resumo, dashboard, cronograma,
-- construtor_relatorios, relatorios, financeiro, agenda, videos, cadastros,
-- utilitarios
create table if not exists perfil_acesso_permissoes (
  id text primary key,
  perfil_id text not null references perfis_acesso(id) on delete cascade,
  menu text not null,
  visualizar boolean not null default false,
  editar boolean not null default false,
  excluir boolean not null default false,
  inserir boolean not null default false
);
alter table perfil_acesso_permissoes enable row level security;
alter table perfil_acesso_permissoes drop constraint if exists perfil_acesso_permissoes_unico;
alter table perfil_acesso_permissoes add constraint perfil_acesso_permissoes_unico unique (perfil_id, menu);
create index if not exists idx_perfil_permissoes_perfil on perfil_acesso_permissoes (perfil_id);

create table if not exists conta_perfis_acesso (
  id text primary key,
  conta_id text not null references contas(id) on delete cascade,
  perfil_id text not null references perfis_acesso(id) on delete cascade
);
alter table conta_perfis_acesso enable row level security;
alter table conta_perfis_acesso drop constraint if exists conta_perfis_acesso_unico;
alter table conta_perfis_acesso add constraint conta_perfis_acesso_unico unique (conta_id, perfil_id);
create index if not exists idx_conta_perfis_conta on conta_perfis_acesso (conta_id);
create index if not exists idx_conta_perfis_perfil on conta_perfis_acesso (perfil_id);

-- comentários dos vídeos/tutoriais — qualquer um que veja o vídeo pode
-- comentar; só o autor do comentário ou o admin pode apagar
create table if not exists video_comentarios (
  id text primary key,
  video_id text not null,
  autor_nome text not null,
  autor_perfil text not null,
  texto text not null,
  criado_em timestamptz default now()
);
alter table video_comentarios enable row level security;
create index if not exists idx_video_comentarios_video on video_comentarios (video_id);

-- vincula um atendimento a um ou mais vídeos/tutoriais (ex: o atendente
-- indica qual vídeo explica a solução aplicada) — N:N, cada linha é um
-- vínculo independente, um atendimento pode ter quantos vídeos precisar
create table if not exists atendimento_videos (
  id text primary key,
  atendimento_id text not null,
  video_id text not null,
  criado_em timestamptz default now()
);
alter table atendimento_videos enable row level security;
create index if not exists idx_atendimento_videos_atendimento on atendimento_videos (atendimento_id);
create index if not exists idx_atendimento_videos_video on atendimento_videos (video_id);
alter table atendimento_videos drop constraint if exists atendimento_videos_unico;
alter table atendimento_videos add constraint atendimento_videos_unico unique (atendimento_id, video_id);

-- liga o RLS em todas as tabelas, sem criar nenhuma política — bloqueia
-- qualquer acesso direto (só a Edge Function, com a service_role key, passa)
alter table contas enable row level security;
alter table clientes enable row level security;
alter table tipos enable row level security;
alter table modulos enable row level security;
alter table submodulos enable row level security;
alter table status_list enable row level security;
alter table valores enable row level security;
alter table atendimentos enable row level security;
alter table mensagens enable row level security;
alter table historico enable row level security;

-- =========================================================
-- Dados iniciais (mesmos da versão anterior — admin/admin123 etc.)
-- Rode esta parte só se as tabelas estiverem vazias (é seguro rodar de
-- novo: os comandos abaixo não duplicam se você já rodou uma vez, graças
-- ao "on conflict do nothing").
-- =========================================================

insert into clientes (id, nome) values
  ('cli-fujicom', 'FUJICOM'),
  ('cli-tea', 'T&A'),
  ('cli-regina', 'REGINA')
on conflict (id) do nothing;

insert into tipos (id, nome) values
  ('tp-online', 'ATENDIMENTO ONLINE'),
  ('tp-visita', 'VISITA TECNICA')
on conflict (id) do nothing;

insert into modulos (id, nome) values
  ('md-nucleus', 'RM Nucleus'),
  ('md-fluxus', 'RM Fluxus'),
  ('md-saldus', 'RM Saldus'),
  ('md-liber', 'RM Liber')
on conflict (id) do nothing;

insert into submodulos (id, nome) values
  ('sm-reports', 'RM Reports'),
  ('sm-net', 'Planilha NET'),
  ('sm-bd', 'Banco de Dados'),
  ('sm-suporte', 'Suporte')
on conflict (id) do nothing;

insert into status_list (id, nome) values
  ('st-pendente', 'PENDENTE'),
  ('st-agendado', 'AGENDADO'),
  ('st-validado', 'VALIDADO'),
  ('st-naovalidado', 'NÃO VALIDADO'),
  ('st-andamento', 'EM ANDAMENTO'),
  ('st-emvalidacao', 'EM VALIDAÇÃO'),
  ('st-cancelado', 'CANCELADO')
on conflict (id) do nothing;

-- ordem padrão pedida: PENDENTE, AGENDADO, EM ANDAMENTO, EM VALIDAÇÃO,
-- NÃO VALIDADO, VALIDADO, CANCELADO — roda de novo sem problema, é só um
-- valor inicial; a partir daqui dá pra reordenar pela tela de Cadastros
update status_list set ordem = 1 where id = 'st-pendente' and ordem = 0;
update status_list set ordem = 2 where id = 'st-agendado' and ordem = 0;
update status_list set ordem = 3 where id = 'st-andamento' and ordem = 0;
update status_list set ordem = 4 where id = 'st-emvalidacao' and ordem = 0;
update status_list set ordem = 5 where id = 'st-naovalidado' and ordem = 0;
update status_list set ordem = 6 where id = 'st-validado' and ordem = 0;
update status_list set ordem = 7 where id = 'st-cancelado' and ordem = 0;

insert into contas (id, nome, login, senha, perfil, cliente_id) values
  ('c-admin', 'Administrador', 'admin', 'admin123', 'ADMIN', null),
  ('c-allan', 'ALLAN', 'allan', '123456', 'ATENDENTE', null),
  ('c-ananda', 'ANANDA', 'ananda', '123456', 'ATENDENTE', null)
on conflict (id) do nothing;

insert into contas (id, nome, login, senha, perfil, cliente_id) values
  ('c-rayane', 'RAYANE', 'rayane', '123456', 'USUARIO', 'cli-fujicom'),
  ('c-luciano', 'LUCIANO', 'luciano', '123456', 'USUARIO', 'cli-fujicom'),
  ('c-guilherme', 'GUILHERME', 'guilherme', '123456', 'USUARIO', 'cli-fujicom'),
  ('c-francilene', 'FRANCILENE', 'francilene', '123456', 'USUARIO', 'cli-fujicom'),
  ('c-vanessa', 'VANESSA', 'vanessa', '123456', 'USUARIO', 'cli-fujicom'),
  ('c-mikael', 'MIKAEL', 'mikael', '123456', 'USUARIO', 'cli-fujicom'),
  ('c-sandro', 'SANDRO', 'sandro', '123456', 'USUARIO', 'cli-fujicom'),
  ('c-geral', 'GERAL', 'geral', '123456', 'USUARIO', 'cli-fujicom'),
  ('c-francisco', 'FRANCISCO', 'francisco', '123456', 'USUARIO', 'cli-tea'),
  ('c-junior', 'JUNIOR', 'junior', '123456', 'USUARIO', 'cli-tea'),
  ('c-vitoria', 'VITORIA', 'vitoria', '123456', 'USUARIO', 'cli-regina')
on conflict (id) do nothing;

insert into valores (id, atendente_id, cliente_id, tipo_id, real, ananda) values
  ('v-allan-fuj-on', 'c-allan', 'cli-fujicom', 'tp-online', 75, 30),
  ('v-allan-fuj-vi', 'c-allan', 'cli-fujicom', 'tp-visita', 90, 10),
  ('v-allan-tea-on', 'c-allan', 'cli-tea', 'tp-online', 80, 35),
  ('v-allan-tea-vi', 'c-allan', 'cli-tea', 'tp-visita', 90, 10),
  ('v-allan-reg-on', 'c-allan', 'cli-regina', 'tp-online', 85, 30),
  ('v-allan-reg-vi', 'c-allan', 'cli-regina', 'tp-visita', 85, 10),
  ('v-ananda-fuj-on', 'c-ananda', 'cli-fujicom', 'tp-online', 75, 30),
  ('v-ananda-fuj-vi', 'c-ananda', 'cli-fujicom', 'tp-visita', 90, 10),
  ('v-ananda-tea-on', 'c-ananda', 'cli-tea', 'tp-online', 80, 35),
  ('v-ananda-tea-vi', 'c-ananda', 'cli-tea', 'tp-visita', 90, 10),
  ('v-ananda-reg-on', 'c-ananda', 'cli-regina', 'tp-online', 85, 30),
  ('v-ananda-reg-vi', 'c-ananda', 'cli-regina', 'tp-visita', 85, 10)
on conflict (id) do nothing;

-- =========================================================
-- Empresas (multi-empresa) — cada Cliente/Atendimento/Valor passa a
-- pertencer a uma Empresa. Um admin/atendente pode estar vinculado a
-- quantas empresas fizer sentido (conta_empresas, N:N, mesmo padrão de
-- conta_perfis_acesso) e escolhe qual usar a cada login — só faz sentido
-- pra ADMIN/ATENDENTE; uma conta USUARIO fica na empresa do próprio
-- cliente dela (clientes.empresa_id), sem precisar escolher nada. Uma
-- conta ADMIN "de verdade" (perfil = ADMIN) sempre enxerga todas as
-- empresas, vinculada ou não — é o mesmo bypass que ela já tem em
-- qualquer outra permissão do sistema.
create table if not exists empresas (
  id text primary key,
  nome text not null,
  nome_fantasia text default '',
  cnpj text default '',
  endereco text default '',
  telefone text default '',
  email text default '',
  cnae text default '',
  inscricao_municipal text default '',
  inscricao_estadual text default '',
  logo_url text default '',
  -- empresa exibida na tela de login antes de autenticar (marca do próprio
  -- sistema) — só uma pode ser a padrão; a app garante isso ao salvar
  padrao boolean not null default false,
  criado_em timestamptz default now()
);
alter table empresas enable row level security;

create table if not exists conta_empresas (
  id text primary key,
  conta_id text not null references contas(id) on delete cascade,
  empresa_id text not null references empresas(id) on delete cascade
);
alter table conta_empresas enable row level security;
alter table conta_empresas drop constraint if exists conta_empresas_unico;
alter table conta_empresas add constraint conta_empresas_unico unique (conta_id, empresa_id);

alter table clientes add column if not exists empresa_id text references empresas(id);
alter table atendimentos add column if not exists empresa_id text references empresas(id);
alter table valores add column if not exists empresa_id text references empresas(id);
create index if not exists idx_clientes_empresa on clientes (empresa_id);
create index if not exists idx_atendimentos_empresa on atendimentos (empresa_id);
create index if not exists idx_valores_empresa on valores (empresa_id);

-- dados reais da T&A (a primeira empresa do sistema) — nome_fantasia fica
-- em branco porque o CNPJ foi informado no lugar dela; ajuste pela tela de
-- Cadastros → Empresas se quiser preencher com o nome fantasia de verdade
insert into empresas (id, nome, nome_fantasia, cnpj, endereco, telefone, email, cnae, inscricao_municipal, inscricao_estadual, padrao)
values ('emp-ta', 'T & A TECNOLOGIA LTDA', '', '42.998.481/0001-16', 'TV MARROCOS, 309, CASA 2, LAGOA REDONDA', '85 97175328', 'teaconsultoriati@gmail.com', '080201', '6668755', '', true)
on conflict (id) do nothing;

-- tudo que já existia (banco novo ou já em produção) fica na T&A —
-- idempotente: só toca quem ainda não tinha empresa nenhuma
update clientes set empresa_id = 'emp-ta' where empresa_id is null;
update atendimentos set empresa_id = 'emp-ta' where empresa_id is null;
update valores set empresa_id = 'emp-ta' where empresa_id is null;

-- todo ADMIN/ATENDENTE que já existia fica vinculado à T&A por padrão —
-- pela tela de Cadastros → Atendentes dá pra vincular a outras empresas
-- (ou tirar essa) depois que existir mais de uma
insert into conta_empresas (id, conta_id, empresa_id)
select 'ce-' || contas.id, contas.id, 'emp-ta' from contas
where contas.perfil in ('ADMIN', 'ATENDENTE')
on conflict (conta_id, empresa_id) do nothing;

-- =========================================================
-- Integração TomTicket — quando um técnico é associado a um chamado lá,
-- a function tomticket-webhook (separada da "api") cria um atendimento
-- aqui automaticamente. tomticket_id guarda o id do chamado de origem,
-- só pra nunca importar o mesmo chamado duas vezes.
alter table atendimentos add column if not exists tomticket_id text;
create unique index if not exists idx_atendimentos_tomticket_id
  on atendimentos (tomticket_id) where tomticket_id is not null;

-- fila de "não deu pra importar" — cliente ou atendente do chamado não
-- bateu com ninguém já cadastrado aqui; fica registrado pra alguém
-- revisar manualmente (ver Utilitários → TomTicket)
create table if not exists tomticket_erros (
  id text primary key,
  ticket_id text not null,
  motivo text not null,
  payload jsonb,
  criado_em timestamptz default now()
);
alter table tomticket_erros enable row level security;
