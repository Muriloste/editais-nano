#!/usr/bin/env python3
"""Checklist de documentos de uma licitação (Nano TI) em .xlsx.

Uso: python3 checklist_xlsx.py spec.json saida.xlsx
Imprime JSON com bytes e resumo e grava saida.xlsx.b64 (base64 para o upload no SharePoint).

spec.json: {titulo, orgao, local, objeto, modalidade, processo, plataforma, link_pncp, link_plataforma,
            sessao "AAAA-MM-DD HH:MM", valor_estimado, recomendacao, hoje "AAAA-MM-DD" (opcional),
            documentos: [{grupo, exigencia, item, arquivo, origem: mestre|outros|emitir|falta, prazo_emissao_dias, obs}],
            prazos: [{evento, data "AAAA-MM-DD[ HH:MM]", obs}],
            itens: [{numero, descricao, qtd, unidade, valor_unit, produto, obs}]}
A situação de cada documento sai do nome do arquivo: "(val DD-MM-AAAA)" ou "(emitida DD-MM-AAAA)".
"""
import base64, datetime as dt, json, re, sys
from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.worksheet.datavalidation import DataValidation

COR = {"OK": "D9EAD3", "EMITIR": "FFF2CC", "CONFERIR": "FFF2CC", "VENCE ANTES DA SESSÃO": "F4CCCC", "VENCIDA": "F4CCCC", "FALTA": "F4CCCC"}
NAVY = "0B1D33"


def data(s):
    if not s:
        return None
    s = str(s).strip()
    for f in ("%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d", "%d/%m/%Y %H:%M", "%d/%m/%Y"):
        try:
            return dt.datetime.strptime(s[:len(dt.datetime.now().strftime(f))], f)
        except ValueError:
            pass
    return None


def br(d):
    return d.strftime("%d/%m/%Y") if d else ""


def situacao(doc, sessao, hoje):
    """-> (situação, data limite, observação automática)"""
    origem = (doc.get("origem") or "").lower()
    arq = doc.get("arquivo") or ""
    if origem == "emitir":
        return "EMITIR", None, ""
    if origem == "falta" or not arq:
        return "FALTA", None, ""
    ref = (sessao or hoje).date()
    m = re.search(r"\(val (\d{2})-(\d{2})-(\d{4})\)", arq)
    e = re.search(r"\(emitida (\d{2})-(\d{2})-(\d{4})\)", arq)
    limite, nota = None, ""
    if m:
        limite = dt.date(int(m[3]), int(m[2]), int(m[1]))
    elif e:
        emissao = dt.date(int(e[3]), int(e[2]), int(e[1]))
        dias = doc.get("prazo_emissao_dias")
        if not dias:
            return "CONFERIR", emissao, "emitida em " + emissao.strftime("%d/%m/%Y") + "; confira o prazo de emissão aceito pelo edital"
        limite = emissao + dt.timedelta(days=int(dias))
        nota = "emitida em %s; o edital aceita até %s dias" % (emissao.strftime("%d/%m/%Y"), dias)
    elif origem == "outros":
        return "CONFERIR", None, "arquivo antigo de DOCUMENTOS NOVOS; confira se ainda vale"
    else:
        return "OK", None, ""
    if limite < hoje.date():
        return "VENCIDA", limite, nota
    if limite < ref:
        return "VENCE ANTES DA SESSÃO", limite, nota
    return "OK", limite, nota


def gerar(spec, saida):
    hoje = data(spec.get("hoje")) or dt.datetime.now()
    sessao = data(spec.get("sessao"))
    wb = Workbook()
    ws = wb.active
    ws.title = "Checklist"
    b = Font(bold=True)
    topo = Alignment(vertical="top", wrap_text=True)
    ws["A1"] = spec.get("titulo") or "Checklist de documentos"
    ws["A1"].font = Font(bold=True, size=14, color=NAVY)
    cab = [("Órgão", spec.get("orgao")), ("Local", spec.get("local")), ("Objeto", spec.get("objeto")),
           ("Modalidade / processo", " · ".join(x for x in (spec.get("modalidade"), spec.get("processo")) if x)),
           ("Sessão", sessao.strftime("%d/%m/%Y %H:%M") if sessao else spec.get("sessao")),
           ("Plataforma", spec.get("plataforma")), ("Link da plataforma", spec.get("link_plataforma")),
           ("Edital no PNCP", spec.get("link_pncp")), ("Valor estimado", spec.get("valor_estimado")),
           ("Recomendação", spec.get("recomendacao")),
           ("Gerado em", hoje.strftime("%d/%m/%Y") + " pela rodada automática do monitor de editais")]
    r = 2
    for k, v in cab:
        if v in (None, ""):
            continue
        ws.cell(r, 1, k).font = b
        ws.merge_cells(start_row=r, start_column=1, end_row=r, end_column=2)
        c = ws.cell(r, 3, v)
        ws.merge_cells(start_row=r, start_column=3, end_row=r, end_column=9)
        c.alignment = Alignment(horizontal="left", wrap_text=False)
        if k == "Valor estimado" and isinstance(v, (int, float)):
            c.number_format = '"R$" #,##0.00'
        if isinstance(v, str) and v.startswith("http"):
            c.hyperlink = v
            c.font = Font(color="1F4E9E", underline="single")
        r += 1
    r += 1
    hdr = ["Nº", "Grupo", "Exigência do edital", "Item", "Arquivo (pasta HABILITAÇÃO)", "Situação", "Validade / limite", "Observação", "Feito?"]
    for i, h in enumerate(hdr, 1):
        c = ws.cell(r, i, h)
        c.font = Font(bold=True, color="FFFFFF")
        c.fill = PatternFill("solid", fgColor=NAVY)
        c.alignment = Alignment(vertical="center", wrap_text=True)
    ini = r
    cont = {"ok": 0, "emitir": 0, "falta": 0, "vencidos": 0, "vence_antes": 0, "conferir": 0}
    chave = {"OK": "ok", "EMITIR": "emitir", "FALTA": "falta", "VENCIDA": "vencidos", "VENCE ANTES DA SESSÃO": "vence_antes", "CONFERIR": "conferir"}
    pend = []
    for n, d in enumerate(spec.get("documentos") or [], 1):
        st, lim, nota = situacao(d, sessao, hoje)
        cont[chave[st]] += 1
        obs = "; ".join(x for x in (d.get("obs"), nota) if x)
        nome = d.get("exigencia") or d.get("arquivo") or ""
        item = (" (item %s)" % d["item"]) if d.get("item") else ""
        if st == "EMITIR":
            pend.append("Emitir: " + nome + item)
        elif st == "FALTA":
            pend.append("Falta: " + nome + item)
        elif st in ("VENCIDA", "VENCE ANTES DA SESSÃO"):
            pend.append("Renovar: %s (%s %s%s)" % (d.get("arquivo") or nome, "venceu" if st == "VENCIDA" else "vence", br(lim),
                                                    ", sessão " + br(sessao) if sessao and st != "VENCIDA" else ""))
        elif st == "CONFERIR":
            pend.append("Conferir: " + (d.get("arquivo") or nome))
        r += 1
        vals = [n, d.get("grupo"), nome, d.get("item"), d.get("arquivo") or ("(emitir para este edital)" if st == "EMITIR" else ""), st, lim, obs, ""]
        for i, v in enumerate(vals, 1):
            c = ws.cell(r, i, v)
            c.alignment = topo
        ws.cell(r, 6).fill = PatternFill("solid", fgColor=COR[st])
        ws.cell(r, 6).font = b
        if lim:
            ws.cell(r, 7).number_format = "dd/mm/yyyy"
    if r > ini:
        dv = DataValidation(type="list", formula1='"Sim,Não"', allow_blank=True)
        ws.add_data_validation(dv)
        dv.add("I%d:I%d" % (ini + 1, r))
        ws.auto_filter.ref = "A%d:I%d" % (ini, r)
    ws.freeze_panes = "A%d" % (ini + 1)
    for col, w in zip("ABCDEFGHI", (5, 20, 46, 9, 44, 16, 13, 40, 8)):
        ws.column_dimensions[col].width = w

    wp = wb.create_sheet("Prazos")
    for i, h in enumerate(["Evento", "Data", "Observação"], 1):
        c = wp.cell(1, i, h)
        c.font = Font(bold=True, color="FFFFFF")
        c.fill = PatternFill("solid", fgColor=NAVY)
    for k, p in enumerate(spec.get("prazos") or [], 2):
        dd = data(p.get("data"))
        wp.cell(k, 1, p.get("evento")).alignment = topo
        c = wp.cell(k, 2, dd or p.get("data"))
        if dd:
            c.number_format = "dd/mm/yyyy hh:mm" if (dd.hour or dd.minute) else "dd/mm/yyyy"
        wp.cell(k, 3, p.get("obs")).alignment = topo
    for col, w in zip("ABC", (38, 17, 60)):
        wp.column_dimensions[col].width = w

    wi = wb.create_sheet("Itens e preço")
    hi = ["Item", "Descrição", "Qtd", "Un", "Valor unit. estimado", "Total estimado", "Produto / solução Nano", "Nosso preço unit.", "Nosso total", "Obs."]
    for i, h in enumerate(hi, 1):
        c = wi.cell(1, i, h)
        c.font = Font(bold=True, color="FFFFFF")
        c.fill = PatternFill("solid", fgColor=NAVY)
        c.alignment = Alignment(wrap_text=True, vertical="center")
    moeda = '"R$" #,##0.00'
    its = spec.get("itens") or []
    for k, it in enumerate(its, 2):
        vals = [it.get("numero"), it.get("descricao"), it.get("qtd"), it.get("unidade"), it.get("valor_unit"),
                "=IF(AND(ISNUMBER(C%d),ISNUMBER(E%d)),C%d*E%d,\"\")" % (k, k, k, k), it.get("produto"), it.get("nosso_unit"),
                "=IF(AND(ISNUMBER(C%d),ISNUMBER(H%d)),C%d*H%d,\"\")" % (k, k, k, k), it.get("obs")]
        for i, v in enumerate(vals, 1):
            c = wi.cell(k, i, v)
            c.alignment = topo
            if i in (5, 6, 8, 9):
                c.number_format = moeda
    if its:
        t = len(its) + 2
        wi.cell(t, 2, "Total").font = b
        for col in ("F", "I"):
            c = wi["%s%d" % (col, t)]
            c.value = "=SUM(%s2:%s%d)" % (col, col, t - 1)
            c.number_format = moeda
            c.font = b
    wi.freeze_panes = "A2"
    for col, w in zip("ABCDEFGHIJ", (6, 50, 8, 7, 15, 15, 30, 15, 15, 30)):
        wi.column_dimensions[col].width = w

    for s in wb.worksheets:   # impressão: paisagem, cabendo na largura da folha
        s.page_setup.orientation = "landscape"
        s.page_setup.fitToWidth, s.page_setup.fitToHeight = 1, 0
        s.sheet_properties.pageSetUpPr.fitToPage = True
    wb.save(saida)
    raw = open(saida, "rb").read()
    open(saida + ".b64", "w").write(base64.b64encode(raw).decode())
    resumo = dict(cont, total=sum(cont.values()), pendencias=pend, sessao=sessao.strftime("%d/%m %H:%M") if sessao else None)
    return {"arquivo": saida, "bytes": len(raw), "resumo": resumo}


if __name__ == "__main__":
    spec = json.load(open(sys.argv[1], encoding="utf-8"))
    print(json.dumps(gerar(spec, sys.argv[2]), ensure_ascii=False, indent=1))
