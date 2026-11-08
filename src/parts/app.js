
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
const recById = id => items.get(id) || (snaps[id] ? deSnap(snaps[id]) : null);
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
  }catch(e){ apiOk = false; atualizaSync(); }
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
      const r = await fetch(base + "&pagina=" + p);
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
    let mudou = 0;
    await pool(cand.map(rec => async () => {
      const it = rec.it; let arr = [];
      for(let p = 1; p <= 4; p++){
        const r = await fetch(ITENS + it.orgao_cnpj + "/compras/" + it.ano + "/" + it.numero_sequencial + "/itens?pagina=" + p + "&tamanhoPagina=500");
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
      if(Object.keys(m).length && ++mudou % 5 === 0) render();
    }), 6, (d,n) => setStatus("Conferindo itens dos editais… " + d + "/" + n));
    const ks = Object.keys(itensCache);
    if(ks.length > 1500) ks.sort((a,b) => itensCache[a].t - itensCache[b].t).slice(0, ks.length - 1500).forEach(k => delete itensCache[k]);
    store.set("itens", itensCache);
  }
  atualizaSnaps();
  treinar();
  const f = window.__falhasBusca || 0;
  setStatus(f ? "Atualizado com " + f + " falha(s) na busca — tente de novo." : "Atualizado às " + horaAgora());
  render();
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
function textoRec(rec){ const its = rec.itens ? Object.values(rec.itens).flat().map(x => x[1]).join(" ") : ""; return (rec.it.description || rec.it.title || "") + " " + its; }
function valorRec(rec){ const d = details.get(rec.id) || {}; return d.valorTotalEstimado || rec.it.valor_global || rec._valor || (snaps[rec.id] && snaps[rec.id].valor) || 0; }
let modelo = { pronto:false, nI:0, nD:0 };
function treinar(){
  const I = [], D = [];
  for(const [id, a] of Object.entries(marks)){
    const rec = recById(id); if(!rec) continue;
    (a === "interesse" ? I : D).push({ rec, t: tokens(textoRec(rec)) });
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
  let s = modelo.prior;
  for(const w of tokens(textoRec(rec))){ const p = modelo.peso.get(w); if(p) s += p; }
  if(modelo.kmLonge != null && rec.km >= modelo.kmLonge) s -= 1.5;
  const v = valorRec(rec); if(modelo.valorBaixo != null && v > 0 && v <= modelo.valorBaixo) s -= 1.5;
  s = Math.max(-8, Math.min(8, s));
  return 1 / (1 + Math.exp(-s));
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

function listaAbertos(f){
  const out = [];
  for(const rec of items.values()){
    if(marks[rec.id] === "descartado") continue;
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
    const rec = recById(id); if(!rec) continue;
    if(!passaTexto(rec, f.q)) continue;
    out.push({ rec, forte: true, confirmadas: [...conf(rec)], p: null });
  }
  out.sort((a,b) => prazoDe(a.rec) - prazoDe(b.rec));
  return out;
}
const idsCom = acao => Object.keys(marks).filter(id => marks[id] === acao && recById(id));
function visiveis(){
  const f = filtros();
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
    '<div class="q">Por que descartar?</div>' +
    '<div class="opts">' + MOTIVOS.map(m => '<button class="mot" type="button" data-motivo="' + m[0] + '">' + esc(m[1]) + '</button>').join("") + '</div>' +
    '<div class="obs"><input type="text" class="obs-in" maxlength="300" placeholder="Observação (opcional): ex. exige atestado de 500 usuários">' +
    '<button class="mark" type="button" data-act="cancelar">Cancelar</button></div></div>';
}

function card(v){
  const { rec, forte, confirmadas, p } = v; const it = rec.it; const d = details.get(rec.id) || {};
  const dias = diasAte(rec.fim);
  const marca = marks[rec.id] || "";
  const encerrado = rec.fim && rec.fim.getTime() < Date.now();
  const cls = ["ed"]; if(!forte) cls.push("weak"); if(marca === "descartado") cls.push("disc");
  else if(!encerrado && dias !== null && dias <= 3) cls.push("urg"); else if(!encerrado && dias !== null && dias <= 7) cls.push("soon");
  const pills = [];
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
  const botoes = marca === "descartado"
    ? '<button class="mark" type="button" data-act="restaurar">↩ Restaurar</button>'
    : '<button class="mark int" type="button" data-act="interesse" aria-pressed="'+(marca==="interesse")+'">★ Interesse</button>' +
      '<button class="mark dis" type="button" data-act="descartar">✕ Descartar</button>';
  return '<article class="'+cls.join(" ")+'" data-id="'+esc(rec.id)+'">'+
    '<div class="top">'+pills.join("")+'<span class="days">'+esc(diasTxt)+'</span></div>'+
    '<h3>'+esc(it.orgao_nome || "")+'</h3>'+
    '<div class="meta">'+esc(it.municipio_nome)+'/'+esc(it.uf)+' · <span class="mono">'+(rec.km != null ? rec.km.toLocaleString("pt-BR") : "?")+' km</span> · '+esc(it.modalidade_licitacao_nome||"")+' · encerra <span class="mono">'+esc(fmtData(rec.fim))+'</span>'+(it.unidade_nome && it.unidade_nome!==it.orgao_nome ? ' · '+esc(it.unidade_nome) : '')+'</div>'+
    '<p class="obj">'+esc(obj)+'</p>'+ itensHtml + motivoHtml +
    '<div class="foot">'+
      (valor ? '<span class="val">'+esc(valor)+'</span>' : '<span class="meta">valor não informado</span>')+
      '<span class="meta">'+esc(plataforma(rec))+'</span>'+
      '<a href="'+esc(linkPncp(rec))+'" target="_blank" rel="noopener">Edital no PNCP ↗</a>'+origem+
      '<span class="sp"></span>'+ botoes +
    '</div>' + (abrirMotivo === rec.id ? painelMotivo(rec.id) : '') + '</article>';
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

function render(){
  const f = filtros();
  const abertos = listaAbertos(f);
  const noRaio = abertos.filter(v => v.forte);
  const tem = (r, pred) => elegiveis(r, f).some(pred);
  $("#nTotal").textContent = noRaio.length;
  $("#n7").textContent = noRaio.filter(v => { const d = diasAte(v.rec.fim); return d !== null && d <= 7; }).length;
  $("#nSeg").textContent = noRaio.filter(v => tem(v.rec, c => CATS[c].grupo === "sophos")).length;
  $("#nBackup").textContent = noRaio.filter(v => tem(v.rec, c => c === "backup")).length;
  $("#nM365").textContent = noRaio.filter(v => tem(v.rec, c => c === "m365")).length;
  $("#nSup").textContent = noRaio.filter(v => tem(v.rec, c => c === "sup")).length;
  $("#nLD").textContent = noRaio.filter(v => isLD(v.rec)).length;
  const nInt = idsCom("interesse").length, nDesc = idsCom("descartado").length;
  $("#nInt").textContent = nInt;
  $("#tAb").textContent = abertos.length; $("#tInt").textContent = nInt; $("#tDesc").textContent = nDesc;
  document.querySelectorAll(".tab").forEach(t => t.setAttribute("aria-selected", t.dataset.aba === aba));
  if(aba === "aprendizado"){
    $("#countLbl").textContent = "";
    $("#lista").innerHTML = painelAprendizado();
    return;
  }
  const vis = aba === "abertos" ? abertos : visiveis();
  const fortes = vis.filter(v => v.forte).length;
  $("#countLbl").textContent = vis.length + (aba === "abertos" ? " na lista" + (vis.length !== fortes ? " · " + fortes + " confirmados" : "") : (aba === "interesse" ? " com interesse" : " descartados"));
  const vazio = aba === "interesse" ? "Nenhum edital marcado com ★ Interesse ainda."
              : aba === "descartados" ? "Nenhum edital descartado ainda."
              : "Nenhum edital aberto com esses filtros. Amplie o raio ou o alcance, ligue mais linhas ou marque \"Mostrar possíveis\".";
  $("#lista").innerHTML = vis.length ? vis.map(card).join("") : '<div class="empty">' + vazio + '</div>';
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
    const r = await fetch(CONSULTA + it.orgao_cnpj + "/compras/" + it.ano + "/" + it.numero_sequencial);
    details.set(rec.id, r.ok ? await r.json() : {});
  }), 4);
  if(myRun === detRun) render();
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
$("#lista").addEventListener("click", e => {
  const card = e.target.closest(".ed"); if(!card) return;
  const id = card.dataset.id;
  const mot = e.target.closest(".mot");
  if(mot){
    const obs = (card.querySelector(".obs-in") || {}).value || "";
    abrirMotivo = null;
    marcar(id, "descartado", mot.dataset.motivo, obs.trim());
    toast("Descartado: " + nomeMotivo(mot.dataset.motivo));
    return;
  }
  const b = e.target.closest(".mark"); if(!b) return;
  const act = b.dataset.act;
  if(act === "interesse"){ marcar(id, marks[id] === "interesse" ? null : "interesse"); toast(marks[id] ? "★ Marcado com interesse" : "Interesse removido"); }
  else if(act === "descartar"){ abrirMotivo = abrirMotivo === id ? null : id; render(); const inp = document.querySelector('.ed[data-id="' + CSS.escape(id) + '"] .obs-in'); if(inp) inp.focus({preventScroll:true}); }
  else if(act === "cancelar"){ abrirMotivo = null; render(); }
  else if(act === "restaurar"){ marcar(id, null); toast("Restaurado para os abertos"); }
});
$("#lista").addEventListener("keydown", e => {
  if(e.key === "Enter" && e.target.classList.contains("obs-in")){
    const card = e.target.closest(".ed"); abrirMotivo = null;
    marcar(card.dataset.id, "descartado", "outro", e.target.value.trim()); toast("Descartado: Outro");
  }
});

// ---- eventos
document.querySelectorAll(".tab").forEach(t => t.addEventListener("click", () => { aba = t.dataset.aba; abrirMotivo = null; render(); }));
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
      marcacao: marks[rec.id] || "", motivo: marks[rec.id] === "descartado" ? nomeMotivo(mo.m) : "", obs: mo.obs || "",
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
  const titulo = aba === "interesse" ? "Editais com interesse" : aba === "descartados" ? "Editais descartados" : "Editais abertos";
  const txt = "*" + titulo + " · Nano TI* (" + new Date().toLocaleDateString("pt-BR") + ")\n\n" + rows.map(r =>
    "• *" + r.frentes + "* — " + r.orgao + " (" + r.municipio + "/" + r.uf + ", " + r.km + " km)\n  Encerra " + r.encerramento + (r.valor_estimado ? " · " + fmtValor(+r.valor_estimado) : "") + " · " + r.plataforma +
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

carregarServidor().then(() => { treinar(); render(); });
buscar().catch(e => { running=false; $("#btnAtualizar").disabled=false; setStatus("Falha ao consultar o PNCP: " + e.message); $("#lista").innerHTML = '<div class="empty">Não consegui falar com o PNCP. Confira a internet e clique em Atualizar.</div>'; });
