const MUN = __MUN__; // código IBGE -> km de Leme (todos os municípios do Brasil)
const UFS_SUP = "SP|MG";
const SEARCH = "https://pncp.gov.br/api/search/";
const CONSULTA = "https://pncp.gov.br/api/consulta/v1/orgaos/";
const ITENS = "https://pncp.gov.br/api/pncp/v1/orgaos/";
const ITENS_TTL = 12 * 3600 * 1000;

// ---- regras de relevância (texto normalizado: minúsculo, sem acento)
const SUP_ACT = /suporte|help ?desk|service ?desk|manutenc|assistencia tecnica|outsourcing|terceirizac|gerenciamento|monitoramento|sustentac|administracao de (rede|servidor)|central de (atendimento|servicos)|servicos (tecnicos |continuados |especializados |de suporte )*(de|em) (tecnologia da informacao|informatica|ti\b)/;
const SUP_TI  = /informatica|tecnologia da informacao|\bti\b|\btic\b|computador|notebook|rede (logica|de dados|de computadores)|servidor|data ?center|help ?desk|service ?desk|parque tecnologico/;
const SUP_NEG = /sistema (integrado )?de gestao|software de gestao|plataforma (integrada )?de gestao|gestao (publica|municipal)|cftv|videomonitoramento|impressora|impressao|outsourcing de impress|telefonia|veicul|equipamentos medic|hospitalar|viage|turismo|passage/;
const BKP_FORTE = /acronis|copias? de seguranca|recuperacao de desastre|armazenamento em nuvem/;
const BKP_TI  = /dados|informatica|\bti\b|\btic\b|servidor|sistema|nuvem|software|armazenamento|digital|arquivo/;
const BKP_NEG = /oxigenio|cilindro|medicinal|gerador/;
const ehSuporte = n => SUP_ACT.test(n) && SUP_TI.test(n) && !SUP_NEG.test(n);
// segurança patrimonial/eletrônica e obras usam as mesmas palavras ("monitoramento de segurança", "VPN" do alarme…)
const SEG_NEG = /vigilancia|patrimonial|alarme|cftv|videomonitoramento|portaria|obra|construcao|pavimentacao|reforma/;
const ITEM_NEG_GERAL = /^(contratacao de empresa para execucao de obra|execucao de obra|obra|construcao|reforma|pavimentacao)/;

const CATS = {
  fw:      { grupo:"sophos", nome:"Firewall",
             terms:['firewall','ngfw','utm','"firewall de próxima geração"','"equipamento segurança rede"','"sd-wan"','"filtro de conteúdo"','"filtragem de conteúdo"'],
             re:/firewall|\butm\b|ngfw|sd-?wan|equipamento seguranca rede|seguranca de perimetro|filtr(o|agem) de conteudo|filtro web|controle de navegacao/ },
  edp:     { grupo:"sophos", nome:"Endpoint/EDR/XDR",
             terms:['antivírus','endpoint','edr','xdr','antimalware','ransomware','"proteção de servidores"','"detecção e resposta"'],
             re:/antivirus|anti-virus|endpoint|\bedr\b|\bxdr\b|\bndr\b|\bitdr\b|antimalware|ransomware|deteccao e resposta|protecao (de|para) servidores/ },
  mdr:     { grupo:"sophos", nome:"MDR/SOC",
             terms:['mdr','"centro de operações de segurança"','"monitoramento de segurança"','"resposta a incidentes"'],
             re:/\bmdr\b|centro de operacoes de seguranca|monitoramento de seguranca|resposta a incidentes|\bsiem\b/, neg:SEG_NEG },
  ztna:    { grupo:"sophos", nome:"ZTNA/VPN",
             terms:['ztna','"zero trust"','"acesso remoto seguro"','vpn'],
             re:/ztna|zero trust|acesso remoto seguro|\bvpn\b/, neg:SEG_NEG },
  email:   { grupo:"sophos", nome:"E-mail seguro",
             terms:['antispam','"segurança de e-mail"','"proteção de e-mail"'],
             re:/anti-?spam|seguranca de e-?mail|protecao de e-?mail|filtro de e-?mail|gateway de e-?mail/ },
  vuln:    { grupo:"sophos", nome:"Nuvem/vulnerabilidades",
             terms:['"segurança em nuvem"','"gestão de vulnerabilidades"','"análise de vulnerabilidades"','"teste de intrusão"','pentest'],
             re:/seguranca (em|na|de) nuvem|cnapp|cspm|vulnerabilidade|pentest|teste de intrusao/, neg:SEG_NEG },
  aware:   { grupo:"sophos", nome:"Phishing/conscientização",
             terms:['phishing','"conscientização em segurança"'],
             re:/phishing|conscientizacao (em|de|sobre) seguranca/ },
  seginfo: { grupo:"sophos", nome:"Segurança da informação",
             terms:['sophos','"segurança da informação"','"segurança de rede"','"segurança cibernética"','cibersegurança'],
             re:/sophos|seguranca (da informacao|de rede|ciberneti)|ciberseguranca/, neg:SEG_NEG },
  rede:    { grupo:"sophos", nome:"Wi-Fi/switch", off:true,
             terms:['"access point"','"ponto de acesso"','"rede sem fio"','switch'],
             re:/access point|ponto de acesso (sem fio|wireless|wi-?fi)|rede sem fio|wi-?fi (corporativo|gerenciad)|\bswitch(es)?\b/ },
  backup:  { grupo:"backup", nome:"Backup",
             terms:['acronis','backup','"backup em nuvem"','"cópia de segurança"','"cópias de segurança"','"recuperação de desastres"','"armazenamento em nuvem"'],
             forte: n => (BKP_FORTE.test(n) || (/backup/.test(n) && BKP_TI.test(n))) && !BKP_NEG.test(n),
             itemRe:/acronis|veeam|backup|copias? de seguranca|recuperacao de desastre|armazenamento em nuvem/,
             itemNeg:/oxigenio|cilindro|medicinal|gerador|videomonitoramento|cftv|\bsom\b|audio/ },
  m365:    { grupo:"m365", nome:"Microsoft",
             terms:['"microsoft 365"','"office 365"','"licenças microsoft"','"licença microsoft"','"pacote office"','"exchange online"','"correio eletrônico"','"e-mail corporativo"','microsoft'],
             re:/microsoft|\boffice\b|\bm365\b|exchange|correio eletronico|e-?mails? (corporativo|institucional)/, neg:/cadeira|poltrona|office banking|home banking/,
             itemRe:/microsoft 365|\boffice\b|\bm365\b|exchange|licenca[^.]{0,40}microsoft|windows server/,
             itemNeg:/cadeira|poltrona|banking|curso|capacitacao|treinamento|^(notebook|computador|microcomputador|mini ?pc|desktop|all in one|tablet|smartphone|celular|estacao de trabalho)/ },
  sup:     { grupo:"sup", nome:"Suporte TI",
             terms:['"suporte técnico"','"help desk"','"service desk"','"manutenção de computadores"','"manutenção preventiva e corretiva"','"assistência técnica"','"outsourcing de ti"','"terceirização de ti"','"tecnologia da informação"','"infraestrutura de ti"','"rede lógica"','"gerenciamento de rede"'],
             forte: ehSuporte, itemFn: () => false }  // suporte é serviço: vale o objeto, não a ficha de item
};
function forteEm(cat, n){ const c = CATS[cat]; if(c.forte) return c.forte(n); return c.re.test(n) && !(c.neg && c.neg.test(n)); }
function itemCasa(cat, n){ const c = CATS[cat]; if(ITEM_NEG_GERAL.test(n)) return false; if(c.itemFn) return c.itemFn(n); const re = c.itemRe || c.re, neg = c.itemNeg || c.neg; return re.test(n) && !(neg && neg.test(n)); }
const nomeCat = c => (CATS[c].grupo === "sophos" ? "Sophos · " : "") + CATS[c].nome;
