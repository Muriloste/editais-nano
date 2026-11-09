# Monitor de editais · Nano TI

Página que consulta o PNCP ao vivo e lista editais abertos para a Nano:
Sophos (por linha de produto), backup/Acronis e Microsoft no Brasil todo, e suporte de TI até 150/200 km de Leme.
Marcações de interesse e descarte (com motivo) ficam num banco D1 e alimentam uma pontuação que aprende com as escolhas.

- Publicado em: https://editais-nano.nano-portal.workers.dev
- Cada push na branch `main` publica automaticamente (Cloudflare Workers Builds).

## Estrutura
- `src/parts/head.html` — HTML e CSS da página.
- `src/parts/regras.js` — termos de busca e regras de relevância por frente (Sophos por linha, backup, Microsoft, suporte).
- `src/parts/app.js` — busca no PNCP, conferência de itens, marcações, aprendizado e tela.
- `src/mun_br.json` — distância em km de Leme/SP para cada município (código IBGE).
- `src/worker.js` — Worker: serve `public/` e a API de marcações no D1.
- `build.mjs` — monta `public/index.html` (`node build.mjs`). Rode antes de cada commit.
- `wrangler.jsonc` — Worker `editais-nano`, assets em `public/`, banco D1 `editais-nano` (binding `DB`, criado no primeiro deploy).

## API
- `GET /api/marcas` — marcações atuais (id do PNCP, `interesse`/`descartado`, motivo, observação, cópia do edital).
- `PUT /api/marcas/:id` — grava `{acao, motivo, obs, frentes, snap}`.
- `DELETE /api/marcas/:id` — remove a marcação (fica no histórico como `removido`).
- `GET /api/historico` — todas as decisões, em ordem, para revisar as buscas.
- `GET /api/analises` · `GET|POST|PUT|DELETE /api/analises/:id` — fila de pré-análise (`pendente` → `processando` → `pronta` | `erro`), com resultado em markdown e resumo.
- `GET /api/participacoes` · `GET|PUT|DELETE /api/participacoes/:id` — pipeline (`participar` → `proposta` → `ganhamos` | `perdemos` | `desistimos`).
  `PUT` recebe `{etapa, snap, obs, arquivar}`; a primeira entrada em `participar` pede a pasta (`pasta_status = pendente`).
- `POST /api/participacoes/:id/pasta` — pede a pasta/checklist de novo; `PUT .../pasta` — a rodada grava `{pasta_status, pasta_url, pasta_id, checklist_url, resumo, erro}`.
- `PUT /api/participacoes/:id/arquivo` — a rodada informa `{status: feito|erro, pasta_url}` depois de mover a pasta para ARQUIVADOS.
- `GET|PUT /api/docs-mestre` — nomes dos arquivos da pasta-mestre (`{nomes, pasta_url}`), gravados pela rodada com `nanoAnalise.documentos(nomes)`; a página lê `(val …)`/`(emitida …)` e mostra o aviso de certidões.
- `GET /api/pncp-proxy/...` — proxy só de leitura do PNCP (itens, dados da compra, arquivos e download de PDF/ZIP sem CORS).
  Cache no D1 (`cache_pncp`): itens 12 h, dados da compra 6 h, lista de arquivos 1 h; cópia vencida (até 7 dias) é servida
  quando o PNCP limita (429) ou cai (5xx). Ao receber 429 a API daquela família pausa 5 min (5xx/timeout: 2 min) — header `x-pncp-pausa`.
  Downloads de documentos não são guardados.

## Limites do PNCP
- A busca (`/api/search`) vai direto do navegador; itens e dados da compra passam pelo servidor (cache compartilhado entre aparelhos)
  e os dados da compra ficam 6 h no aparelho. Uma abertura repetida não consulta o PNCP de novo.
- Se o PNCP responder 429/5xx, a tela para de consultar, mostra "O PNCP pediu uma pausa… retomo às HH:MM" e retoma sozinha.
- Rodando análises em paralelo fora da rodada agendada: no máximo 3 ao mesmo tempo.

## Pré-análise
O botão "🔍 Pedir pré-análise" no card coloca o edital na fila. A rodada agendada no Claude (dias úteis, 7h06 e 13h06, até 5 por rodada)
abre o monitor no navegador do app e usa `window.nanoAnalise` (`fila`, `marcar`, `arquivos`, `itens`, `ler`, `detalhe`, `salvar`, `falhar`)
para ler edital, TR e anexos (PDF, ZIP, DOCX), escrever a pré-análise e devolvê-la ao card.

## Pipeline (v7)
"✅ Vamos participar" leva o edital para a aba Pipeline. Na rodada seguinte, o Claude:
1. usa `nanoAnalise.pastasPendentes()` e `nomePasta(id)` (padrão `ÓRGÃO-UF - MODALIDADE Nº 011.2026 - PROCESSO 022.2026`);
2. cria a pasta em SharePoint `NANO/LICITACOES/LICITACOES 2026` com a subpasta `HABILITAÇÃO` e copia o que o edital pede de
   `NANO/LICITACOES/DOCUMENTOS PADRAO - HABILITACAO` (pasta-mestre; o nome de cada certidão traz `(val DD-MM-AAAA)` ou `(emitida DD-MM-AAAA)`);
3. faz a análise completa (grava com `salvar`), gera `00 - Checklist de Documentos.xlsx` com `ferramentas/checklist_xlsx.py`
   (situação de cada documento pela validade x data da sessão) e sobe links e análise em markdown;
4. devolve tudo ao card com `pastaCriada(id, {pasta_url, pasta_id, checklist_url, resumo})` (ou `pastaFalhou`).
Perdemos/Desistimos podem pedir para arquivar a pasta: a rodada lê `arquivarPendentes()`, move para `ARQUIVADOS` e chama `arquivoFeito`.

Motivos de descarte: `escopo`, `erp`, `hardware`, `longe`, `valor`, `exigencia`, `prazo`, `marca`, `duplicado`, `outro`.

## Como atualizar
Edite as partes em `src/parts/`, rode `node build.mjs` e faça push na `main`. O Cloudflare publica em cerca de 1 minuto no mesmo endereço.
Para testar localmente com banco: `npm install` e `npm run dev`.
