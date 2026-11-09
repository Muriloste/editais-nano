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
   )`,
  // pipeline: participar -> proposta -> ganhamos | perdemos | desistimos
  // pasta_status: pendente -> criando -> pronta | erro (pasta no SharePoint + checklist, feita pela rodada agendada)
  // arquivar: pendente -> feito | erro (mover a pasta para ARQUIVADOS)
  `CREATE TABLE IF NOT EXISTS participacoes (
     id TEXT PRIMARY KEY,
     etapa TEXT NOT NULL,
     snap TEXT,
     obs TEXT,
     pasta_status TEXT,
     pasta_url TEXT,
     pasta_id TEXT,
     checklist_url TEXT,
     resumo TEXT,
     erro TEXT,
     arquivar TEXT,
     criado_em TEXT NOT NULL,
     atualizado_em TEXT NOT NULL,
     pasta_pedida_em TEXT,
     pasta_concluida_em TEXT
   )`,
  // cache das respostas do PNCP (itens, dados da compra, lista de arquivos): poupa o limite de acessos e serve cópia durante quedas
  `CREATE TABLE IF NOT EXISTS cache_pncp (
     chave TEXT PRIMARY KEY,
     status INTEGER NOT NULL,
     tipo TEXT,
     corpo TEXT,
     salvo_em INTEGER NOT NULL
   )`,
  // ajustes gerais (ex.: "docs_mestre" = nomes dos arquivos da pasta-mestre de habilitação, lidos pela rodada)
  `CREATE TABLE IF NOT EXISTS ajustes (
     chave TEXT PRIMARY KEY,
     valor TEXT,
     atualizado_em TEXT NOT NULL
   )`,
  // licitações vindas de fora do PNCP (boletins do ConLicitação), importadas pela rodada agendada.
  // Uso interno da Nano: o conteúdo dos boletins não é repassado a terceiros.
  `CREATE TABLE IF NOT EXISTS externos (
     id TEXT PRIMARY KEY,
     fonte TEXT NOT NULL,
     pncp_id TEXT,
     prazo TEXT,
     situacao TEXT,
     boletim INTEGER,
     dados TEXT NOT NULL,
     criado_em TEXT NOT NULL,
     atualizado_em TEXT NOT NULL
   )`
];

// ---- ConLicitação: normalização dos boletins (os campos chegam como a API do boletim devolve)
import MUN_NOME from "./mun_nome.json";   // "UF|nome normalizado" -> código IBGE
const semAcento = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "");
const chaveCidade = (uf, cidade) => String(uf || "").toUpperCase().trim() + "|" + semAcento(cidade).toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
function pncpIdDe(x) {
  const m = String(x.observacao || "").match(/Id contrata[çc][ãa]o PNCP:\s*(\d{14})-(\d)-0*(\d+)\/(\d{4})/i);
  if (m) return m[1] + "-" + m[2] + "-" + m[3].padStart(6, "0") + "/" + m[4];
  const s = String(x.edital_site || "").match(/pncp\.gov\.br\/(?:app\/)?editais\/(\d{14})\/(\d{4})\/(\d+)/);
  if (s) return s[1] + "-1-" + s[3].padStart(6, "0") + "/" + s[2];
  return null;
}
const dataIso = (v) => { if (!v) return null; const d = new Date(v); return isNaN(d) ? null : d.toISOString(); };
// prazo para a proposta: abertura da sessão; sem ela, o limite de proposta/documentos; por último a validade do aviso (fim do dia)
const prazoCL = (x) => dataIso(x.datahora_abertura) || dataIso(x.datahora_prazo) || dataIso(x.datahora_documento) ||
  (x.data_validade ? dataIso(String(x.data_validade).slice(0, 10) + "T23:59:00-03:00") : null);
const limpaObjeto = (s) => String(s || "").replace(/\*+\s*(https?:\/\/|www\.)[^*\s]+\s*\*+/gi, " ")
  .replace(/\*\s+[^*]{2,40}?\s+\*/g, " ").replace(/\s+/g, " ").trim();   // tira as marcas "* Licitação Eletrônica *", "* www.portal *"
function normalizaCL(x, boletim) {
  const bid = Number(x.bidding_id);
  if (!Number.isInteger(bid) || bid <= 0) return null;
  const uf = texto(x.orgao_estado, 2);
  const ibge = MUN_NOME[chaveCidade(uf, x.orgao_cidade)] || null;
  return {
    id: "CL-" + bid, bidding_id: bid, pncp: pncpIdDe(x),
    orgao: texto(x.orgao || x.orgao_nome, 300), uasg: texto(x.orgao_uasg, 20), classe: texto(x.orgao_classe, 80),
    cidade: texto(x.orgao_cidade, 120), uf, codigo_ibge: ibge,
    edital: texto(x.edital, 80), processo: texto(x.processo, 80), modalidade: texto(x.modalidade, 80),
    objeto: texto(limpaObjeto(x.objeto), 3000), itens: texto(String(x.itens || "").replace(/\r/g, "").trim(), 4000),
    valor: numero(x.valor_estimado) || null, prazo: prazoCL(x), abertura: dataIso(x.datahora_abertura),
    site: texto(x.edital_site, 1000), situacao: texto(x.situacao, 40), obs: texto(x.observacao, 1500),
    tem_resumo: !!x.has_summary, tem_edital: !!x.tem_edital, atualizado: dataIso(x.updated_at),
    boletim: Number(boletim && boletim.id) || null, edicao: Number(boletim && boletim.edicao) || null
  };
}

const ETAPAS = new Set(["participar", "proposta", "ganhamos", "perdemos", "desistimos"]);
const STATUS_PASTA = new Set(["pendente", "criando", "pronta", "erro"]);
const parseJ = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
const linhaPart = (r) => ({ ...r, snap: parseJ(r.snap), resumo: parseJ(r.resumo) });

// Proxy só de leitura para os documentos e itens do PNCP (evita CORS ao baixar PDFs/ZIPs no navegador)
const PNCP_PERMITIDO = /^(api\/pncp\/v1\/orgaos\/\d{14}\/compras\/\d{4}\/\d+(\/arquivos(\/\d+)?|\/itens)?|api\/consulta\/v1\/orgaos\/\d{14}\/compras\/\d{4}\/\d+|pncp-api\/v1\/orgaos\/\d{14}\/compras\/\d{4}\/\d+\/arquivos(\/\d+)?)$/;
// ---- proxy do PNCP com cache no D1 e pausa automática
// itens 12 h, dados da compra 6 h, lista de arquivos 1 h; cópia vencida (até 7 dias) é servida se o PNCP limitar ou cair.
// Ao receber 429 o proxy pausa aquela API por 5 min (503/timeout: 2 min) e não insiste nesse intervalo.
const HORA = 3600 * 1000;
function ttlCache(caminho) {
  if (/\/itens$/.test(caminho)) return 12 * HORA;
  if (/^api\/consulta\//.test(caminho)) return 6 * HORA;
  if (/\/arquivos$/.test(caminho)) return 1 * HORA;
  return 0; // downloads de documentos não vão para o cache
}
const familia = (caminho) => (/^api\/consulta\//.test(caminho) ? "consulta" : "pncp");
const respCache = (row, estado) =>
  new Response(row.corpo, { status: row.status, headers: { "content-type": row.tipo || "application/json", "cache-control": "no-store", "x-cache": estado } });

async function proxyPncp(url, env, ctx) {
  const caminho = url.pathname.slice("/api/pncp-proxy/".length);
  if (!PNCP_PERMITIDO.test(caminho)) return json({ erro: "caminho do PNCP não permitido" }, 400);
  const db = env.DB || null;
  if (db) await garantirTabelas(db);
  const chave = caminho + url.search;
  const ttl = ttlCache(caminho);
  const agora = Date.now();
  let guardado = null;
  if (db && ttl) {
    guardado = await db.prepare("SELECT status, tipo, corpo, salvo_em FROM cache_pncp WHERE chave = ?1").bind(chave).first();
    if (guardado && agora - guardado.salvo_em < ttl) return respCache(guardado, "HIT");
  }
  const fam = familia(caminho);
  let pausa = null;
  if (db) {
    const p = await db.prepare("SELECT valor FROM ajustes WHERE chave = ?1").bind("pncp_pausa_" + fam).first();
    pausa = p ? parseJ(p.valor) : null;
    if (pausa && pausa.ate > agora) {
      if (guardado) return respCache(guardado, "STALE");
      return new Response(JSON.stringify({ erro: "pncp_pausa", motivo: pausa.motivo, ate: new Date(pausa.ate).toISOString() }), {
        status: 503, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-pncp-pausa": new Date(pausa.ate).toISOString() }
      });
    }
  }
  let r = null, falha = null;
  try {
    r = await fetch((env.PNCP_BASE || "https://pncp.gov.br/") + caminho + url.search, {
      headers: { "user-agent": "editais-nano/1.0 (Nano TI; monitor de editais)" },
      signal: AbortSignal.timeout(ttl ? 25000 : 90000)
    });
  } catch (e) { falha = "timeout"; }
  if (!r || r.status === 429 || r.status >= 500) {
    const motivo = r && r.status === 429 ? "limite" : "fora";
    if (db) {
      const ate = agora + (motivo === "limite" ? 5 : 2) * 60 * 1000;
      ctx.waitUntil(db.prepare(
        `INSERT INTO ajustes (chave, valor, atualizado_em) VALUES (?1, ?2, ?3) ON CONFLICT(chave) DO UPDATE SET valor = ?2, atualizado_em = ?3`
      ).bind("pncp_pausa_" + fam, JSON.stringify({ ate, motivo, status: r ? r.status : falha }), new Date().toISOString()).run());
    }
    if (guardado) return respCache(guardado, "STALE");
    if (!r) return json({ erro: "PNCP não respondeu (timeout)" }, 504);
  }
  const h = new Headers({ "cache-control": "no-store" });
  for (const k of ["content-type", "content-disposition", "content-length"]) { const v = r.headers.get(k); if (v) h.set(k, v); }
  if (db && ttl && r.status === 200) {
    const corpo = await r.text();
    h.delete("content-length");
    if (corpo.length < 1800000) {
      ctx.waitUntil((async () => {
        await db.prepare(
          `INSERT INTO cache_pncp (chave, status, tipo, corpo, salvo_em) VALUES (?1, 200, ?2, ?3, ?4)
           ON CONFLICT(chave) DO UPDATE SET status = 200, tipo = ?2, corpo = ?3, salvo_em = ?4`
        ).bind(chave, r.headers.get("content-type") || "application/json", corpo, agora).run();
        if (Math.random() < 0.02) await db.prepare("DELETE FROM cache_pncp WHERE salvo_em < ?1").bind(agora - 7 * 24 * HORA).run();
      })().catch(() => {}));
    }
    h.set("x-cache", "MISS");
    return new Response(corpo, { status: 200, headers: h });
  }
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
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    if (url.pathname.startsWith("/api/pncp-proxy/") && request.method === "GET") return proxyPncp(url, env, ctx);
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
        // upsert: a rodada do pipeline grava a análise completa mesmo sem pedido de pré-análise
        await env.DB.prepare(
          `INSERT INTO analises (id, status, pedido_em, iniciado_em, concluido_em, resumo, resultado, erro)
           VALUES (?1, ?2, ?3, CASE WHEN ?2 = 'processando' THEN ?3 END, CASE WHEN ?2 IN ('pronta', 'erro') THEN ?3 END, ?4, ?5, ?6)
           ON CONFLICT(id) DO UPDATE SET status = ?2,
             iniciado_em = CASE WHEN ?2 = 'processando' THEN ?3 ELSE iniciado_em END,
             concluido_em = CASE WHEN ?2 IN ('pronta', 'erro') THEN ?3 ELSE concluido_em END,
             resumo = COALESCE(?4, resumo), resultado = COALESCE(?5, resultado), erro = ?6`
        ).bind(aid, b.status, agoraA, b.resumo ? JSON.stringify(b.resumo) : null, texto(b.resultado, 380000), texto(b.erro, 2000)).run();
        return json({ ok: true });
      }
      if (request.method === "DELETE" && aid) {
        await env.DB.prepare("DELETE FROM analises WHERE id = ?1").bind(aid).run();
        return json({ ok: true });
      }
      return json({ erro: "método não permitido" }, 405);
    }

    // ---- documentos da pasta-mestre (a rodada grava os nomes; a página calcula validade e avisos)
    if (url.pathname === "/api/docs-mestre") {
      if (request.method === "GET") {
        const r = await env.DB.prepare("SELECT valor, atualizado_em FROM ajustes WHERE chave = 'docs_mestre'").first();
        const v = r ? parseJ(r.valor) || {} : {};
        return json({ nomes: v.nomes || [], pasta_url: v.pasta_url || null, atualizado_em: r ? r.atualizado_em : null });
      }
      if (request.method === "PUT") {
        const raw = await request.text();
        if (raw.length > 60000) return json({ erro: "lista grande demais" }, 413);
        let b; try { b = JSON.parse(raw); } catch { return json({ erro: "json inválido" }, 400); }
        if (!b || !Array.isArray(b.nomes)) return json({ erro: "envie {nomes: [...]}" }, 400);
        const nomes = b.nomes.filter((n) => typeof n === "string").slice(0, 300).map((n) => n.slice(0, 300));
        await env.DB.prepare(
          `INSERT INTO ajustes (chave, valor, atualizado_em) VALUES ('docs_mestre', ?1, ?2)
           ON CONFLICT(chave) DO UPDATE SET valor = ?1, atualizado_em = ?2`
        ).bind(JSON.stringify({ nomes, pasta_url: texto(b.pasta_url, 1000) }), new Date().toISOString()).run();
        return json({ ok: true, total: nomes.length });
      }
      return json({ erro: "método não permitido" }, 405);
    }

    // ---- licitações de fora do PNCP (boletins do ConLicitação)
    // PUT /api/externos {fonte:"conlicitacao", boletins:[{id, edicao, fechado_em}], itens:[...]}: grava/atualiza (a página manda o que a rodada trouxe)
    // GET /api/externos: as que ainda não venceram + o estado da importação; GET|PUT /api/externos/estado: ponto de partida da próxima rodada / falha
    if (url.pathname === "/api/externos" || url.pathname === "/api/externos/estado") {
      const lerEstado = async () => {
        const r = await env.DB.prepare("SELECT valor, atualizado_em FROM ajustes WHERE chave = 'conlicitacao'").first();
        return r ? { ...(parseJ(r.valor) || {}), atualizado_em: r.atualizado_em } : {};
      };
      const gravaEstado = (v) => env.DB.prepare(
        `INSERT INTO ajustes (chave, valor, atualizado_em) VALUES ('conlicitacao', ?1, ?2) ON CONFLICT(chave) DO UPDATE SET valor = ?1, atualizado_em = ?2`
      ).bind(JSON.stringify(v), new Date().toISOString()).run();
      if (url.pathname === "/api/externos/estado") {
        if (request.method === "GET") return json(await lerEstado());
        if (request.method === "PUT") {
          const b = await request.json().catch(() => null);
          if (!b) return json({ erro: "json inválido" }, 400);
          const est = await lerEstado(); delete est.atualizado_em;
          est.erro = b.erro ? texto(b.erro, 500) : null; est.erro_em = b.erro ? new Date().toISOString() : null;
          await gravaEstado(est);
          return json({ ok: true });
        }
        return json({ erro: "método não permitido" }, 405);
      }
      if (request.method === "GET") {
        // vencidas há mais de 2 dias saem da lista (as marcadas continuam pela cópia guardada na marcação)
        const corte = new Date(Date.now() - 2 * 86400000).toISOString();
        const { results } = await env.DB.prepare(
          "SELECT dados FROM externos WHERE prazo IS NULL OR prazo >= ?1 ORDER BY prazo"
        ).bind(corte).all();
        if (Math.random() < 0.05) {
          ctx.waitUntil(env.DB.prepare("DELETE FROM externos WHERE prazo < ?1").bind(new Date(Date.now() - 60 * 86400000).toISOString()).run());
        }
        return json({ externos: results.map((r) => parseJ(r.dados)).filter(Boolean), estado: await lerEstado() });
      }
      if (request.method === "PUT") {
        const raw = await request.text();
        if (raw.length > 8000000) return json({ erro: "importação grande demais" }, 413);
        let b; try { b = JSON.parse(raw); } catch { return json({ erro: "json inválido" }, 400); }
        if (!b || b.fonte !== "conlicitacao" || !Array.isArray(b.itens) || !Array.isArray(b.boletins)) return json({ erro: "envie {fonte:'conlicitacao', boletins:[...], itens:[...]}" }, 400);
        if (b.itens.length > 3000 || b.boletins.length > 60) return json({ erro: "importação grande demais" }, 413);
        const boletins = b.boletins.map((x) => ({ id: Number(x && x.id), edicao: Number(x && x.edicao) || null, fechado_em: dataIso(x && x.fechado_em) }))
          .filter((x) => Number.isInteger(x.id) && x.id > 0);
        const porId = new Map(boletins.map((x) => [x.id, x]));
        const agoraE = new Date().toISOString();
        const linhas = new Map();
        for (const x of b.itens) {
          if (!x || typeof x !== "object") continue;
          const d = normalizaCL(x, porId.get(Number(x._b)));
          if (!d) continue;
          const ant = linhas.get(d.id);
          if (!ant || (d.boletim || 0) >= (ant.boletim || 0)) linhas.set(d.id, d);   // o boletim mais novo vale
        }
        const lista = [...linhas.values()];
        let novos = 0;
        if (lista.length) {
          const existentes = new Set();
          for (let i = 0; i < lista.length; i += 90) {
            const parte = lista.slice(i, i + 90);
            const { results } = await env.DB.prepare("SELECT id FROM externos WHERE id IN (" + parte.map((_, k) => "?" + (k + 1)).join(",") + ")")
              .bind(...parte.map((d) => d.id)).all();
            results.forEach((r) => existentes.add(r.id));
          }
          novos = lista.filter((d) => !existentes.has(d.id)).length;
          const stmts = lista.map((d) => env.DB.prepare(
            `INSERT INTO externos (id, fonte, pncp_id, prazo, situacao, boletim, dados, criado_em, atualizado_em)
             VALUES (?1, 'conlicitacao', ?2, ?3, ?4, ?5, ?6, ?7, ?7)
             ON CONFLICT(id) DO UPDATE SET
               pncp_id = CASE WHEN COALESCE(externos.boletim, 0) <= ?5 THEN ?2 ELSE externos.pncp_id END,
               prazo = CASE WHEN COALESCE(externos.boletim, 0) <= ?5 THEN ?3 ELSE externos.prazo END,
               situacao = CASE WHEN COALESCE(externos.boletim, 0) <= ?5 THEN ?4 ELSE externos.situacao END,
               dados = CASE WHEN COALESCE(externos.boletim, 0) <= ?5 THEN ?6 ELSE externos.dados END,
               boletim = MAX(COALESCE(externos.boletim, 0), ?5), atualizado_em = ?7`
          ).bind(d.id, d.pncp, d.prazo, d.situacao, d.boletim || 0, JSON.stringify(d), agoraE));
          for (let i = 0; i < stmts.length; i += 80) await env.DB.batch(stmts.slice(i, i + 80));
        }
        const est = await lerEstado(); delete est.atualizado_em;
        const maisNovo = boletins.reduce((a, x) => (!a || x.id > a.id ? x : a), null);
        if (maisNovo && (!est.ultimo_boletim || maisNovo.id >= est.ultimo_boletim)) {
          est.ultimo_boletim = maisNovo.id; est.ultima_edicao = maisNovo.edicao; est.ultimo_fechado_em = maisNovo.fechado_em;
        }
        est.ultima_importacao = agoraE; est.ultimos_boletins = boletins.map((x) => x.edicao || x.id).slice(-20);
        est.recebidas = lista.length; est.novas = novos; est.erro = null; est.erro_em = null;
        await gravaEstado(est);
        return json({ ok: true, recebidas: lista.length, novas: novos, atualizadas: lista.length - novos, sem_cidade: lista.filter((d) => !d.codigo_ibge).length, estado: est });
      }
      return json({ erro: "método não permitido" }, 405);
    }

    // ---- pipeline de participação
    const mp = url.pathname.match(/^\/api\/participacoes(?:\/([^/]+)(?:\/(pasta|arquivo))?)?$/);
    if (mp) {
      const pid = mp[1] ? decodeURIComponent(mp[1]) : null;
      const sub = mp[2] || null;
      if (pid && pid.length > 120) return json({ erro: "id inválido" }, 400);
      const agoraP = new Date().toISOString();
      const ler = async () => {
        const raw = await request.text();
        if (raw.length > 120000) throw Object.assign(new Error("registro grande demais"), { st: 413 });
        try { return raw ? JSON.parse(raw) : {}; } catch { throw Object.assign(new Error("json inválido"), { st: 400 }); }
      };
      try {
        if (request.method === "GET" && !pid) {
          const { results } = await env.DB.prepare("SELECT * FROM participacoes ORDER BY criado_em").all();
          return json({ participacoes: results.map(linhaPart) });
        }
        if (request.method === "GET" && pid && !sub) {
          const r = await env.DB.prepare("SELECT * FROM participacoes WHERE id = ?1").bind(pid).first();
          return r ? json(linhaPart(r)) : json({ erro: "não encontrada" }, 404);
        }
        // tela: mover de etapa (cria a linha na primeira vez)
        if (request.method === "PUT" && pid && !sub) {
          const b = await ler();
          if (!ETAPAS.has(b.etapa)) return json({ erro: "etapa inválida" }, 400);
          const atual = await env.DB.prepare("SELECT * FROM participacoes WHERE id = ?1").bind(pid).first();
          const snap = b.snap && typeof b.snap === "object" ? JSON.stringify(b.snap).slice(0, 60000) : null;
          // a pasta é pedida na primeira vez que entra em "participar" (ou se a anterior falhou)
          let pastaStatus = atual ? atual.pasta_status : null;
          let pastaPedida = atual ? atual.pasta_pedida_em : null;
          if (b.etapa === "participar" && (!pastaStatus || pastaStatus === "erro")) { pastaStatus = "pendente"; pastaPedida = agoraP; }
          let arquivar = atual ? atual.arquivar : null;
          if (b.etapa === "perdemos" || b.etapa === "desistimos") {
            if (b.arquivar === true && arquivar !== "feito") arquivar = "pendente";
            if (b.arquivar === false && arquivar === "pendente") arquivar = null;
          } else if (arquivar === "pendente") arquivar = null;
          await env.DB.batch([
            env.DB.prepare(
              `INSERT INTO participacoes (id, etapa, snap, obs, pasta_status, arquivar, criado_em, atualizado_em, pasta_pedida_em)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8)
               ON CONFLICT(id) DO UPDATE SET etapa = ?2, snap = COALESCE(?3, snap), obs = COALESCE(?4, obs),
                 pasta_status = ?5, arquivar = ?6, atualizado_em = ?7, pasta_pedida_em = ?8,
                 erro = CASE WHEN ?5 = 'pendente' THEN NULL ELSE erro END`
            ).bind(pid, b.etapa, snap, texto(b.obs, 1000), pastaStatus, arquivar, agoraP, pastaPedida),
            env.DB.prepare("INSERT INTO historico (id, acao, obs, em) VALUES (?1, ?2, ?3, ?4)")
              .bind(pid, "etapa:" + b.etapa, texto(b.obs, 500), agoraP)
          ]);
          return json({ ok: true, pasta_status: pastaStatus, arquivar });
        }
        // tela: pedir de novo a pasta/checklist
        if (request.method === "POST" && pid && sub === "pasta") {
          const r = await env.DB.prepare(
            "UPDATE participacoes SET pasta_status = 'pendente', pasta_pedida_em = ?2, erro = NULL, atualizado_em = ?2 WHERE id = ?1"
          ).bind(pid, agoraP).run();
          return r.meta.changes ? json({ ok: true }) : json({ erro: "não está no pipeline" }, 404);
        }
        // rodada agendada: andamento da pasta
        if (request.method === "PUT" && pid && sub === "pasta") {
          const b = await ler();
          if (!STATUS_PASTA.has(b.pasta_status)) return json({ erro: "pasta_status inválido" }, 400);
          const r = await env.DB.prepare(
            `UPDATE participacoes SET pasta_status = ?2, pasta_url = COALESCE(?3, pasta_url), pasta_id = COALESCE(?4, pasta_id),
               checklist_url = COALESCE(?5, checklist_url), resumo = COALESCE(?6, resumo), erro = ?7, atualizado_em = ?8,
               pasta_concluida_em = CASE WHEN ?2 IN ('pronta', 'erro') THEN ?8 ELSE pasta_concluida_em END
             WHERE id = ?1`
          ).bind(pid, b.pasta_status, texto(b.pasta_url, 1000), texto(b.pasta_id, 200), texto(b.checklist_url, 1000),
                 b.resumo ? JSON.stringify(b.resumo).slice(0, 20000) : null, texto(b.erro, 2000), agoraP).run();
          return r.meta.changes ? json({ ok: true }) : json({ erro: "não está no pipeline" }, 404);
        }
        // rodada agendada: pasta movida para ARQUIVADOS
        if (request.method === "PUT" && pid && sub === "arquivo") {
          const b = await ler();
          if (!["feito", "erro"].includes(b.status)) return json({ erro: "status deve ser feito ou erro" }, 400);
          const r = await env.DB.prepare(
            "UPDATE participacoes SET arquivar = ?2, pasta_url = COALESCE(?3, pasta_url), erro = ?4, atualizado_em = ?5 WHERE id = ?1"
          ).bind(pid, b.status, texto(b.pasta_url, 1000), b.status === "erro" ? texto(b.erro, 2000) : null, agoraP).run();
          return r.meta.changes ? json({ ok: true }) : json({ erro: "não está no pipeline" }, 404);
        }
        if (request.method === "DELETE" && pid && !sub) {
          await env.DB.batch([
            env.DB.prepare("DELETE FROM participacoes WHERE id = ?1").bind(pid),
            env.DB.prepare("INSERT INTO historico (id, acao, em) VALUES (?1, 'etapa:removido', ?2)").bind(pid, agoraP)
          ]);
          return json({ ok: true });
        }
        return json({ erro: "método não permitido" }, 405);
      } catch (e) {
        if (e.st) return json({ erro: e.message }, e.st);
        throw e;
      }
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
