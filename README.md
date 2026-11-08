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

Motivos de descarte: `escopo`, `erp`, `hardware`, `longe`, `valor`, `exigencia`, `prazo`, `marca`, `duplicado`, `outro`.

## Como atualizar
Edite as partes em `src/parts/`, rode `node build.mjs` e faça push na `main`. O Cloudflare publica em cerca de 1 minuto no mesmo endereço.
Para testar localmente com banco: `npm install` e `npm run dev`.
