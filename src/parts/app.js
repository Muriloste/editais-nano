
const $ = s => document.querySelector(s);
const norm = s => (s||"").normalize("NFD").replace(/[̀-ͯ]/g,"").toLowerCase();
const esc = s => String(s==null?"":s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const API = /^https?:$/.test(location.protocol) ? "/api/marcas" : null;

// ---- armazenamento local (tolerante a falhas)
const store = {
  get(k, d){ try{ const v = localStorage.getItem("nanoEditais."+k); return v ? JSON.parse(v) : d; }catch(e){ return d; } },
  set(k, v){ try{ localStorage.setItem("nanoEditais."+k, JSON.stringify(v)); }catch(e){} }
};
let itensCache = store.get("itens", {});
const prevSeen = new Set(store.get("seen", []));
const firstVisit = prevSeen.size === 0;

// ---- marcações: id -> "interesse" | "descartado"; motivos: id -> {m, obs}; snaps: cópia do edital
let marks = store.get("marks", {});
let motivos = store.get("motivos", {});
let snaps = store.get("snaps", {});
let pendentes = new Set(store.get("pendentes", []));
let apiOk = false;
let servidorIds = new Set();

// ---- pipeline (participações): id -> {etapa, pasta_status, pasta_url, checklist_url, resumo, arquivar, snap…}
const ETAPAS = [
  ["participar", "Vamos participar"],
  ["proposta", "Proposta enviada"],
  ["ganhamos", "Ganhamos"],
  ["perdemos", "Perdemos"],
  ["desistimos", "Desistimos"]
];
const nomeEtapa = e => (ETAPAS.find(x => x[0] === e) || [e, e])[1];
const ATIVAS = new Set(["participar", "proposta"]);
let particip = new Map();
let abrirResultado = null;   // {id, etapa}: perguntando se arquiva a pasta
let confirmarTirar = null;   // id aguardando confirmação para sair do pipeline

const MOTIVOS = [
  ["escopo", "Fora do nosso escopo"],
  ["erp", "Sistema de gestão / software específico"],
  ["hardware", "Só equipamento / hardware"],
  ["longe", "Longe ou exige presença"],
  ["valor", "Valor baixo"],
  ["exigencia", "Exigência que não atendemos"],
  ["prazo", "Prazo curto"],
  ["marca", "Marca concorrente exigida"],
  ["duplicado", "Duplicado / já visto"],
  ["outro", "Outro"]
];
const nomeMotivo = c => (MOTIVOS.find(m => m[0] === c) || [c, c || "sem motivo"])[1];

const SNAP_CAMPOS = ["orgao_nome","unidade_nome","municipio_nome","uf","description","title","modalidade_licitacao_nome","item_url","usuario_nome","orgao_cnpj","ano","numero_sequencial","valor_global","codigo_ibge"];
function snapshot(rec){
  const it = {}; SNAP_CAMPOS.forEach(k => { if(rec.it[k] != null) it[k] = rec.it[k]; });
  const d = details.get(rec.id) || {};
  return { id: rec.id, km: rec.km, fim: rec.fim ? rec.fim.toISOString() : null, ini: rec.ini ? rec.ini.toISOString() : null,
           so: [...rec.strong], si: [...(rec.strongItens || [])], cats: [...rec.cats], itens: rec.itens || null,
           valor: d.valorTotalEstimado || rec.it.valor_global || (snaps[rec.id] && snaps[rec.id].valor) || null,
           origem: d.linkSistemaOrigem || (snaps[rec.id] && snaps[rec.id].origem) || null, it };
}
function deSnap(s){
  return { id: s.id, it: s.it || {}, km: s.km, fim: s.fim ? new Date(s.fim) : null, ini: s.ini ? new Date(s.ini) : null,
           n: norm(((s.it||{}).title||"") + " " + ((s.it||{}).description||"")), cats: new Set(s.cats || []), strong: new Set(s.so || []),
           strongItens: new Set(s.si || []), itens: s.itens, _snap: true, _valor: s.valor, _origem: s.origem };
}
const recById = id => items.get(id) || (snaps[id] ? deSnap(snaps[id]) : ((particip.get(id) || {}).snap ? deSnap(particip.get(id).snap) : null));
function salvaLocal(){ store.set("marks", marks); store.set("motivos", motivos); store.set("snaps", snaps); store.set("pendentes", [...pendentes]); }

function atualizaSync(){
  const el = $("#sync");
  if(!API){ el.textContent = "Arquivo local: marcações só neste navegador"; el.className = "sync"; return; }
  el.textContent = apiOk ? (pendentes.size ? "Sincronizando marcações…" : "✓ Marcações sincronizadas") : "Marcações salvas só neste aparelho (sem conexão com o banco)";
  el.className = "sync" + (apiOk && !pendentes.size ? " ok" : "");
}
async function enviar(id){
  if(!API || !apiOk){ pendentes.add(id); salvaLocal(); atualizaSync(); return; }
  try{
    let r;
    if(marks[id]){
      const mo = motivos[id] || {};
      const fr = [...conf(recById(id) || {strong:new Set(), strongItens:null})].map(nomeCat).join(", ");
      r = await fetch(API + "/" + encodeURIComponent(id), { method:"PUT", headers:{"content-type":"application/json"},
        body: JSON.stringify({ acao: marks[id], motivo: mo.m || null, obs: mo.obs || null, frentes: fr, snap: snaps[id] || null }) });
    } else {
      r = await fetch(API + "/" + encodeURIComponent(id), { method:"DELETE" });
    }
    if(!r.ok) throw new Error("HTTP " + r.status);
    pendentes.delete(id); if(marks[id]) servidorIds.add(id); else servidorIds.delete(id);
  }catch(e){ apiOk = false; pendentes.add(id); }
  salvaLocal(); atualizaSync();
}
async function carregarServidor(){
  if(!API){ atualizaSync(); return; }
  try{
    const r = await fetch(API, { cache:"no-store" });
    if(!r.ok || !(r.headers.get("content-type")||"").includes("json")) throw new Error("sem API");
    const j = await r.json();
    const localMarks = { ...marks }, localMot = { ...motivos };
    apiOk = true; servidorIds = new Set(); marks = {}; motivos = {};
    for(const m of j.marcas || []){
      servidorIds.add(m.id); marks[m.id] = m.acao;
      if(m.motivo || m.obs) motivos[m.id] = { m: m.motivo, obs: m.obs };
      if(m.snap) snaps[m.id] = m.snap;
    }
    // primeira vez: sobe as marcações antigas deste aparelho; depois, só o que mudou sem conexão
    const subir = new Set(pendentes);
    if(!store.get("migrado", false)) Object.keys(localMarks).forEach(id => { if(!servidorIds.has(id)) subir.add(id); });
    for(const id of subir){
      if(localMarks[id]){ marks[id] = localMarks[id]; if(localMot[id]) motivos[id] = localMot[id]; } else delete marks[id];
    }
    for(const id of Object.keys(snaps)) if(!marks[id]) delete snaps[id];
    salvaLocal(); store.set("migrado", true);
    atualizaSync();
    for(const id of subir) await enviar(id);
    await Promise.all([carregarAnalises(), carregarParticipacoes(), carregarDocsMestre()]);
  }catch(e){ apiOk = false; atualizaSync(); }
}

// ---- pré-análise (fila no banco; quem processa é a rodada agendada no Claude)
let analises = new Map();          // id -> {status, resumo, pedido_em, concluido_em, erro}
const analiseTexto = new Map();    // id -> resultado em markdown (carregado ao abrir)
const analiseAberta = new Set();
async function carregarAnalises(){
  if(!API || !apiOk) return;
  try{
    const r = await fetchT("/api/analises", { cache:"no-store" }, 15000);
    if(!r.ok) return;
    const j = await r.json(); analises = new Map((j.analises || []).map(a => [a.id, a]));
  }catch(e){}
}
const SLOTS_RODADA = [[7,6],[13,6]]; // dias úteis, horário de Brasília (tarefa agendada no Claude)
function rodadaPerdida(pedidoIso){
  // houve um horário de rodada depois do pedido, há mais de 90 min, e o pedido segue na fila?
  const pedido = new Date(pedidoIso), agora = new Date();
  for(let dia = new Date(pedido.getFullYear(), pedido.getMonth(), pedido.getDate()); dia <= agora; dia.setDate(dia.getDate() + 1)){
    if(dia.getDay() === 0 || dia.getDay() === 6) continue;
    for(const [h, m] of SLOTS_RODADA){ const t = new Date(dia); t.setHours(h, m, 0, 0); if(t > pedido && agora - t > 90 * 60000) return t; }
  }
  return null;
}
function proximaRodada(){
  const d = new Date(); const slots = SLOTS_RODADA;
  for(let i = 0; i < 8; i++){
    const dia = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i);
    if(dia.getDay() === 0 || dia.getDay() === 6) continue;
    for(const [h, m] of slots){ const t = new Date(dia); t.setHours(h, m, 0, 0); if(t > d) return t; }
  }
  return null;
}
function fmtRodada(t){
  if(!t) return "";
  const hoje = new Date(); const am = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate() + 1);
  const hora = t.toLocaleTimeString("pt-BR", { hour:"2-digit", minute:"2-digit" });
  if(t.toDateString() === hoje.toDateString()) return "hoje " + hora;
  if(t.toDateString() === am.toDateString()) return "amanhã " + hora;
  return t.toLocaleDateString("pt-BR", { weekday:"short", day:"2-digit", month:"2-digit" }) + " " + hora;
}
async function pedirAnalise(id){
  if(!API || !apiOk){ toast("A pré-análise precisa da conexão com o banco do monitor"); return; }
  if(marks[id] !== "interesse") marcar(id, "interesse");
  const rec = recById(id);
  const snap = snaps[id] || (rec ? snapshot(rec) : null);
  try{
    const r = await fetchT("/api/analises/" + encodeURIComponent(id), { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({ snap }) }, 15000);
    if(!r.ok) throw new Error("HTTP " + r.status);
    analises.set(id, { id, status:"pendente", pedido_em: new Date().toISOString() });
    analiseTexto.delete(id); analiseAberta.delete(id);
    render(); toast("Pré-análise na fila (" + fmtRodada(proximaRodada()) + ") · o edital está na aba Interesse");
  }catch(e){ toast("Não consegui pedir a pré-análise. Tente de novo."); }
}
async function cancelarAnalise(id){
  try{ await fetchT("/api/analises/" + encodeURIComponent(id), { method:"DELETE" }, 15000); analises.delete(id); render(); toast("Pedido de pré-análise cancelado"); }
  catch(e){ toast("Não consegui cancelar agora"); }
}
async function abrirAnalise(id){
  if(analiseAberta.has(id)){ analiseAberta.delete(id); render(); return; }
  analiseAberta.add(id);
  if(!analiseTexto.has(id)){
    try{ const r = await fetchT("/api/analises/" + encodeURIComponent(id), { cache:"no-store" }, 15000); const j = await r.json(); analiseTexto.set(id, j.resultado || "(sem texto)"); }
    catch(e){ analiseTexto.set(id, "Não consegui carregar a pré-análise agora."); }
  }
  render();
}
// ---- pipeline: mover de etapa; a pasta no SharePoint e o checklist saem na rodada agendada
async function carregarParticipacoes(){
  if(!API || !apiOk) return;
  try{
    const r = await fetchT("/api/participacoes", { cache:"no-store" }, 15000);
    if(!r.ok) return;
    const j = await r.json(); particip = new Map((j.participacoes || []).map(p => [p.id, p]));
  }catch(e){}
}
async function moverEtapa(id, etapa, arquivar){
  if(!API || !apiOk){ toast("O pipeline precisa da conexão com o banco do monitor"); return; }
  const atual = particip.get(id);
  const rec = recById(id);
  const snap = atual ? null : (snaps[id] || (rec ? snapshot(rec) : null));
  // entrar no pipeline também marca interesse (aprendizado + cópia do edital)
  if(!atual && marks[id] !== "interesse") marcar(id, "interesse");
  try{
    const r = await fetchT("/api/participacoes/" + encodeURIComponent(id), { method:"PUT", headers:{"content-type":"application/json"},
      body: JSON.stringify({ etapa, snap, arquivar: arquivar === undefined ? null : arquivar }) }, 15000);
    if(!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json(); const agora = new Date().toISOString();
    const novo = { ...(atual || { id, criado_em: agora, snap }), etapa, pasta_status: j.pasta_status, arquivar: j.arquivar, atualizado_em: agora };
    if(j.pasta_status === "pendente" && (!atual || atual.pasta_status !== "pendente")){ novo.pasta_pedida_em = agora; novo.erro = null; }
    particip.set(id, novo);
    abrirResultado = null; confirmarTirar = null; render();
    if(!atual) toast("Foi para a aba Pipeline · pasta e checklist na rodada de " + fmtRodada(proximaRodada()));
    else toast(nomeEtapa(etapa) + (j.arquivar === "pendente" ? " · a pasta vai para ARQUIVADOS na próxima rodada" : ""));
  }catch(e){ toast("Não consegui mover agora. Tente de novo."); }
}
async function pedirPasta(id){
  try{
    const r = await fetchT("/api/participacoes/" + encodeURIComponent(id) + "/pasta", { method:"POST" }, 15000);
    if(!r.ok) throw new Error("HTTP " + r.status);
    const p = particip.get(id); if(p){ p.pasta_status = "pendente"; p.pasta_pedida_em = new Date().toISOString(); p.erro = null; }
    render(); toast("Checklist na fila · rodada de " + fmtRodada(proximaRodada()));
  }catch(e){ toast("Não consegui pedir agora. Tente de novo."); }
}
async function tirarDoPipeline(id){
  try{
    const r = await fetchT("/api/participacoes/" + encodeURIComponent(id), { method:"DELETE" }, 15000);
    if(!r.ok) throw new Error("HTTP " + r.status);
    particip.delete(id); confirmarTirar = null; render();
    toast("Saiu do pipeline (a pasta no SharePoint continua lá)");
  }catch(e){ toast("Não consegui tirar agora"); }
}
function blocoPipeline(rec){
  const p = particip.get(rec.id); if(!p) return "";
  let h = '<div class="analise-linha pipe">';
  if(p.pasta_status === "pendente"){
    const perdida = p.pasta_pedida_em ? rodadaPerdida(p.pasta_pedida_em) : null;
    h += '<span class="pill">pasta e checklist na fila · ' + esc(fmtRodada(proximaRodada())) + '</span>' +
         (perdida ? '<span class="pill warn">a rodada de ' + esc(perdida.toLocaleString("pt-BR", { weekday:"short", hour:"2-digit", minute:"2-digit" })) + ' não rodou</span>' : '');
  }
  else if(p.pasta_status === "criando") h += '<span class="pill">criando a pasta e o checklist…</span>';
  else if(p.pasta_status === "erro" && /PNCP fora do ar/i.test(p.erro || "")) h += '<span class="pill warn">PNCP fora do ar</span><span class="meta">pasta e checklist tentam de novo na rodada de ' + esc(fmtRodada(proximaRodada())) + '</span>';
  else if(p.pasta_status === "erro") h += '<span class="pill warn">pasta/checklist falhou</span><span class="meta">' + esc((p.erro || "").slice(0, 160)) + '</span><button class="mark" type="button" data-act="pedirPasta">tentar de novo</button>';
  else if(p.pasta_status === "pronta"){
    const rz = p.resumo || {};
    if(p.pasta_url) h += '<a href="' + esc(p.pasta_url) + '" target="_blank" rel="noopener">📁 Pasta no SharePoint ↗</a>';
    if(p.checklist_url) h += '<a href="' + esc(p.checklist_url) + '" target="_blank" rel="noopener">📋 Checklist ↗</a>';
    if(ATIVAS.has(p.etapa)){
    if(rz.ok != null) h += '<span class="pill ok">' + rz.ok + ' ok</span>';
    if(rz.emitir) h += '<span class="pill">' + rz.emitir + ' a emitir</span>';
    if(rz.falta) h += '<span class="pill warn">' + rz.falta + ' faltando</span>';
    const venc = (rz.vencidos || 0) + (rz.vence_antes || 0);
    if(venc) h += '<span class="pill warn">' + venc + ' vencido(s) na sessão</span>';
    if(rz.conferir) h += '<span class="pill ghost">' + rz.conferir + ' conferir</span>';
    h += '<button class="mark" type="button" data-act="pedirPasta">refazer checklist</button>';
    }
  }
  if(p.arquivar === "pendente") h += '<span class="pill">vai para ARQUIVADOS na próxima rodada</span>';
  else if(p.arquivar === "feito") h += '<span class="pill ghost">pasta arquivada</span>';
  else if(p.arquivar === "erro") h += '<span class="pill warn">não consegui arquivar a pasta</span><span class="meta">' + esc((p.erro || "").slice(0, 120)) + '</span>';
  h += '</div>';
  const pend = (p.resumo && p.resumo.pendencias) || [];
  if(p.pasta_status === "pronta" && ATIVAS.has(p.etapa) && pend.length)
    h += '<ul class="pend">' + pend.slice(0, 6).map(x => '<li>' + esc(x) + '</li>').join("") + (pend.length > 6 ? '<li>+ ' + (pend.length - 6) + ' no checklist</li>' : '') + '</ul>';
  return h;
}
function botoesPipeline(p){
  const e = (et, txt, cls) => '<button class="mark' + (cls ? " " + cls : "") + '" type="button" data-act="etapa" data-etapa="' + et + '">' + txt + '</button>';
  const tirar = confirmarTirar === p.id
    ? '<button class="mark dis" type="button" data-act="tirarSim">confirmar: tirar do pipeline</button>'
    : '<button class="mark" type="button" data-act="tirar">tirar do pipeline</button>';
  if(p.etapa === "participar") return e("proposta", "📨 Proposta enviada", "go") + e("desistimos", "Desistimos") + tirar;
  if(p.etapa === "proposta") return e("ganhamos", "🏆 Ganhamos", "go") + e("perdemos", "Perdemos") + e("desistimos", "Desistimos") + e("participar", "↩ voltar");
  const arquivavel = p.etapa !== "ganhamos" && (p.pasta_url || p.pasta_id) && !p.arquivar;
  return e("proposta", "↩ reabrir") + (arquivavel ? '<button class="mark" type="button" data-act="arquivar">📦 Arquivar pasta</button>' : '') + tirar;
}
function painelResultado(id, etapa){
  return '<div class="motivos"><div class="q">' + (etapa === "perdemos" ? "Perdemos." : "Desistimos.") + ' Mover a pasta desta licitação para ARQUIVADOS?</div>' +
    '<div class="opts"><button class="mark go" type="button" data-act="resSim">Sim, mover na próxima rodada</button>' +
    '<button class="mark" type="button" data-act="resNao">Não, deixar onde está</button>' +
    '<button class="mark" type="button" data-act="resCancelar">Cancelar</button></div></div>';
}

// ---- aviso de certidões da pasta-mestre (a rodada agendada grava os nomes dos arquivos)
const PASTA_MESTRE_URL = "https://nanosolucoesti.sharepoint.com/Documentos%20Compartilhados/NANO/LICITACOES/DOCUMENTOS%20PADRAO%20-%20HABILITACAO";
const DIAS_AVISO_VAL = 15;              // validade: avisa com 15 dias de antecedência
const IDADE_AVISO = 50, IDADE_RUIM = 90; // "(emitida …)": editais costumam aceitar 60 ou 90 dias
let docsMestre = null;
async function carregarDocsMestre(){
  if(!API || !apiOk) return;
  try{ const r = await fetchT("/api/docs-mestre", { cache:"no-store" }, 15000); if(r.ok) docsMestre = await r.json(); }catch(e){}
}
const fmtDia = d => d.toLocaleDateString("pt-BR", { day:"2-digit", month:"2-digit", year:"numeric" });
function situacaoDocs(){
  const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
  const out = [];
  for(const nome of (docsMestre && docsMestre.nomes) || []){
    const m = nome.match(/\(val (\d{2})-(\d{2})-(\d{4})\)/i), e = nome.match(/\(emitida (\d{2})-(\d{2})-(\d{4})\)/i);
    if(!m && !e) continue;
    const rotulo = nome.replace(/\.[a-z0-9]{2,4}$/i, "").replace(/\s*\((val|emitida) [^)]*\)/i, "").replace(/^\d+[a-z]?\s*-\s*/i, "").trim();
    const x = m || e; const d = new Date(+x[3], +x[2] - 1, +x[1]);
    if(m){ const dias = Math.round((d - hoje) / 86400000); out.push({ nome, rotulo, tipo:"val", data:d, dias, nivel: dias < 0 ? 2 : dias <= DIAS_AVISO_VAL ? 1 : 0 }); }
    else { const idade = Math.round((hoje - d) / 86400000); out.push({ nome, rotulo, tipo:"emitida", data:d, idade, nivel: idade >= IDADE_RUIM ? 2 : idade >= IDADE_AVISO ? 1 : 0 }); }
  }
  return out;
}
function avisoDocs(){
  const el = $("#avisoDocs"); if(!el) return;
  if(!API || !apiOk || !docsMestre || !docsMestre.atualizado_em){ el.hidden = true; return; }
  const docs = situacaoDocs();
  const conferido = docsMestre.atualizado_em ? new Date(docsMestre.atualizado_em).toLocaleString("pt-BR", { day:"2-digit", month:"2-digit", hour:"2-digit", minute:"2-digit" }) : null;
  const pasta = '<a href="' + esc(docsMestre.pasta_url || PASTA_MESTRE_URL) + '" target="_blank" rel="noopener">Pasta-mestre ↗</a>';
  const rod = '<span class="rod">' + (conferido ? "conferido em " + esc(conferido) + " (rodada automática)" : "ainda não conferido pela rodada") + '</span>';
  el.hidden = false;
  if(!docs.length){ el.className = "aviso-docs ok"; el.innerHTML = '<span class="t">Certidões da pasta-mestre</span><span>nenhum arquivo com "(val …)" ou "(emitida …)" no nome</span>' + pasta + rod; return; }
  // sessões do pipeline em andamento, para cruzar com as validades
  const sessoes = [...particip.values()].filter(p => ATIVAS.has(p.etapa) && p.snap && p.snap.fim)
    .map(p => ({ fim: new Date(p.snap.fim), orgao: ((p.snap.it || {}).orgao_nome || "").trim() })).filter(s => s.fim > new Date());
  const ruins = docs.filter(d => d.nivel > 0).sort((a, b) => (b.nivel - a.nivel) || (a.data - b.data));
  const afeta = d => d.tipo === "val" && d.dias >= 0 ? sessoes.filter(s => d.data < s.fim) : [];
  const extra = docs.filter(d => d.nivel === 0 && afeta(d).length);
  if(!ruins.length && !extra.length){
    const prox = docs.filter(d => d.tipo === "val").sort((a, b) => a.data - b.data)[0];
    el.className = "aviso-docs ok";
    el.innerHTML = '<span class="t">✓ Certidões da pasta-mestre em dia</span>' + (prox ? '<span>próximo vencimento: <b>' + esc(prox.rotulo) + '</b> em <span class="mono">' + esc(fmtDia(prox.data)) + '</span></span>' : '') + pasta + rod;
    return;
  }
  const nV = docs.filter(d => d.nivel === 2).length, nA = docs.filter(d => d.nivel === 1).length;
  el.className = "aviso-docs " + (nV ? "red" : "amber");
  const linha = d => {
    let t;
    if(d.tipo === "val") t = d.dias < 0 ? '<span class="tag-r">vencida</span> desde <span class="mono">' + esc(fmtDia(d.data)) + '</span>'
                          : (d.dias === 0 ? '<span class="tag-a">vence hoje</span>' : (d.nivel ? '<span class="tag-a">vence em ' + d.dias + (d.dias === 1 ? ' dia' : ' dias') + '</span>' : 'vale até')) + ' (<span class="mono">' + esc(fmtDia(d.data)) + '</span>)';
    else t = '<span class="' + (d.nivel === 2 ? "tag-r" : "tag-a") + '">emitida há ' + d.idade + ' dias</span> (<span class="mono">' + esc(fmtDia(d.data)) + '</span>) · editais costumam aceitar até 60 ou 90 dias';
    const s = afeta(d);
    if(s.length) t += ' · <b>antes da sessão</b> de ' + s.slice(0, 2).map(x => esc(x.orgao) + ' (' + esc(fmtDia(x.fim).slice(0, 5)) + ')').join(", ") + (s.length > 2 ? ' e mais ' + (s.length - 2) : '');
    return '<li><b>' + esc(d.rotulo) + '</b> — ' + t + '</li>';
  };
  const partes = []; if(nV) partes.push(nV + (nV === 1 ? " vencida" : " vencidas")); if(nA) partes.push(nA + " perto de vencer"); if(extra.length) partes.push(extra.length + " vence antes de sessão do pipeline");
  el.innerHTML = '<div class="t">⚠ Certidões da pasta-mestre: ' + esc(partes.join(" · ")) + '</div>' +
    '<ul>' + ruins.concat(extra).map(linha).join("") + '</ul>' +
    '<div class="rod">Renove, suba na pasta-mestre com a nova data no nome, ex. <span class="mono">10 - CRF FGTS (val DD-MM-AAAA).pdf</span>, e apague a antiga. ' + pasta + ' · ' + (conferido ? "conferido em " + esc(conferido) + " (rodada automática)" : "") + '</div>';
}

// markdown simples -> HTML (títulos, listas, tabelas, negrito, links)
function md(src){
  const inline = s => esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const linhas = String(src || "").replace(/\r/g, "").split("\n"); let h = "", lista = false, tabela = false;
  const fecha = () => { if(lista){ h += "</ul>"; lista = false; } if(tabela){ h += "</table></div>"; tabela = false; } };
  for(const l of linhas){
    const t = l.trim();
    if(/^\|.*\|$/.test(t)){
      if(/^\|[\s:|-]+\|$/.test(t)) continue;
      if(!tabela){ fecha(); h += '<div class="tbl"><table>'; tabela = true; }
      h += "<tr>" + t.slice(1, -1).split("|").map(c => "<td>" + inline(c.trim()) + "</td>").join("") + "</tr>"; continue;
    }
    if(/^[-*] /.test(t)){ if(tabela) fecha(); if(!lista){ h += "<ul>"; lista = true; } h += "<li>" + inline(t.slice(2)) + "</li>"; continue; }
    fecha();
    if(!t) continue;
    const m = t.match(/^(#{1,4}) (.*)$/);
    if(m){ h += "<h" + (m[1].length + 2) + ">" + inline(m[2]) + "</h" + (m[1].length + 2) + ">"; continue; }
    h += "<p>" + inline(t) + "</p>";
  }
  fecha(); return h;
}
function blocoAnalise(rec){
  if(!API) return "";
  const a = analises.get(rec.id);
  let h = '<div class="analise-linha">';
  if(!a) h += '<button class="mark" type="button" data-act="pedir">🔍 Pedir pré-análise</button>';
  else if(a.status === "pendente"){
    const perdida = rodadaPerdida(a.pedido_em);
    h += '<span class="pill">pré-análise na fila · ' + esc(fmtRodada(proximaRodada())) + '</span>' +
         (perdida ? '<span class="pill warn">a rodada de ' + esc(perdida.toLocaleString("pt-BR", { weekday:"short", hour:"2-digit", minute:"2-digit" })) + ' não rodou</span><span class="meta">computador desligado, app do Claude fechado ou login do monitor expirado no navegador do app</span>' : '') +
         '<button class="mark" type="button" data-act="cancelarAnalise">cancelar</button>';
  }
  else if(a.status === "processando") h += '<span class="pill">analisando os documentos…</span>';
  else if(a.status === "erro" && /PNCP fora do ar/i.test(a.erro || "")) h += '<span class="pill warn">PNCP fora do ar</span><span class="meta">tenta de novo na rodada de ' + esc(fmtRodada(proximaRodada())) + '</span>';
  else if(a.status === "erro") h += '<span class="pill warn">pré-análise falhou</span><span class="meta">' + esc((a.erro || "").slice(0, 160)) + '</span><button class="mark" type="button" data-act="pedir">tentar de novo</button>';
  else if(a.status === "pronta"){
    const rz = a.resumo || {};
    h += '<span class="pill ok">pré-análise pronta</span>' + (rz.recomendacao ? '<span class="pill ' + (/n[aã]o/i.test(rz.recomendacao) ? "warn" : "lime") + '">' + esc(rz.recomendacao) + '</span>' : "") +
         (rz.sessao ? '<span class="meta">sessão ' + esc(rz.sessao) + '</span>' : "") +
         '<button class="mark" type="button" data-act="verAnalise">' + (analiseAberta.has(rec.id) ? "fechar" : "ver pré-análise") + '</button>' +
         '<button class="mark" type="button" data-act="pedir">refazer</button>';
  }
  h += '</div>';
  if(a && a.status === "pronta" && analiseAberta.has(rec.id)) h += '<div class="analise">' + md(analiseTexto.get(rec.id) || "Carregando…") + '</div>';
  return h;
}

// ---- tema
function applyTheme(t){ if(t) document.documentElement.setAttribute("data-theme", t); else document.documentElement.removeAttribute("data-theme"); }
applyTheme(store.get("theme", null));
$("#themeBtn").addEventListener("click", () => {
  const cur = document.documentElement.getAttribute("data-theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const nxt = cur === "dark" ? "light" : "dark"; applyTheme(nxt); store.set("theme", nxt);
});

// ---- chips das linhas Sophos
const linhasRow = $("#linhasSophos");
for(const [k, c] of Object.entries(CATS)){
  if(c.grupo !== "sophos") continue;
  const b = document.createElement("button");
  b.className = "chip sub"; b.type = "button"; b.dataset.linha = k; b.textContent = c.nome;
  b.setAttribute("aria-pressed", c.off ? "false" : "true");
  linhasRow.appendChild(b);
}
const savedG = store.get("grupos", null), savedL = store.get("linhas", null);
if(savedG) document.querySelectorAll(".chip[data-grupo]").forEach(b => b.setAttribute("aria-pressed", savedG.includes(b.dataset.grupo)));
if(savedL) document.querySelectorAll(".chip[data-linha]").forEach(b => b.setAttribute("aria-pressed", savedL.includes(b.dataset.linha)));
function catsAtivas(){
  const g = new Set([...document.querySelectorAll(".chip[data-grupo][aria-pressed=true]")].map(b => b.dataset.grupo));
  const l = new Set([...document.querySelectorAll(".chip[data-linha][aria-pressed=true]")].map(b => b.dataset.linha));
  linhasRow.classList.toggle("off", !g.has("sophos"));
  return new Set(Object.keys(CATS).filter(c => g.has(CATS[c].grupo) && (CATS[c].grupo !== "sophos" || l.has(c))));
}

// ---- estado
let items = new Map();   // id -> registro da busca atual
let details = new Map(); // id -> detalhe da API de consulta
let running = false;
let aba = "abertos";
let abrirMotivo = null;   // id do card com o painel de motivo aberto
let motivoEscolhido = null;  // motivo marcado no painel aberto (só grava ao confirmar)
const rascunhoObs = {};      // id -> texto da observação sendo digitada (sobrevive às atualizações da lista)

function setStatus(t){ $("#status").textContent = t; }
function toast(t){ const el=$("#toast"); el.textContent=t; el.classList.add("on"); setTimeout(()=>el.classList.remove("on"), 2000); }
function horaAgora(){ return new Date().toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"}); }

async function pool(tasks, n, onTick){
  let i=0, done=0; const out=new Array(tasks.length);
  async function worker(){ while(i<tasks.length){ const k=i++; try{ out[k]=await tasks[k](); }catch(e){ out[k]={__err:e}; } done++; onTick && onTick(done, tasks.length); } }
  await Promise.all(Array.from({length:Math.min(n,tasks.length)}, worker));
  return out;
}
const conf = rec => { const s = new Set(rec.strong); if(rec.strongItens) rec.strongItens.forEach(c => s.add(c)); return s; };
// fetch com limite de tempo: o PNCP às vezes para de responder e a tela não pode ficar presa
async function fetchT(url, opts, ms){
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms || 25000);
  try{ return await fetch(url, { ...(opts || {}), signal: c.signal }); } finally { clearTimeout(t); }
}

async function buscar(){
  if(running) return; running = true;
  $("#btnAtualizar").disabled = true;
  const termCats = new Map();
  for(const [cat, c] of Object.entries(CATS)) for(const t of c.terms){ if(!termCats.has(t)) termCats.set(t, []); termCats.get(t).push(cat); }
  const jobs = [...termCats.entries()].map(([t, cats]) => async () => {
    const soSup = cats.every(c => c === "sup");
    const base = SEARCH + "?q=" + encodeURIComponent(t) + "&tipos_documento=edital&ordenacao=-data&tam_pagina=500&status=recebendo_proposta" + (soSup ? "&ufs=" + UFS_SUP : "");
    let todos = [];
    for(let p = 1; p <= 4; p++){
      const r = await fetchT(base + "&pagina=" + p, null, 30000);
      if(!r.ok) throw new Error("HTTP "+r.status);
      const j = await r.json(); const its = j.items || [];
      todos = todos.concat(its);
      if(its.length < 500 || todos.length >= (j.total || 0)) break;
    }
    return { cats, items: todos };
  });
  let falhas = 0;
  const res = await pool(jobs, 6, (d,n) => setStatus("Buscando no PNCP… "+d+"/"+n));
  const fresh = new Map();
  const agora = Date.now();
  for(const r of res){
    if(!r || r.__err){ falhas++; continue; }
    for(const it of r.items){
      const id = it.numero_controle_pncp || it.id;
      const km = MUN[String(it.codigo_ibge||"")];
      if(km === undefined) continue;
      const fim = it.data_fim_vigencia ? new Date(it.data_fim_vigencia) : null;
      if(fim && fim.getTime() < agora) continue;
      let rec = fresh.get(id);
      if(!rec){
        rec = { id, it, km, fim, ini: it.data_inicio_vigencia ? new Date(it.data_inicio_vigencia) : null,
                n: norm((it.title||"") + " " + (it.description||"")), cats:new Set(), strong:new Set(), strongItens:null, itens:null };
        fresh.set(id, rec);
      }
      r.cats.forEach(c => rec.cats.add(c));
    }
  }
  for(const rec of fresh.values()){
    for(const cat of Object.keys(CATS)) if(forteEm(cat, rec.n)){ rec.strong.add(cat); rec.cats.add(cat); }
    const c = itensCache[rec.id];
    if(c && Date.now() - c.t < ITENS_TTL) aplicaItens(rec, c.m);
  }
  items = fresh;
  running = false;
  $("#btnAtualizar").disabled = false;
  $("#lastRun").textContent = "Última consulta: " + new Date().toLocaleString("pt-BR") + (falhas ? " · " + falhas + " busca(s) falharam" : "") + ".";
  window.__falhasBusca = falhas;
  atualizaSnaps();
  preencheUFs();
  treinar();
  render();
  store.set("seen", Array.from(new Set([...prevSeen, ...items.keys()])).slice(-3000));
  await verificarItens();
}

// cópias dos editais marcados: renova com os dados atuais; marcação antiga sem cópia ganha uma e sobe para o banco
function atualizaSnaps(){
  const subir = [];
  for(const [id, m] of Object.entries(marks)){
    if(!m || !items.has(id)) continue;
    const tinha = !!snaps[id];
    snaps[id] = snapshot(items.get(id));
    if(!tinha) subir.push(id);
  }
  for(const id of Object.keys(snaps)) if(!marks[id]) delete snaps[id];
  salvaLocal();
  subir.forEach(id => enviar(id));
}

// ---- conferência dos itens de cada edital
function aplicaItens(rec, m){ rec.itens = m; rec.strongItens = new Set(Object.keys(m).filter(c => !rec.strong.has(c))); }
let verifRodando = false, verifPendente = false;
async function verificarItens(){
  if(verifRodando){ verifPendente = true; return; }
  verifRodando = true;
  const f0 = filtros();
  const cand = [...items.values()].filter(r => !r.itens && marks[r.id] !== "descartado" && passaUF(r, f0) && !elegiveis(r, f0).length
      && [...r.cats].some(c => c !== "sup" && f0.ativas.has(c) && dentro(r, c, f0)));
  if(cand.length){
    await pool(cand.map(rec => async () => {
      const it = rec.it; let arr = [];
      for(let p = 1; p <= 4; p++){
        const r = await fetchT(ITENS + it.orgao_cnpj + "/compras/" + it.ano + "/" + it.numero_sequencial + "/itens?pagina=" + p + "&tamanhoPagina=500", null, 20000);
        if(!r.ok) throw new Error("HTTP " + r.status);
        const j = await r.json(); const a = Array.isArray(j) ? j : (j.data || []);
        arr = arr.concat(a); if(a.length < 500) break;
      }
      const m = {};
      for(const x of arr){
        // só o nome do item (começo da descrição): a ficha técnica longa cita "backup", "suporte" etc. de passagem
        const n = norm((x.descricao||"").slice(0, 100));
        for(const cat of Object.keys(CATS)) if(itemCasa(cat, n)) (m[cat] = m[cat] || []).push([x.numeroItem, (x.descricao||"").replace(/\s+/g," ").slice(0,140), x.quantidade, x.unidadeMedida, x.valorTotal]);
      }
      for(const k in m) m[k] = m[k].slice(0, 5);
      itensCache[rec.id] = { t: Date.now(), m };
      aplicaItens(rec, m);
      if(Object.keys(m).length) renderDepois(1200);
    }), 6, (d,n) => setStatus("Conferindo itens dos editais… " + d + "/" + n));
    const ks = Object.keys(itensCache);
    if(ks.length > 1500) ks.sort((a,b) => itensCache[a].t - itensCache[b].t).slice(0, ks.length - 1500).forEach(k => delete itensCache[k]);
    store.set("itens", itensCache);
  }
  atualizaSnaps();
  treinar();
  const f = window.__falhasBusca || 0;
  setStatus(f ? "Atualizado com " + f + " falha(s) na busca — tente de novo." : "Atualizado às " + horaAgora());
  renderDepois(50);
  verifRodando = false;
  if(verifPendente){ verifPendente = false; verificarItens(); }
}

// ---- aprendizado: palavras do objeto/itens dos marcados como interesse x descartados
const STOP = new Set(("para pela pelo pelos pelas com sem dos das nos nas por que uma uns umas este esta esse essa isso como mais menos entre sobre conforme demais " +
  "diversos diversas atender atendimento necessidades necessidade secretaria secretarias municipal municipais municipio prefeitura camara estado estadual " +
  "contratacao contratar empresa empresas especializada especializado especializadas prestacao servico servicos fornecimento aquisicao aquisicoes " +
  "registro precos preco futura futuras futuro eventual eventuais objeto presente licitacao pregao eletronico edital forma modalidade item itens lote lotes " +
  "unidade unidades periodo meses anos visando destinados destinadas destinado destinada conforme termo referencia anexo durante tipo").split(" "));
function tokens(texto){ return [...new Set(norm(texto).replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(w => w.length >= 4 && !STOP.has(w) && !/^\d+$/.test(w)))]; }
function tokensRec(rec){
  const chave = rec.itens || null;
  if(!rec._tok || rec._tokChave !== chave){ rec._tok = tokens(textoRec(rec)); rec._tokChave = chave; }
  return rec._tok;
}
function textoRec(rec){ const its = rec.itens ? Object.values(rec.itens).flat().map(x => x[1]).join(" ") : ""; return (rec.it.description || rec.it.title || "") + " " + its; }
function valorRec(rec){ const d = details.get(rec.id) || {}; return d.valorTotalEstimado || rec.it.valor_global || rec._valor || (snaps[rec.id] && snaps[rec.id].valor) || 0; }
let modelo = { pronto:false, nI:0, nD:0 };
function treinar(){
  const I = [], D = [];
  for(const [id, a] of Object.entries(marks)){
    const rec = recById(id); if(!rec) continue;
    (a === "interesse" ? I : D).push({ rec, t: tokensRec(rec) });
  }
  // descarte por distância, valor, prazo, exigência ou duplicidade não diz nada sobre o assunto do edital:
  // esses entram como regra (km/valor) e ficam fora do aprendizado por palavras
  const NAO_ASSUNTO = new Set(["longe", "valor", "prazo", "exigencia", "duplicado"]);
  const DW = D.filter(d => !NAO_ASSUNTO.has((motivos[d.rec.id]||{}).m));
  const cI = new Map(), cD = new Map();
  I.forEach(d => d.t.forEach(w => cI.set(w, (cI.get(w)||0) + 1)));
  DW.forEach(d => d.t.forEach(w => cD.set(w, (cD.get(w)||0) + 1)));
  const peso = new Map();
  for(const w of new Set([...cI.keys(), ...cD.keys()])){
    const pI = ((cI.get(w)||0) + 1) / (I.length + 2), pD = ((cD.get(w)||0) + 1) / (DW.length + 2);
    peso.set(w, Math.log(pI / pD));
  }
  const longe = D.filter(d => (motivos[d.rec.id]||{}).m === "longe").map(d => d.rec.km).filter(k => k != null);
  const baixos = D.filter(d => (motivos[d.rec.id]||{}).m === "valor").map(d => valorRec(d.rec)).filter(v => v > 0);
  const contMot = {}; D.forEach(d => { const m = (motivos[d.rec.id]||{}).m || "sem"; contMot[m] = (contMot[m]||0) + 1; });
  modelo = { pronto: I.length >= 2 && D.length >= 3, nI: I.length, nD: D.length, peso, cI, cD,
             prior: Math.log((I.length + 1) / (DW.length + 1)),
             kmLonge: longe.length ? Math.min(...longe) : null, valorBaixo: baixos.length ? Math.max(...baixos) : null, contMot };
}
function pontua(rec){
  if(!modelo.pronto) return null;
  const tok = tokensRec(rec), v0 = valorRec(rec);
  if(rec._pModelo === modelo && rec._pTok === tok && rec._pV === v0) return rec._p;
  let s = modelo.prior;
  for(const w of tok){ const p = modelo.peso.get(w); if(p) s += p; }
  if(modelo.kmLonge != null && rec.km >= modelo.kmLonge) s -= 1.5;
  const v = valorRec(rec); if(modelo.valorBaixo != null && v > 0 && v <= modelo.valorBaixo) s -= 1.5;
  s = Math.max(-8, Math.min(8, s));
  rec._pModelo = modelo; rec._pTok = tok; rec._pV = v0;
  return (rec._p = 1 / (1 + Math.exp(-s)));
}

function filtros(){
  return {
    ativas: catsAtivas(),
    supRaio: +$("#raioSup").value,
    alcance: +$("#alcance").value,
    uf: $("#uf").value,
    ordem: $("#ordem").value,
    fracos: $("#fracos").checked,
    soLD: $("#soLD").checked,
    ocultarProv: $("#ocultarProv").checked,
    q: norm($("#busca").value.trim())
  };
}
const isLD = rec => /licitar digital/i.test(rec.it.usuario_nome || "") || /licitardigital/i.test(((details.get(rec.id)||{}).linkSistemaOrigem) || rec._origem || "");
function diasAte(d){ if(!d) return null; return Math.ceil((d.getTime() - Date.now())/86400000); }
// suporte respeita o raio do suporte; as demais frentes, o alcance escolhido
const dentro = (rec, c, f) => rec.km <= (c === "sup" ? f.supRaio : f.alcance);
const passaUF = (rec, f) => !f.uf || rec.it.uf === f.uf;
const elegiveis = (rec, f) => [...conf(rec)].filter(c => f.ativas.has(c) && dentro(rec, c, f));
function passaTexto(rec, q){ if(!q) return true; return (rec.n + " " + norm(rec.it.orgao_nome) + " " + norm(rec.it.municipio_nome) + " " + norm(rec.it.unidade_nome)).includes(q); }
function preencheUFs(){
  const sel = $("#uf"); const cur = sel.value || ((store.get("filtros", {}) || {}).uf || "");
  const ufs = [...new Set([...items.values()].map(r => r.it.uf).filter(Boolean))].sort();
  sel.innerHTML = '<option value="">Todas as UFs</option>' + ufs.map(u => '<option' + (u === cur ? ' selected' : '') + '>' + esc(u) + '</option>').join("");
}
const prazoDe = r => r.fim ? r.fim.getTime() : 9e15;

// Abertos = só o que ainda não foi triado: ao marcar Interesse, Vamos participar ou Descartar, o edital sai daqui e vai para a aba dele.
// Com {todos:true} (números do topo) entram também os triados, menos os descartados.
function listaAbertos(f, todos){
  const out = [];
  for(const rec of items.values()){
    if(marks[rec.id] === "descartado") continue;
    if(!todos && (marks[rec.id] === "interesse" || particip.has(rec.id))) continue;
    if(!passaUF(rec, f)) continue;
    const confirmadas = elegiveis(rec, f);
    const forte = confirmadas.length > 0;
    const fraco = !forte && [...rec.cats].some(c => f.ativas.has(c) && dentro(rec, c, f));
    if(!forte && !(fraco && f.fracos)) continue;
    if(f.soLD && !isLD(rec)) continue;
    if(!passaTexto(rec, f.q)) continue;
    const p = marks[rec.id] ? null : pontua(rec);
    if(f.ocultarProv && p != null && p < 0.3) continue;
    out.push({ rec, forte, confirmadas, p });
  }
  if(f.ordem === "km") out.sort((a,b) => (a.rec.km - b.rec.km) || (prazoDe(a.rec) - prazoDe(b.rec)));
  else if(f.ordem === "relevancia") out.sort((a,b) => ((b.p == null ? 0.5 : b.p) - (a.p == null ? 0.5 : a.p)) || (prazoDe(a.rec) - prazoDe(b.rec)));
  else out.sort((a,b) => prazoDe(a.rec) - prazoDe(b.rec));
  return out;
}
function listaMarcadas(acao, f){
  const out = [];
  for(const [id, m] of Object.entries(marks)){
    if(m !== acao) continue;
    if(acao === "interesse" && particip.has(id)) continue;   // já está no pipeline
    const rec = recById(id); if(!rec) continue;
    if(!passaTexto(rec, f.q)) continue;
    out.push({ rec, forte: true, confirmadas: [...conf(rec)], p: null });
  }
  out.sort((a,b) => prazoDe(a.rec) - prazoDe(b.rec));
  return out;
}
const idsCom = acao => Object.keys(marks).filter(id => marks[id] === acao && recById(id));
const ordemEtapa = Object.fromEntries(ETAPAS.map((e, i) => [e[0], Math.min(i, 2)]));
function listaPipeline(f){
  const out = [];
  for(const [id, p] of particip){
    const rec = recById(id); if(!rec) continue;
    if(!passaTexto(rec, f.q)) continue;
    out.push({ rec, forte: true, confirmadas: [...conf(rec)], p: null, etapa: p.etapa });
  }
  const quando = v => String((particip.get(v.rec.id) || {}).atualizado_em || "");
  out.sort((a, b) => (ordemEtapa[a.etapa] - ordemEtapa[b.etapa]) ||
    (ATIVAS.has(a.etapa) ? prazoDe(a.rec) - prazoDe(b.rec) : quando(b).localeCompare(quando(a))));
  return out;
}
function visiveis(){
  const f = filtros();
  if(aba === "pipeline") return listaPipeline(f);
  if(aba === "interesse") return listaMarcadas("interesse", f);
  if(aba === "descartados") return listaMarcadas("descartado", f);
  if(aba === "aprendizado") return [];
  return listaAbertos(f);
}

function fmtData(d){ return d ? d.toLocaleDateString("pt-BR",{day:"2-digit",month:"2-digit"}) + " " + d.toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"}) : "—"; }
function fmtValor(v){ return (v && v > 0) ? v.toLocaleString("pt-BR",{style:"currency",currency:"BRL",maximumFractionDigits:0}) : null; }
function plataforma(rec){ const d = details.get(rec.id); if(isLD(rec)) return "Licitar Digital"; return (d && d.usuarioNome) || rec.it.usuario_nome || "—"; }
function linkPncp(rec){ const u = rec.it.item_url || ""; return "https://pncp.gov.br/app/editais" + u.replace(/^\/compras/,""); }
function itensDe(rec, cats){
  if(!rec.itens) return [];
  const vistos = new Set(), out = [];
  for(const c of cats){ if(rec.strong.has(c)) continue; for(const x of (rec.itens[c] || [])){ if(!vistos.has(x[0])){ vistos.add(x[0]); out.push(x); } } }
  return out;
}
function itemTxt(x){ const v = fmtValor(x[4]); return "Item " + x[0] + " · " + x[1] + (x[2] ? " · " + x[2] + " " + (x[3]||"") : "") + (v ? " · " + v : ""); }

function painelMotivo(id){
  return '<div class="motivos" data-id="' + esc(id) + '">' +
    '<div class="q">Por que descartar? <span class="meta">escolha o motivo, detalhe se quiser e confirme</span></div>' +
    '<div class="opts">' + MOTIVOS.map(m => '<button class="mot" type="button" data-motivo="' + m[0] + '" aria-pressed="' + (motivoEscolhido === m[0]) + '">' + esc(m[1]) + '</button>').join("") + '</div>' +
    '<div class="obs"><input type="text" class="obs-in" maxlength="300" value="' + esc(rascunhoObs[id] || "") + '" placeholder="Observação (opcional): ex. exige atestado de 500 usuários">' +
    '<button class="mark dis" type="button" data-act="confirmarDescarte">✕ Descartar</button>' +
    '<button class="mark" type="button" data-act="cancelar">Cancelar</button></div></div>';
}

function card(v){
  const { rec, forte, confirmadas, p } = v; const it = rec.it; const d = details.get(rec.id) || {};
  const dias = diasAte(rec.fim);
  const marca = marks[rec.id] || "";
  const encerrado = rec.fim && rec.fim.getTime() < Date.now();
  const part = particip.get(rec.id);
  const naPipe = aba === "pipeline" && part;
  const cls = ["ed"]; if(!forte) cls.push("weak");
  if(naPipe && (part.etapa === "perdemos" || part.etapa === "desistimos")) cls.push("disc");
  else if(naPipe && part.etapa === "ganhamos") cls.push("won");
  else if(marca === "descartado") cls.push("disc");
  else if(!encerrado && dias !== null && dias <= 3) cls.push("urg"); else if(!encerrado && dias !== null && dias <= 7) cls.push("soon");
  const pills = [];
  if(part) pills.push('<span class="pill etapa e-' + esc(part.etapa) + '">' + (naPipe ? "" : "pipeline · ") + esc(nomeEtapa(part.etapa)) + '</span>');
  if(!marca && !firstVisit && !prevSeen.has(rec.id) && !rec._snap) pills.push('<span class="pill new">novo</span>');
  for(const c of confirmadas) pills.push('<span class="pill">' + esc(nomeCat(c)) + (rec.strong.has(c) ? "" : ' <small>· nos itens</small>') + '</span>');
  if(!forte){ const ff = filtros(); for(const c of rec.cats) if(ff.ativas.has(c) && dentro(rec, c, ff)) pills.push('<span class="pill ghost">possível · ' + esc(nomeCat(c)) + '</span>'); }
  if(isLD(rec)) pills.push('<span class="pill lime">Licitar Digital</span>');
  if(p != null && p < 0.3) pills.push('<span class="pill warn">parece descarte</span>');
  else if(p != null && p > 0.7) pills.push('<span class="pill ok">parece interesse</span>');
  if(rec._snap) pills.push('<span class="pill ghost">' + (encerrado ? "encerrado" : "fora da busca atual") + '</span>');
  const diasTxt = dias === null ? "" : (encerrado ? "encerrado" : (dias <= 0 ? "fecha hoje" : (dias === 1 ? "fecha amanhã" : "fecha em "+dias+" dias")));
  const valor = fmtValor(d.valorTotalEstimado) || fmtValor(it.valor_global) || fmtValor(rec._valor);
  const linkOrigem = d.linkSistemaOrigem || rec._origem;
  const origem = linkOrigem ? '<a href="'+esc(linkOrigem)+'" target="_blank" rel="noopener">Sistema de origem ↗</a>' : "";
  const obj = (it.description || it.title || "").replace(/^\[[^\]]+\]\s*-\s*/,"");
  const its = itensDe(rec, confirmadas);
  const itensHtml = its.length ? '<div class="itens">' + its.slice(0,4).map(x => '<div><b>Item ' + esc(x[0]) + '</b> · ' + esc(x[1]) + (x[2] ? ' · ' + esc(x[2]) + ' ' + esc(x[3]||"") : '') + (fmtValor(x[4]) ? ' · ' + esc(fmtValor(x[4])) : '') + '</div>').join("") + (its.length > 4 ? '<div>+ ' + (its.length-4) + ' item(ns)</div>' : '') + '</div>' : "";
  const mo = motivos[rec.id];
  const motivoHtml = marca === "descartado" ? '<div class="motivo-lido">✕ ' + esc(nomeMotivo(mo && mo.m)) + (mo && mo.obs ? ' — ' + esc(mo.obs) : '') + '</div>' : "";
  const botoes = naPipe ? botoesPipeline(part)
    : marca === "descartado"
    ? '<button class="mark" type="button" data-act="restaurar">↩ Restaurar</button>'
    : '<button class="mark int" type="button" data-act="interesse" aria-pressed="'+(marca==="interesse")+'">★ Interesse</button>' +
      (part ? '<button class="mark" type="button" data-act="irPipeline">ver no pipeline</button>'
            : (API ? '<button class="mark go" type="button" data-act="participar">✅ Vamos participar</button>' : '') +
              '<button class="mark dis" type="button" data-act="descartar">✕ Descartar</button>');
  return '<article class="'+cls.join(" ")+'" data-id="'+esc(rec.id)+'" data-k="'+esc(rec.id)+'">'+
    '<div class="top">'+pills.join("")+'<span class="days">'+esc(diasTxt)+'</span></div>'+
    '<h3>'+esc(it.orgao_nome || "")+'</h3>'+
    '<div class="meta">'+esc(it.municipio_nome)+'/'+esc(it.uf)+' · <span class="mono">'+(rec.km != null ? rec.km.toLocaleString("pt-BR") : "?")+' km</span> · '+esc(it.modalidade_licitacao_nome||"")+' · encerra <span class="mono">'+esc(fmtData(rec.fim))+'</span>'+(it.unidade_nome && it.unidade_nome!==it.orgao_nome ? ' · '+esc(it.unidade_nome) : '')+'</div>'+
    '<p class="obj">'+esc(obj)+'</p>'+ itensHtml + motivoHtml +
    '<div class="foot">'+
      (valor ? '<span class="val">'+esc(valor)+'</span>' : '<span class="meta">valor não informado</span>')+
      '<span class="meta">'+esc(plataforma(rec))+'</span>'+
      '<a href="'+esc(linkPncp(rec))+'" target="_blank" rel="noopener">Edital no PNCP ↗</a>'+origem+
      '<span class="sp"></span>'+ botoes +
    '</div>' + (naPipe ? blocoPipeline(rec) : '') + (marca !== "descartado" || naPipe ? blocoAnalise(rec) : '') +
    (abrirMotivo === rec.id ? painelMotivo(rec.id) : '') +
    (naPipe && abrirResultado && abrirResultado.id === rec.id ? painelResultado(rec.id, abrirResultado.etapa) : '') + '</article>';
}

function painelAprendizado(){
  const m = modelo;
  const nI = idsCom("interesse").length, nD = idsCom("descartado").length;
  let h = '<div class="learn">';
  h += '<div class="card"><h3>Onde estou</h3><p>' + nI + ' marcado(s) com interesse e ' + nD + ' descartado(s).</p>' +
       (m.pronto ? '<p>Já estou pontuando os editais abertos: os parecidos com seus interesses ganham o selo <span class="pill ok">parece interesse</span> e os parecidos com seus descartes, <span class="pill warn">parece descarte</span>. Use "Ordenar pelo que aprendi" ou "Ocultar prováveis descartes".</p>'
                 : '<p>Marque pelo menos 2 interesses e 3 descartes para eu começar a pontuar os editais abertos.</p>') +
       '<p>Tudo fica no banco do monitor, com o histórico de cada decisão. Quando você pedir ao Claude para revisar, ele lê esse histórico e ajusta os termos e filtros da busca.</p></div>';
  const mot = Object.entries(m.contMot || {}).sort((a,b) => b[1] - a[1]);
  h += '<div class="grid2"><div class="card"><h3>Motivos de descarte</h3>' + (mot.length
       ? '<table>' + mot.map(([k, n]) => '<tr><td>' + esc(k === "sem" ? "Sem motivo (marcação antiga)" : nomeMotivo(k)) + '</td><td class="n">' + n + '</td></tr>').join("") + '</table>'
       : '<p>Nenhum descarte ainda.</p>') + '</div>';
  h += '<div class="card"><h3>Limites que aprendi</h3>' +
       '<p>' + (m.kmLonge != null ? 'Editais a partir de <b>' + m.kmLonge.toLocaleString("pt-BR") + ' km</b> perdem pontos (descartes por "Longe ou exige presença").' : 'Distância: ainda sem descartes por "Longe ou exige presença".') + '</p>' +
       '<p>' + (m.valorBaixo != null ? 'Editais de até <b>' + esc(fmtValor(m.valorBaixo)) + '</b> perdem pontos (descartes por "Valor baixo").' : 'Valor: ainda sem descartes por "Valor baixo".') + '</p></div></div>';
  if(m.peso && m.peso.size){
    const lista = [...m.peso.entries()].filter(([w]) => ((m.cI.get(w)||0) + (m.cD.get(w)||0)) >= 2);
    const pro = lista.filter(e => e[1] > 0.3).sort((a,b) => b[1] - a[1]).slice(0, 15);
    const contra = lista.filter(e => e[1] < -0.3).sort((a,b) => a[1] - b[1]).slice(0, 15);
    h += '<div class="grid2"><div class="card"><h3>Palavras que puxam para interesse</h3><div class="words">' +
         (pro.length ? pro.map(([w]) => '<span class="pill ok">' + esc(w) + '</span>').join("") : '<p>Ainda poucas marcações.</p>') + '</div></div>' +
         '<div class="card"><h3>Palavras que puxam para descarte</h3><div class="words">' +
         (contra.length ? contra.map(([w]) => '<span class="pill warn">' + esc(w) + '</span>').join("") : '<p>Ainda poucas marcações.</p>') + '</div></div></div>';
  }
  return h + '</div>';
}

// troca só os cards que mudaram: o resto da lista fica intacto (clique e digitação não se perdem)
const htmlDoNo = new WeakMap();
function patchLista(partes){
  const el = $("#lista");
  const atuais = new Map();
  for(const n of el.children) if(n.dataset && n.dataset.k) atuais.set(n.dataset.k, n);
  const nos = partes.map(({ k, h }) => {
    const velho = atuais.get(k);
    if(velho && htmlDoNo.get(velho) === h) return velho;
    const t = document.createElement("template"); t.innerHTML = h.trim();
    const novo = t.content.firstElementChild; htmlDoNo.set(novo, h); return novo;
  });
  const filhos = [...el.children];
  if(filhos.length === nos.length && filhos.every((n, i) => n === nos[i])) return;
  if(filhos.length === nos.length && filhos.every((n, i) => n.dataset && n.dataset.k === nos[i].dataset.k)){
    filhos.forEach((n, i) => { if(n !== nos[i]) n.replaceWith(nos[i]); });
    return;
  }
  el.replaceChildren(...nos);
}
// atualizações em segundo plano (conferência de itens, detalhes): agrupadas e adiadas enquanto o botão do mouse/dedo
// está pressionado ou enquanto se digita a observação, para nenhum clique se perder
let ponteiroAbaixo = false, renderAgendado = null, renderPara = 0;
document.addEventListener("pointerdown", () => { ponteiroAbaixo = true; }, true);
["pointerup", "pointercancel"].forEach(ev => document.addEventListener(ev, () => { ponteiroAbaixo = false; }, true));
function renderDepois(ms){
  const quando = Date.now() + (ms == null ? 800 : ms);
  if(renderAgendado){ if(quando >= renderPara) return; clearTimeout(renderAgendado); }   // um pedido mais urgente antecipa o agendado
  const tenta = () => {
    const digitando = document.activeElement && document.activeElement.classList && document.activeElement.classList.contains("obs-in");
    if(ponteiroAbaixo || digitando){ renderPara = Date.now() + 400; renderAgendado = setTimeout(tenta, 400); return; }
    renderAgendado = null; render();
  };
  renderPara = quando; renderAgendado = setTimeout(tenta, quando - Date.now());
}

function render(){
  if(renderAgendado){ clearTimeout(renderAgendado); renderAgendado = null; }
  const f = filtros();
  const todosAbertos = listaAbertos(f, true);
  const abertos = todosAbertos.filter(v => marks[v.rec.id] !== "interesse" && !particip.has(v.rec.id));
  const noRaio = todosAbertos.filter(v => v.forte);
  const tem = (r, pred) => elegiveis(r, f).some(pred);
  $("#nTotal").textContent = noRaio.length;
  $("#n7").textContent = noRaio.filter(v => { const d = diasAte(v.rec.fim); return d !== null && d <= 7; }).length;
  $("#nSeg").textContent = noRaio.filter(v => tem(v.rec, c => CATS[c].grupo === "sophos")).length;
  $("#nBackup").textContent = noRaio.filter(v => tem(v.rec, c => c === "backup")).length;
  $("#nM365").textContent = noRaio.filter(v => tem(v.rec, c => c === "m365")).length;
  $("#nSup").textContent = noRaio.filter(v => tem(v.rec, c => c === "sup")).length;
  $("#nLD").textContent = noRaio.filter(v => isLD(v.rec)).length;
  const nInt = idsCom("interesse").length, nDesc = idsCom("descartado").length;
  const nTriagem = idsCom("interesse").filter(id => !particip.has(id)).length;
  const nPipe = [...particip.values()].filter(p => ATIVAS.has(p.etapa)).length;
  $("#nInt").textContent = nInt;
  $("#tAb").textContent = abertos.length; $("#tInt").textContent = nTriagem; $("#tDesc").textContent = nDesc; $("#tPipe").textContent = nPipe;
  document.querySelectorAll(".tab").forEach(t => t.setAttribute("aria-selected", t.dataset.aba === aba));
  avisoDocs();
  if(aba === "aprendizado"){
    $("#countLbl").textContent = "";
    patchLista([{ k: "aprendizado", h: '<div data-k="aprendizado">' + painelAprendizado() + '</div>' }]);
    return;
  }
  const vis = aba === "abertos" ? abertos : visiveis();
  const fortes = vis.filter(v => v.forte).length;
  if(aba === "pipeline"){
    const and = vis.filter(v => ATIVAS.has(v.etapa)).length;
    $("#countLbl").textContent = and + " em andamento · " + (vis.length - and) + " com resultado";
  }
  else $("#countLbl").textContent = vis.length + (aba === "abertos" ? " na lista" + (vis.length !== fortes ? " · " + fortes + " confirmados" : "") : (aba === "interesse" ? " com interesse" : " descartados"));
  const vazio = aba === "interesse" ? "Nenhum edital marcado com ★ Interesse ainda."
              : aba === "descartados" ? "Nenhum edital descartado ainda."
              : aba === "pipeline" ? "Nada no pipeline ainda. Num edital de Abertos ou ★ Interesse, clique em ✅ Vamos participar: a rodada seguinte cria a pasta no SharePoint, copia os documentos da pasta-mestre e monta o checklist."
              : "Nenhum edital aberto com esses filtros. Amplie o raio ou o alcance, ligue mais linhas ou marque \"Mostrar possíveis\".";
  const partes = [];
  if(aba === "pipeline"){
    const titulos = ["Vamos participar", "Proposta enviada", "Resultado"]; let g = -1;
    for(const v of vis){
      const gi = ordemEtapa[v.etapa];
      if(gi !== g){ g = gi; partes.push({ k: "grp-" + gi, h: '<h2 class="grp" data-k="grp-' + gi + '">' + titulos[gi] + ' <span class="n">' + vis.filter(x => ordemEtapa[x.etapa] === gi).length + '</span></h2>' }); }
      partes.push({ k: v.rec.id, h: card(v) });
    }
  } else for(const v of vis) partes.push({ k: v.rec.id, h: card(v) });
  if(!vis.length) partes.push({ k: "vazio", h: '<div class="empty" data-k="vazio">' + vazio + '</div>' });
  const ativo = document.activeElement && document.activeElement.classList && document.activeElement.classList.contains("obs-in") ? document.activeElement : null;
  const foco = ativo ? { id: (ativo.closest(".ed") || {}).dataset?.id, ini: ativo.selectionStart, fim: ativo.selectionEnd } : null;
  patchLista(partes);
  if(foco && foco.id){
    const inp = document.querySelector('.ed[data-id="' + CSS.escape(foco.id) + '"] .obs-in');
    if(inp){ inp.focus({ preventScroll: true }); try{ inp.setSelectionRange(foco.ini, foco.fim); }catch(e){} }
  }
  carregarDetalhes(vis.slice(0, 120).map(v => v.rec).filter(r => !r._snap));
}

let detRun = 0;
async function carregarDetalhes(recs){
  const falta = recs.filter(r => !details.has(r.id));
  if(!falta.length) return;
  const myRun = ++detRun;
  await pool(falta.map(rec => async () => {
    if(details.has(rec.id)) return;
    const it = rec.it;
    const r = await fetchT(CONSULTA + it.orgao_cnpj + "/compras/" + it.ano + "/" + it.numero_sequencial, null, 15000);
    details.set(rec.id, r.ok ? await r.json() : {});
  }), 4);
  if(myRun === detRun) renderDepois();
}

// ---- marcações
function marcar(id, acao, motivo, obs){
  const rec = recById(id);
  if(acao){
    marks[id] = acao;
    if(acao === "descartado") motivos[id] = { m: motivo || null, obs: obs || null }; else delete motivos[id];
    if(rec) snaps[id] = rec._snap ? (snaps[id] || snapshot(rec)) : snapshot(rec);
  } else {
    // restaurar: reaproveita os itens já conferidos (ou confere agora) para o edital voltar aos abertos
    const vivo = items.get(id);
    if(vivo && !vivo.itens && snaps[id] && snaps[id].itens) aplicaItens(vivo, snaps[id].itens);
    delete marks[id]; delete motivos[id]; delete snaps[id];
    if(vivo && !vivo.itens) setTimeout(() => verificarItens(), 0);
  }
  salvaLocal(); treinar(); render(); enviar(id);
}
function confirmarDescarte(id){
  const inp = document.querySelector('.ed[data-id="' + CSS.escape(id) + '"] .obs-in');
  const obs = ((inp && inp.value) || rascunhoObs[id] || "").trim();
  if(!motivoEscolhido && !obs){ toast("Escolha um motivo ou escreva a observação"); if(inp) inp.focus({preventScroll:true}); return; }
  const mot = motivoEscolhido || "outro";
  abrirMotivo = null; motivoEscolhido = null; delete rascunhoObs[id];
  marcar(id, "descartado", mot, obs);
  toast("Descartado (" + nomeMotivo(mot) + ") · foi para a aba Descartados");
}
$("#lista").addEventListener("click", e => {
  const card = e.target.closest(".ed"); if(!card) return;
  const id = card.dataset.id;
  const mot = e.target.closest(".mot");
  if(mot){
    const inp = card.querySelector(".obs-in"); if(inp) rascunhoObs[id] = inp.value;
    motivoEscolhido = motivoEscolhido === mot.dataset.motivo ? null : mot.dataset.motivo;
    render();
    const novo = document.querySelector('.ed[data-id="' + CSS.escape(id) + '"] .obs-in'); if(novo){ novo.focus({preventScroll:true}); const n = novo.value.length; try{ novo.setSelectionRange(n, n); }catch(e){} }
    return;
  }
  const b = e.target.closest(".mark"); if(!b) return;
  const act = b.dataset.act;
  if(act === "interesse"){
    marcar(id, marks[id] === "interesse" ? null : "interesse");
    toast(marks[id] ? "★ Foi para a aba Interesse" : (particip.has(id) ? "Interesse removido" : "Interesse removido · voltou para Abertos"));
  }
  else if(act === "confirmarDescarte") confirmarDescarte(id);
  else if(act === "descartar"){ abrirMotivo = abrirMotivo === id ? null : id; motivoEscolhido = null; render(); const inp = document.querySelector('.ed[data-id="' + CSS.escape(id) + '"] .obs-in'); if(inp) inp.focus({preventScroll:true}); }
  else if(act === "cancelar"){ delete rascunhoObs[id]; abrirMotivo = null; motivoEscolhido = null; render(); }
  else if(act === "restaurar"){ marcar(id, null); toast("Voltou para Abertos"); }
  else if(act === "participar") moverEtapa(id, "participar");
  else if(act === "irPipeline"){ aba = "pipeline"; abrirMotivo = null; render(); window.scrollTo({ top: $(".tabs").offsetTop - 10 }); }
  else if(act === "etapa"){
    const et = b.dataset.etapa, p = particip.get(id);
    // perdeu/desistiu com pasta já criada: pergunta se arquiva
    if((et === "perdemos" || et === "desistimos") && p && (p.pasta_url || p.pasta_id || p.pasta_status === "pendente" || p.pasta_status === "criando")){ abrirResultado = { id, etapa: et }; render(); }
    else moverEtapa(id, et);
  }
  else if(act === "resSim" && abrirResultado) moverEtapa(id, abrirResultado.etapa, true);
  else if(act === "resNao" && abrirResultado) moverEtapa(id, abrirResultado.etapa, false);
  else if(act === "resCancelar"){ abrirResultado = null; render(); }
  else if(act === "arquivar"){ const p = particip.get(id); if(p) moverEtapa(id, p.etapa, true); }
  else if(act === "pedirPasta") pedirPasta(id);
  else if(act === "tirar"){ confirmarTirar = id; render(); }
  else if(act === "tirarSim") tirarDoPipeline(id);
  else if(act === "pedir") pedirAnalise(id);
  else if(act === "cancelarAnalise") cancelarAnalise(id);
  else if(act === "verAnalise") abrirAnalise(id);
});
$("#lista").addEventListener("keydown", e => {
  if(e.key === "Enter" && e.target.classList.contains("obs-in")){ e.preventDefault(); confirmarDescarte(e.target.closest(".ed").dataset.id); }
});
// guarda o que está sendo digitado: a lista se redesenha sozinha enquanto confere itens e detalhes
$("#lista").addEventListener("input", e => {
  if(e.target.classList.contains("obs-in")){ const c = e.target.closest(".ed"); if(c) rascunhoObs[c.dataset.id] = e.target.value; }
});

// ---- eventos
document.querySelectorAll(".tab").forEach(t => t.addEventListener("click", () => { aba = t.dataset.aba; abrirMotivo = null; abrirResultado = null; confirmarTirar = null; render(); }));
function salvaChips(){
  store.set("grupos", [...document.querySelectorAll(".chip[data-grupo][aria-pressed=true]")].map(b => b.dataset.grupo));
  store.set("linhas", [...document.querySelectorAll(".chip[data-linha][aria-pressed=true]")].map(b => b.dataset.linha));
}
document.querySelectorAll(".chip").forEach(b => b.addEventListener("click", () => {
  b.setAttribute("aria-pressed", b.getAttribute("aria-pressed") !== "true"); salvaChips(); render(); if(items.size) verificarItens();
}));
["#raioSup","#alcance","#uf"].forEach(s => $(s).addEventListener("change", () => { salvaFiltros(); render(); if(items.size) verificarItens(); }));
["#ordem","#fracos","#soLD","#ocultarProv"].forEach(s => $(s).addEventListener("change", () => { salvaFiltros(); render(); }));
function salvaFiltros(){ store.set("filtros", { raioSup:$("#raioSup").value, alcance:$("#alcance").value, uf:$("#uf").value, ordem:$("#ordem").value, fracos:$("#fracos").checked, soLD:$("#soLD").checked, ocultarProv:$("#ocultarProv").checked }); }
$("#busca").addEventListener("input", () => render());
$("#btnAtualizar").addEventListener("click", () => { itensCache = {}; store.set("itens", {}); carregarServidor().then(buscar); });

function linhas(){
  return visiveis().map(({rec, forte, confirmadas, p}) => {
    const it = rec.it, d = details.get(rec.id) || {};
    const fa = filtros().ativas;
    const frentes = forte ? confirmadas : [...rec.cats].filter(c => fa.has(c));
    const viaObj = confirmadas.some(c => rec.strong.has(c)), viaIt = confirmadas.some(c => !rec.strong.has(c));
    const mo = motivos[rec.id] || {};
    return {
      relevancia: forte ? "confirmado" : "possível",
      confirmado_em: forte ? (viaObj && viaIt ? "objeto+itens" : (viaObj ? "objeto" : "itens")) : "anexos",
      frentes: frentes.map(nomeCat).join(", "),
      orgao: it.orgao_nome || "", municipio: it.municipio_nome || "", uf: it.uf || "", km: rec.km,
      modalidade: it.modalidade_licitacao_nome || "", objeto: (it.description || "").replace(/\s+/g," "),
      itens_encontrados: itensDe(rec, confirmadas).map(itemTxt).join(" | "),
      abertura: fmtData(rec.ini), encerramento: fmtData(rec.fim), dias: diasAte(rec.fim),
      valor_estimado: d.valorTotalEstimado || it.valor_global || rec._valor || "", plataforma: plataforma(rec),
      processo: d.processo || "", numero_compra: d.numeroCompra || "",
      link_pncp: linkPncp(rec), link_origem: d.linkSistemaOrigem || rec._origem || "", controle_pncp: rec.id,
      marcacao: marks[rec.id] || "", etapa_pipeline: particip.has(rec.id) ? nomeEtapa(particip.get(rec.id).etapa) : "",
      pasta_sharepoint: (particip.get(rec.id) || {}).pasta_url || "", motivo: marks[rec.id] === "descartado" ? nomeMotivo(mo.m) : "", obs: mo.obs || "",
      pontuacao_aprendida: p == null ? "" : Math.round(p * 100) + "%"
    };
  });
}
$("#btnCsv").addEventListener("click", () => {
  const rows = linhas(); if(!rows.length){ toast("Nada para exportar"); return; }
  const cols = Object.keys(rows[0]);
  const cell = v => { const s = String(v==null?"":v); return /[;"\n]/.test(s) ? '"' + s.replace(/"/g,'""') + '"' : s; };
  const csv = "﻿" + cols.join(";") + "\n" + rows.map(r => cols.map(c => cell(r[c])).join(";")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], {type:"text/csv;charset=utf-8"}));
  a.download = "editais-nano-" + aba + "-" + new Date().toISOString().slice(0,10) + ".csv";
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
});
$("#btnZap").addEventListener("click", async () => {
  const rows = linhas().filter(r => r.relevancia === "confirmado");
  if(!rows.length){ toast("Nenhum edital confirmado na lista"); return; }
  const titulo = aba === "pipeline" ? "Pipeline de licitações" : aba === "interesse" ? "Editais com interesse" : aba === "descartados" ? "Editais descartados" : "Editais abertos";
  const txt = "*" + titulo + " · Nano TI* (" + new Date().toLocaleDateString("pt-BR") + ")\n\n" + rows.map(r =>
    "• " + (r.etapa_pipeline ? "[" + r.etapa_pipeline + "] " : "") + "*" + r.frentes + "* — " + r.orgao + " (" + r.municipio + "/" + r.uf + ", " + r.km + " km)\n  Encerra " + r.encerramento + (r.valor_estimado ? " · " + fmtValor(+r.valor_estimado) : "") + " · " + r.plataforma +
    (r.motivo ? "\n  Motivo: " + r.motivo + (r.obs ? " — " + r.obs : "") : "") +
    (r.itens_encontrados ? "\n  " + r.itens_encontrados.split(" | ")[0] : "") + "\n  " + r.link_pncp
  ).join("\n\n");
  try{ await navigator.clipboard.writeText(txt); toast("Copiado — cole no WhatsApp"); }
  catch(e){ const ta=document.createElement("textarea"); ta.value=txt; document.body.appendChild(ta); ta.select(); try{ document.execCommand("copy"); toast("Copiado — cole no WhatsApp"); }catch(_){ toast("Não consegui copiar"); } ta.remove(); }
});

// filtros salvos
const fs = store.get("filtros", null);
if(fs){
  if(fs.raioSup) $("#raioSup").value = fs.raioSup;
  if(fs.alcance) $("#alcance").value = fs.alcance;
  if(fs.ordem) $("#ordem").value = fs.ordem;
  $("#fracos").checked = !!fs.fracos; $("#soLD").checked = !!fs.soLD; $("#ocultarProv").checked = !!fs.ocultarProv;
}
catsAtivas();
atualizaSync();

// ---- ferramentas para a rodada agendada de pré-análise (usadas pelo Claude no navegador do app)
// Fluxo: fila() -> marcar(id,"processando") -> arquivos(id) / itens(id) -> ler(id, seq, inicio) em partes -> salvar(id, resultado, resumo)
const CDN = {
  pdf: "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js",
  pdfWorker: "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js",
  zip: "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"
};
const scriptsCarregados = {};
function carregaScript(src){
  if(!scriptsCarregados[src]) scriptsCarregados[src] = new Promise((ok, falha) => {
    const s = document.createElement("script"); s.src = src; s.onload = ok; s.onerror = () => falha(new Error("não carregou " + src)); document.head.appendChild(s);
  });
  return scriptsCarregados[src];
}
const filaSnaps = new Map();
const textoDoc = new Map();
const PROXY = "/api/pncp-proxy/";
function compraPath(id){
  const s = (filaSnaps.get(id) || snaps[id] || {}); const it = s.it || {};
  if(!it.orgao_cnpj){ const m = String(id).match(/^(\d{14})-\d+-0*(\d+)\/(\d{4})$/); if(m) return "orgaos/" + m[1] + "/compras/" + m[3] + "/" + m[2]; throw new Error("edital sem CNPJ/ano/sequencial: " + id); }
  return "orgaos/" + it.orgao_cnpj + "/compras/" + it.ano + "/" + it.numero_sequencial;
}
async function pdfTexto(buf){
  await carregaScript(CDN.pdf);
  const pdfjs = window.pdfjsLib; pdfjs.GlobalWorkerOptions.workerSrc = CDN.pdfWorker;
  const doc = await pdfjs.getDocument({ data: buf }).promise;
  let out = "";
  for(let p = 1; p <= doc.numPages; p++){
    const pg = await doc.getPage(p); const tc = await pg.getTextContent();
    out += "\n[página " + p + "]\n" + tc.items.map(i => i.str + (i.hasEOL ? "\n" : " ")).join("").replace(/[ \t]+\n/g, "\n");
  }
  return { paginas: doc.numPages, texto: out };
}
function docxTexto(xml){
  const d = new DOMParser().parseFromString(xml, "application/xml");
  return [...d.getElementsByTagName("w:p")].map(p => [...p.getElementsByTagName("w:t")].map(t => t.textContent).join("")).join("\n");
}
async function extrair(buf, nome){
  const b = new Uint8Array(buf.slice(0, 4)); const magic = String.fromCharCode(...b);
  if(magic.startsWith("%PDF")){ const r = await pdfTexto(buf); return { tipo:"pdf", paginas:r.paginas, texto:r.texto, escaneado: r.texto.replace(/\[página \d+\]|\s/g, "").length < r.paginas * 80 }; }
  if(magic.startsWith("PK")){
    await carregaScript(CDN.zip);
    const z = await window.JSZip.loadAsync(buf);
    if(z.file("word/document.xml")) return { tipo:"docx", texto: docxTexto(await z.file("word/document.xml").async("string")) };
    let out = "", lista = [];
    for(const f of Object.values(z.files)){
      if(f.dir) continue; lista.push(f.name);
      if(/\.(pdf|docx|txt)$/i.test(f.name)){
        try{ const r = await extrair(await f.async("arraybuffer"), f.name); out += "\n\n===== " + f.name + " (" + r.tipo + (r.paginas ? ", " + r.paginas + " pág." : "") + (r.escaneado ? ", ESCANEADO sem texto" : "") + ") =====\n" + r.texto; }
        catch(e){ out += "\n\n===== " + f.name + " (não consegui ler: " + e.message + ") =====\n"; }
      }
    }
    return { tipo:"zip", arquivos:lista, texto: out };
  }
  if(/\.txt$/i.test(nome || "")) return { tipo:"txt", texto: new TextDecoder().decode(buf) };
  return { tipo:"desconhecido (" + magic.replace(/[^\x20-\x7e]/g, "?") + ")", texto:"" };
}
const PNCP_FORA = /PNCP fora do ar/i;   // falha que a próxima rodada tenta de novo sozinha
function dadosSnap(id, snap){
  const it = (snap && snap.it) || {};
  return { id, orgao: it.orgao_nome, unidade: it.unidade_nome, municipio: it.municipio_nome, uf: it.uf, km: snap && snap.km,
           objeto: (it.description || it.title || "").replace(/^\[[^\]]+\]\s*-\s*/, ""), encerramento: snap && snap.fim, plataforma: it.usuario_nome,
           valor_estimado: snap && snap.valor, link_pncp: "https://pncp.gov.br/app/editais" + String(it.item_url || "").replace(/^\/compras/, ""),
           link_origem: snap && snap.origem, itens_encontrados: snap && snap.itens };
}
// nome da pasta no padrão da Nano: "ÓRGÃO-UF - MODALIDADE Nº 011.2026 - PROCESSO 022.2026"
function nomePastaDe(det, it){
  det = det || {}; it = it || {};
  const semAcento = s => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  let org = semAcento((det.orgaoEntidade && det.orgaoEntidade.razaoSocial) || it.orgao_nome || "ORGAO").toUpperCase().replace(/\s+/g, " ").trim();
  org = org.replace(/^MUNICIPIO (D[EOA]S?) /, "PREFEITURA $1 ");
  const uf = ((det.unidadeOrgao && det.unidadeOrgao.ufSigla) || it.uf || "").toUpperCase();
  const mn = semAcento(det.modalidadeNome || it.modalidade_licitacao_nome || "").toLowerCase();
  const mod = /preg/.test(mn) ? "PREGÃO" : /dispensa/.test(mn) ? "DISPENSA" : /concorr/.test(mn) ? "CONCORRÊNCIA" : /inexig/.test(mn) ? "INEXIGIBILIDADE"
            : /credenc/.test(mn) ? "CREDENCIAMENTO" : /leil/.test(mn) ? "LEILÃO" : (det.modalidadeNome || "COMPRA").toUpperCase();
  const ano = String(det.anoCompra || it.ano || new Date().getFullYear());
  const num = String(det.numeroCompra || it.numero_sequencial || "").replace(/\/\d{4}$/, "").trim();
  const proc = String(det.processo || "").trim().replace(/\//g, ".");
  let nome = org + (uf && !org.endsWith("-" + uf) ? "-" + uf : "") + " - " + mod + (num ? " Nº " + num + "." + ano : "") + (proc ? " - PROCESSO " + proc : "");
  nome = nome.replace(/[\\/:*?"<>|#%]/g, "-").replace(/\s+/g, " ").replace(/[. ]+$/, "").trim();
  return nome.length > 180 ? nome.slice(0, 180).trim() : nome;
}
async function apiPart(caminho, metodo, corpo){
  const r = await fetchT("/api/participacoes" + caminho, { method: metodo || "GET", cache:"no-store",
    headers: corpo ? {"content-type":"application/json"} : undefined, body: corpo ? JSON.stringify(corpo) : undefined }, 20000);
  if(!r.ok) throw new Error("participacoes" + caminho + " respondeu " + r.status + ": " + await r.text());
  return r.json();
}
window.nanoAnalise = {
  versao: 4,
  async fila(){
    const r = await fetchT("/api/analises", { cache:"no-store" }, 20000);
    if(!r.ok) throw new Error("API de análises respondeu " + r.status);
    const j = await r.json();
    // pendentes + os que falharam só porque o PNCP estava fora do ar; quem fecha antes vem primeiro
    return (j.analises || []).filter(a => a.status === "pendente" || (a.status === "erro" && PNCP_FORA.test(a.erro || "")))
      .map(a => {
        if(a.snap) filaSnaps.set(a.id, a.snap);
        const fim = a.snap && a.snap.fim ? new Date(a.snap.fim) : null;
        return { ...dadosSnap(a.id, a.snap), pedido_em: a.pedido_em, nova_tentativa: a.status === "erro", encerrado: !!(fim && fim < new Date()) };
      })
      .sort((x, y) => (x.encerrado - y.encerrado) || (String(x.encerramento || "9").localeCompare(String(y.encerramento || "9"))));
  },
  async marcar(id, status, extra){
    const r = await fetchT("/api/analises/" + encodeURIComponent(id), { method:"PUT", headers:{"content-type":"application/json"}, body: JSON.stringify({ status, ...(extra || {}) }) }, 20000);
    if(!r.ok) throw new Error("PUT respondeu " + r.status + ": " + await r.text());
    return true;
  },
  async detalhe(id){ const r = await fetchT(PROXY + "api/consulta/v1/" + compraPath(id), null, 30000); return r.ok ? r.json() : { erro: "HTTP " + r.status }; },
  async arquivos(id){
    const r = await fetchT(PROXY + "api/pncp/v1/" + compraPath(id) + "/arquivos", null, 45000);
    if(!r.ok) throw new Error("lista de arquivos respondeu " + r.status);
    const arr = await r.json();
    return (Array.isArray(arr) ? arr : []).filter(a => a.statusAtivo !== false)
      .map(a => ({ seq: a.sequencialDocumento, titulo: a.titulo, tipo: a.tipoDocumentoNome || a.tipoDocumentoDescricao, publicado: a.dataPublicacaoPncp }));
  },
  async itens(id){
    const r = await fetchT(PROXY + "api/pncp/v1/" + compraPath(id) + "/itens?pagina=1&tamanhoPagina=500", null, 45000);
    if(!r.ok) throw new Error("itens responderam " + r.status);
    const arr = await r.json();
    return (Array.isArray(arr) ? arr : (arr.data || [])).map(x => ({ numero:x.numeroItem, descricao:x.descricao, quantidade:x.quantidade, unidade:x.unidadeMedida,
      valor_unitario:x.valorUnitarioEstimado, valor_total:x.valorTotal, material_ou_servico:x.materialOuServicoNome, criterio:x.criterioJulgamentoNome, beneficio:x.tipoBeneficioNome }));
  },
  // lê um documento em partes de até `tamanho` caracteres; chame de novo com o `proximo` devolvido até ele vir null
  async ler(id, seq, inicio, tamanho){
    const chave = id + "#" + seq;
    if(!textoDoc.has(chave)){
      const r = await fetchT(PROXY + "api/pncp/v1/" + compraPath(id) + "/arquivos/" + seq, null, 90000);
      if(!r.ok) throw new Error("download respondeu " + r.status);
      const nome = ((r.headers.get("content-disposition") || "").match(/filename\*?=(?:UTF-8'')?"?([^";]+)/i) || [])[1] || "";
      const buf = await r.arrayBuffer();
      const x = await extrair(buf, decodeURIComponent(nome));
      textoDoc.set(chave, { nome: decodeURIComponent(nome), bytes: buf.byteLength, ...x });
    }
    const d = textoDoc.get(chave); const ini = inicio || 0; const tam = tamanho || 40000;
    const fim = Math.min(d.texto.length, ini + tam);
    return { arquivo: d.nome, tipo: d.tipo, paginas: d.paginas, escaneado: !!d.escaneado, arquivos_no_zip: d.arquivos, total: d.texto.length,
             inicio: ini, fim, proximo: fim < d.texto.length ? fim : null, texto: d.texto.slice(ini, fim) };
  },
  async salvar(id, resultado, resumo){ await this.marcar(id, "pronta", { resultado, resumo }); analises.set(id, { id, status:"pronta", resumo }); analiseTexto.set(id, resultado); render(); return true; },
  async falhar(id, erro){ await this.marcar(id, "erro", { erro: String(erro).slice(0, 1500) }); return true; },

  // ---- pipeline: pasta no SharePoint + checklist (rodada agendada)
  // Fluxo: pastasPendentes() -> pasta(id,"criando") -> nomePasta(id) / preAnalise(id) / arquivos / itens / ler
  //        -> (SharePoint e planilha fora daqui) -> pastaCriada(id, {pasta_url, pasta_id, checklist_url, resumo}) | pastaFalhou(id, erro)
  async pastasPendentes(){
    const j = await apiPart("");
    let an = new Map();
    try{ const ra = await fetchT("/api/analises", { cache:"no-store" }, 20000); if(ra.ok) an = new Map(((await ra.json()).analises || []).map(a => [a.id, a])); }catch(e){}
    return (j.participacoes || []).filter(p => p.pasta_status === "pendente" || (p.pasta_status === "erro" && PNCP_FORA.test(p.erro || "")))
      .sort((a, b) => String((a.snap || {}).fim || "9").localeCompare(String((b.snap || {}).fim || "9")))
      .map(p => {
        if(p.snap) filaSnaps.set(p.id, p.snap);
        return { ...dadosSnap(p.id, p.snap), etapa: p.etapa, pasta_pedida_em: p.pasta_pedida_em,
                 pasta_existente: (p.pasta_id || p.pasta_url) ? { id: p.pasta_id, url: p.pasta_url, checklist_url: p.checklist_url } : null,
                 pre_analise: an.has(p.id) ? an.get(p.id).status : null };
      });
  },
  async nomePasta(id){
    const s = filaSnaps.get(id) || snaps[id] || (particip.get(id) || {}).snap || {};
    const det = await this.detalhe(id);
    return { nome: nomePastaDe(det && !det.erro ? det : null, s.it), numero_compra: det && det.numeroCompra, processo: det && det.processo, modalidade: det && det.modalidadeNome };
  },
  async preAnalise(id){
    const r = await fetchT("/api/analises/" + encodeURIComponent(id), { cache:"no-store" }, 20000);
    if(r.status === 404) return null;
    if(!r.ok) throw new Error("análise respondeu " + r.status);
    const a = await r.json(); return { status: a.status, resumo: a.resumo, resultado: a.resultado };
  },
  async pasta(id, status, extra){ await apiPart("/" + encodeURIComponent(id) + "/pasta", "PUT", { pasta_status: status, ...(extra || {}) }); return true; },
  async pastaCriada(id, dados){
    const d = dados || {};
    await this.pasta(id, "pronta", { pasta_url: d.pasta_url, pasta_id: d.pasta_id, checklist_url: d.checklist_url, resumo: d.resumo, erro: null });
    const p = particip.get(id); if(p) Object.assign(p, { pasta_status: "pronta", pasta_url: d.pasta_url || p.pasta_url, pasta_id: d.pasta_id || p.pasta_id, checklist_url: d.checklist_url || p.checklist_url, resumo: d.resumo || p.resumo, erro: null });
    render(); return true;
  },
  async pastaFalhou(id, erro){
    await this.pasta(id, "erro", { erro: String(erro).slice(0, 1500) });
    const p = particip.get(id); if(p){ p.pasta_status = "erro"; p.erro = String(erro); } render(); return true;
  },
  async arquivarPendentes(){
    const j = await apiPart("");
    return (j.participacoes || []).filter(p => p.arquivar === "pendente")
      .map(p => ({ id: p.id, etapa: p.etapa, orgao: ((p.snap || {}).it || {}).orgao_nome, pasta_id: p.pasta_id, pasta_url: p.pasta_url }));
  },
  async arquivoFeito(id, pasta_url){ await apiPart("/" + encodeURIComponent(id) + "/arquivo", "PUT", { status: "feito", pasta_url: pasta_url || null }); const p = particip.get(id); if(p){ p.arquivar = "feito"; if(pasta_url) p.pasta_url = pasta_url; } render(); return true; },
  // nomes dos arquivos da raiz da pasta-mestre (a página calcula as validades e mostra o aviso)
  async documentos(nomes, pasta_url){
    const r = await fetchT("/api/docs-mestre", { method:"PUT", headers:{"content-type":"application/json"}, body: JSON.stringify({ nomes, pasta_url: pasta_url || null }) }, 20000);
    if(!r.ok) throw new Error("docs-mestre respondeu " + r.status + ": " + await r.text());
    await carregarDocsMestre(); render();
    return situacaoDocs().filter(d => d.nivel > 0).map(d => d.rotulo + (d.tipo === "val" ? (d.dias < 0 ? " — vencida" : " — vence em " + d.dias + " dias") : " — emitida há " + d.idade + " dias"));
  },
  async arquivoFalhou(id, erro){ await apiPart("/" + encodeURIComponent(id) + "/arquivo", "PUT", { status: "erro", erro: String(erro).slice(0, 1500) }); return true; }
};

carregarServidor().then(() => { treinar(); render(); });
buscar().catch(e => { running=false; $("#btnAtualizar").disabled=false; setStatus("Falha ao consultar o PNCP: " + e.message); $("#lista").innerHTML = '<div class="empty">Não consegui falar com o PNCP. Confira a internet e clique em Atualizar.</div>'; });
