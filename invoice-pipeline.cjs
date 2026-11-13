/**
 * Invoice extraction pipeline using local PDF text/OCR and Anthropic LLM.
 *
 * Requires the system binaries pdftoppm, pdftotext (both ship with poppler) and
 * tesseract, plus sharp.
 *
 * Per page, the pipeline picks one of two sources:
 *   - "text": the PDF has a real text layer. Words and positions come from
 *             `pdftotext -bbox`, no rendering and no OCR (fast and exact).
 *   - "ocr":  scanned / image-only page. The page is rendered with pdftoppm and
 *             read with tesseract (slow, only used when needed).
 * Both sources produce the same word shape ({ text, left, top, ... } in 300 DPI
 * pixel coordinates), so all layout logic below is shared.
 *
 * Everything is async: nothing here blocks the Node event loop.
 */

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const sharp = require('sharp');


const execFileAsync = promisify(execFile);

// Load a local .env file without overriding variables already supplied by the environment.
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile(path.join(__dirname, '.env'));

const DPI = 300;
// Low-resolution render used only to classify scanned pages (cheap OCR probe).
const PROBE_DPI = 150;
// SHEIN order numbers look like GSU183400001EW3 / GSU17V30Q000BBW.
const SHEIN_ORDER_ID_RE = /\bGS[A-Z0-9]{10,}\b/;
// SHEIN orders per LLM request (keeps each response far below the output limit).
const ORDERS_PER_REQUEST = 15;
// LLM requests in flight at once.
const LLM_CONCURRENCY = 2;
const MAX_OUTPUT_TOKENS = 16384;
const PT_TO_PX = DPI / 72; // pdftotext reports PDF points (1/72 inch)

const PDF_TO_IMAGE_COMMAND = resolveCommand('pdftoppm', [
  'C:\\Program Files\\poppler-26.09.0\\Library\\bin\\pdftoppm.exe',
]);
const TESSERACT_COMMAND = resolveCommand('tesseract', [
  'C:\\Users\\muddassir\\AppData\\Local\\Programs\\Tesseract-OCR\\tesseract.exe',
]);
// Optional: if pdftotext is missing, every page simply goes through OCR.
const PDF_TO_TEXT_COMMAND = resolveOptionalCommand('pdftotext', [
  path.join(path.dirname(PDF_TO_IMAGE_COMMAND), 'pdftotext.exe'),
  'C:\\Program Files\\poppler-26.09.0\\Library\\bin\\pdftotext.exe',
]);

const AMOUNT_RE_G = /-?(?:USD|KYD)?\s?-?\d[\d,]*\.\d{2}/g;
const ORDER_NUM_RE = /Order\s*#\s*([\d-]{10,})/i;

// Set to true to print per-order cutoff diagnostics.
const DEBUG_ITEMS = false;

// Max length of the short item description written to the output.
const MAX_DESC_LEN = 50;

// Pages with fewer words than this are treated as scans and sent to OCR.
const MIN_TEXT_WORDS = 20;
// Pages processed in parallel (each OCR job is CPU heavy, so keep this small).
const DEFAULT_CONCURRENCY = Math.max(1, Math.min(4, os.cpus().length - 1));
const MAX_BUFFER = 1024 * 1024 * 200;
// Tesseract is multi-threaded by itself; limit it so parallel jobs don't oversubscribe the CPU.
const TESSERACT_ENV = { ...process.env, OMP_THREAD_LIMIT: '1' };

const LABEL_MAP = [
  [/item\(?s?\)?\s*subtotal/i, 'subtotal'],
  [/itern\(?s?\)?\s*subtotal/i, 'subtotal'],
  [/subtotal/i, 'subtotal'],
  [/shipping\s*&?\s*handling/i, 'shipping'],
  [/shipping/i, 'shipping'],
  [/your coupon savings/i, 'discount'],
  [/promotion applied/i, 'discount'],
  [/discount/i, 'discount'],
  [/total before tax/i, 'total_before_tax'],
  [/estimated tax/i, 'tax'],
  [/^tax/i, 'tax'],
  [/exchange rate/i, 'fx_guarantee_fee'],
  [/grand total/i, 'grand_total'],
  [/^total$/i, 'grand_total'],
  [/reward points/i, 'reward_points'],
];

function resolveCommand(command, knownPaths) {
  if (process.platform !== 'win32') return command;

  const pathExtensions = (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';');
  const pathEntries = (process.env.Path || '').split(';').filter(Boolean);
  const pathCandidates = pathEntries.flatMap((entry) => [
    path.join(entry, command),
    ...pathExtensions.map((extension) => path.join(entry, `${command}${extension.toLowerCase()}`)),
  ]);
  const resolvedPath = [...pathCandidates, ...knownPaths].find((candidate) => fs.existsSync(candidate));

  if (!resolvedPath) {
    throw new Error(
      `${command} was not found. Install it and add its bin folder to PATH, or set the appropriate tool path in invoice-pipeline.cjs.`
    );
  }

  return resolvedPath;
}

function resolveOptionalCommand(command, knownPaths) {
  try {
    return resolveCommand(command, knownPaths);
  } catch (err) {
    console.warn(`[pipeline] ${err.message} Text-layer extraction disabled; all pages will use OCR.`);
    return null;
  }
}

function normLabel(rawLabel) {
  const key = rawLabel.toLowerCase().replace(/collected/g, '').trim();
  for (const [re, canon] of LABEL_MAP) {
    if (re.test(key)) return canon;
  }
  return null;
}

// Runs fn(item, index) over items with at most `limit` running at once.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

// =====================================================================
// Short item descriptions
//
// The model returns the pieces (short_name + variant); the code assembles the
// final string so the 50-character cap is exact and the variant is never cut.
// =====================================================================

const hasRealText = (s) => /[A-Za-z0-9]{2,}/.test(String(s || ''));
const squash = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// Cuts at a word boundary, no ellipsis.
function trimToWords(text, max) {
  const clean = squash(text);
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  const base = lastSpace > max * 0.5 ? cut.slice(0, lastSpace) : cut;
  return base.replace(/[\s,;:\-/|(]+$/, '');
}

// "<short name> - <variant>", always <= MAX_DESC_LEN chars. The name is trimmed first, never the variant.
function pickDescription(item) {
  const name = hasRealText(item.short_name) ? squash(item.short_name)
    : hasRealText(item.description) ? squash(item.description)
    : squash(item.source_text);
  let variant = hasRealText(item.variant) ? trimToWords(item.variant, 22) : '';

  if (!variant) return trimToWords(name, MAX_DESC_LEN);
  const nameBudget = MAX_DESC_LEN - variant.length - 3; // " - "
  if (nameBudget < 12) { // variant too long, keep the name readable
    variant = trimToWords(variant, 12);
    return `${trimToWords(name, MAX_DESC_LEN - variant.length - 3)} - ${variant}`;
  }
  return `${trimToWords(name, nameBudget)} - ${variant}`;
}

// =====================================================================
// Page sources: text layer (pdftotext) and OCR (pdftoppm + tesseract)
// =====================================================================

function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

const BBOX_PAGE_RE = /<page width="([\d.]+)" height="([\d.]+)">([\s\S]*?)<\/page>/g;
const BBOX_WORD_RE = /<word xMin="(-?[\d.]+)" yMin="(-?[\d.]+)" xMax="(-?[\d.]+)" yMax="(-?[\d.]+)">([\s\S]*?)<\/word>/g;

// Converts `pdftotext -bbox` output into the same word shape tesseract produces,
// scaled from PDF points to 300 DPI pixels so every pixel threshold below keeps working.
function parseBbox(html) {
  const pages = [];
  for (const pageMatch of html.matchAll(BBOX_PAGE_RE)) {
    const words = [];
    for (const m of pageMatch[3].matchAll(BBOX_WORD_RE)) {
      const text = decodeEntities(m[5]).trim();
      if (!text) continue;
      const xMin = parseFloat(m[1]);
      const yMin = parseFloat(m[2]);
      const xMax = parseFloat(m[3]);
      const yMax = parseFloat(m[4]);
      words.push({
        text,
        left: Math.round(xMin * PT_TO_PX),
        top: Math.round(yMin * PT_TO_PX),
        width: Math.round((xMax - xMin) * PT_TO_PX),
        height: Math.round((yMax - yMin) * PT_TO_PX),
      });
    }
    pages.push({
      words,
      width: Math.round(parseFloat(pageMatch[1]) * PT_TO_PX),
      height: Math.round(parseFloat(pageMatch[2]) * PT_TO_PX),
    });
  }
  return pages;
}

// Returns one { words, width, height } per PDF page, or null if pdftotext is
// unavailable or fails (callers then fall back to OCR for everything).
async function getTextLayerPages(pdfPath) {
  if (!PDF_TO_TEXT_COMMAND) return null;
  try {
    const { stdout } = await execFileAsync(
      PDF_TO_TEXT_COMMAND,
      ['-bbox', '-enc', 'UTF-8', pdfPath, '-'],
      { maxBuffer: MAX_BUFFER, encoding: 'utf8' }
    );
    const pages = parseBbox(stdout);
    return pages.length ? pages : null;
  } catch (err) {
    console.warn(`[pdftotext] failed for ${path.basename(pdfPath)}, falling back to OCR: ${err.message}`);
    return null;
  }
}

// A page counts as digital only if it has enough words and they look like real
// text (broken font encodings produce pages full of symbols or replacement chars).
function hasUsableText(words) {
  if (words.length < MIN_TEXT_WORDS) return false;
  const readable = words.filter((w) => /[A-Za-z0-9]/.test(w.text) && !w.text.includes('\uFFFD')).length;
  return readable / words.length >= 0.8;
}

async function renderPageImage(pdfPath, pageNumber, workdir, dpi = DPI, tag = 'pg') {
  const prefix = path.join(workdir, `${tag}-${pageNumber}`);
  await execFileAsync(PDF_TO_IMAGE_COMMAND, [
    '-png', '-r', String(dpi),
    '-f', String(pageNumber), '-l', String(pageNumber),
    '-singlefile', pdfPath, prefix,
  ]);
  return `${prefix}.png`;
}

// Fallback when pdftotext is unavailable: render every page (at `dpi`).
async function renderAllPageImages(pdfPath, workdir, dpi = DPI, tag = 'pg') {
  const prefix = path.join(workdir, tag);
  await execFileAsync(PDF_TO_IMAGE_COMMAND, ['-png', '-r', String(dpi), pdfPath, prefix]);
  const base = path.basename(prefix);
  return (await fsp.readdir(workdir))
    .filter((fileName) => fileName.startsWith(`${base}-`) && fileName.endsWith('.png') && !/_(crop|price_\d+)\.png$/.test(fileName))
    .sort()
    .map((fileName) => path.join(workdir, fileName));
}

async function getWordsTSV(imgPath) {
  // --psm 11 (sparse text) instead of the default page-layout analysis: with
  // product thumbnails next to the item text, the default mode treats whole
  // text blocks as part of the picture and skips them (entire items vanish).
  // Words are regrouped into lines by coordinates, so reading order is irrelevant.
  const { stdout } = await execFileAsync(TESSERACT_COMMAND, [imgPath, 'stdout', '--psm', '11', 'tsv'], {
    maxBuffer: MAX_BUFFER,
    encoding: 'utf8',
    env: TESSERACT_ENV,
  });
  // Tesseract on Windows emits CRLF, which can leave a trailing carriage return
  // on the final TSV header and prevent the text column from being read.
  const output = stdout.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = output.trim().split('\n');
  const header = lines[0].split('\t');
  const words = [];

  for (let i = 1; i < lines.length; i += 1) {
    const columns = lines[i].split('\t');
    if (columns.length < header.length) continue;
    const row = {};
    header.forEach((key, index) => { row[key] = columns[index]; });
    row.text = (row.text || '').trim();
    if (!row.text) continue;
    ['left', 'top', 'width', 'height', 'block_num', 'par_num', 'line_num'].forEach((key) => {
      row[key] = parseInt(row[key], 10);
    });
    row.conf = parseFloat(row.conf);
    if (row.conf < 10) continue; // pure OCR junk (thumbnail artefacts, clipped glyphs)
    words.push(row);
  }
  return words;
}

// OCR sometimes garbles a price sitting right under the "Return or replace
// items" line (e.g. "$7.99" read as "*7°°"). For every item whose price line
// is missing, re-read just the strip under that line as a single line of
// digits and, if it parses, put the clean price back into the word list.
async function rescueMissingPrices(imgPath, words, pageHeight, pageWidth) {
  const colLeft = findItemColumnLeft(words);
  if (colLeft === null) return;
  const keptText = (line) => line.words.filter((w) => w.left >= colLeft).map((w) => w.text).join(' ').replace(/\s+/g, ' ').trim();
  const lines = groupWordsIntoLines(words);

  for (const anchor of lines.filter((l) => /^Return\b/i.test(keptText(l)))) {
    const hasPrice = lines.some((l) =>
      l.top > anchor.top + 20 && l.top < anchor.top + 110 && parsePriceLine(keptText(l)) !== null
    );
    if (hasPrice) continue;

    const y0 = anchor.top + 38;
    const y1 = Math.min(pageHeight, anchor.top + 105);
    const x0 = Math.max(0, colLeft - 5);
    if (y1 - y0 < 30) continue; // item is cut off by the page edge; price is on the next page
    const cropPath = imgPath.replace(/\.png$/, `_price_${anchor.top}.png`);
    try {
      await sharp(imgPath)
        .extract({ left: x0, top: y0, width: Math.min(600, pageWidth - x0), height: y1 - y0 })
        .grayscale()
        .normalise()
        .toFile(cropPath);
      const { stdout } = await execFileAsync(TESSERACT_COMMAND, [
        cropPath, 'stdout', '--psm', '7', '-c', 'tessedit_char_whitelist=$0123456789.,',
      ], { maxBuffer: MAX_BUFFER, encoding: 'utf8', env: TESSERACT_ENV });
      const m = /(\d[\d,]*\.\d{2})/.exec(stdout.replace(/\s+/g, ''));
      if (!m) continue;
      for (let i = words.length - 1; i >= 0; i -= 1) {
        if (words[i].top > anchor.top + 25 && words[i].top < anchor.top + 110 && words[i].left >= colLeft - 5) {
          words.splice(i, 1);
        }
      }
      words.push({
        text: `$${m[1]}`, left: colLeft, top: anchor.top + 46, width: 120, height: 35, conf: 100,
      });
    } catch (err) {
      console.warn(`[ocr] price rescue failed near y=${anchor.top}: ${err.message}`);
    }
  }
}

async function ocrPage(imgPath) {
  const [words, meta] = await Promise.all([getWordsTSV(imgPath), sharp(imgPath).metadata()]);
  await rescueMissingPrices(imgPath, words, meta.height, meta.width);
  return { source: 'ocr', imgPath, words, width: meta.width, height: meta.height };
}

// Plain reading-order text of a word list (used for classification only).
function wordsToText(words) {
  return groupWordsIntoLines(words).map((line) => line.text).join('\n');
}

// Cheap OCR used only to classify a scanned page (low DPI, text only, no price rescue).
async function probeOcrText(imgPath) {
  const words = await getWordsTSV(imgPath);
  return wordsToText(words);
}

// Loads the pages of the PDF as { source, words, width, height, pageNumber, imgPath? }.
//
// Pipeline:
//   1. Read the text layer of every page (free). Pages with real text need no OCR.
//   2. Scanned pages get a cheap low-DPI OCR probe, just enough to classify them.
//   3. If the document is a SHEIN invoice, only the order-detail pages are kept,
//      and only those are OCR'd at full resolution.
//      Otherwise every page is loaded (original behaviour).
// Returns { pages, totalPages, vendor }.
async function loadPages(pdfPath, workdir, concurrency) {
  await fsp.mkdir(workdir, { recursive: true });
  const textLayer = await getTextLayerPages(pdfPath);

  // slots[i] = { pageNumber, textPage?, probeText? }
  let slots;
  if (textLayer) {
    slots = textLayer.map((textPage, i) => ({
      pageNumber: i + 1,
      textPage: hasUsableText(textPage.words) ? textPage : null,
    }));
  } else {
    // No text layer at all: render low-res images of every page to count and probe them.
    const probeImages = await renderAllPageImages(pdfPath, workdir, PROBE_DPI, 'probe');
    slots = probeImages.map((imgPath, i) => ({ pageNumber: i + 1, textPage: null, probeImg: imgPath }));
  }

  // Probe the pages that have no usable text layer.
  await mapLimit(slots.filter((s) => !s.textPage), concurrency, async (slot) => {
    const imgPath = slot.probeImg || await renderPageImage(pdfPath, slot.pageNumber, workdir, PROBE_DPI, 'probe');
    slot.probeText = await probeOcrText(imgPath);
  });

  const pageText = (slot) => (slot.textPage ? wordsToText(slot.textPage.words) : slot.probeText || '');
  slots.forEach((slot) => { slot.text = pageText(slot); });

  // Merged PDFs (several vendors' order emails printed into one file) are split
  // into one segment per vendor first; SHEIN trimming then applies per segment, so a
  // SHEIN email inside a merged file can't cause the other vendors' pages to be dropped.
  // A normal single-vendor PDF yields exactly one segment (original behaviour).
  const segmentsPlan = splitIntoVendorSegments(slots).map((seg) => {
    const isShein = detectShein(seg.slots.map((s) => s.text));
    const selected = isShein ? seg.slots.filter((s) => isSheinOrderPage(s.text)) : seg.slots;
    // If detection was positive but no page matched, don't risk dropping everything.
    const toLoad = selected.length ? selected : seg.slots;
    return { vendorHint: seg.vendorHint, shein: isShein && selected.length > 0, slots: toLoad };
  });
  const toLoad = segmentsPlan.flatMap((seg) => seg.slots);

  const pages = await mapLimit(toLoad, concurrency, async (slot) => {
    if (slot.textPage) {
      return {
        source: 'text',
        words: slot.textPage.words,
        width: slot.textPage.width,
        height: slot.textPage.height,
        pageNumber: slot.pageNumber,
      };
    }
    const imgPath = await renderPageImage(pdfPath, slot.pageNumber, workdir);
    const ocr = await ocrPage(imgPath);
    return { ...ocr, pageNumber: slot.pageNumber };
  });

  const pageByNumber = new Map(pages.map((p) => [p.pageNumber, p]));
  const segments = segmentsPlan.map((seg) => ({
    vendorHint: seg.vendorHint,
    shein: seg.shein,
    pages: seg.slots.map((slot) => pageByNumber.get(slot.pageNumber)),
  }));

  return { pages, totalPages: slots.length, segments };
}

// =====================================================================
// Merged invoices (several vendors in one PDF)
//
// Typical case: order-confirmation emails from different stores printed from a
// mail client and merged into one PDF. Each email's first page carries a sender
// line with a date ("Zeelool <hello@news.zeelool.com>   Sat, Oct 17 at 2:13 PM");
// the continuation pages do not. That line marks where a new vendor's document
// starts, so each vendor can be extracted on its own instead of asking the LLM to
// untangle everything in one request.
// =====================================================================

const EMAIL_SENDER_LINE_RE = new RegExp(
  '^(.{1,80}?)\\s*<[^<>\\s]+@[^<>\\s]+>\\s+' +
  '(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,?\\s+[A-Za-z]{3,9}\\s+\\d{1,2}' + // "Sat, Oct 17 at 2:13 PM"
  '|[A-Za-z]{3,9}\\s+\\d{1,2},\\s+\\d{4}' +                                    // "Oct 17, 2026, 2:13 PM"
  '|\\d{1,2}\\/\\d{1,2}\\/\\d{2,4})',                                          // "10/17/2026"
  'i'
);

// Display name of the sender if the top of the page has an "email start" line, else null.
function emailSenderOf(text) {
  for (const line of String(text || '').split('\n').slice(0, 15)) {
    const m = EMAIL_SENDER_LINE_RE.exec(line.trim());
    if (m) return m[1].replace(/["']/g, '').trim() || null;
  }
  return null;
}

// Splits the pages into one segment per vendor. Returns [{ vendorHint, slots }].
// Fewer than two detected document starts means "not a merged file": everything
// stays in one segment. Several emails from the same sender (e.g. order + shipping
// confirmation) are kept together so one order isn't extracted twice.
function splitIntoVendorSegments(slots) {
  const senders = slots.map((s) => emailSenderOf(s.text));
  if (senders.filter(Boolean).length < 2) return [{ vendorHint: null, slots }];

  const byKey = new Map();
  const segments = [];
  let current = null;
  slots.forEach((slot, i) => {
    if (senders[i]) {
      const key = senders[i].toLowerCase();
      current = byKey.get(key);
      if (!current) {
        current = { vendorHint: senders[i], slots: [] };
        byKey.set(key, current);
        segments.push(current);
      }
    } else if (!current) {
      current = { vendorHint: null, slots: [] }; // pages before the first email start
      segments.push(current);
    }
    current.slots.push(slot);
  });
  return segments;
}

// =====================================================================
// SHEIN invoices
//
// A SHEIN "order details" printout is one browser page per order, followed by
// "You May Also Like" product grids and the site footer. Those extra pages
// carry no invoice data but make up most of the file (and most of the tokens).
// =====================================================================

// A page that holds order data: the order header/table, or the totals block
// that spills onto the next page when an order is long.
function isSheinOrderPage(text) {
  const hasTitle = /ORDER\s+DETAILS/i.test(text);
  const hasOrderNo = /Order\s*NO\b/i.test(text) || SHEIN_ORDER_ID_RE.test(text);
  const hasTable = /Products\s+Quantity\s+SKU\s+Amount/i.test(text);
  const hasTotals = /Subtotal\s*:/i.test(text) && /Shipping\s*Fee/i.test(text);
  return (hasTitle && hasOrderNo) || hasTable || hasTotals;
}

// The document is SHEIN if it has order-detail pages and SHEIN branding somewhere.
function detectShein(texts) {
  const joined = texts.join('\n');
  return /SHEIN/i.test(joined) && texts.some((t) => isSheinOrderPage(t));
}

// Lines that never matter for extraction (promo banners, buttons, legal boilerplate).
const SHEIN_NOISE_LINE_RE = /^(back|copy|subscribe|track|review|received|\(?combine\)? return)$|Benefit will only|Delivery Service\]|Force Majeure|circumstance beyond|joint shipment/i;

// Reduces a SHEIN order page to the part that matters: the order number/date,
// the item table, and the price breakdown. The account sidebar, top navigation,
// billing/shipping/seller blocks and footer are dropped.
function sheinOrderText(page) {
  const words = page.words;

  // Sidebar: when the "Personal Center" menu is present, the content column starts
  // at the left edge of "Logistics" / "Products" / "Have been delivered".
  const hasSidebar = words.some((w) => /^Personal$/i.test(w.text)) && words.some((w) => /^Center$/i.test(w.text));
  let contentLeft = 0;
  if (hasSidebar) {
    const anchors = words.filter((w) => /^(Logistics|Products|Have|Order)$/i.test(w.text) && w.left > page.width * 0.2);
    contentLeft = anchors.length ? Math.min(...anchors.map((w) => w.left)) - 15 : Math.floor(page.width * 0.3);
  }

  // Top: start at the "ORDER DETAILS" title (skips header bar and breadcrumb).
  const titleWord = words
    .filter((w) => /^ORDER$/i.test(w.text) && w.left >= contentLeft)
    .find((w) => words.some((x) => /^DETAILS$/i.test(x.text) && Math.abs(x.top - w.top) < Y_TOL && x.left > w.left));
  const startTop = titleWord ? titleWord.top - 5 : 0;

  // Bottom: everything from the "Subscription" block down is billing/shipping/seller/footer.
  const subWord = words
    .filter((w) => /^Subscription$/i.test(w.text) && w.top > startTop)
    .sort((a, b) => a.top - b.top)[0];
  const endTop = subWord ? subWord.top - 5 : Infinity;

  const kept = words.filter((w) => w.top >= startTop && w.top < endTop && w.left >= contentLeft);
  return groupWordsIntoLines(kept)
    .map((line) => line.text)
    .filter((t) => t && !SHEIN_NOISE_LINE_RE.test(t.trim()))
    .join('\n');
}

// Groups the kept pages into orders: a page that shows an order number starts a
// new order; pages without one (a spilled totals block) belong to the previous order.
function groupSheinOrders(pages) {
  const groups = [];
  for (const page of pages) {
    const text = wordsToText(page.words);
    const startsOrder = /Order\s*NO\b/i.test(text) || SHEIN_ORDER_ID_RE.test(text);
    if (startsOrder || !groups.length) {
      groups.push({ pageNumbers: [page.pageNumber], text: sheinOrderText(page) });
    } else {
      const g = groups[groups.length - 1];
      g.pageNumbers.push(page.pageNumber);
      g.text += `\n${sheinOrderText(page)}`;
    }
  }
  return groups;
}

// =====================================================================
// Order summary box
// =====================================================================

const Y_TOL = 40;

// Pure layout logic (works on either word source). Finds the
// "Ship to ... Order Summary" header row and returns the box region to read.
function locateSummaryRegion(words, width, height) {
  const orderWords = words.filter((word) => word.text === 'Order');
  const summaryWords = words.filter((word) => word.text === 'Summary');
  let headerWord = null;

  for (const orderWord of orderWords) {
    const nearSummary = summaryWords.find((summaryWord) =>
      Math.abs(summaryWord.top - orderWord.top) < Y_TOL &&
      summaryWord.left > orderWord.left &&
      summaryWord.left - orderWord.left < 400
    );
    if (!nearSummary) continue;
    const hasShipOnRow = words.some((word) =>
      word.text === 'Ship' &&
      Math.abs(word.top - orderWord.top) < Y_TOL &&
      word.left < orderWord.left
    );
    if (hasShipOnRow) {
      headerWord = orderWord;
      break;
    }
  }
  if (!headerWord) return null;

  const shipWord = words.find((word) =>
    word.text === 'Ship' && Math.abs(word.top - headerWord.top) < Y_TOL
  );
  const topY = Math.min(headerWord.top, shipWord ? shipWord.top : headerWord.top) - 10;
  const leftX = (shipWord ? shipWord.left : headerWord.left) - 20;
  const grandWords = words.filter((word) => /grand/i.test(word.text) && word.top > topY);
  const bottomY = grandWords.length
    ? Math.min(...grandWords.map((word) => word.top)) + 60
    : topY + Math.floor(height * 0.25);
  const left = Math.max(0, leftX);
  const top = Math.max(0, topY);
  const cropWidth = width - left;
  const cropHeight = Math.min(height, bottomY) - top;
  if (cropWidth <= 0 || cropHeight <= 0) return null;

  // bottomY is returned as a fallback cutoff for item extraction.
  // headerTop lets item extraction find the first "Delivered..." status line below the box.
  return {
    left,
    top,
    width: cropWidth,
    height: cropHeight,
    bottomY: Math.min(height, bottomY),
    headerTop: topY,
    hadGrand: grandWords.length > 0,
  };
}

// Text-layer pages: the summary text is just the words inside the region.
function summaryTextFromWords(words, region) {
  const inRegion = words.filter((w) =>
    w.top >= region.top && w.top < region.top + region.height && w.left >= region.left
  );
  return groupWordsIntoLines(inRegion).map((line) => line.text).join('\n');
}

// OCR pages: crop the box out of the image and read it as a block of lines.
async function summaryTextFromImage(imgPath, region) {
  const cropPath = imgPath.replace(/\.png$/, '_crop.png');
  await sharp(imgPath)
    .extract({ left: region.left, top: region.top, width: region.width, height: region.height })
    .toFile(cropPath);
  const { stdout } = await execFileAsync(TESSERACT_COMMAND, [cropPath, 'stdout', '--psm', '6'], {
    maxBuffer: MAX_BUFFER,
    encoding: 'utf8',
    env: TESSERACT_ENV,
  });
  return stdout.replace(/\r\n/g, '\n');
}

function parseSummaryText(text) {
  const fields = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const amounts = line.replace(/,/g, '').match(AMOUNT_RE_G);
    if (!amounts) continue;
    const rawLabel = line.replace(AMOUNT_RE_G, '').trim().replace(/:$/, '').trim();
    const canon = normLabel(rawLabel);
    if (!canon) continue;
    const valStr = amounts[amounts.length - 1];
    const isNegative = valStr.includes('-');
    let num = parseFloat(valStr.replace(/[^\d.]/g, ''));
    if (isNaN(num)) continue;
    if (isNegative) num = -num;
    fields[canon] = num;
    if (line.includes('KYD')) fields.currency = 'KYD';
    else if (line.includes('USD')) fields.currency = 'USD';
  }
  return fields;
}

function getOrderNumber(text) {
  const match = ORDER_NUM_RE.exec(text);
  return match ? match[1] : null;
}

function computeNetTotal(fields, discountCapPct = 0.20) {
  const subtotal = fields.subtotal;
  if (subtotal === undefined) return {};
  const shipping = fields.shipping || 0;
  const discount = Math.abs(fields.discount || 0);
  const fxFee = fields.fx_guarantee_fee || 0;
  const rewardPts = Math.abs(fields.reward_points || 0);
  const actualDiscountPct = subtotal ? discount / subtotal : 0;
  const cappedPct = Math.min(actualDiscountPct, discountCapPct);
  const netTotal = (subtotal - subtotal * cappedPct) + shipping;

  // Discount above the cap is not honoured, so it is added back to the invoice's grand
  // total. Everything else in the grand total (tax, fees, shipping) stays as printed.
  const allowedDiscount = subtotal * cappedPct;
  const excessDiscount = discount - allowedDiscount;
  const grandTotalCapped = typeof fields.grand_total === 'number' && Number.isFinite(fields.grand_total)
    ? fields.grand_total + excessDiscount
    : null;

  return {
    discount_allowed: round2(allowedDiscount),
    discount_excess_added_back: round2(excessDiscount),
    grand_total_capped: grandTotalCapped === null ? null : round2(grandTotalCapped),
    subtotal: round2(subtotal),
    shipping: round2(shipping),
    discount_taken: round2(discount),
    actual_discount_pct: round2(actualDiscountPct * 100),
    discount_honored_pct_by_customs: round2(cappedPct * 100),
    fx_guarantee_fee_excluded: round2(fxFee),
    reward_points_redeemed_flag: rewardPts > 0,
    net_total_for_duty: round2(netTotal),
    currency: fields.currency || 'USD',
    tax_excluded: round2(fields.tax || 0),
    grand_total_on_invoice: fields.grand_total ?? null,
  };
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function getItemLineAmount(item) {
  if (typeof item.line_total === 'number' && Number.isFinite(item.line_total)) {
    return item.line_total;
  }
  if (typeof item.unit_price === 'number' && Number.isFinite(item.unit_price)) {
    const quantity = typeof item.quantity === 'number' && Number.isFinite(item.quantity)
      ? item.quantity
      : 1;
    return item.unit_price * quantity;
  }
  return null;
}

function allocateGrandTotalAcrossItems(items, grandTotal) {
  const amounts = items.map(getItemLineAmount);
  if (
    !amounts.length
    || typeof grandTotal !== 'number'
    || !Number.isFinite(grandTotal)
    || amounts.some((amount) => amount === null)
  ) {
    return amounts;
  }

  const itemCents = amounts.map((amount) => Math.round(amount * 100));
  const itemsSumCents = itemCents.reduce((total, cents) => total + cents, 0);
  const targetCents = Math.round(grandTotal * 100);

  // Preferred: scale every item in proportion to its value so the items add up to the
  // target (largest-remainder rounding keeps the cents exact). Tax, shipping and the
  // discount are therefore shared by value, not equally per item.
  if (itemsSumCents > 0 && targetCents > 0 && itemCents.every((cents) => cents >= 0)) {
    const exact = itemCents.map((cents) => (cents * targetCents) / itemsSumCents);
    const floors = exact.map(Math.floor);
    let left = targetCents - floors.reduce((total, cents) => total + cents, 0);
    const byRemainder = exact
      .map((value, index) => ({ index, rem: value - floors[index] }))
      .sort((a, b) => b.rem - a.rem);
    for (let i = 0; left > 0; i = (i + 1) % byRemainder.length, left -= 1) floors[byRemainder[i].index] += 1;
    return floors.map((cents) => cents / 100);
  }

  // Fallback (zero or negative amounts): equal split of the difference, as before.
  const adjustmentCents = targetCents - itemsSumCents;
  const equalShare = Math.trunc(adjustmentCents / itemCents.length);
  const remainder = adjustmentCents - equalShare * itemCents.length;

  return itemCents.map((cents, index) => {
    const remainderCent = index < Math.abs(remainder) ? Math.sign(remainder) : 0;
    return (cents + equalShare + remainderCent) / 100;
  });
}

// =====================================================================
// Item-line extraction (title -> "Sold by:" -> boilerplate -> price)
// =====================================================================

const BOILERPLATE_LINE_RE = new RegExp([
  '^(Delivered|Arriving|It was handed|Your package|Sold by|Supplied by',
  'Return or replace|View related transactions|Back to top|Conditions of Use',
  'Privacy Notice|Consumer Health|Your Ads|English|United States|Help|amazon',
  'Ship to|Payment method|Order Summary|Order placed|Grand Total',
  'Item\\(?s?\\)? Subtotal|Shipping ?& ?Handling|Estimated tax|Total before tax',
  'Print|©|http|Exchange rate|1 USD',
  // Browser print headers/footers: "10/5/26, 3:42 PM ..." and page counters like "2/3".
  '\\d{1,2}\\/\\d{1,2}\\/\\d{2,4},?\\s+\\d{1,2}:\\d{2}',
  '\\d{1,2}\\s?\\/\\s?\\d{1,2}$)',
].join('|'), 'i');

const STANDALONE_PRICE_RE = /^\$?-?\d[\d,]*\.\d{2}$/;

// Items always begin at the first delivery-status line ("Delivered October 5",
// "Arriving ...", etc.) below the summary box. Anchoring on that line is more
// robust than "Grand Total top + 60px", which breaks if OCR misses "Grand".
function findItemsStartY(words, headerTop) {
  const hit = words
    .filter((w) =>
      /^(Delivered|Arriving|Shipped|Delivery|Now|Preparing|Not)$/i.test(w.text) &&
      w.top > headerTop + 300
    )
    .sort((a, b) => a.top - b.top)[0];
  return hit ? hit.top - 10 : null;
}

// Product thumbnails sit to the left of the item text and OCR often reads junk
// from them ("q u) oO", "} ©", "hd", "aN."). Those junk words land at the same
// height as the title/price and get merged into the line, which stops the price
// from being recognised (the item is then silently dropped).
// The item text column starts at the "Sold by:" / "Return or replace" lines, so
// anything left of that column is thumbnail noise.
function findItemColumnLeft(words) {
  const anchors = words.filter((w) => /^(Sold|Supplied|Return)$/i.test(w.text));
  if (!anchors.length) return null;
  return Math.min(...anchors.map((w) => w.left)) - 25;
}

// Returns the numeric price if the line is a price on its own, allowing a few
// short junk tokens (<= 3 chars) in front of it; otherwise null.
function parsePriceLine(clean) {
  if (STANDALONE_PRICE_RE.test(clean.replace(/\s+/g, ''))) {
    return parseFloat(clean.replace(/[^\d.]/g, ''));
  }
  const tokens = clean.split(' ');
  const last = tokens[tokens.length - 1];
  if (
    STANDALONE_PRICE_RE.test(last) &&
    tokens.slice(0, -1).every((t) => t.length <= 3)
  ) {
    return parseFloat(last.replace(/[^\d.]/g, ''));
  }
  return null;
}

// Words join a line when their vertical centre is within 18px of the line's
// average centre. Comparing to the line average (not to the previous word) stops
// stray junk fragments from chaining two neighbouring lines together, and using
// the centre instead of the top edge keeps tall glyphs ("$", capitals) and
// x-height-only words on the same line.
function groupWordsIntoLines(words) {
  const center = (w) => w.top + (w.height || 0) / 2;
  const sorted = [...words].sort((a, b) => center(a) - center(b) || a.left - b.left);
  const lines = [];
  let cur = [];
  let sum = 0;
  for (const w of sorted) {
    const c = center(w);
    if (cur.length && Math.abs(c - sum / cur.length) > 18) {
      lines.push(cur);
      cur = [];
      sum = 0;
    }
    cur.push(w);
    sum += c;
  }
  if (cur.length) lines.push(cur);
  return lines.map((line) => {
    line.sort((a, b) => a.left - b.left);
    // Median (not min) so a stray junk fragment can't drag the line's position.
    const tops = line.map((w) => w.top).sort((a, b) => a - b);
    return {
      top: tops[Math.floor(tops.length / 2)],
      text: line.map((w) => w.text).join(' ').trim(),
      words: line,
    };
  });
}

// pages: array of { words, excludeBelowTop? } for the page range belonging to one order.
// excludeBelowTop (on the first page only) skips the order-summary header box region.
// A title buffer is carried across page breaks, so an item whose title is at the
// bottom of one page and price at the top of the next is still joined. If the
// range ends while a title has no price (item cut off), it is returned with
// price: null and incomplete: true instead of being silently dropped.
function extractItemsFromPageRange(pages) {
  const items = [];
  let titleBuffer = [];
  // Item layout is: title lines -> "Sold by:" -> (return info) -> price. Once
  // "Sold by:" has been seen, only the price can follow; anything else is noise
  // (typically half-clipped text lines at the edge of a screenshot page).
  let sawSoldBy = false;

  const flushIncomplete = () => {
    if (titleBuffer.length) {
      items.push({
        description: titleBuffer.join(' ').replace(/\s+/g, ' ').trim(),
        price: null,
        incomplete: true,
      });
    }
    titleBuffer = [];
    sawSoldBy = false;
  };

  for (const page of pages) {
    let words = page.words;
    if (page.excludeBelowTop !== undefined) {
      words = words.filter((w) => w.top >= page.excludeBelowTop);
    }
    const colLeft = findItemColumnLeft(words);
    const lines = groupWordsIntoLines(words);

    for (const line of lines) {
      // Strip thumbnail noise left of the item text column.
      const kept = colLeft === null ? line.words : line.words.filter((w) => w.left >= colLeft);
      const clean = kept.map((w) => w.text).join(' ').replace(/\s+/g, ' ').trim();
      // Boilerplate is matched on the full line too (e.g. "It was handed
      // directly to a receptionist..." starts left of the item column).
      const fullText = line.text.replace(/\s+/g, ' ').trim();

      if (BOILERPLATE_LINE_RE.test(fullText) || BOILERPLATE_LINE_RE.test(clean)) {
        if (/^(Sold|Supplied) by/i.test(clean) || /^(Sold|Supplied) by/i.test(fullText)) sawSoldBy = true;
        // A new delivery block can't start in the middle of an item: a title
        // still waiting for its price here means the price was never read.
        if (/^(Delivered|Arriving)/i.test(fullText)) flushIncomplete();
        continue;
      }
      if (!clean || clean.length <= 2) continue; // drop OCR noise like stray "-"

      const priceNum = parsePriceLine(clean);
      if (priceNum !== null) {
        if (titleBuffer.length) {
          items.push({
            description: titleBuffer.join(' ').replace(/\s+/g, ' ').trim(),
            price: priceNum,
            incomplete: false,
          });
          titleBuffer = [];
        }
        sawSoldBy = false;
        continue;
      }

      const conf = lineConf(kept);
      if (conf < 40) continue; // garbled / clipped text, not a real title line

      if (sawSoldBy) {
        // Between "Sold by:" and the price. Low-confidence text is clipped-line
        // noise. A clean, confident line means the next item's title has started
        // because this item's price was never read, so close it as incomplete.
        if (conf < 85 || clean.length < 12) continue;
        flushIncomplete();
      }
      titleBuffer.push(clean);
    }
  }

  flushIncomplete();
  return items;
}

// Mean OCR confidence of a line's words (text-layer words have none -> 100).
function lineConf(words) {
  const confs = words.map((w) => w.conf).filter((c) => typeof c === 'number' && !Number.isNaN(c));
  return confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : 100;
}

// =====================================================================
// LLM extraction (batched, with retries and automatic splitting on truncation)
// =====================================================================

const BASE_PROMPT = `Extract invoice/order details from the supplied text. The document may contain multiple orders, and they may come from DIFFERENT vendors/stores (for example several order emails merged into one PDF). Return one object per order and put that order's own vendor/store name on it ("vendor"); never stop after the first vendor, and never attach one vendor's items or totals to another vendor's order. When the price printed beside an item's quantity (e.g. "QTY: 6 $11.88") makes the item prices add up to the printed subtotal, it is the line total: set line_total to it and unit_price to line_total divided by quantity. Do not guess missing values: use null. Include every purchased item. For each item return description, short_name, variant, quantity, unit_price, line_total, and source_text. description is the full product title as printed. short_name is the product type in 2-4 words (e.g. "Tie-Up Jumpsuit", "Wireless Earbuds", "Phone Case"): no brand, no gender or season words ("Women's", "Summer"), no marketing filler. variant is the size/color/model/capacity as printed (e.g. "Hot Pink / L", "128GB Black"), or null. source_text is the first 120 characters of the title as printed. unit_price is the price of one unit; line_total only when explicitly printed as a line total. Also return order_number, order_date, currency, subtotal, shipping, discount (positive number), tax, and grand_total. Return ONLY valid JSON with this shape:
{"orders":[{"vendor":string|null,"order_number":string|null,"order_date":string|null,"currency":string|null,"items":[{"description":string,"short_name":string,"variant":string|null,"quantity":number|null,"unit_price":number|null,"line_total":number|null,"source_text":string}],"subtotal":number|null,"shipping":number|null,"discount":number|null,"tax":number|null,"grand_total":number|null}],"warnings":string[]}`;

const SHEIN_PROMPT_NOTES = `
This is a SHEIN "Order Details" printout. Each "=== ORDER ===" block below is exactly ONE order; return exactly one object per block, in the same order.
- order_number is the code starting with "GS" (e.g. GSU17V30Q000BBW), shown under "Order NO."; order_date is the value under "Date".
- Items are in the table with columns Products / Quantity / SKU / Amount / Status. The product title can wrap over several lines and ends with the variant (e.g. "Hot Pink / L"). Put the whole title in description, the product type in short_name, and the trailing variant in variant.
- The Amount column shows two prices for the item: the price charged and the struck-through original retail price. The text order of the two can be swapped (especially in OCR text), so the LOWER one is the charged price; use it as unit_price and never use the retail price.
- Text may come from OCR: in order numbers, letters O/Q and digit 0 are easily confused, so keep the order number exactly as printed.
- Under the table: Retail Price, Subtotal, Shipping Fee, On-Time Delivery Guarantee, Discount (coupon, shown as a negative), Sales Tax, Total. Map Total to grand_total, Sales Tax to tax, Shipping Fee to shipping ("FREE" means 0). Return the discount as a positive number.
- currency is USD unless stated otherwise.
- Keep source_text to the product title as printed, max 120 characters.`;

async function callAnthropic(prompt, { apiKey, model, signal }) {
  const maxAttempts = 5;
  for (let attempt = 1; ; attempt += 1) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal,
    });

    if (response.ok) return response.json();

    const retryable = response.status === 429 || response.status === 529 || response.status >= 500;
    if (retryable && attempt < maxAttempts) {
      const retryAfter = parseFloat(response.headers.get('retry-after'));
      const delayMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : Math.min(30000, 1000 * 2 ** attempt);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      continue;
    }
    const detail = await response.text().catch(() => '');
    throw new Error(`Anthropic API ${response.status}: ${detail.slice(0, 1500)}`);
  }
}

function parseModelJson(raw) {
  let cleaned = raw.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // Tolerate stray prose around the JSON object.
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start !== -1 && end > start) cleaned = cleaned.slice(start, end + 1);
    return JSON.parse(cleaned);
  }
}

// groups: [{ pageNumbers, text }]. Returns { orders, warnings }.
// If the answer is cut off (max_tokens) the batch is split in half and retried.
async function extractBatchAdaptive(groups, llmOptions) {
  const body = llmOptions.shein
    ? groups.map((g, i) => `=== ORDER ${i + 1} (pages ${g.pageNumbers.join(', ')}) ===\n${g.text}`).join('\n\n')
    : groups.map((g) => g.text).join('\n\n');
  const hintNote = llmOptions.vendorHint && !llmOptions.shein
    ? `\nThe text below is one vendor's document, sent by "${llmOptions.vendorHint}" (taken from the email header). Use the store's brand name as vendor.`
    : '';
  const prompt = `${BASE_PROMPT}${llmOptions.shein ? `\n${SHEIN_PROMPT_NOTES}` : ''}${hintNote}\n\nInvoice text:\n${body}`;

  const result = await callAnthropic(prompt, llmOptions);
  const raw = (result.content || []).filter((part) => part.type === 'text').map((part) => part.text).join('');

  let data = null;
  if (result.stop_reason !== 'max_tokens') {
    try {
      data = parseModelJson(raw);
    } catch {
      data = null;
    }
  }

  if (!data || !Array.isArray(data.orders)) {
    if (groups.length > 1) {
      const mid = Math.ceil(groups.length / 2);
      const [a, b] = await Promise.all([
        extractBatchAdaptive(groups.slice(0, mid), llmOptions),
        extractBatchAdaptive(groups.slice(mid), llmOptions),
      ]);
      return { orders: [...a.orders, ...b.orders], warnings: [...a.warnings, ...b.warnings] };    }
    if (result.stop_reason === 'max_tokens') {
      throw new Error('Anthropic response was truncated (max_tokens) even for a single batch.');
    }
    throw new Error(`Anthropic returned invalid JSON: ${raw.slice(0, 1000)}`);
  }

  const warnings = Array.isArray(data.warnings) ? [...data.warnings] : [];
  // One group = one order for SHEIN; when counts line up, remember which pages each order came from.
  // Vendor: the model's value wins; fall back to a top-level "vendor" (old shape), then the email-header hint.
  const orders = data.orders.map((order, i) => ({
    ...order,
    vendor: order.vendor || data.vendor || (llmOptions.shein ? 'SHEIN' : llmOptions.vendorHint) || null,
    __pages: llmOptions.shein && data.orders.length === groups.length
      ? groups[i].pageNumbers.join(',')
      : (llmOptions.pagesLabel || null),
  }));
  if (llmOptions.shein && data.orders.length !== groups.length) {
    warnings.push(`Expected ${groups.length} orders for pages ${groups[0].pageNumbers[0]}-${groups[groups.length - 1].pageNumbers.slice(-1)[0]} but got ${data.orders.length}; please review.`);
  }
  return { orders, warnings };
}

// =====================================================================

// Reads everything needed from one page: where the summary box is (if any),
// the parsed summary fields, and the order number mentioned on the page.
async function analyzePage(page) {
  const region = locateSummaryRegion(page.words, page.width, page.height);
  let fields = null;
  if (region) {
    const summaryText = page.source === 'text'
      ? summaryTextFromWords(page.words, region)
      : await summaryTextFromImage(page.imgPath, region);
    fields = parseSummaryText(summaryText);
  }
  const fullText = page.words.map((w) => w.text).join(' ');
  return { ...page, region, fields, orderNumber: getOrderNumber(fullText) };
}

/**
 * @param {string} pdfPath
 * @param {string} outputRoot  Scratch images (OCR pages only) go in <outputRoot>/_page_images/<name>.
 * @param {{ concurrency?: number, keepImages?: boolean }} [options]
 * @returns {Promise<{ orderRows: object[], itemRows: object[], warnings: string[], pageSources: string[] }>}
 */
async function processPdf(pdfPath, outputRoot, options = {}) {
  const { concurrency = DEFAULT_CONCURRENCY, keepImages = false } = options;
  const name = path.basename(pdfPath, '.pdf');
  const workdir = path.join(outputRoot, '_page_images', name);
  const warnings = [];

  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set. Add it to your environment or .env file.');

    const { pages: loaded, totalPages, segments } = await loadPages(pdfPath, workdir, concurrency);
    const pageSources = loaded.map((p) => p.source);
    const merged = segments.length > 1; // several vendors' documents in one PDF

    // Build the units of work, one per vendor segment. SHEIN segment: one group per
    // order, trimmed to the useful lines, sent in batches. Anything else: all of the
    // segment's pages in a single request. A single-vendor PDF is one segment.
    const batches = [];
    for (const seg of segments) {
      if (seg.shein) {
        const groups = groupSheinOrders(seg.pages);
        const before = batches.length;
        for (let i = 0; i < groups.length; i += ORDERS_PER_REQUEST) {
          batches.push({ shein: true, vendorHint: 'SHEIN', pagesLabel: null, groups: groups.slice(i, i + ORDERS_PER_REQUEST) });
        }
        warnings.push(
          `SHEIN invoice detected: sent ${seg.pages.length} of ${totalPages} pages (${groups.length} orders) to the LLM in ${batches.length - before} request(s).`
        );
      } else {
        const pageNumbers = seg.pages.map((p) => p.pageNumber);
        const text = seg.pages.map((page) =>
          `=== PAGE ${page.pageNumber} ===\n${wordsToText(page.words)}`
        ).join('\n\n');
        batches.push({
          shein: false,
          vendorHint: seg.vendorHint,
          pagesLabel: merged ? pageNumbers.join(',') : null,
          groups: [{ pageNumbers, text }],
        });
      }
    }
    if (merged) {
      warnings.push(
        `Merged invoice detected: ${segments.length} vendor documents (${segments.map((s) => s.vendorHint || 'unknown').join(', ')}), each extracted separately.`
      );
    }

    const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
    const baseLlmOptions = { apiKey, model, signal: options.signal };
    const batchResults = await mapLimit(batches, LLM_CONCURRENCY, (batch) =>
      extractBatchAdaptive(batch.groups, {
        ...baseLlmOptions,
        shein: batch.shein,
        vendorHint: batch.vendorHint,
        pagesLabel: batch.pagesLabel,
      })
    );

    const allOrders = [];
    batchResults.forEach((res, i) => {
      allOrders.push(...res.orders);
      warnings.push(...res.warnings);
      // In a merged file a vendor that yields nothing must not vanish silently:
      // emit an empty order so it shows up in the output flagged for review.
      if (merged && !res.orders.length) {
        const b = batches[i];
        warnings.push(`No orders extracted for ${b.vendorHint || 'unknown vendor'} (pages ${b.groups[0].pageNumbers.join(',')}).`);
        allOrders.push({ vendor: b.vendorHint || null, items: [], __pages: b.pagesLabel });
      }
    });
    const data = { orders: allOrders };
    const orderRows = [];
    const itemRows = [];

    data.orders.forEach((order, index) => {
      const fields = {
        subtotal: order.subtotal,
        shipping: order.shipping,
        discount: order.discount,
        tax: order.tax,
        grand_total: order.grand_total,
        currency: order.currency,
      };
      const netTotals = computeNetTotal(fields);
      const items = Array.isArray(order.items) ? order.items : [];
      const itemAmounts = items.map(getItemLineAmount);
      // Item prices add up to the grand total recomputed with the discount capped (20%),
      // falling back to the printed grand total when it can't be computed.
      const allocatedItemPrices = allocateGrandTotalAcrossItems(items, netTotals.grand_total_capped ?? order.grand_total);
      const reviewFlags = [];
      if (order.subtotal == null) reviewFlags.push('summary_not_parsed');
      if (!order.order_number) reviewFlags.push('order_number_missing');
      if (!items.length) reviewFlags.push('no_items_found');
      if (items.some((item) => item.unit_price == null && item.line_total == null)) {
        reviewFlags.push('items_missing_price');
      }

      const itemsSum = round2(itemAmounts.reduce((sum, amount) => sum + (amount ?? 0), 0));

      if (typeof order.subtotal === 'number' && items.length && Math.abs(itemsSum - order.subtotal) > 0.01) {
        reviewFlags.push('items_sum_differs_from_subtotal');
      }

      orderRows.push({
        order_index: index,
        source_file: path.basename(pdfPath),
        vendor: order.vendor || null,
        order_number: order.order_number || null,
        order_date: order.order_date || null,
        pages: order.__pages || 'all',
        ...netTotals,
        items_sum: itemsSum,
        needs_review: reviewFlags.length > 0,
        review_flags: reviewFlags.join('; '),
      });

      items.forEach((item, itemIndex) => {
        const price = allocatedItemPrices[itemIndex];
        itemRows.push({
          order_index: index,
          source_file: path.basename(pdfPath),
          vendor: order.vendor || null,
          order_number: order.order_number || null,
          item_description: pickDescription(item),
          item_price: price,
          item_quantity: item.quantity ?? null,
          item_unit_price: item.unit_price ?? null,
          item_line_total: item.line_total ?? null,
          item_source_text: hasRealText(item.source_text) ? item.source_text : (item.description || ''),
          item_incomplete: price === null,
        });
      });
    });

    return { orderRows, itemRows, warnings, pageSources, totalPages, pagesSent: loaded.length, merged };
  } finally {
    if (!keepImages) {
      await fsp.rm(workdir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

module.exports = { processPdf };