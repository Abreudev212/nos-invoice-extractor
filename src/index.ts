import { extractText, getDocumentProxy } from "unpdf";

// =====================================================================
// REGISTO DE DOCUMENTOS
// =====================================================================

const DOCUMENTS = {
  nos_fatura: {
    match: /nos|circuitos|ft\s*\d{6}/i,
    model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    filtro: /5\.86350\.\d+\.\d+/,
    prompt: `Recebes o TEXTO de UMA página de uma fatura NOS, extraído
diretamente do PDF com o layout preservado. Devolves JSON.

CLASSIFICACAO — regra de decisão, por esta ordem:

1. Se o texto contiver pelo menos uma linha no formato
   5.86350.NN.NN (VAxxx)  ->  tipoPagina = "circuitos"
   Esta regra tem prioridade absoluta. Todas as páginas têm cabeçalho
   com número de conta, número de fatura e datas — isso NÃO faz da
   página um "cabecalho".

2. Senão, se contiver linhas com "Tarifário" e "Descrição"
   ->  tipoPagina = "movimentos"

3. Senão, se contiver "Resumo da conta" ou "Resumo desta fatura"
   ->  tipoPagina = "cabecalho"

4. Caso contrário  ->  "outro"

CABEÇALHO DA FATURA
Extrai apenas se estiver presente no texto, senão null:
- numeroFatura (ex.: "FT 202613/94278")
- dataFatura (data de emissão, não o vencimento nem o período)
- periodoFaturacao (ex.: "01-02-2026 até 28-02-2026")
- totalFatura (o total SEM IVA, o valor que aparece como "Total: €..."
  no topo da tabela de circuitos)

TABELA DE CIRCUITOS
Três tipos de linha:

1. CABEÇALHO DE GRUPO - código curto e um nome, sem VA.
   5.86350.17 (FORTIGATE)   13.492,951
   Ignora por completo.

2. CIRCUITO - código longo e um código VA na mesma linha.
   5.86350.17.10 (VA001)    782,570
   -> { codigo: "5.86350.17.10", va: "VA001", valor: 782.570 }

3. REFERENCIA - linha indentada, só com um número e um valor.
        020045813           391,280
   Pertence ao circuito imediatamente ACIMA.

PRIMEIRO PASSO OBRIGATORIO — LINHAS ORFAS

Antes de extraires qualquer circuito, percorre o texto de cima para baixo
e localiza a PRIMEIRA linha que contenha um código VA.

Todas as linhas de referência que apareçam ANTES dessa linha pertencem a um
circuito de uma página anterior. Coloca-as em "referenciasOrfas" e NUNCA no
array "referencias" do primeiro circuito.

Exemplo desta situação:

  500087098 €5,540 €5,540          <- ORFA
  930512172 €0,000                 <- ORFA
  5.86350.17.14 (VA011) €140,020   <- primeiro circuito
  500086961 €134,480               <- referência do VA011
  500087129 €5,540                 <- referência do VA011
  932314889 €0,000                 <- referência do VA011

Resultado correto:
  referenciasOrfas: [500087098, 930512172]
  VA011.referencias: [500086961, 500087129, 932314889]

Resultado ERRADO (nunca faças isto):
  VA011.referencias: [500087098, 930512172, ...]

Só se o texto começar logo com um código VA é que referenciasOrfas fica [].
NUMEROS
Notação portuguesa para número JSON:
  13.492,951 -> 13492.951    782,570 -> 782.570    0,000 -> 0

REGRAS
Copia os dígitos EXATAMENTE como estão no texto. Não corrijas, não
completes, não calcules, não somas, não inventes códigos VA.
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
// VALIDACAO
// =====================================================================

const RE_CODIGO = /^5\.86350(?:\.\d+)+$/;
const RE_VA = /^VA\d+$/;
const RE_REFERENCIA = /^\d{6,12}$/;

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

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

  // Se o modelo devolveu circuitos válidos, a página é de circuitos,
  // independentemente de como os tenha classificado.
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
// ENTRADA — aceita bytes crus ou base64
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

  const binario = atob(texto);
  const saida = new Uint8Array(binario.length);
  for (let i = 0; i < binario.length; i++) saida[i] = binario.charCodeAt(i);
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

const json = (corpo, status = 200) => Response.json(corpo, { status });

// =====================================================================
// CONSOLIDACAO
// =====================================================================

function consolidar(paginas) {
  const ordenadas = [...paginas].sort((a, b) => (a.pageNumber ?? 0) - (b.pageNumber ?? 0));

  const circuitos = [];
  const indice = new Map();
  const cabecalho = {
    numeroFatura: null,
    dataFatura: null,
    periodoFaturacao: null,
    totalFatura: null,
  };

  for (const pagina of ordenadas) {
    const dados = pagina?.data ?? pagina;

    for (const campo of Object.keys(cabecalho)) {
      if (cabecalho[campo] === null && dados?.[campo] != null) {
        cabecalho[campo] = dados[campo];
      }
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

  const totalSemIVA = ordenadas
    .map((p) => p?.data ?? p)
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

  const arredondar = (n) => Math.round(n * 1000) / 1000;
  const somaCircuitos = arredondar(saida.reduce((t, c) => t + (c.valor ?? 0), 0));

  const divergencias = saida
    .filter((c) => c.valor !== null && c.linhasAssociadas.length > 0)
    .map((c) => ({
      va: c.va,
      valor: c.valor,
      somaLinhas: arredondar(c.linhasAssociadas.reduce((t, l) => t + (l.valor ?? 0), 0)),
    }))
    .filter((c) => Math.abs(c.valor - c.somaLinhas) > 0.005);

  return {
    numeroFatura: cabecalho.numeroFatura,
    dataFatura: cabecalho.dataFatura,
    periodoFaturacao: cabecalho.periodoFaturacao,
    circuitos: saida,
    validacao: {
      paginasRecebidas: ordenadas.length,
      totalCircuitos: saida.length,
      totalFaturaLido: cabecalho.totalFatura,
      somaCircuitos,
      diferenca:
        cabecalho.totalFatura === null
          ? null
          : arredondar(somaCircuitos - cabecalho.totalFatura),
      circuitosSemValor: saida.filter((c) => c.valor === null).map((c) => c.va),
      circuitosComSomaDivergente: divergencias,
      fiavel:
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
      return json({ status: "ok", modo: "texto", documentos: Object.keys(DOCUMENTS) });
    }

    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
    if (request.headers.get("x-api-key") !== env.FLOW_API_KEY) {
      return json({ error: "Unauthorized" }, 401);
    }

    try {
      // ---------------------------------------------------------
      // /api/pdf-text
      // ---------------------------------------------------------
      if (url.pathname === "/api/pdf-text") {
        const nomeFicheiro = request.headers.get("x-file-name") || "fatura.pdf";
        const documento = resolverDocumento(request.headers.get("x-document-type"), nomeFicheiro);
        const filtro = documento?.config?.filtro ?? null;

        const bytes = paraBytes(await request.arrayBuffer());
        if (!bytes.byteLength) return json({ success: false, error: "PDF vazio." }, 400);

        const pdf = await getDocumentProxy(bytes);
        const de = Number(request.headers.get("x-page-from")) || 1;
        const ate = Number(request.headers.get("x-page-to")) || 0;

        const { text } = await extractText(pdf, { mergePages: false });
        const fatia = ate > 0 ? text.slice(de - 1, ate) : text;

        const paginas = fatia.map((texto, i) => ({
          pageNumber: de + i,
          caracteres: texto.length,
          temCircuitos: filtro ? filtro.test(texto) : true,
          texto,
        }));

        const totalCaracteres = paginas.reduce((t, p) => t + p.caracteres, 0);

        return json({
          success: true,
          documentType: documento?.tipo ?? null,
          totalPaginas: paginas.length,
          totalCaracteres,
          temCamadaTexto: totalCaracteres > 100,
          paginasComCircuitos: paginas.filter((p) => p.temCircuitos).map((p) => p.pageNumber),
          paginas,
        });
      }

      // ---------------------------------------------------------
      // /api/consolidate
      // ---------------------------------------------------------
      if (url.pathname === "/api/consolidate") {
        const corpo = await request.json();
        const paginas = Array.isArray(corpo) ? corpo : corpo?.paginas;
        if (!Array.isArray(paginas)) {
          return json({ success: false, error: "Esperado um array de páginas." }, 400);
        }
        return json({ success: true, ...consolidar(paginas) });
      }

      // ---------------------------------------------------------
      // /api/extract
      // ---------------------------------------------------------
      if (url.pathname !== "/api/extract") {
        return json({ error: "Not found", path: url.pathname }, 404);
      }

      const corpo = await request.json();
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
          { success: false, error: "Tipo de documento não reconhecido.", disponiveis: Object.keys(DOCUMENTS) },
          400
        );
      }

      const modelo = request.headers.get("x-model") || documento.config.model;

      const resultado = await env.AI.run(modelo, {
        messages: [
          { role: "system", content: documento.config.prompt },
          { role: "user", content: `TEXTO DA PAGINA:\n\n${texto}` },
        ],
        temperature: 0,
        max_tokens: 6000,
        response_format: { type: "json_schema", json_schema: PAGE_SCHEMA },
      });

      let bruto;
      try {
        bruto = lerRespostaAI(resultado);
      } catch (erro) {
        return json(
          {
            success: false,
            stage: "parse_json",
            pageNumber,
            error: erro?.message ?? String(erro),
            rawResponse: resultado?.choices?.[0]?.message?.content ?? resultado?.response ?? null,
          },
          502
        );
      }

      const data = normalizarPagina(bruto);

      return json({
        success: true,
        documentType: documento.tipo,
        model: modelo,
        pageNumber,
        tipoPagina: data.tipoPagina,
        totalCircuitos: data.circuitos.length,
        usage: resultado?.usage ?? null,
        data,
      });
    } catch (erro) {
      console.error("Erro:", erro);
      return json({ success: false, stage: "worker", error: erro?.message ?? String(erro) }, 500);
    }
  },
};
