/**
 * Invoice Net-Total + Line-Item Extraction Pipeline.
 * Requires the system binaries pdftoppm and tesseract, plus sharp.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const sharp = require('sharp');

const DPI = 300;
const PDF_TO_IMAGE_COMMAND = resolveCommand('pdftoppm', [
  'C:\\Program Files\\poppler-26.09.0\\Library\\bin\\pdftoppm.exe',
]);
const TESSERACT_COMMAND = resolveCommand('tesseract', [
  'C:\\Users\\muddassir\\AppData\\Local\\Programs\\Tesseract-OCR\\tesseract.exe',
]);
const AMOUNT_RE_G = /-?(?:USD|KYD)?\s?-?\d[\d,]*\.\d{2}/g;
const ORDER_NUM_RE = /Order\s*#\s*([\d-]{10,})/i;

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

function normLabel(rawLabel) {
  const key = rawLabel.toLowerCase().replace(/collected/g, '').trim();
  for (const [re, canon] of LABEL_MAP) {
    if (re.test(key)) return canon;
  }
  return null;
}

function pdfToImages(pdfPath, outPrefix) {
  fs.mkdirSync(path.dirname(outPrefix), { recursive: true });
  execFileSync(PDF_TO_IMAGE_COMMAND, ['-png', '-r', String(DPI), pdfPath, outPrefix]);
  const dir = path.dirname(outPrefix);
  const base = path.basename(outPrefix);
  return fs.readdirSync(dir)
    .filter((fileName) => fileName.startsWith(base) && fileName.endsWith('.png') && !fileName.endsWith('_crop.png'))
    .sort()
    .map((fileName) => path.join(dir, fileName));
}

function getWordsTSV(imgPath) {
  const raw = execFileSync(TESSERACT_COMMAND, [imgPath, 'stdout', 'tsv'], {
    maxBuffer: 1024 * 1024 * 50,
  }).toString();
  // Tesseract on Windows emits CRLF, which can leave a trailing carriage return
  // on the final TSV header and prevent the text column from being read.
  const output = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
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
    words.push(row);
  }
  return words;
}

const Y_TOL = 40;

async function findOrderSummaryCrop(imgPath, words) {
  const meta = await sharp(imgPath).metadata();
  const { width, height } = meta;
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

  const cropPath = imgPath.replace(/\.png$/, '_crop.png');
  await sharp(imgPath).extract({ left, top, width: cropWidth, height: cropHeight }).toFile(cropPath);
  // bottomY is returned so item extraction can skip the summary box region.
  return { cropPath, bottomY: Math.min(height, bottomY) };
}

function parseCrop(cropPath) {
  // Fixed: uses the resolved TESSERACT_COMMAND (V2 previously called bare 'tesseract' here).
  const text = execFileSync(TESSERACT_COMMAND, [cropPath, 'stdout', '--psm', '6']).toString().replace(/\r\n/g, '\n');
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

  return {
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

// =====================================================================
// Item-line extraction (title -> "Sold by:" -> boilerplate -> price)
// =====================================================================

const BOILERPLATE_LINE_RE = new RegExp([
  '^(Delivered|Arriving|It was handed|Your package|Sold by|Supplied by',
  'Return or replace|View related transactions|Back to top|Conditions of Use',
  'Privacy Notice|Consumer Health|Your Ads|English|United States|Help|amazon',
  'Ship to|Payment method|Order Summary|Order placed|Grand Total',
  'Item\\(?s?\\)? Subtotal|Shipping ?& ?Handling|Estimated tax|Total before tax',
  'Print|©|http|Exchange rate|1 USD)',
].join('|'), 'i');

const STANDALONE_PRICE_RE = /^\$?-?\d[\d,]*\.\d{2}$/;

function groupWordsIntoLines(words) {
  const sorted = [...words].sort((a, b) => a.top - b.top || a.left - b.left);
  const lines = [];
  let cur = [];
  let lastTop = null;
  for (const w of sorted) {
    if (lastTop !== null && Math.abs(w.top - lastTop) > 18) {
      lines.push(cur);
      cur = [];
    }
    cur.push(w);
    lastTop = w.top;
  }
  if (cur.length) lines.push(cur);
  return lines.map((line) => {
    line.sort((a, b) => a.left - b.left);
    return { top: line[0].top, text: line.map((w) => w.text).join(' ').trim() };
  });
}

// pages: array of { words, excludeBelowTop? } for the page range belonging to one order.
// excludeBelowTop (on the first page only) skips the order-summary header box region.
function extractItemsFromPageRange(pages) {
  const items = [];
  let titleBuffer = [];

  for (const page of pages) {
    let words = page.words;
    if (page.excludeBelowTop !== undefined) {
      words = words.filter((w) => w.top >= page.excludeBelowTop);
    }
    const lines = groupWordsIntoLines(words);

    for (const { text } of lines) {
      const clean = text.replace(/\s+/g, ' ').trim();
      if (!clean || clean.length <= 2) continue; // drop OCR noise like stray "-"
      if (STANDALONE_PRICE_RE.test(clean.replace(/\s+/g, ''))) {
        if (titleBuffer.length) {
          const priceNum = parseFloat(clean.replace(/[^\d.]/g, ''));
          items.push({
            description: titleBuffer.join(' ').replace(/\s+/g, ' ').trim(),
            price: priceNum,
          });
          titleBuffer = [];
        }
        continue;
      }
      if (BOILERPLATE_LINE_RE.test(clean)) continue;
      titleBuffer.push(clean);
    }
  }
  return items;
}

// =====================================================================

async function processPdf(pdfPath, outputRoot) {
  const name = path.basename(pdfPath, '.pdf');
  const workdir = path.join(outputRoot, '_page_images', name);
  const images = pdfToImages(pdfPath, path.join(workdir, 'pg'));

  // Pass 1: OCR every page once and locate each order's anchor page
  // (the page carrying its Ship-to / Order Summary / Grand Total box).
  const pages = images.map((imgPath) => ({ imgPath, words: getWordsTSV(imgPath) }));
  const anchors = [];
  let currentOrderNum = null;

  for (let i = 0; i < pages.length; i += 1) {
    const fullText = pages[i].words.map((w) => w.text).join(' ');
    const orderNumber = getOrderNumber(fullText);
    if (orderNumber) currentOrderNum = orderNumber;

    const crop = await findOrderSummaryCrop(pages[i].imgPath, pages[i].words);
    if (crop) {
      const fields = parseCrop(crop.cropPath);
      anchors.push({ pageIdx: i, fields, orderNum: currentOrderNum, bottomY: crop.bottomY });
      currentOrderNum = null;
    }
  }

  const orderRows = [];
  const itemRows = [];

  // Pass 2: an order's items run from below its summary box on the anchor page
  // through the page before the next anchor.
  for (let a = 0; a < anchors.length; a += 1) {
    const anchor = anchors[a];
    const startIdx = anchor.pageIdx;
    const endIdx = (a + 1 < anchors.length) ? anchors[a + 1].pageIdx - 1 : pages.length - 1;

    const pageSlice = [];
    for (let p = startIdx; p <= endIdx; p += 1) {
      pageSlice.push({
        words: pages[p].words,
        excludeBelowTop: (p === startIdx) ? anchor.bottomY : undefined,
      });
    }

    orderRows.push({
      order_index: a,
      source_file: path.basename(pdfPath),
      order_number: anchor.orderNum,
      pages: `pg-${startIdx + 1}..pg-${endIdx + 1}`,
      ...computeNetTotal(anchor.fields),
    });

    for (const item of extractItemsFromPageRange(pageSlice)) {
      itemRows.push({
        order_index: a,
        source_file: path.basename(pdfPath),
        order_number: anchor.orderNum,
        item_description: item.description,
        item_price: item.price,
      });
    }
  }

  return { orderRows, itemRows };
}

module.exports = { processPdf };
