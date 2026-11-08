// Monta public/index.html a partir das partes em src/parts:
//   head.html  — HTML + CSS da página
//   regras.js  — constantes, termos de busca e regras de relevância por frente (tem o marcador __MUN__)
//   app.js     — busca no PNCP, conferência de itens, marcações (API /api/marcas), aprendizado e tela
// e de src/mun_br.json (distância em km de Leme/SP por código IBGE).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
const ler = (f) => readFileSync(f, "utf8");
const regras = ler("src/parts/regras.js");
if (regras.split("__MUN__").length !== 2) throw new Error("regras.js precisa ter exatamente um __MUN__");
const html =
  ler("src/parts/head.html") +
  "<script>\n(function(){\n\"use strict\";\n" +
  regras.replace("__MUN__", ler("src/mun_br.json").trim()) +
  ler("src/parts/app.js") +
  "})();\n</script>\n</body>\n</html>\n";
mkdirSync("public", { recursive: true });
writeFileSync("public/index.html", html);
console.log("public/index.html gerado (" + html.length + " bytes)");
