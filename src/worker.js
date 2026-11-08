// Monitor de editais · Nano TI
// Serve a página (pasta public/) e uma API pequena que guarda as marcações
// (interesse / descartado + motivo) no banco D1, para valer em todos os aparelhos
// e para o histórico de decisões poder ser revisado depois.

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS marcas (
     id TEXT PRIMARY KEY,
     acao TEXT NOT NULL,
     motivo TEXT,
     obs TEXT,
     frentes TEXT,
     orgao TEXT,
     municipio TEXT,
     uf TEXT,
     km INTEGER,
     objeto TEXT,
     valor REAL,
     plataforma TEXT,
     encerramento TEXT,
     snap TEXT,
     criado_em TEXT NOT NULL,
     atualizado_em TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS historico (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     id TEXT NOT NULL,
     acao TEXT NOT NULL,
     motivo TEXT,
     obs TEXT,
     em TEXT NOT NULL
   )`,
  // fila de pré-análise: pendente -> processando -> pronta | erro
  `CREATE TABLE IF NOT EXISTS analises (
     id TEXT PRIMARY KEY,
     status TEXT NOT NULL,
     snap TEXT,
     pedido_em TEXT NOT NULL,
     iniciado_em TEXT,
     concluido_em TEXT,
     resumo TEXT,
     resultado TEXT,
     erro TEXT
   )`
];

// Proxy só de leitura para os documentos e itens do PNCP (evita CORS ao baixar PDFs/ZIPs no navegador)
const PNCP_PERMITIDO = /^(api\/pncp\/v1\/orgaos\/\d{14}\/compras\/\d{4}\/\d+(\/arquivos(\/\d+)?|\/itens)?|api\/consulta\/v1\/orgaos\/\d{14}\/compras\/\d{4}\/\d+|pncp-api\/v1\/orgaos\/\d{14}\/compras\/\d{4}\/\d+\/arquivos(\/\d+)?)$/;
async function proxyPncp(url) {
  const caminho = url.pathname.slice("/api/pncp-proxy/".length);
  if (!PNCP_PERMITIDO.test(caminho)) return json({ erro: "caminho do PNCP não permitido" }, 400);
  const r = await fetch("https://pncp.gov.br/" + caminho + url.search, {
    headers: { "user-agent": "editais-nano/1.0 (Nano TI; monitor de editais)" }
  });
  const h = new Headers({ "cache-control": "no-store" });
  for (const k of ["content-type", "content-disposition", "content-length"]) { const v = r.headers.get(k); if (v) h.set(k, v); }
  return new Response(r.body, { status: r.status, headers: h });
}

const STATUS_ANALISE = new Set(["pendente", "processando", "pronta", "erro"]);

let tabelasProntas = null;
function garantirTabelas(db) {
  if (!tabelasProntas) {
    tabelasProntas = db.batch(SCHEMA.map((s) => db.prepare(s))).catch((e) => {
      tabelasProntas = null;
      throw e;
    });
  }
  return tabelasProntas;
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });

const ACOES = new Set(["interesse", "descartado"]);
const texto = (v, max) => (v == null ? null : String(v).slice(0, max));
const numero = (v) => (typeof v === "number" && isFinite(v) ? v : null);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    if (url.pathname.startsWith("/api/pncp-proxy/") && request.method === "GET") return proxyPncp(url);
    if (!env.DB) return json({ erro: "banco não configurado" }, 503);
    await garantirTabelas(env.DB);

    // ---- fila de pré-análise
    const ma = url.pathname.match(/^\/api\/analises(?:\/([^/]+))?$/);
    if (ma) {
      const aid = ma[1] ? decodeURIComponent(ma[1]) : null;
      if (aid && aid.length > 120) return json({ erro: "id inválido" }, 400);
      const agoraA = new Date().toISOString();
      if (request.method === "GET" && !aid) {
        const { results } = await env.DB.prepare(
          "SELECT id, status, snap, pedido_em, iniciado_em, concluido_em, resumo, erro FROM analises ORDER BY pedido_em"
        ).all();
        return json({ analises: results.map((r) => ({ ...r, snap: r.snap ? JSON.parse(r.snap) : null, resumo: r.resumo ? JSON.parse(r.resumo) : null })) });
      }
      if (request.method === "GET" && aid) {
        const r = await env.DB.prepare("SELECT * FROM analises WHERE id = ?1").bind(aid).first();
        if (!r) return json({ erro: "não encontrada" }, 404);
        return json({ ...r, snap: r.snap ? JSON.parse(r.snap) : null, resumo: r.resumo ? JSON.parse(r.resumo) : null });
      }
      if (request.method === "POST" && aid) {
        // pedir (ou pedir de novo) a pré-análise: volta para a fila
        const b = await request.json().catch(() => ({}));
        const snap = b && b.snap ? JSON.stringify(b.snap).slice(0, 60000) : null;
        await env.DB.prepare(
          `INSERT INTO analises (id, status, snap, pedido_em) VALUES (?1, 'pendente', ?2, ?3)
           ON CONFLICT(id) DO UPDATE SET status = 'pendente', snap = COALESCE(?2, snap), pedido_em = ?3, erro = NULL`
        ).bind(aid, snap, agoraA).run();
        return json({ ok: true });
      }
      if (request.method === "PUT" && aid) {
        const raw = await request.text();
        if (raw.length > 400000) return json({ erro: "resultado grande demais" }, 413);
        let b; try { b = JSON.parse(raw); } catch { return json({ erro: "json inválido" }, 400); }
        if (!b || !STATUS_ANALISE.has(b.status)) return json({ erro: "status inválido" }, 400);
        await env.DB.prepare(
          `UPDATE analises SET status = ?2,
             iniciado_em = CASE WHEN ?2 = 'processando' THEN ?3 ELSE iniciado_em END,
             concluido_em = CASE WHEN ?2 IN ('pronta', 'erro') THEN ?3 ELSE concluido_em END,
             resumo = COALESCE(?4, resumo), resultado = COALESCE(?5, resultado), erro = ?6
           WHERE id = ?1`
        ).bind(aid, b.status, agoraA, b.resumo ? JSON.stringify(b.resumo) : null, texto(b.resultado, 380000), texto(b.erro, 2000)).run();
        return json({ ok: true });
      }
      if (request.method === "DELETE" && aid) {
        await env.DB.prepare("DELETE FROM analises WHERE id = ?1").bind(aid).run();
        return json({ ok: true });
      }
      return json({ erro: "método não permitido" }, 405);
    }

    // histórico completo de decisões (para revisão)
    if (url.pathname === "/api/historico" && request.method === "GET") {
      const { results } = await env.DB.prepare(
        "SELECT seq, id, acao, motivo, obs, em FROM historico ORDER BY seq DESC LIMIT 5000"
      ).all();
      return json({ historico: results });
    }

    const m = url.pathname.match(/^\/api\/marcas(?:\/([^/]+))?$/);
    if (!m) return json({ erro: "rota inexistente" }, 404);
    const id = m[1] ? decodeURIComponent(m[1]) : null;
    if (id && id.length > 120) return json({ erro: "id inválido" }, 400);
    const agora = new Date().toISOString();

    if (request.method === "GET" && !id) {
      const { results } = await env.DB.prepare(
        "SELECT id, acao, motivo, obs, snap, criado_em, atualizado_em FROM marcas ORDER BY atualizado_em DESC"
      ).all();
      return json({
        marcas: results.map((r) => ({ ...r, snap: r.snap ? JSON.parse(r.snap) : null }))
      });
    }

    if (request.method === "PUT" && id) {
      const raw = await request.text();
      if (raw.length > 60000) return json({ erro: "registro grande demais" }, 413);
      let b;
      try { b = JSON.parse(raw); } catch { return json({ erro: "json inválido" }, 400); }
      if (!b || !ACOES.has(b.acao)) return json({ erro: "acao deve ser interesse ou descartado" }, 400);
      const snap = b.snap && typeof b.snap === "object" ? b.snap : null;
      const it = (snap && snap.it) || {};
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO marcas (id, acao, motivo, obs, frentes, orgao, municipio, uf, km, objeto, valor, plataforma, encerramento, snap, criado_em, atualizado_em)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?15)
           ON CONFLICT(id) DO UPDATE SET acao = ?2, motivo = ?3, obs = ?4, frentes = ?5, orgao = ?6, municipio = ?7, uf = ?8,
             km = ?9, objeto = ?10, valor = ?11, plataforma = ?12, encerramento = ?13, snap = ?14, atualizado_em = ?15`
        ).bind(
          id, b.acao, texto(b.motivo, 40), texto(b.obs, 500),
          texto(b.frentes, 300), texto(it.orgao_nome, 300), texto(it.municipio_nome, 120), texto(it.uf, 2),
          snap ? numero(snap.km) : null, texto(it.description || it.title, 2000), snap ? numero(snap.valor) : null,
          texto(it.usuario_nome, 200), snap ? texto(snap.fim, 40) : null, snap ? JSON.stringify(snap) : null, agora
        ),
        env.DB.prepare("INSERT INTO historico (id, acao, motivo, obs, em) VALUES (?1, ?2, ?3, ?4, ?5)")
          .bind(id, b.acao, texto(b.motivo, 40), texto(b.obs, 500), agora)
      ]);
      return json({ ok: true });
    }

    if (request.method === "DELETE" && id) {
      await env.DB.batch([
        env.DB.prepare("DELETE FROM marcas WHERE id = ?1").bind(id),
        env.DB.prepare("INSERT INTO historico (id, acao, em) VALUES (?1, 'removido', ?2)").bind(id, agora)
      ]);
      return json({ ok: true });
    }

    return json({ erro: "método não permitido" }, 405);
  }
};
