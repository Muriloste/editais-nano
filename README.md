# Monitor de editais · Nano TI

Página que consulta o PNCP ao vivo e lista editais abertos para a Nano:
Sophos (por linha de produto), backup/Acronis e Microsoft no Brasil todo, e suporte de TI até 150/200 km de Leme.

- Publicado em: https://editais-nano.nano-portal.workers.dev
- Cada push na branch `main` publica automaticamente (Cloudflare Workers Builds).

## Estrutura
- `src/template.html` — a página (HTML, CSS e JS), com o marcador `__MUN__`.
- `src/mun_br.json` — distância em km de Leme/SP para cada município (código IBGE).
- `build.mjs` — gera `public/index.html` (`node build.mjs`).
- `public/index.html` — o que vai ao ar. Sempre rode o build antes do commit.
- `wrangler.jsonc` — configuração do Worker `editais-nano` (só arquivos estáticos).
