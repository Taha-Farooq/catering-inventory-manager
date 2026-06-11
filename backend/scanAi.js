// AI document reading for the scanner pipeline.
//
// WHY THIS EXISTS: the original pipeline classified documents by regexing
// text out of pdf-parse. Scanned documents are images — pdf-parse extracts
// nothing from them, so every real-world scan landed as "other / Unknown
// Sender / needs_review". This module sends each document to a vision-
// capable LLM and gets back structured fields.
//
// Two providers are supported. Pick one by setting its API key in the
// backend environment; if both are set, SCAN_AI_PROVIDER decides.
//
//   GEMINI_API_KEY      — Google Gemini (free tier: 1500 docs/day, 15/min).
//                         The recommended option for a small business that
//                         doesn't want to pay for AI. Quality is genuinely
//                         close to Claude on typical printed paperwork.
//                         Privacy note: Google's free tier uses your data
//                         to improve their products; the paid tier opts out.
//   ANTHROPIC_API_KEY   — Claude. Best quality on the hardest cases
//                         (heavy handwriting, degraded scans). Paid only.
//                         Anthropic does NOT train on customer API data.
//
// Without either key, the pipeline silently falls back to the keyword path.

import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';

const ANTHROPIC_KEY = String(process.env.ANTHROPIC_API_KEY || '').trim();
const GEMINI_KEY = String(process.env.GEMINI_API_KEY || '').trim();
const PROVIDER_ENV = String(process.env.SCAN_AI_PROVIDER || '').trim().toLowerCase();

const ANTHROPIC_MODEL = process.env.SCAN_AI_MODEL_ANTHROPIC || process.env.SCAN_AI_MODEL || 'claude-sonnet-4-6';
const GEMINI_MODEL = process.env.SCAN_AI_MODEL_GEMINI || 'gemini-2.0-flash';

const AI_MAX_BYTES = Number(process.env.SCAN_AI_MAX_BYTES || 25 * 1024 * 1024);

function activeProvider() {
  if (PROVIDER_ENV === 'gemini') return GEMINI_KEY ? 'gemini' : null;
  if (PROVIDER_ENV === 'anthropic') return ANTHROPIC_KEY ? 'anthropic' : null;
  if (GEMINI_KEY) return 'gemini';
  if (ANTHROPIC_KEY) return 'anthropic';
  return null;
}

export function aiEnabled() { return activeProvider() !== null; }
export function aiProvider() { return activeProvider(); }
export function aiModel() {
  const p = activeProvider();
  if (p === 'anthropic') return ANTHROPIC_MODEL;
  if (p === 'gemini') return GEMINI_MODEL;
  return null;
}

const SYSTEM_PROMPT = `You read scanned documents for a family-run business owner. Documents fall into two broad categories:

  1. Catering business paperwork for three companies in NY/NJ — DeGrill, Parathas & Platters, and Dera Masala Grill: supplier invoices, receipts, purchase orders, payroll records, bank statements, vendor correspondence.

  2. Personal and tax documents — IRS notices, W-2s, 1099s, state tax forms, personal bank statements, medical bills, insurance documents, utility bills, legal correspondence, government mail.

Documents are usually phone photos or flatbed scans of paper, often skewed, faded, glare-affected, or with handwritten annotations. Read carefully and extract the requested fields exactly as printed. For dense forms (tax documents, multi-column statements), match field labels precisely. If a field is genuinely unreadable, return an empty string or 0 rather than guessing.

For businessTag: choose 'degrill', 'parathas', or 'dera' if the document clearly belongs to one of the three catering businesses. Choose 'personal' for tax documents, personal mail, medical bills, insurance, utilities, or anything addressed to an individual rather than a business. Use 'unknown' only when the document genuinely cannot be categorized.`;

// Shared JSON schema describing the extraction shape. Both providers accept
// this format (Anthropic's structured outputs and Gemini's responseSchema
// both use JSON Schema with the same basic types).
const EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    docType: {
      type: 'string',
      enum: ['transaction_invoice', 'tax', 'legal', 'credit', 'bank', 'payroll', 'medical', 'insurance', 'utility', 'other'],
      description: 'Document category. transaction_invoice covers business invoices, receipts, bills, and purchase orders. medical covers doctor bills and EOBs. utility covers electric/gas/water/internet. legal covers court documents and legal correspondence.',
    },
    sender: {
      type: 'string',
      description: 'The company, agency, or person that issued this document. Short — just the name (e.g. "Restaurant Depot", "Internal Revenue Service", "Bergen Medical Center").',
    },
    businessTag: {
      type: 'string',
      enum: ['degrill', 'parathas', 'dera', 'personal', 'unknown'],
      description: 'Which bucket this document belongs to. Use personal for tax documents, medical bills, personal mail; the three business tags for catering paperwork; unknown only if genuinely indeterminate.',
    },
    docDate: {
      type: 'string',
      description: 'The date printed ON the document (invoice date, statement date, notice date) in YYYY-MM-DD. Empty string if no date is visible.',
    },
    totalAmount: {
      type: 'number',
      description: 'The main dollar amount (invoice total, amount due, statement balance, refund amount). 0 if not applicable.',
    },
    referenceNumber: {
      type: 'string',
      description: 'Invoice number, account number, case number, or claim number printed on the document. Empty string if none.',
    },
    summary: {
      type: 'string',
      description: 'One sentence that helps the owner file this by, e.g. "Restaurant Depot invoice for $412.86, due Nov 12" or "IRS CP2000 notice — proposed adjustment for tax year 2024".',
    },
    confidence: {
      type: 'number',
      description: 'Your confidence in the docType classification from 0 to 1.',
    },
  },
  required: ['docType', 'sender', 'businessTag', 'docDate', 'totalAmount', 'referenceNumber', 'summary', 'confidence'],
};

let anthropicClient = null;
function getAnthropic() {
  if (!anthropicClient) anthropicClient = new Anthropic();
  return anthropicClient;
}

let geminiClient = null;
function getGemini() {
  if (!geminiClient) geminiClient = new GoogleGenAI({ apiKey: GEMINI_KEY });
  return geminiClient;
}

// Normalize the LLM's raw extraction into the durable shape the pipeline
// stores. Defensively coerces and clamps so a malformed model answer can
// never poison the DB.
function normalizeExtraction(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const docDateStr = String(raw.docDate || '').trim();
  const refStr = String(raw.referenceNumber || '').trim();
  return {
    docType: String(raw.docType || 'other'),
    sender: String(raw.sender || '').slice(0, 120) || 'Unknown Sender',
    businessTag: ['degrill', 'parathas', 'dera', 'personal'].includes(raw.businessTag) ? raw.businessTag : '',
    docDate: /^\d{4}-\d{2}-\d{2}$/.test(docDateStr) ? docDateStr : null,
    totalAmount: Number.isFinite(raw.totalAmount) && raw.totalAmount !== 0 ? +Number(raw.totalAmount).toFixed(2) : null,
    referenceNumber: refStr ? refStr.slice(0, 80) : null,
    summary: String(raw.summary || '').slice(0, 300),
    confidence: Math.max(0, Math.min(1, Number(raw.confidence) || 0)),
  };
}

async function extractWithAnthropic(buffer, mediaType, filename) {
  const isPdf = mediaType === 'application/pdf';
  const fileBlock = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } }
    : { type: 'image', source: { type: 'base64', media_type: mediaType, data: buffer.toString('base64') } };
  const response = await getAnthropic().messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    output_config: {
      format: { type: 'json_schema', schema: EXTRACTION_SCHEMA },
      effort: 'low',
    },
    messages: [{
      role: 'user',
      content: [fileBlock, { type: 'text', text: `Filename: ${filename}\nExtract the document fields.` }],
    }],
  });
  if (response.stop_reason === 'refusal') return null;
  const textBlock = response.content.find(b => b.type === 'text');
  if (!textBlock?.text) return null;
  return normalizeExtraction(JSON.parse(textBlock.text));
}

async function extractWithGemini(buffer, mediaType, filename) {
  const response = await getGemini().models.generateContent({
    model: GEMINI_MODEL,
    contents: [{
      role: 'user',
      parts: [
        { inlineData: { mimeType: mediaType, data: buffer.toString('base64') } },
        { text: `${SYSTEM_PROMPT}\n\nFilename: ${filename}\nExtract the document fields.` },
      ],
    }],
    config: {
      responseMimeType: 'application/json',
      responseSchema: EXTRACTION_SCHEMA,
      temperature: 0.1,
    },
  });
  const text = typeof response?.text === 'function' ? response.text() : response?.text;
  if (!text) return null;
  return normalizeExtraction(JSON.parse(text));
}

/**
 * Read one document with the active AI provider. Returns the extracted
 * fields object, or null on any failure (caller falls back to the regex
 * path).
 *
 * @param {Buffer} buffer       file contents
 * @param {string} mediaType    'application/pdf' | 'image/jpeg' | 'image/png' | 'image/webp'
 * @param {string} filename     original name, given to the model as context
 */
export async function extractDocumentAI(buffer, mediaType, filename) {
  const provider = activeProvider();
  if (!provider) return null;
  if (!buffer || buffer.length === 0 || buffer.length > AI_MAX_BYTES) return null;
  try {
    if (provider === 'gemini') return await extractWithGemini(buffer, mediaType, filename);
    return await extractWithAnthropic(buffer, mediaType, filename);
  } catch {
    // Rate limits, network failures, malformed JSON — fall back, log upstream.
    return null;
  }
}
