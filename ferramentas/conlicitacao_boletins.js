// Leitura dos boletins do ConLicitação para o monitor de editais (uso interno da Nano).
// Rode no navegador do app do Claude, numa aba em https://consulteonline.conlicitacao.com.br (sessão já logada),
// com o javascript_tool. Troque os três valores abaixo antes de rodar:
//   DESDE  = ultimo_boletim devolvido por nanoAnalise.conlicitacao() no monitor (lê os boletins DEPOIS dele); null na primeira vez
//   INICIO = id de um boletim (o número em .../boletins/<id>/open no link do e-mail do boletim), usado só quando DESDE é null
//   VOLTAR = quantos boletins anteriores ao INICIO ler também (só quando DESDE é null; 3 boletins por dia útil)
// O script junta as licitações ainda abertas, compacta e abre o monitor nesta mesma aba com #conlicitacao=<pacote>.
// Depois, na aba (agora no monitor): await nanoAnalise.importarConlicitacao()
const DESDE = null, INICIO = null, VOLTAR = 0;
const MONITOR = "https://editais-nano.nano-portal.workers.dev/";
const H = "https://consultaonline.conlicitacao.com.br/boletim_web/";
const g = async (u) => {
  const r = await fetch(H + u, { credentials: "include" });
  const t = await r.text();
  if (!r.ok) throw new Error("ConLicitação respondeu " + r.status + " em " + u.split("?")[0] + (r.status === 401 || r.status === 403 ? " (sessão expirada)" : ""));
  try { return JSON.parse(t); } catch (e) { throw new Error("sessão do ConLicitação expirada (veio uma página em vez dos dados)"); }
};
const info = async (id) => { const j = await g("bulletin_filter_content?bulletin_filter_id=" + id); if (!j || !j[0]) throw new Error("boletim " + id + " não encontrado"); return j[0]; };
const metas = [];
if (DESDE) {
  let x = await info(DESDE);
  while (x.next_bulletin_filter_id && metas.length < 30) { x = await info(x.next_bulletin_filter_id); metas.push(x); }
} else if (INICIO) {
  let x = await info(INICIO); metas.unshift(x);
  for (let i = 0; i < VOLTAR && x.previous_bulletin_filter_id; i++) { x = await info(x.previous_bulletin_filter_id); metas.unshift(x); }
} else throw new Error("informe DESDE ou INICIO");
const agora = Date.now(), porId = new Map(), boletins = [];
for (const m of metas) {   // do mais antigo para o mais novo: o boletim mais novo prevalece
  boletins.push({ id: m.id, edicao: m.issue, fechado_em: m.bulletin && m.bulletin.closing_date });
  for (let p = 1, tp = 1; p <= tp && p <= 40; p++) {
    const j = await g("public/boletins/" + m.id + "/biddings.json?per_page=50&page=" + p);
    tp = j.total_pages || 1;
    for (const b of j.biddings || []) {
      const prazo = b.datahora_abertura || b.datahora_prazo || b.datahora_documento || (b.data_validade ? b.data_validade + "T23:59:00-03:00" : null);
      if (prazo && new Date(prazo).getTime() < agora - 864e5) { porId.delete(b.bidding_id); continue; }
      porId.set(b.bidding_id, {
        _b: m.id, bidding_id: b.bidding_id, orgao: b.public_body && b.public_body.nome, orgao_uasg: b.orgao_uasg, orgao_classe: b.orgao_classe,
        orgao_cidade: b.orgao_cidade, orgao_estado: b.orgao_estado, edital: b.edital, processo: b.processo, modalidade: b.modality && b.modality.nome,
        objeto: b.objeto, itens: String(b.itens || "").slice(0, 4000), valor_estimado: b.valor_estimado,
        datahora_abertura: b.datahora_abertura, datahora_prazo: b.datahora_prazo, datahora_documento: b.datahora_documento, data_validade: b.data_validade,
        edital_site: b.edital_site, situacao: b.bidding_grouping && b.bidding_grouping.descricao, observacao: String(b.observacao || "").slice(0, 1500),
        has_summary: !!b.has_summary, tem_edital: (b.edicts || []).length > 0, updated_at: b.updated_at
      });
    }
  }
}
const pacote = { v: 1, boletins, itens: [...porId.values()] };
const z = new Uint8Array(await new Response(new Blob([JSON.stringify(pacote)]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
let bin = ""; for (let i = 0; i < z.length; i += 8192) bin += String.fromCharCode.apply(null, z.subarray(i, i + 8192));
const h = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
if (boletins.length) setTimeout(() => location.assign(MONITOR + "#conlicitacao=" + h), 300);
({ boletins: boletins.map((b) => b.edicao), licitacoes: pacote.itens.length, tamanho: h.length, abrindo_monitor: boletins.length > 0 });
