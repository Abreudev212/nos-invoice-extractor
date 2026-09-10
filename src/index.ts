import { extractText, getDocumentProxy } from "unpdf";

// =====================================================================
// REGISTO DE DOCUMENTOS
// =====================================================================
// Cada tipo tem prompt, modelo, filtro de páginas e, opcionalmente,
// um bloco "verificacao" com o layout conhecido. Quando "verificacao"
// existe, o código valida e repara o output do modelo contra o texto.
// Para formatos novos, basta omitir "verificacao": o modelo manda.

const DOCUMENTS = {
  nos_fatura: {
    match: /nos|circuitos|ft\s*\d{6}/i,
    model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    filtro: /5\.86350\.\d+\.\d+\s+\(VA\d+\)/,

    verificacao: {
      circuito: /^\s*(5\.86350\.\d+\.\d+)\s+\(VA(\d+)\)\s+€([\d.,]+)/,
      referencia: /^\s*(\d{9})\s+€([\d.,]+)/,
      // Linhas que fecham o circuito atual: cabeçalhos de grupo e totais.
      corte: /^\s*(?:5\.86350\.\d+\s+\(|Total\b|.*Total\s+da\(s\))/,
    },

    prompt: `Recebes o TEXTO de UMA página de uma fatura NOS, extraído do PDF
com o layout preservado. Devolves JSON.

CLASSIFICACAO — por esta ordem:

1. Se existir pelo menos uma linha no formato 5.86350.NN.NN (VAxxx)
   -> tipoPagina = "circuitos"
   Prioridade absoluta. Todas as páginas têm cabeçalho com número de
   conta e datas; isso NÃO faz da página um "cabecalho".
2. Senão, se contiver "Tarifário" e "Descrição" -> "movimentos"
3. Senão, se contiver "Resumo da conta" ou "Resumo desta fatura" -> "cabecalho"
4. Caso contrário -> "outro"

CABECALHO — extrai só se estiver no texto, senão null:
- numeroFatura (ex.: "FT 202613/94278")
- dataFatura (data de emissão; não o vencimento nem o período)
- periodoFaturacao (ex.: "01-02-2026 até 28-02-2026")
- totalFatura (o total SEM IVA, o "Total: €..." no topo da tabela)

TABELA DE CIRCUITOS — três tipos de linha:

1. GRUPO: código curto e um nome, sem VA.
   5.86350.17 (FORTIGATE) €13.492,951
   Ignora.

2. CIRCUITO: código longo e um VA na mesma linha.
   5.86350.17.10 (VA001) €782,570
   -> { codigo: "5.86350.17.10", va: "VA001", valor: 782.570 }

3. REFERENCIA: linha com um número de 9 dígitos e um valor.
   020045813 €391,280
   Pertence ao circuito imediatamente acima.
   Inclui também as que têm um só valor (€0,000) e a última da página.

NUMEROS — notação portuguesa para JSON:
  13.492,951 -> 13492.951    782,570 -> 782.57    €0,000 -> 0
A vírgula é o separador decimal. Nunca a elimines.

REGRAS
Copia os dígitos exatamente. Não calcules, não somes, não inventes VAs.
Se tipoPagina for "movimentos" ou "outro", devolve arrays vazios.`,
  },
};

// =====================================================================
// SCHEMA
// =====================================================================

const REFERENCIA_SCHEMA = {
  type: "object",
  properties: {
    referencia: { type: "string" },
    valor: { anyOf: [{ type: "number" }, { type: "null" }] },
  },
  required: ["referencia", "valor"],
  additionalProperties: false,
};

const PAGE_SCHEMA = {
  type: "object",
  properties: {
    tipoPagina: {
      type: "string",
      enum: ["cabecalho", "circuitos", "movimentos", "outro"],
    },
    numeroFatura: { anyOf: [{ type: "string" }, { type: "null" }] },
    dataFatura: { anyOf: [{ type: "string" }, { type: "null" }] },
    periodoFaturacao: { anyOf: [{ type: "string" }, { type: "null" }] },
    totalFatura: { anyOf: [{ type: "number" }, { type: "null" }] },
    circuitos: {
      type: "array",
      items: {
        type: "object",
        properties: {
          codigo: { type: "string" },
          va: { type: "string" },
          valor: { anyOf: [{ type: "number" }, { type: "null" }] },
          referencias: { type: "array", items: REFERENCIA_SCHEMA },
        },
        required: ["codigo", "va", "valor", "referencias"],
        additionalProperties: false,
      },
    },
    referenciasOrfas: { type: "array", items: REFERENCIA_SCHEMA },
  },
  required: [
    "tipoPagina",
    "numeroFatura",
    "dataFatura",
    "periodoFaturacao",
    "totalFatura",
    "circuitos",
    "referenciasOrfas",
  ],
  additionalProperties: false,
};

// =====================================================================
// NORMALIZACAO BASICA
// =====================================================================

const RE_CODIGO = /^5\.86350(?:\.\d+)+$/;
const RE_VA = /^VA\d+$/;
const RE_REFERENCIA = /^\d{6,12}$/;

const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

// Converte "13.492,951" em 13492.951
function valorPT(s) {
  const limpo = String(s ?? "").replace(/[€\s]/g, "").replace(/\./g, "").replace(",", ".");
  const n = parseFloat(limpo);
  return Number.isFinite(n) ? n : null;
}

// O modelo às vezes devolve 14002 em vez de 140.02 (come a vírgula).
// Só se aplica quando não há verificação pelo texto a corrigir o valor.
function num(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  // 14002 -> 140.02 (o modelo comeu a vírgula decimal)
  if (Number.isInteger(v) && Math.abs(v) >= 1000) return v / 100;
  // 17.94691 -> 17946.91 (tratou o ponto de milhares como decimal)
  if (!Number.isInteger(v) && Math.abs(v) < 100) {
    const casas = (String(v).split(".")[1] ?? "").length;
    if (casas >= 4) return v * 1000;
  }
  return v;
}

const normalizarVA = (v) =>
  String(v ?? "").trim().toUpperCase()
    .replace(/^VA0*(\d+)$/, (_, n) => "VA" + n.padStart(3, "0"));

function limparReferencias(lista) {
  const vistas = new Map();
  for (const item of Array.isArray(lista) ? lista : []) {
    const referencia = String(item?.referencia ?? "").trim();
    if (!RE_REFERENCIA.test(referencia)) continue;
    const valor = num(item?.valor);
    const anterior = vistas.get(referencia);
    if (!anterior) vistas.set(referencia, { referencia, valor });
    else if (anterior.valor === null && valor !== null) anterior.valor = valor;
  }
  return [...vistas.values()];
}

function limparCircuitos(lista) {
  const agrupados = new Map();
  for (const item of Array.isArray(lista) ? lista : []) {
    const codigo = String(item?.codigo ?? "").trim();
    const va = normalizarVA(item?.va);
    if (!RE_CODIGO.test(codigo) || !RE_VA.test(va)) continue;

    const chave = `${codigo}|${va}`;
    const existente = agrupados.get(chave);

    if (!existente) {
      agrupados.set(chave, {
        codigo,
        va,
        valor: num(item?.valor),
        referencias: limparReferencias(item?.referencias),
      });
      continue;
    }
    if (existente.valor === null) existente.valor = num(item?.valor);
    existente.referencias = limparReferencias([
      ...existente.referencias,
      ...limparReferencias(item?.referencias),
    ]);
  }
  return [...agrupados.values()];
}

function normalizarPagina(dados) {
  const tipos = ["cabecalho", "circuitos", "movimentos", "outro"];
  let tipoPagina = tipos.includes(dados?.tipoPagina) ? dados.tipoPagina : "outro";

  const candidatos = limparCircuitos(dados?.circuitos);
  if (candidatos.length > 0) tipoPagina = "circuitos";

  const semCircuitos = tipoPagina !== "circuitos";

  return {
    tipoPagina,
    numeroFatura: str(dados?.numeroFatura),
    dataFatura: str(dados?.dataFatura),
    periodoFaturacao: str(dados?.periodoFaturacao),
    totalFatura: num(dados?.totalFatura),
    circuitos: semCircuitos ? [] : candidatos,
    referenciasOrfas: semCircuitos ? [] : limparReferencias(dados?.referenciasOrfas),
  };
}

// =====================================================================
// VERIFICACAO CONTRA O TEXTO
// =====================================================================
// Lê o texto da página com o layout conhecido e produz a estrutura
// esperada. Serve para detetar e reparar erros do modelo.

function lerEstruturaDoTexto(texto, regras) {
  const linhas = String(texto).split("\n");
  const circuitos = [];
  const orfas = [];
  let atual = null;

  for (const linha of linhas) {
    const c = linha.match(regras.circuito);
    if (c) {
      atual = {
        codigo: c[1],
        va: "VA" + c[2].padStart(3, "0"),
        valor: valorPT(c[3]),
        referencias: [],
      };
      circuitos.push(atual);
      continue;
    }

    // Cabeçalho de grupo ou total fecha o circuito corrente:
    // as referências que se seguem não lhe pertencem.
    if (regras.corte.test(linha)) {
      atual = null;
      continue;
    }

    const r = linha.match(regras.referencia);
    if (r) {
      const ref = { referencia: r[1], valor: valorPT(r[2]) };
      if (atual) atual.referencias.push(ref);
      else if (!circuitos.length) orfas.push(ref);   // só antes do 1.º VA
    }
  }

  return { circuitos, orfas };
}

// Reconcilia o output do modelo com a estrutura lida do texto.
function reconciliar(data, texto, regras) {
  const esperado = lerEstruturaDoTexto(texto, regras);

  if (!esperado.circuitos.length && !esperado.orfas.length) {
    return { data, reparos: [] };
  }

  const reparos = [];
  const doModelo = new Map(data.circuitos.map((c) => [`${c.codigo}|${c.va}`, c]));
  const finais = [];

  for (const ref of esperado.circuitos) {
    const chave = `${ref.codigo}|${ref.va}`;
    const obtido = doModelo.get(chave);

    if (!obtido) {
      reparos.push(`circuito em falta: ${ref.va}`);
      finais.push(ref);
      continue;
    }

    doModelo.delete(chave);

    if (obtido.valor !== ref.valor) {
      reparos.push(`valor de ${ref.va}: ${obtido.valor} -> ${ref.valor}`);
    }

    const refsObtidas = obtido.referencias.map((r) => r.referencia).sort().join(",");
    const refsEsperadas = ref.referencias.map((r) => r.referencia).sort().join(",");
    if (refsObtidas !== refsEsperadas) {
      reparos.push(`referências de ${ref.va} corrigidas`);
    }

    // O texto é a fonte de verdade para valores e pertença.
    finais.push(ref);
  }

  for (const extra of doModelo.values()) {
    reparos.push(`circuito inventado, removido: ${extra.va}`);
  }

  const orfasEsperadas = limparReferencias(esperado.orfas);
  if (orfasEsperadas.length !== data.referenciasOrfas.length) {
    reparos.push(`órfãs: ${data.referenciasOrfas.length} -> ${orfasEsperadas.length}`);
  }

  return {
    data: {
      ...data,
      tipoPagina: finais.length ? "circuitos" : data.tipoPagina,
      circuitos: limparCircuitos(finais),
      referenciasOrfas: orfasEsperadas,
    },
    reparos,
  };
}

// =====================================================================
// ENTRADA
// =====================================================================

function paraBytes(buffer) {
  const bytes = new Uint8Array(buffer);

  const ehPDF =
    bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
  if (ehPDF) return bytes;

  const texto = new TextDecoder()
    .decode(bytes)
    .replace(/^"|"$/g, "")
    .replace(/^data:[^;]+;base64,/, "")
    .replace(/\s+/g, "");

  let binario;
  try {
    binario = atob(texto);
  } catch {
    throw new Error("O corpo do pedido não é um PDF nem base64 válido.");
  }

  const saida = new Uint8Array(binario.length);
  for (let i = 0; i < binario.length; i++) saida[i] = binario.charCodeAt(i);

  if (!(saida[0] === 0x25 && saida[1] === 0x50 && saida[2] === 0x44 && saida[3] === 0x46)) {
    throw new Error("O ficheiro descodificado não começa por %PDF.");
  }

  return saida;
}

// =====================================================================
// UTILITARIOS
// =====================================================================

function resolverDocumento(tipoPedido, nomeFicheiro) {
  if (tipoPedido && DOCUMENTS[tipoPedido]) {
    return { tipo: tipoPedido, config: DOCUMENTS[tipoPedido] };
  }
  for (const [tipo, config] of Object.entries(DOCUMENTS)) {
    if (config.match?.test(String(nomeFicheiro || ""))) return { tipo, config };
  }
  return null;
}

function lerRespostaAI(resultado) {
  let resposta = resultado?.choices?.[0]?.message?.content ?? resultado?.response ?? resultado;
  if (resposta && typeof resposta === "object") return resposta;

  let texto = String(resposta ?? "").trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");

  const inicio = texto.indexOf("{");
  const fim = texto.lastIndexOf("}");
  if (inicio >= 0 && fim > inicio) texto = texto.slice(inicio, fim + 1);

  return JSON.parse(texto);
}

// Uma tentativa extra: o modelo falha de forma intermitente.
async function correrModelo(env, modelo, opcoes, tentativas = 2) {
  let ultimoErro;
  for (let i = 0; i < tentativas; i++) {
    try {
      const r = await env.AI.run(modelo, opcoes);
      lerRespostaAI(r);
      return r;
    } catch (erro) {
      ultimoErro = erro;
    }
  }
  throw ultimoErro;
}

const json = (corpo, status = 200) => Response.json(corpo, { status });

// =====================================================================
// CONSOLIDACAO
// =====================================================================

function consolidar(entradas) {
  const falhadas = [];
  const paginas = [];

  for (const item of entradas) {
    if (item && item.success === false) {
      falhadas.push({ pageNumber: item.pageNumber ?? null, error: item.error ?? "desconhecido" });
      continue;
    }
    const dados = item?.data ?? item;
    if (dados && typeof dados === "object") {
      paginas.push({ pageNumber: item?.pageNumber ?? dados?.pageNumber ?? 0, dados });
    }
  }

  paginas.sort((a, b) => a.pageNumber - b.pageNumber);

  const vistas = new Set();
  const duplicadas = [];
  for (const p of paginas) {
    if (vistas.has(p.pageNumber)) duplicadas.push(p.pageNumber);
    vistas.add(p.pageNumber);
  }

  const circuitos = [];
  const indice = new Map();
  const cabecalho = {
    numeroFatura: null,
    dataFatura: null,
    periodoFaturacao: null,
    totalFatura: null,
  };

  for (const { dados } of paginas) {
    for (const campo of Object.keys(cabecalho)) {
      if (cabecalho[campo] === null && dados?.[campo] != null) cabecalho[campo] = dados[campo];
    }

    const orfas = limparReferencias(dados?.referenciasOrfas);
    if (orfas.length && circuitos.length) {
      const ultimo = circuitos[circuitos.length - 1];
      ultimo.referencias = limparReferencias([...ultimo.referencias, ...orfas]);
    }

    for (const circuito of limparCircuitos(dados?.circuitos)) {
      const chave = `${circuito.codigo}|${circuito.va}`;
      const existente = indice.get(chave);

      if (!existente) {
        indice.set(chave, circuito);
        circuitos.push(circuito);
        continue;
      }
      if (existente.valor === null) existente.valor = circuito.valor;
      existente.referencias = limparReferencias([
        ...existente.referencias,
        ...circuito.referencias,
      ]);
    }
  }

  // Nas páginas de circuitos o total é o valor sem IVA — é com esse que a soma bate.
  const totalSemIVA = paginas
    .map((p) => p.dados)
    .find((d) => d?.tipoPagina === "circuitos" && d?.totalFatura != null)?.totalFatura;

  if (totalSemIVA != null) cabecalho.totalFatura = totalSemIVA;

  const saida = circuitos.map((c) => ({
    codigo: c.codigo,
    va: c.va,
    conta: null,
    descricao: null,
    valor: c.valor,
    linhasAssociadas: c.referencias.map((r) => ({
      referencia: r.referencia,
      descricao: null,
      valor: r.valor,
    })),
  }));

  const arr = (n) => Math.round(n * 1000) / 1000;
  const somaCircuitos = arr(saida.reduce((t, c) => t + (c.valor ?? 0), 0));

  const divergencias = saida
    .filter((c) => c.valor !== null && c.linhasAssociadas.length > 0)
    .map((c) => ({
      va: c.va,
      valor: c.valor,
      somaLinhas: arr(c.linhasAssociadas.reduce((t, l) => t + (l.valor ?? 0), 0)),
    }))
    .filter((c) => Math.abs(c.valor - c.somaLinhas) > 0.005);

  const vasRepetidos = [];
  const contagem = new Map();
  for (const c of saida) contagem.set(c.va, (contagem.get(c.va) ?? 0) + 1);
  for (const [va, n] of contagem) if (n > 1) vasRepetidos.push(va);

  const semLinhas = saida.filter((c) => c.linhasAssociadas.length === 0).map((c) => c.va);

  return {
    numeroFatura: cabecalho.numeroFatura,
    dataFatura: cabecalho.dataFatura,
    periodoFaturacao: cabecalho.periodoFaturacao,
    circuitos: saida,
    validacao: {
      paginasRecebidas: paginas.length,
      paginasFalhadas: falhadas,
      paginasDuplicadas: duplicadas,
      totalCircuitos: saida.length,
      totalFaturaLido: cabecalho.totalFatura,
      somaCircuitos,
      diferenca:
        cabecalho.totalFatura === null ? null : arr(somaCircuitos - cabecalho.totalFatura),
      circuitosSemValor: saida.filter((c) => c.valor === null).map((c) => c.va),
      circuitosSemLinhas: semLinhas,
      vasRepetidos,
      circuitosComSomaDivergente: divergencias,
      fiavel:
        falhadas.length === 0 &&
        duplicadas.length === 0 &&
        vasRepetidos.length === 0 &&
        saida.length > 0 &&
        cabecalho.numeroFatura !== null &&
        cabecalho.totalFatura !== null &&
        Math.abs(somaCircuitos - cabecalho.totalFatura) <= 0.01 &&
        divergencias.length === 0,
    },
  };
}

// =====================================================================
// WORKER
// =====================================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/api/health") {
      return json({
        status: "ok",
        modo: "texto",
        documentos: Object.keys(DOCUMENTS).map((t) => ({
          tipo: t,
          verificacao: Boolean(DOCUMENTS[t].verificacao),
        })),
      });
    }

    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

    if (!env.FLOW_API_KEY) {
      return json({ error: "FLOW_API_KEY não está configurado no Worker." }, 500);
    }
    if (request.headers.get("x-api-key") !== env.FLOW_API_KEY) {
      return json({ error: "Unauthorized" }, 401);
    }

    try {
      // -----------------------------------------------------------
      // /api/pdf-text
      // -----------------------------------------------------------
      if (url.pathname === "/api/pdf-text") {
        const nomeFicheiro = request.headers.get("x-file-name") || "fatura.pdf";
        const documento = resolverDocumento(request.headers.get("x-document-type"), nomeFicheiro);
        const filtro = documento?.config?.filtro ?? null;

        let bytes;
        try {
          bytes = paraBytes(await request.arrayBuffer());
        } catch (erro) {
          return json({ success: false, stage: "input", error: erro.message }, 400);
        }
        if (!bytes.byteLength) return json({ success: false, error: "PDF vazio." }, 400);

        let text;
        try {
          const pdf = await getDocumentProxy(bytes);
          ({ text } = await extractText(pdf, { mergePages: false }));
        } catch (erro) {
          return json(
            { success: false, stage: "pdf", error: `Não foi possível ler o PDF: ${erro.message}` },
            422
          );
        }

        const de = Math.max(1, Number(request.headers.get("x-page-from")) || 1);
        const ate = Number(request.headers.get("x-page-to")) || 0;
        const fatia = ate > 0 ? text.slice(de - 1, ate) : text;

        const paginas = fatia.map((texto, i) => {
          const t = String(texto ?? "");
          return {
            pageNumber: de + i,
            caracteres: t.length,
            temCircuitos: filtro ? filtro.test(t) : t.length > 0,
            texto: t,
          };
        });

        const totalCaracteres = paginas.reduce((t, p) => t + p.caracteres, 0);

        return json({
          success: true,
          documentType: documento?.tipo ?? null,
          totalPaginasPDF: text.length,
          totalPaginas: paginas.length,
          totalCaracteres,
          temCamadaTexto: totalCaracteres > 100,
          paginasComCircuitos: paginas.filter((p) => p.temCircuitos).map((p) => p.pageNumber),
          paginasVazias: paginas.filter((p) => p.caracteres === 0).map((p) => p.pageNumber),
          paginas,
        });
      }

      // -----------------------------------------------------------
      // /api/consolidate
      // -----------------------------------------------------------
      if (url.pathname === "/api/consolidate") {
        let corpo;
        try {
          corpo = await request.json();
        } catch {
          return json({ success: false, error: "Corpo não é JSON válido." }, 400);
        }

        const entradas = Array.isArray(corpo) ? corpo : corpo?.paginas;
        if (!Array.isArray(entradas)) {
          return json({ success: false, error: "Esperado um array de páginas." }, 400);
        }
        if (!entradas.length) {
          return json({ success: false, error: "O array de páginas está vazio." }, 400);
        }

        return json({ success: true, ...consolidar(entradas) });
      }

      // -----------------------------------------------------------
      // /api/extract
      // -----------------------------------------------------------
      if (url.pathname !== "/api/extract") {
        return json({ error: "Not found", path: url.pathname }, 404);
      }

      let corpo;
      try {
        corpo = await request.json();
      } catch {
        return json({ success: false, error: "Corpo não é JSON válido." }, 400);
      }

      const texto = String(corpo?.texto ?? "");
      const pageNumber = Number(corpo?.pageNumber) || null;

      if (!texto.trim()) {
        return json({ success: false, pageNumber, error: "Texto vazio." }, 400);
      }

      const documento = resolverDocumento(
        corpo?.documentType ?? request.headers.get("x-document-type"),
        corpo?.fileName
      );

      if (!documento) {
        return json(
          {
            success: false,
            pageNumber,
            error: "Tipo de documento não reconhecido.",
            disponiveis: Object.keys(DOCUMENTS),
          },
          400
        );
      }

      const modelo = request.headers.get("x-model") || documento.config.model;

      let resultado;
      try {
        resultado = await correrModelo(env, modelo, {
          messages: [
            { role: "system", content: documento.config.prompt },
            { role: "user", content: `TEXTO DA PAGINA:\n\n${texto}` },
          ],
          temperature: 0,
          max_tokens: 8000,
          response_format: { type: "json_schema", json_schema: PAGE_SCHEMA },
        });
      } catch (erro) {
        return json(
          { success: false, stage: "modelo", pageNumber, model: modelo, error: erro?.message ?? String(erro) },
          502
        );
      }

      let data = normalizarPagina(lerRespostaAI(resultado));
      let reparos = [];

      if (documento.config.verificacao) {
        const r = reconciliar(data, texto, documento.config.verificacao);
        data = r.data;
        reparos = r.reparos;
      }

      return json({
        success: true,
        documentType: documento.tipo,
        model: modelo,
        pageNumber,
        tipoPagina: data.tipoPagina,
        totalCircuitos: data.circuitos.length,
        totalOrfas: data.referenciasOrfas.length,
        verificado: Boolean(documento.config.verificacao),
        reparos,
        usage: resultado?.usage ?? null,
        data,
      });
    } catch (erro) {
      console.error("Erro:", erro);
      return json({ success: false, stage: "worker", error: erro?.message ?? String(erro) }, 500);
    }
  },
};
