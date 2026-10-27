// 받아쓰기 뒤 고치기: 자소서·채용공고에 나온 영문 약어(ISMS-P, GRC 등)만 맞춘다.
// 2026-10-27 실사용: "ISMS-P"가 "imfp"·"imsp"로, "GRC"가 "grc"로 나왔다. Chrome 받아쓰기는 단어 힌트를 대부분 무시해서
// 결과 글을 고치는 수밖에 없다. 한국어 단어(예: 규제→교재)는 비슷한 다른 단어로 바꿀 위험이 커서 손대지 않는다.

/** 영문이 들어간 낱말 (하이픈·& 이어진 것 포함) */
const LATIN = /[A-Za-z][A-Za-z0-9]*(?:[-&][A-Za-z0-9]+)*/g;

const key = (w: string) => w.toLowerCase().replace(/[^a-z0-9]/g, "");

/** 자소서·공고에서 영문 용어 목록 (같은 것은 한 번만, 원래 표기 유지) */
export function termVocab(texts: string[]): string[] {
  const seen = new Map<string, string>();
  for (const t of texts) for (const w of t.match(LATIN) ?? []) if (key(w).length >= 2 && !seen.has(key(w))) seen.set(key(w), w);
  return [...seen.values()];
}

export function editDistance(a: string, b: string): number {
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return d[b.length];
}

/** 글자 수에 따른 허용 오타 수: 3글자 이하는 정확히 같아야, 4글자 1개, 5글자 이상 2개 [가설] */
const allowed = (len: number) => (len <= 3 ? 0 : len === 4 ? 1 : 2);

/** 알파벳 읽는 소리 (한글로 받아써진 약어를 찾을 때) */
const LETTER_KO: Record<string, string> = {
  a: "에이", b: "비", c: "씨", d: "디", e: "이", f: "에프", g: "지", h: "에이치", i: "아이", j: "제이", k: "케이", l: "엘", m: "엠",
  n: "엔", o: "오", p: "피", q: "큐", r: "알", s: "에스", t: "티", u: "유", v: "브이", w: "더블유", x: "엑스", y: "와이", z: "지",
};

export interface SttFix {
  from: string;
  to: string;
}

/** 받아쓴 글의 영문 낱말을 용어 목록과 맞춘다. 가장 가까운 후보가 하나일 때만 바꾼다. */
export function fixTerms(text: string, vocab: string[]): { text: string; fixes: SttFix[] } {
  const fixes: SttFix[] = [];
  const terms = vocab.map((v) => ({ v, k: key(v) })).filter((x) => x.k.length >= 2);
  let out = text.replace(LATIN, (w) => {
    const k = key(w);
    let best: string | null = null, bestD = Infinity, tie = false;
    for (const t of terms) {
      if (t.k[0] !== k[0]) continue; // 첫 글자는 대개 맞게 들린다
      const d = editDistance(k, t.k);
      if (d > allowed(Math.max(k.length, t.k.length))) continue;
      if (d < bestD) [best, bestD, tie] = [t.v, d, false];
      else if (d === bestD && t.v !== best) tie = true;
    }
    if (!best || tie || best === w) return w;
    fixes.push({ from: w, to: best });
    return best;
  });
  // 한글로 받아써진 약어: 3글자 이상 대문자 약어만 (AI = '아이'처럼 흔한 말과 겹치는 것을 피함)
  for (const t of terms) {
    if (t.k.length < 3 || !/^[A-Z0-9&-]+$/.test(t.v) || /\d/.test(t.k)) continue;
    const syll = [...t.k].map((c) => LETTER_KO[c]);
    const re = new RegExp(syll.join("\\s?"), "g");
    out = out.replace(re, (m) => {
      fixes.push({ from: m, to: t.v });
      return t.v;
    });
  }
  return { text: out, fixes };
}
