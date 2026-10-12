/**
 * Tariff matching module (importable). Claude-only, three-stage approach:
 *
 *   Stage 1 (Claude, cheap): generate synonym/keyword variants for the item
 *   Stage 2 (local, exhaustive): IDF-weighted keyword search over the ENTIRE tariff list
 *   Stage 3 (Claude, careful): pick the best fit from the short candidate list
 *
 * Setup:
 *   npm install @anthropic-ai/sdk dotenv
 *   .env:  ANTHROPIC_API_KEY=...
 *   Optional env: TARIFFS_FILE (default ./tariffs.json next to this file),
 *                 CLAUDE_MODEL, TARIFF_MATCH_CONCURRENCY
 *
 * Usage:
 *   const { matchItems, matchItem } = require('./matchTariffs.cjs');
 *   const results = await matchItems(['item one', 'item two']); // same order as input
 *
 * Never throws per item: a failed item gets matched_code null, confidence "low"
 * and the failure in `reason`, so one bad call can't fail a whole invoice.
 */

const fs = require("fs/promises");
const path = require("path");
require("dotenv").config();
const Anthropic = require("@anthropic-ai/sdk");

// ---------- CONFIG ----------
const TARIFFS_FILE = process.env.TARIFFS_FILE || path.join(__dirname, "tariffs.json");
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5-5";
const DEFAULT_CONCURRENCY = parseInt(process.env.TARIFF_MATCH_CONCURRENCY || "4", 10);
const MAX_CANDIDATES = 60;

let _client = null;
function getClient() {
  // Lazy so that requiring this module never crashes the server if the key is missing.
  if (!_client) _client = new Anthropic({ maxRetries: 4 });
  return _client;
}

// ---------- JSON EXTRACTION HELPER ----------
function extractJson(text) {
  const cleaned = text.trim().replace(/^```json|^```|```$/gm, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    // fall through
  }
  for (const [openC, closeC] of [["{", "}"], ["[", "]"]]) {
    const start = cleaned.indexOf(openC);
    const end = cleaned.lastIndexOf(closeC);
    if (start !== -1 && end !== -1 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch (e) {
        continue;
      }
    }
  }
  throw new Error("Could not extract JSON from: " + text.slice(0, 200));
}

// ---------- TEXT NORMALIZATION ----------
const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "this", "that", "your", "are", "size",
  "pack", "set", "made", "ages", "age", "pre", "no", "not", "new", "all",
  "any", "has", "had", "was", "can", "its", "per",
]);

function normalizeText(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function extractLiteralWords(itemText) {
  const words = normalizeText(itemText).match(/[a-z0-9]{3,}/g) || [];
  return [...new Set(words)].filter((w) => !STOPWORDS.has(w));
}

// ---------- 1. LOAD & FILTER TARIFFS (cached) ----------
function isLeafCode(entry) {
  const code = entry.code;
  return !code.includes("-") && code.trim() !== "";
}

function buildHierarchyMap(tariffs) {
  const map = {};
  for (const t of tariffs) map[t.code] = t.description;
  return map;
}

function getHierarchyText(entry, prefixMap) {
  const code = entry.code;
  const chain = [];
  const chapterPrefix = code.slice(0, 2) + "----";
  const headingPrefix = code.slice(0, 4) + "--";
  for (const prefix of [chapterPrefix, headingPrefix]) {
    const desc = prefixMap[prefix];
    if (desc && desc !== entry.description && !chain.includes(desc)) chain.push(desc);
  }
  chain.push(entry.description);
  return chain.join(" zzlevelboundaryzz ");
}

async function loadTariffEntries() {
  const data = JSON.parse(await fs.readFile(TARIFFS_FILE, "utf-8"));
  const tariffs = data.tariffs;
  const prefixMap = buildHierarchyMap(tariffs);
  const entries = tariffs.filter(isLeafCode);
  const byCode = new Map();
  for (const t of entries) {
    t.search_text = getHierarchyText(t, prefixMap);
    t._norm = normalizeText(t.search_text); // precomputed once, not per item
    if (!byCode.has(t.code)) byCode.set(t.code, t);
  }
  return { entries, byCode };
}

let _tariffPromise = null;
function getTariffs() {
  if (!_tariffPromise) {
    _tariffPromise = loadTariffEntries().catch((err) => {
      _tariffPromise = null; // allow retry after e.g. a missing file is fixed
      throw err;
    });
  }
  return _tariffPromise;
}

// ---------- STAGE 1: CLAUDE GENERATES SEARCH KEYWORDS ----------
async function getSearchTerms(itemText) {
  const prompt = `An invoice line item needs to be matched against a customs tariff code list. Tariff descriptions use formal/technical trade terminology, which often differs from plain product names (e.g. a "garbage disposal" appears in tariff lists as a "food grinder"; a "massage ball" might appear as "massage apparatus" or just "balls").

Invoice item: "${itemText}"

List 6-10 short keywords or technical synonyms (single words or short phrases, 1-3 words each) that might appear in the formal tariff description for this product's material, function, or category. Include the obvious terms AND less obvious technical/trade equivalents.

Respond ONLY with a JSON array of strings, no markdown fences, no extra text:
["term1", "term2", ...]
`;

  const response = await getClient().messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 400,
    messages: [{ role: "user", content: prompt }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  const text = textBlock ? textBlock.text.trim() : "[]";
  try {
    const terms = extractJson(text);
    if (!Array.isArray(terms)) return [];
    return terms.filter((t) => typeof t === "string").map((t) => t.toLowerCase());
  } catch (e) {
    console.warn(`[tariff-match] could not parse search terms: ${text.slice(0, 200)}`);
    return [];
  }
}

// ---------- STAGE 2: LOCAL EXHAUSTIVE KEYWORD SEARCH ----------
const GENERIC_DF_THRESHOLD = 300;
const PHRASE_WEIGHT = 3;
const WORD_WEIGHT = 1;
const DISTINCTIVE_DF_MAX = 20;
const ABSOLUTE_MAX_CANDIDATES = 90;

function keywordSearch(rawTerms, entries, k = MAX_CANDIDATES) {
  const expandedTerms = new Set();
  for (const term of rawTerms) {
    const norm = normalizeText(term);
    if (norm) {
      expandedTerms.add(norm);
      for (const word of norm.split(" ")) {
        if (word.length >= 3 && !STOPWORDS.has(word)) expandedTerms.add(word);
      }
    }
  }
  const terms = [...expandedTerms];
  const texts = entries.map((e) => e._norm);
  const N = entries.length;

  const docFreq = {};
  for (const term of terms) {
    docFreq[term] = texts.reduce((count, t) => count + (t.includes(term) ? 1 : 0), 0);
  }

  function scoreEntry(text) {
    let score = 0.0;
    for (const term of terms) {
      const df = docFreq[term];
      if (df > 0 && df <= GENERIC_DF_THRESHOLD && text.includes(term)) {
        const idf = Math.log(N / df);
        score += (term.includes(" ") ? PHRASE_WEIGHT : WORD_WEIGHT) * idf;
      }
    }
    return score;
  }

  let scored = texts.map((text, i) => [scoreEntry(text), i]).filter(([s]) => s > 0);
  if (scored.length === 0) {
    scored = texts
      .map((text, i) => [terms.reduce((c, term) => c + (text.includes(term) ? 1 : 0), 0), i])
      .filter(([s]) => s > 0);
  }

  scored.sort((a, b) => b[0] - a[0]);
  const topIndices = scored.slice(0, k).map(([, i]) => i);

  const distinctiveTerms = terms.filter((t) => docFreq[t] > 0 && docFreq[t] <= DISTINCTIVE_DF_MAX);
  const topSet = new Set(topIndices);
  for (let i = 0; i < texts.length; i++) {
    if (topIndices.length >= ABSOLUTE_MAX_CANDIDATES) break;
    if (topSet.has(i)) continue;
    if (distinctiveTerms.some((t) => texts[i].includes(t))) {
      topIndices.push(i);
      topSet.add(i);
    }
  }

  return topIndices.slice(0, ABSOLUTE_MAX_CANDIDATES).map((i) => entries[i]);
}

// ---------- STAGE 3: CLAUDE CAREFULLY PICKS FROM CANDIDATES ----------
async function finalMatch(itemText, candidates) {
  if (candidates.length === 0) {
    return {
      matched_code: null,
      description: "",
      confidence: "low",
      reason: "No candidates found via keyword search - needs manual classification.",
    };
  }

  const candidatesText = candidates.map((c) => `${c.code}\t${c.description}`).join("\n");

  const prompt = `You are a customs classification expert. Below are candidate tariff codes for this invoice item, found via keyword search. Read each candidate's FULL description carefully, including any exclusion clauses in parentheses (excl. ...) - a candidate that looks like a strong keyword match can still be WRONG if it explicitly excludes this type of product, in which case another candidate on the list is likely the correct one.

Invoice item: "${itemText}"

Candidate tariff codes:
${candidatesText}

Respond ONLY with JSON, no markdown fences, no extra text:
{"matched_code": "best code exactly as given, or null if none genuinely fit", "description": "its description", "confidence": "high|medium|low", "reason": "MAX 25 words. The fit, plus why the closest competitor lost if relevant. Do not list every rejected candidate."}
`;

  const response = await getClient().messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 4096,
    messages: [{ role: "user", content: prompt }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock) {
    return { matched_code: null, description: "", confidence: "low", reason: "no text block in response" };
  }
  if (response.stop_reason === "max_tokens") {
    console.warn("[tariff-match] response truncated at max_tokens");
  }
  const text = textBlock.text.trim();
  try {
    return extractJson(text);
  } catch (e) {
    console.warn(`[tariff-match] could not parse final match: ${text.slice(0, 300)}`);
    return { matched_code: null, description: "", confidence: "low", reason: "parse error" };
  }
}

// ---------- PUBLIC API ----------
const _cache = new Map(); // normalized description -> Promise<result>

async function matchItemUncached(itemText) {
  const { entries, byCode } = await getTariffs();

  const aiTerms = await getSearchTerms(itemText);
  const terms = [...new Set([...aiTerms, ...extractLiteralWords(itemText)])];
  const candidates = keywordSearch(terms, entries);
  const result = await finalMatch(itemText, candidates);

  let code = result.matched_code ?? null;
  let confidence = result.confidence || "unknown";
  let reason = result.reason || "";

  // Guard against hallucinated codes: the answer must be one of the candidates we sent.
  if (code !== null && !candidates.some((c) => c.code === String(code))) {
    reason = `Model returned a code not in the candidate list (${code}). ${reason}`.trim();
    code = null;
    confidence = "low";
  }

  const entry = code !== null ? byCode.get(String(code)) : null;
  return {
    matched_code: code,
    description: entry ? entry.description : result.description || "",
    duty_rate: entry ? entry.duty : null,
    unit: entry ? entry.unit ?? null : null,
    confidence,
    reason,
    candidates_considered: candidates.length,
  };
}

/** Match one item description. Never rejects; failures come back as a low-confidence null match. */
function matchItem(itemText) {
  const key = normalizeText(itemText);
  if (!key) {
    return Promise.resolve({
      matched_code: null, description: "", duty_rate: null, unit: null,
      confidence: "low", reason: "empty item description", candidates_considered: 0,
    });
  }
  if (_cache.has(key)) return _cache.get(key);

  const promise = matchItemUncached(itemText).catch((err) => {
    _cache.delete(key); // don't cache failures
    console.error(`[tariff-match] failed for "${itemText}":`, err.message);
    return {
      matched_code: null, description: "", duty_rate: null, unit: null,
      confidence: "low", reason: `matching failed: ${err.message}`, candidates_considered: 0,
    };
  });
  _cache.set(key, promise);
  return promise;
}

/** Match many items with bounded concurrency. Results are returned in input order. */
async function matchItems(itemTexts, { concurrency = DEFAULT_CONCURRENCY } = {}) {
  const results = new Array(itemTexts.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= itemTexts.length) return;
      results[i] = await matchItem(itemTexts[i]);
    }
  }
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, itemTexts.length)) }, worker);
  await Promise.all(workers);
  return results;
}

module.exports = { matchItem, matchItems };
