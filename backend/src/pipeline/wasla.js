// Hamzat al-wasl (ٱ) in a fully vowelled book that prints it: "ٱلْحَدَثِ", "وَٱلتَّغَيُّرُ", "ٱسْمَ ٱلْمَاءِ", "ٱدَّعَى". The line reader
// has no such letter in mind: it writes a plain alif ("الْحَدَثِ"), or takes the small ص over the alif for a hamza and a fatha
// ("أَلْمَاءُ", "أَلطَّهَارَةُ", "أَسْمَ"). Whether the book prints ٱ is told by those slips over the whole book: an article with a hamza
// in the middle of a sentence ("لَمْ تَصِحَّ أَلطَّهَارَةُ") is no Arabic, and the reader writes it only where it saw a mark there.
// The alifs that are wasla are then written ٱ:
// - an article's alif written plain;
// - an article's alif written with a hamza where the word is surely the article: a doubled sun letter after the lam
//   ("أَلطَّهَارَةُ"), a lam with a kasra before an alif ("أَلِاسْتِنْجَاءِ"), or a word the book has elsewhere without the article or
//   with a plain one ("أَلْمَاءِ" and "مَاءً"). "أَلْحَقَ", "أَلْفَاظٌ", "أَلْقَى" are words of their own and keep their hamza;
// - a plain alif before a letter with a sukun, or opening a word before a doubled letter ("ٱسْمَ", "ٱدَّعَى"), unless the book
//   has the word with a hamza more often (a hamza the reader dropped: "اكْثَرُ"); with a hamza, only in ٱسْم ٱبْن ٱمْرَأَة ٱثْنَانِ.
// Whatever the book, a sukun on the article's lam before a doubled sun letter ("الْنَّجَسِ") is a misreading and is dropped.

const MARK = /[\u064B-\u0655\u0670]/;
const SUKUN = '\u0652';
const SHADDA = '\u0651';
const FATHA = '\u064E';
const KASRA = '\u0650';
const WASLA = 'ٱ';
// the nouns that open with a wasla, as the letters after it (with the pronouns joined to them)
const WASLA_NOUNS = /^(?:سم|بن|بنة|مرأة|مرأت|مرؤ|مرئ|مرأ|ثنان|ثنين|ثنتان|ثنتين)(?:ه|ها|هم|هما|هن|ك|كم|ي|نا)?$/;

/** A word's letters, each with the marks that follow it. */
function graphemes(word) {
  const out = [];
  for (const ch of word) {
    if (MARK.test(ch) && out.length) out[out.length - 1].m += ch;
    else out.push({ c: ch, m: '' });
  }
  return out;
}
const join = (g) => g.map((x) => x.c + x.m).join('');
const lettersOf = (g) => g.map((x) => x.c).join('');

/**
 * Where a word's alif stands, after the letters joined before it (و ف ب ك, two at most), and what kind of alif it would be:
 * `article` (the lam of the article after it), `sukun` (a letter with a sukun after it) or `shadda` (a doubled letter after it, the
 * word opening with the alif). null when the alif cannot be a wasla.
 */
function alifOf(g) {
  for (let a = 0; a <= 2 && a < g.length; a++) {
    if (a && !'وفبك'.includes(g[a - 1].c)) return null;
    if (!'اأٱ'.includes(g[a].c)) continue;
    const next = g[a + 1];
    const after = g[a + 2];
    if (!next || !after) return null;
    if (next.c === 'ل' && g.length - a >= 4) {
      // the lam with a kasra before the wasla of the word after it: "ٱلِاسْتِنْجَاءُ"
      if (next.m === KASRA && 'اٱ'.includes(after.c)) return { a, kind: 'article', sure: true };
      if (next.m === '' || next.m === SUKUN) {
        // the lam unmarked: an article only in a vowelled word ("وَالِدٌ" has its kasra, "الحمد" is not vowelled)
        if (next.m === '' && !g.slice(a + 2).some((x) => x.m)) return null;
        return { a, kind: 'article', sun: after.m.includes(SHADDA), sure: after.m.includes(SHADDA) };
      }
    }
    if (next.m === SUKUN && g.length - a >= 3) return { a, kind: 'sukun' }; // "ٱسْمَ", "ٱبْنُ"
    // "ٱدَّعَى", "ٱتَّقَى": opening the word (after و or ف, a doubled letter is "كَافَّةً", "بَارٌّ"); "إِنَّ" / "أَنَّ" keep their hamza
    if (!a && next.m.includes(SHADDA) && next.c !== 'ن' && g.length >= 3) return { a, kind: 'shadda' };
    return null;
  }
  return null;
}

/** A word from its letter `i` on, as a key: its letters and marks, without the vowel of its last letter (its case ending). */
const keyFrom = (g, i) => (g.length - i < 2 ? '' : join(g.slice(i, -1)) + g[g.length - 1].c + (g[g.length - 1].m.includes(SHADDA) ? SHADDA : ''));

const plainAlif = (x) => x.c === 'ا' && (x.m === '' || x.m === FATHA);
const hamzaFatha = (x) => x.c === 'أ' && (x.m === '' || x.m === FATHA);

const parasOf = (models) => models.map((m) => (m?.blocks || []).flatMap((b) => (b.type === 'table' ? b.cells.flatMap((c) => c.paras) : b.type === 'p' ? [b] : [])).filter((p) => p.ai));
const WORD = /[^\s]+/g;
const core = (tok) => tok.match(/^([^\p{L}\p{M}]*)([\p{L}\p{M}]+)(.*)$/su);

/**
 * @param {object[]} models the page models of the book
 * @returns {{ wasla: boolean, fixed: number }} whether the book prints ٱ, and how many words were changed
 */
export function fixWasla(models) {
  const pages = parasOf(models);
  // how sure we are that the book prints ٱ: the reader's ٱ, and its articles with a hamza inside a sentence
  let seen = 0;
  let articles = 0;
  let onPages = 0;
  // the words the book has without the article (also after a joined letter, or after "لِلْ") or with a plain article
  const nouns = new Set();
  // how often the book has each word that opens with an alif with a plain alif (or ٱ) and with a hamza
  const spelt = new Map();
  const count = (key, field) => { if (!spelt.has(key)) spelt.set(key, { plain: 0, hamza: 0 }); spelt.get(key)[field]++; };
  for (const paras of pages) {
    let here = 0;
    for (const p of paras) {
      let prev = '';
      for (const r of p.runs || []) {
        if (r.verse) { prev = ''; continue; }
        for (const tok of r.text.match(WORD) || []) {
          const m = core(tok);
          if (!m) { prev = tok; continue; }
          const g = graphemes(m[2]);
          const at = alifOf(g);
          const inSentence = !m[1] && /[\p{L}\p{M}]$/u.test(prev);
          if (at) {
            const alif = g[at.a];
            if (at.kind === 'article' && inSentence) articles++;
            if (alif.c === WASLA) here++;
            else if (at.kind === 'article' && at.sun && hamzaFatha(alif) && inSentence) here++;
            if (at.kind === 'article' && (plainAlif(alif) || alif.c === WASLA)) nouns.add(keyFrom(g, at.a + 2));
            if (at.kind !== 'article') count(keyFrom(g, at.a + 1), plainAlif(alif) || alif.c === WASLA ? 'plain' : 'hamza');
          } else {
            nouns.add(keyFrom(g, 0));
            if ('وفبكل'.includes(g[0].c)) nouns.add(keyFrom(g, 1));
            if (g[0].c === 'ل' && g[1]?.c === 'ل') nouns.add(keyFrom(g, 2));
          }
          prev = tok;
        }
      }
    }
    seen += here;
    if (here) onPages++;
  }
  nouns.delete('');
  const wasla = seen >= 3 && onPages >= 2 && seen >= articles * 0.03;

  let fixed = 0;
  const fixWord = (word) => {
    const g = graphemes(word);
    const at = alifOf(g);
    if (!at) return word;
    const alif = g[at.a];
    if (at.sun && g[at.a + 1].m === SUKUN) g[at.a + 1].m = '';
    if (wasla && (plainAlif(alif) || hamzaFatha(alif))) {
      let set;
      if (at.kind === 'article') set = plainAlif(alif) || at.sure || nouns.has(keyFrom(g, at.a + 2));
      else if (plainAlif(alif)) {
        const n = spelt.get(keyFrom(g, at.a + 1));
        set = !n || n.plain >= n.hamza;
      } else set = at.kind === 'sukun' && WASLA_NOUNS.test(lettersOf(g.slice(at.a + 1)));
      if (set) g[at.a] = { c: WASLA, m: '' };
    }
    const out = join(g);
    if (out !== word) fixed++;
    return out;
  };
  for (const paras of pages) {
    for (const p of paras) {
      for (const r of p.runs || []) {
        if (r.verse) continue;
        r.text = r.text.replace(WORD, (tok) => {
          const m = core(tok);
          return m ? m[1] + fixWord(m[2]) + m[3] : tok;
        });
      }
    }
  }
  return { wasla, fixed };
}
