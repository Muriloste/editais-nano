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
   )`
];

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
    if (!env.DB) return json({ erro: "banco não configurado" }, 503);
    await garantirTabelas(env.DB);

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
