// Turns the per-token probabilities of a model answer into per-word confidence and alternative readings.
//
// Ollama reports, for every generated token, its probability and the most likely other tokens at that position. For Arabic the
// probability of a token is spread over its diacritic variants (fatha / damma / kasra of the same letters), which says nothing
// about whether the LETTERS are right. So the confidence of a token is the total probability of all candidates that have the same
// letters (diacritics ignored); the alternatives are the candidates that have different letters but the same length (a ق where a ف
// could be, a ب where a ن could be). A word with a doubtful letter is flagged for review and the other spellings are offered.
// Nothing is ever swapped automatically.
import { stripMarks } from './arabic.js';

const FFFD = String.fromCharCode(0xfffd);
const isSpace = (ch) => ch === ' ' || ch === String.fromCharCode(10) || ch === String.fromCharCode(9);
const letters = (s) => stripMarks(s);

/**
 * @param {{token:string,logprob:number,bytes:number[],top_logprobs:{token:string,logprob:number,bytes:number[]}[]}[]} logprobs
 * @param {{altProb?:number, maxAlts?:number}} [opt]
 * @returns {{text:string, words:{text:string,start:number,end:number,conf:number,alts:{text:string,p:number}[]}[]}}
 *   `text` is the decoded answer; word offsets are indexes into it (end exclusive); `conf` is the probability that the letters
 *   of the word are what the model wrote.
 */
export function wordConfidence(logprobs, { altProb = 0.05, maxAlts = 3 } = {}) {
  const toks = (logprobs || []).filter((t) => Array.isArray(t.bytes));
  const all = Buffer.concat(toks.map((t) => Buffer.from(t.bytes)));
  const text = all.toString('utf8');

  // byte offset -> char index (interior bytes of a character belong to that character)
  const byteToChar = new Int32Array(all.length + 1);
  {
    let b = 0, c = 0;
    for (const ch of text) {
      const n = Buffer.byteLength(ch);
      for (let k = 0; k < n; k++) byteToChar[b + k] = c;
      b += n;
      c += ch.length;
    }
    byteToChar[all.length] = c;
  }

  const words = [];
  let i = 0;
  while (i < text.length) {
    if (isSpace(text[i])) { i++; continue; }
    let j = i;
    while (j < text.length && !isSpace(text[j])) j++;
    words.push({ text: text.slice(i, j), start: i, end: j, conf: 1, alts: [] });
    i = j;
  }

  let pos = 0;
  let w = 0;
  for (const t of toks) {
    const b0 = pos;
    const b1 = pos + t.bytes.length;
    pos = b1;
    const own = Buffer.from(t.bytes).toString('utf8');
    // a token that is only a fragment of a character (or pure marks/spaces) carries no letter decision
    if (b1 <= b0 || own.includes(FFFD) || !letters(own).trim()) continue;
    const ownLetters = letters(own);
    const c0 = byteToChar[b0];
    const c1 = byteToChar[Math.min(b1, all.length) - 1] + 1;

    let same = Math.exp(t.logprob);
    const diff = [];
    for (const alt of t.top_logprobs || []) {
      if (!alt.bytes || alt.token === t.token) continue;
      const s = Buffer.from(alt.bytes).toString('utf8');
      if (s.includes(FFFD)) continue;
      const ap = Math.exp(alt.logprob);
      const al = letters(s);
      if (al === ownLetters) same += ap;
      else if (al.length === ownLetters.length && ap >= altProb) diff.push({ s, ap });
    }
    const conf = Math.min(1, same);

    while (w < words.length - 1 && words[w].end <= c0) w++;
    for (let x = w; x < words.length && words[x].start < c1; x++) {
      const word = words[x];
      if (conf < word.conf) word.conf = conf;
      for (const { s, ap } of diff) {
        const replaced = Buffer.concat([all.subarray(0, b0), Buffer.from(s), all.subarray(b1)]).toString('utf8');
        const cand = replaced.slice(word.start, word.end + (replaced.length - text.length)).trim();
        if (cand && !cand.includes(' ') && cand !== word.text && !word.alts.some((a) => a.text === cand)) word.alts.push({ text: cand, p: ap });
      }
    }
  }
  for (const word of words) word.alts = word.alts.sort((a, b) => b.p - a.p).slice(0, maxAlts);
  return { text, words };
}
