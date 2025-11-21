// server.js
//
// Crontal RFQ backend with:
// - /api/buyer/parse-request
// - /api/buyer/clarify
// - /api/buyer/upload-specs (PDF/Excel -> structured RFQ, no OCR dependency)
// - /api/buyer/negotiate
// - static serving from /public
//
// Run:
//   npm install express cors multer xlsx openai
//   export OPENAI_API_KEY="your-key"
//   node server.js
const rfqStore = {};   // { [rfq_id]: rfqObject }
const quoteStore = {}; // { [rfq_id]: [quote, ...] }


const express = require("express");
const cors = require("cors");
const multer = require("multer");
const xlsx = require("xlsx");
const fs = require("fs");
const path = require("path");
const OpenAI = require("openai");

// ---------------------------
// Basic setup
// ---------------------------
const app = express();
app.use(cors());
app.use(express.json());

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

if (!process.env.OPENAI_API_KEY) {
  console.warn(
    "WARNING: OPENAI_API_KEY is not set. All AI endpoints will fail until you provide it."
  );
}

// Multer for uploads
const upload = multer({
  dest: "uploads/",
  limits: {
    fileSize: 25 * 1024 * 1024, // 25MB
    files: 5
  }
});

// ---------------------------
// Helper: extract text from Excel/PDF/others
// ---------------------------
async function extractTextFromFile(file) {
  const ext = (file.originalname.split(".").pop() || "").toLowerCase();
  const filePath = file.path;

  // 1) Excel – tech spec or BOM
  if (ext === "xlsx" || ext === "xls") {
    const workbook = xlsx.readFile(filePath);
    let allSheetsText = "";

    workbook.SheetNames.forEach((sheetName) => {
      const sheet = workbook.Sheets[sheetName];
      if (!sheet) return;
      const csv = xlsx.utils.sheet_to_csv(sheet, { FS: ",", RS: "\n" });
      allSheetsText += `\n\nSHEET: ${sheetName}\n${csv}`;
    });

    if (!allSheetsText.trim()) {
      console.warn(
        `No useful content found in Excel file ${file.originalname}.`
      );
    }

    return `EXCEL FILE: ${file.originalname}\n${allSheetsText}`;
  }

  // 2) PDF – treat bytes as text; this is not perfect but avoids OCR complexity
  if (ext === "pdf") {
    try {
      const buf = fs.readFileSync(filePath);
      let text = buf.toString("utf8");

      // If utf8 looks totally empty, at least emit a marker
      if (!text || !text.trim()) {
        console.warn(
          `No clear text extracted from PDF ${file.originalname}. Likely scanned or mostly graphical.`
        );
        text =
          "[NO CLEAR TEXT EXTRACTED – PDF may be scanned or graphical. Buyer may need to upload a BOM or type the scope in text.]";
      }

      return `PDF FILE: ${file.originalname}\n\n${text}`;
    } catch (err) {
      console.error(`Raw read failed for PDF ${file.originalname}:`, err);
      return `PDF FILE: ${file.originalname}\n\n[UNABLE TO READ PDF BYTES – ${
        err.message || err
      }]`;
    }
  }

  // 3) Others – treat as plain text
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw.trim()) {
      console.warn(`File ${file.originalname} appears empty as text.`);
      return `FILE: ${file.originalname}\n\n[NO TEXT EXTRACTED]`;
    }
    return `FILE: ${file.originalname}\n\n${raw}`;
  } catch (err) {
    console.error(`Raw read failed for ${file.originalname}:`, err);
    return `FILE: ${file.originalname}\n\n[UNABLE TO READ FILE CONTENT – ${
      err.message || err
    }]`;
  }
}

// ---------------------------
// Helper: OpenAI spec → line_items
// ---------------------------
async function parseSpecsToLineItems(combinedText, project_name = null) {
  const MAX_CHARS = 12000;
  const truncated =
    combinedText.length > MAX_CHARS
      ? combinedText.slice(0, MAX_CHARS) + "\n\n[TRUNCATED]"
      : combinedText;

  const systemPrompt = `
You are a procurement assistant for industrial stainless steel / metal projects.

You receive long, complex technical content: engineering drawings, design specifications, BOM tables, datasheets.

Your job is to extract a CLEAN LIST of procurement line items in THIS JSON schema:

{
  "project_name": string|null,
  "line_items": [
    {
      "item_id": string,
      "raw_description": string,
      "product_category": string|null,
      "product_type": string|null,
      "material_grade": string|null,
      "standard_or_spec": string|null,
      "size": {
        "outer_diameter": { "value": number|null, "unit": string|null },
        "wall_thickness": { "value": number|null, "unit": string|null },
        "length":        { "value": number|null, "unit": string|null }
      },
      "quantity": number|null,
      "unit": string|null,
      "delivery_location": string|null,
      "required_delivery_date": string|null,
      "incoterm": string|null,
      "payment_terms": string|null,
      "other_requirements": string[]
    }
  ]
}

Rules:
- Focus on items that must be physically procured (pipes, tubes, fittings, valves, plates, structural steel, fasteners, gaskets, instruments, etc.).
- If multiple distinct sizes, ratings or materials are present, split them into separate line_items.
- Use "other_requirements" for free-text like "cut to 500–1000 mm", "plywood case", "ISO9001 and MTC".
- Only use null when the document truly does not specify the value.
- Do NOT invent sizes, grades or quantities.
- project_name can be inferred from context or null.
- Return ONLY the JSON object, no extra text.
`;

  const userPrompt = `
Below are one or more files from a project specification package
(engineering PDFs and Excel tech specs).

Please extract a clean list of line_items that a buyer would need to source from suppliers.

Provided project_name (may be null): ${project_name || "null"}

TEXT STARTS:
"""${truncated}"""
`;

  const completion = await client.chat.completions.create({
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ]
  });

  return JSON.parse(completion.choices[0].message.content);
}

// ---------------------------
// /api/buyer/parse-request
// ---------------------------
app.post("/api/buyer/parse-request", async (req, res) => {
  const { text, project_name } = req.body || {};
  if (!text) return res.status(400).json({ error: "Missing text" });

  const systemPrompt = `
You turn messy natural-language procurement text into a structured RFQ JSON object
for industrial stainless steel / metal products.

The input text may be an email, bullets, or a long paragraph.
Identify each distinct product (tube/pipe/fitting/valve, etc) and commercial terms.

Return ONLY JSON in this schema:

{
  "project_name": string|null,
  "line_items": [
    {
      "item_id": string,
      "raw_description": string,
      "product_category": string|null,
      "product_type": string|null,
      "material_grade": string|null,
      "standard_or_spec": string|null,
      "size": {
        "outer_diameter": { "value": number|null, "unit": string|null },
        "wall_thickness": { "value": number|null, "unit": string|null },
        "length":        { "value": number|null, "unit": string|null }
      },
      "quantity": number|null,
      "unit": string|null,
      "delivery_location": string|null,
      "required_delivery_date": string|null,
      "incoterm": string|null,
      "payment_terms": string|null,
      "other_requirements": string[]
    }
  ]
}

Rules:
- One line_item per distinct product (size/material/use).
- If numerical details are unclear, set value to null and put text in other_requirements.
- Do NOT invent data. Use null when not given.
- project_name can be inferred from context or null.
- Return ONLY the JSON object, no extra text.
`;

  const userPrompt = `
Buyer RFQ text:
"""${text}"""

Provided project_name (may be null): ${project_name || "null"}

Extract line_items and commercial terms.
`;

  try {
    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ]
    });

    const parsed = JSON.parse(completion.choices[0].message.content);

    const finalProjectName =
      parsed.project_name || project_name || "Untitled RFQ";

    const rfqId = "RFQ-" + Date.now();

    const rfq = {
      rfq_id: rfqId,
      project_name: finalProjectName,
      line_items: parsed.line_items || [],
      original_text: text
    };

    rfqStore[rfqId] = rfq;

    res.json(rfq);
  } catch (err) {
    console.error("Parsing failed:", err);
    res.status(500).json({ error: "Parsing failed", detail: err.message });
  }
});

// ---------------------------
// /api/buyer/clarify
// ---------------------------
app.post("/api/buyer/clarify", async (req, res) => {
  const { rfq, history, user_message } = req.body || {};

  if (!rfq) {
    return res.status(400).json({ error: "Missing rfq in request body" });
  }

  const systemPrompt = `
You are Crontal's RFQ conversation assistant for industrial stainless steel / metal procurement.

Goal:
- Help the buyer refine a structured RFQ (already parsed) through short, concrete messages.
- Always reference the STRUCTURED RFQ JSON you receive, not just the raw text.

VERY IMPORTANT:
- Before asking for more information, carefully READ the existing rfq.line_items and rfq.commercial fields.
- ONLY ask for details that are still missing across MOST line items.
  - If description, grade and size are already present, do NOT say they are missing.
  - If destination, incoterm, or payment_terms are already set, do NOT ask for them again.

Your job:
1) Briefly confirm what you have understood.
2) Call out IMPORTANT missing details ONLY if they are truly missing.
3) Make 1–3 SPECIFIC suggestions about what to update in the table on the right.
4) Ask 1 clear follow-up question.

Style:
- Be concise (3–6 sentences).
- Use plain, professional language.
- Do NOT repeat what Crontal is or greet again.
`;

  const items = rfq.items || rfq.line_items || [];
  const rfqSummary = JSON.stringify(
    {
      rfq_id: rfq.id || rfq.rfq_id,
      project_name: rfq.project_name,
      commercial: rfq.commercial,
      line_items: items.map((li) => ({
        line: li.line,
        description: li.description || li.product_type || li.raw_description,
        grade: li.grade || li.material_grade,
        quantity: li.quantity,
        uom: li.uom || li.unit
      }))
    },
    null,
    2
  );

  const historyMessages = Array.isArray(history)
    ? history.map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content || ""
      }))
    : [];

  const latestUser = user_message || "";

  try {
    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content:
            "Here is the current structured RFQ JSON:\n\n" +
            rfqSummary +
            "\n\nUse this as ground truth for what has been parsed so far."
        },
        ...historyMessages,
        latestUser
          ? {
              role: "user",
              content:
                "Latest buyer message (may clarify destination, dates, payment, etc.):\n\n" +
                latestUser
            }
          : {
              role: "user",
              content:
                "No new buyer message; just suggest next refinements based on the RFQ JSON."
            }
      ]
    });

    const assistant_message =
      completion.choices[0].message.content?.trim() ||
      "I’ve interpreted your RFQ and populated the table. Let me know what delivery location, dates, and payment terms you want so I can tighten it further.";

    return res.json({ assistant_message });
  } catch (err) {
    console.error("Clarify failed:", err);
    return res
      .status(500)
      .json({ error: "Clarify failed", detail: err.message || String(err) });
  }
});

// ---------------------------
// /api/buyer/upload-specs
// ---------------------------
app.post(
  "/api/buyer/upload-specs",
  upload.array("files"),
  async (req, res) => {
    const files = req.files || [];
    const { project_name } = req.body || {};

    if (!files.length) {
      return res.status(400).json({ error: "No files uploaded." });
    }

    try {
      const texts = [];

      for (const file of files) {
        try {
          const text = await extractTextFromFile(file);
          if (text && text.trim()) {
            texts.push(text);
          }
        } catch (err) {
          console.error(`Failed to extract from ${file.originalname}:`, err);
        } finally {
          try {
            fs.unlinkSync(file.path);
          } catch {
            // ignore
          }
        }
      }

      if (!texts.length) {
        console.warn("upload-specs: no text extracted from any file.");
        // Fallback: still send something to the model instead of 400
        const fallbackText = files
          .map(
            (f) =>
              `FILE: ${
                f.originalname
              } (no readable content extracted; likely scanned or unsupported format)`
          )
          .join("\n");
        texts.push(fallbackText);
      }

      const combinedText = texts.join(
        "\n\n----- FILE SEPARATOR -----\n\n"
      );

      const parsed = await parseSpecsToLineItems(combinedText, project_name);
      const finalProjectName =
        parsed.project_name || project_name || "Untitled RFQ";
      const lineItems = Array.isArray(parsed.line_items)
        ? parsed.line_items
        : [];

      const rfqId = "RFQ-" + Date.now();
      const rfq = {
        rfq_id: rfqId,
        project_name: finalProjectName,
        line_items: lineItems,
        original_text: combinedText
      };

      rfqStore[rfqId] = rfq;

      return res.json(rfq);
    } catch (err) {
      console.error("upload-specs failed:", err);
      return res.status(500).json({
        error: "Parsing failed",
        detail: err.message || String(err)
      });
    }
  }
);

// ---------------------------
// /api/buyer/negotiate
// ---------------------------
app.post("/api/buyer/negotiate", async (req, res) => {
  const { rfq, quote, goal } = req.body || {};

  if (!rfq || !quote) {
    return res.status(400).json({ error: "Missing rfq or quote in request body" });
  }

  const systemPrompt = `
You are Crontal's negotiation assistant helping an industrial buyer negotiate RFQs with suppliers.

Given:
- rfq: structured JSON of what the buyer is procuring
- quote: a supplier's quote including prices, lead time, payment terms, notes
- goal: a short string describing the buyer's negotiation objective

Tasks:
1. Briefly restate what the supplier is offering (1–2 sentences).
2. Provide 2–4 concrete negotiation suggestions aligned with the goal.
3. Draft a short sample email paragraph the buyer could send to the supplier to open the negotiation.

Keep it practical, professional, and under about 200 words.
Return plain text (no JSON).
`;

  const context = {
    rfq: {
      id: rfq.id || rfq.rfq_id,
      commercial: rfq.commercial,
      items: (rfq.items || []).map((it) => ({
        line: it.line,
        description: it.description,
        grade: it.grade,
        quantity: it.quantity,
        uom: it.uom
      }))
    },
    quote
  };

  try {
    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content:
            "RFQ and quote data:\n" +
            JSON.stringify(context, null, 2) +
            "\n\nNegotiation goal: " +
            (goal || "negotiate this quote in the buyer's favor")
        }
      ]
    });

    const advice = completion.choices[0].message.content?.trim() || "";
    return res.json({ advice });
  } catch (err) {
    console.error("negotiate failed:", err);
    return res
      .status(500)
      .json({ error: "Negotiation failed", detail: err.message || String(err) });
  }
});

// Fetch RFQ by ID (used by supplier-demo)
app.get("/api/rfqs/:id", (req, res) => {
  const id = req.params.id;
  const rfq = rfqStore[id];
  if (!rfq) return res.status(404).json({ error: "RFQ not found" });
  res.json(rfq);
});

// Supplier submits quote for RFQ
app.post("/api/rfqs/:id/quotes", (req, res) => {
  const id = req.params.id;
  const rfq = rfqStore[id];
  if (!rfq) return res.status(404).json({ error: "RFQ not found" });

  const quote = req.body;
  if (!quote || typeof quote !== "object") {
    return res.status(400).json({ error: "Invalid quote payload" });
  }

  if (!quoteStore[id]) quoteStore[id] = [];
  quoteStore[id].push(quote);
  res.json({ ok: true });
});

// Buyer fetches all quotes for an RFQ
app.get("/api/rfqs/:id/quotes", (req, res) => {
  const id = req.params.id;
  const quotes = quoteStore[id] || [];
  res.json({ quotes });
});


// ---------------------------
// Static frontend
// ---------------------------
app.use(express.static(path.join(__dirname, "../public")));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "../public", "buyer-demo.html"));
});





// ---------------------------
// Start server
// ---------------------------
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Crontal RFQ backend listening on http://localhost:${PORT}`);
});
