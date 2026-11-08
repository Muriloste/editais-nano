// Gera public/index.html a partir de src/template.html + src/mun_br.json (distâncias de Leme por código IBGE).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
const t = readFileSync("src/template.html", "utf8");
const mun = readFileSync("src/mun_br.json", "utf8").trim();
if (t.split("__MUN__").length !== 2) throw new Error("template precisa ter exatamente um __MUN__");
mkdirSync("public", { recursive: true });
writeFileSync("public/index.html", t.replace("__MUN__", mun));
console.log("public/index.html gerado");
