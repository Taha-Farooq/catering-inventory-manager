// AI document reading for the scanner pipeline.
//
// WHY THIS EXISTS: the original pipeline classified documents by regexing
// text out of pdf-parse. Scanned documents are images — pdf-parse extracts
// nothing from them, so every real-world scan landed as "other / Unknown
// Sender / needs_review". This module sends the document to Claude (which
// reads scanned PDFs and photos natively) and gets back structured fields.
//
// Enabled by setting ANTHROPIC_API_KEY in the backend environment. Without
// a key the pipeline silently falls back to the legacy regex path.

import Anthropic from '@anthropic-ai/sdk';

const SCAN_AI_MODEL = process.env.SCAN_AI_MODEL || 'claude-opus-4-8';
// Claude's PDF limit is 32MB / 100 pages; stay under it and keep request
// bodies sane. Larger docs fall back to the regex path.
const AI_MAX_BYTES = Number(process.env.SCAN_AI_MAX_BYTES || 25 * 1024 * 1024);

let client = null;
export function aiEnabled() {
  return Boolean(String(process.env.ANTHROPIC_API_KEY || '').trim());
}
export function aiModel() {
  return SCAN_AI_MODEL;
}
function getClient() {
  if (!client) client = new Anthropic(); // reads ANTHROPIC_API_KEY from env
  return client;
}

const EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    docType: {
      type: 'string',
      enum: ['transaction_invoice', 'tax', 'legal', 'credit', 'bank', 'payroll', 'other'],
      description: 'Document category. transaction_invoice covers invoices, receipts, bills, purchase orders, and delivery slips.',
    },
    sender: {
      type: 'string',
      description: 'The company or person that issued this document (vendor, agency, bank, law firm). Short — just the name.',
    },
    businessTag: {
      type: 'string',
      enum: ['degrill', 'parathas', 'dera', 'unknown'],
      description: 'Which of the three businesses this document belongs to: DeGrill, Parathas & Platters, or Dera Masala Grill. "unknown" if it cannot be determined.',
    },
    docDate: {
      type: ['string', 'null'],
      description: 'The date printed ON the document (invoice date, statement date) in YYYY-MM-DD. null if no date is visible.',
    },
    totalAmount: {
      type: ['number', 'null'],
      description: 'The main dollar amount (invoice total, amount due, statement balance). null if not applicable.',
    },
    referenceNumber: {
      type: ['string', 'null'],
      description: 'Invoice number, account number, or case number printed on the document. null if none.',
    },
    summary: {
      type: 'string',
      description: 'One sentence a busy restaurant owner can file by, e.g. "Restaurant Depot invoice for $412.86, due Nov 12".',
    },
    confidence: {
      type: 'number',
      description: 'Your confidence in the docType classification from 0 to 1.',
    },
  },
  required: ['docType', 'sender', 'businessTag', 'docDate', 'totalAmount', 'referenceNumber', 'summary', 'confidence'],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You read scanned business documents for a family-run catering company that operates three businesses: DeGrill, Parathas & Platters, and Dera Masala Grill (all in the NY/NJ area). Documents are typically supplier invoices, receipts, tax notices, bank statements, payroll records, legal letters, and credit memos — often phone photos or flatbed scans of paper, sometimes skewed, faded, or handwritten-on. Extract the requested fields exactly as printed. If a field is genuinely unreadable, use null rather than guessing.`;

/**
 * Read one document with Claude. Returns the extracted fields object, or
 * null on any failure (caller falls back to the regex path).
 *
 * @param {Buffer} buffer  file contents
 * @param {string} mediaType  'application/pdf' | 'image/jpeg' | 'image/png' | 'image/webp'
 * @param {string} filename  original name, given to the model as context
 */
export async function extractDocumentAI(buffer, mediaType, filename) {
  if (!aiEnabled()) return null;
  if (!buffer || buffer.length === 0 || buffer.length > AI_MAX_BYTES) return null;

  const isPdf = mediaType === 'application/pdf';
  const fileBlock = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } }
    : { type: 'image', source: { type: 'base64', media_type: mediaType, data: buffer.toString('base64') } };

  try {
    const response = await getClient().messages.create({
      model: SCAN_AI_MODEL,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      output_config: {
        format: { type: 'json_schema', schema: EXTRACTION_SCHEMA },
        effort: 'low',
      },
      messages: [{
        role: 'user',
        content: [
          fileBlock,
          { type: 'text', text: `Filename: ${filename}\nExtract the document fields.` },
        ],
      }],
    });

    if (response.stop_reason === 'refusal') return null;
    const textBlock = response.content.find(b => b.type === 'text');
    if (!textBlock?.text) return null;
    const parsed = JSON.parse(textBlock.text);

    // Light validation so a malformed answer can't poison the DB.
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      docType: String(parsed.docType || 'other'),
      sender: String(parsed.sender || '').slice(0, 120) || 'Unknown Sender',
      businessTag: ['degrill', 'parathas', 'dera'].includes(parsed.businessTag) ? parsed.businessTag : '',
      docDate: /^\d{4}-\d{2}-\d{2}$/.test(String(parsed.docDate || '')) ? parsed.docDate : null,
      totalAmount: Number.isFinite(parsed.totalAmount) ? +Number(parsed.totalAmount).toFixed(2) : null,
      referenceNumber: parsed.referenceNumber ? String(parsed.referenceNumber).slice(0, 80) : null,
      summary: String(parsed.summary || '').slice(0, 300),
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
    };
  } catch (err) {
    // Rate limits, network failures, malformed JSON — fall back, log upstream.
    return null;
  }
}
