// 사실 대조: 자소서에 쓴 기간·숫자·역할·프로젝트명을, 면접 답변(받아쓰기)이 같은 뜻으로 말했는지 본다.
// 1) 규칙으로 자소서에서 사실을 뽑고  2) 답변의 말투를 숫자로 맞추고(세 달 → 3개월)
// 3) 뜻 비교로 같은 경험을 말한 답변 문장을 찾아  4) 일치·불일치·말 안 함·확인 필요로 판정한다.
// 불일치는 이 PC 안 AI에게 "정말 같은 경험 이야기인가"를 한 번 더 묻는다 (자소서는 밖으로 안 나감).
import { SAME_TOPIC, similarity } from "./embed";

export type FactKind = "기간" | "숫자" | "역할" | "프로젝트";
export interface Fact {
  id: string;
  kind: FactKind;
  text: string; // 화면에 보일 값 (예: 6개월, 팀장, 캡스톤 프로젝트)
  value: string; // 비교용 값 (예: 6|개월, lead, 캡스톤프로젝트)
  sentence: string; // 자소서 원문 문장
}
export type Verdict = "일치" | "불일치" | "말 안 함" | "확인 필요";
export interface FactResult extends Fact {
  verdict: Verdict;
  said: string; // 답변에서 말한 값 (불일치일 때)
  answerSentence: string; // 근거가 된 답변 문장
  q: number; // 몇 번째 답변인지 (-1 = 없음)
  note: string; // 판정 이유
}

const norm = (s: string) => (s ?? "").replace(/\s+/g, " ").trim();
export const splitSentences = (t: string) => norm(t).split(/(?<=[.?!])\s+|(?<=[다요죠])\s+(?=[가-힣A-Za-z0-9])|\n+/).map((s) => s.trim()).filter((s) => s.length > 1);

// ── 말투 맞추기: 받아쓰기는 숫자를 한글로 쓸 때가 많다 ──
const SINO: Record<string, number> = { 일: 1, 이: 2, 삼: 3, 사: 4, 오: 5, 육: 6, 칠: 7, 팔: 8, 구: 9 };
const SINO_UNIT: Record<string, number> = { 십: 10, 백: 100, 천: 1000 };
function sinoToNumber(s: string): number | null {
  let total = 0, cur = 0;
  for (const ch of s) {
    if (ch in SINO) cur = SINO[ch];
    else if (ch in SINO_UNIT) {
      total += (cur || 1) * SINO_UNIT[ch];
      cur = 0;
    } else if (ch === "만") {
      total = (total + cur || 1) * 10000;
      cur = 0;
    } else return null;
  }
  return total + cur;
}
const NATIVE_TENS: Record<string, number> = { 열: 10, 스물: 20, 스무: 20, 서른: 30, 마흔: 40, 쉰: 50 };
const NATIVE_ONES: Record<string, number> = { 한: 1, 하나: 1, 두: 2, 둘: 2, 세: 3, 셋: 3, 석: 3, 네: 4, 넷: 4, 다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9 };
const UNIT_RE = "(개월|퍼센트|프로|%|명|배|건|개|원|시간|분|주|일|년|달|번|살|등|위|점)";
const AFFIX_SAFE = new Set(["개월", "퍼센트", "프로", "%", "시간"]);
// 단위 뒤는 끝이거나 조사여야 한다 ("한 개발", "네 명확히"는 숫자가 아님)
const AFTER = "(?=$|[^가-힣]|이|가|을|를|은|는|의|에|도|만|과|와|로|으로|동안|간|째|씩|정도|쯤|이상|이하|부터|까지|짜리|여)";
const SINO_RE = new RegExp(`(^|[^가-힣])([일이삼사오육칠팔구십백천만]{1,6})\\s?${UNIT_RE}${AFTER}`, "g");
// 앞 글자 뒤 띄어쓰기도 같이 잡아 둬야 "습니다. 여섯 달"이 "습니다.6개월"로 붙지 않는다
const NATIVE_RE = new RegExp(`(^|[^가-힣]\\s?)(열|스물|스무|서른|마흔|쉰)?\\s?(한|하나|두|둘|세|셋|석|네|넷|다섯|여섯|일곱|여덟|아홉)?\\s?(달|명|개|번|살|시간|주|배|건)${AFTER}`, "g");

/** "세 달" → "3개월", "삼십 퍼센트" → "30%", "6달" → "6개월" */
export function normalizeSpoken(text: string): string {
  let t = ` ${text} `;
  t = t.replace(NATIVE_RE, (m, pre: string, tens?: string, ones?: string, unit?: string) => {
    if (!tens && !ones) return m;
    const n = (tens ? NATIVE_TENS[tens] : 0) + (ones ? NATIVE_ONES[ones] : 0);
    return `${pre}${n}${unit}`;
  });
  t = t.replace(SINO_RE, (m, pre: string, num: string, unit: string) => {
    const n = sinoToNumber(num);
    // 한 글자 숫자가 짧은 단위에 붙어 있으면 보통 낱말이다 (이번, 일일, 사주, 구분). 띄어 썼거나 긴 단위만 숫자로 본다
    if (n === null || (num.length === 1 && !/\s/.test(m.slice(pre.length)) && !AFFIX_SAFE.has(unit))) return m;
    return `${pre}${n}${unit}`;
  });
  t = t
    .replace(/(\d+)\s?달/g, "$1개월")
    .replace(/(\d+)\s?해/g, "$1년")
    .replace(/반년/g, "6개월")
    .replace(/(\d+)\s?(퍼센트|프로)/g, "$1%")
    .replace(/(\d+)\s+(개월|명|배|건|개|원|시간|분|주|일|년|%)/g, "$1$2");
  return norm(t);
}

// ── 자소서에서 사실 뽑기 ──
const PERIOD_RE = /(\d+(?:\.\d+)?)\s?(개월|주|일|년|달)(?:\s?(?:동안|간))?/g;
// "6개월"의 "6개"는 숫자가 아니라 기간이라서 "개" 뒤에 "월"이 오면 뺀다 (2026-10-19)
const NUMBER_RE = /(\d+(?:[.,]\d+)?)\s?(%|퍼센트|프로|명|배|건|개(?!월)|원|만 원|시간|점|위|등|회)/g;
const LEAD = ["팀장", "리더", "조장", "회장", "대표", "파트장", "PM", "PL", "총괄"];
const SUB_LEAD = ["부팀장", "부조장", "부회장", "부리더"];
const MEMBER = ["팀원", "조원", "구성원", "참여자", "멤버"];
const ROLE_GROUPS: Record<string, string[]> = { lead: LEAD, sub: SUB_LEAD, member: MEMBER };
const ROLE_LABEL: Record<string, string> = { lead: "팀장(리더)", sub: "부팀장", member: "팀원" };
const SELF_ROLE = new RegExp(`(${[...SUB_LEAD, ...LEAD, ...MEMBER].join("|")})(?:을|를|으로|로|으로서|로서|의)?\\s?(?:맡|역할|활동|담당|참여|이었|였)`, "g");
const DUTY_RE = /([가-힣A-Za-z]+(?:\s[가-힣A-Za-z]+)?)(?:을|를)\s?(?:담당|전담|책임)/g;
const PROJECT_RE = /([가-힣A-Za-z0-9]+)\s?(프로젝트|공모전|경진대회|해커톤|대회|인턴십|인턴|동아리|연구)/g;
const PROJECT_SKIP = /(에서|에게|으로|이나|에는|의|을|를|은|는|이|가|와|과|도|동안|하며|하고|했던|하는)$/;
const QUOTED_RE = /['"“‘「『]([^'"”’」』]{2,30})['"”’」』]/g;

const roleGroup = (word: string) => Object.entries(ROLE_GROUPS).find(([, ws]) => ws.includes(word))?.[0];

export function extractFacts(resume: string): Fact[] {
  const out: Fact[] = [];
  const seen = new Set<string>();
  const add = (f: Omit<Fact, "id">) => {
    const key = `${f.kind}|${f.value}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ ...f, id: `f${out.length}` });
  };
  for (const s of splitSentences(resume)) {
    for (const m of s.matchAll(PERIOD_RE)) {
      const unit = m[2] === "달" ? "개월" : m[2];
      if (unit === "년" && Number(m[1]) >= 1900) continue; // 연도는 기간이 아님
      add({ kind: "기간", text: `${m[1]}${unit}`, value: `${m[1]}|${unit}`, sentence: s });
    }
    for (const m of s.matchAll(NUMBER_RE)) {
      const unit = m[2] === "퍼센트" || m[2] === "프로" ? "%" : m[2];
      const n = m[1].replace(",", "");
      add({ kind: "숫자", text: `${n}${unit}`, value: `${n}|${unit}`, sentence: s });
    }
    for (const m of s.matchAll(SELF_ROLE)) {
      const g = roleGroup(m[1]);
      if (g) add({ kind: "역할", text: m[1], value: g, sentence: s });
    }
    for (const m of s.matchAll(DUTY_RE)) add({ kind: "역할", text: `${m[1]} 담당`, value: `duty|${m[1]}`, sentence: s });
    for (const m of s.matchAll(QUOTED_RE)) add({ kind: "프로젝트", text: m[1], value: m[1].replace(/\s/g, ""), sentence: s });
    for (const m of s.matchAll(PROJECT_RE)) {
      if (PROJECT_SKIP.test(m[1]) || /^\d/.test(m[1])) continue;
      const name = `${m[1]} ${m[2]}`;
      add({ kind: "프로젝트", text: name, value: name.replace(/\s/g, ""), sentence: s });
    }
  }
  return out;
}

// ── 판정 ──
const STOP = new Set(["저는", "제가", "그때", "당시", "통해", "위해", "있었", "했습", "하였", "합니", "대한", "에서", "으로"]);
const keywords = (s: string) => new Set(s.split(/[\s,.!?]+/).filter((w) => w.length >= 2).map((w) => w.slice(0, 2)).filter((w) => !STOP.has(w) && !/^\d/.test(w)));
const sharedKeywords = (a: string, b: string) => [...keywords(a)].filter((w) => keywords(b).has(w)).length;

/** 프로젝트명 비교: 공백 빼고 포함 → 일치, 글자 절반 이상 겹침 → 확인 필요 (받아쓰기가 고유명사를 틀리기 쉬움) */
function nameMatch(name: string, text: string): "일치" | "확인 필요" | null {
  const n = name.replace(/\s/g, ""), t = text.replace(/\s/g, "");
  if (t.includes(n)) return "일치";
  const core = n.replace(/(프로젝트|공모전|경진대회|해커톤|대회|인턴십|인턴|동아리|연구)$/, "");
  if (core.length >= 2 && t.includes(core)) return "일치";
  let best = 0;
  for (let i = 0; i + core.length <= t.length; i++) {
    let same = 0;
    for (let j = 0; j < core.length; j++) if (t[i + j] === core[j]) same++;
    best = Math.max(best, same / Math.max(core.length, 1));
  }
  return core.length >= 3 && best >= 0.6 ? "확인 필요" : null;
}

export interface CheckDeps {
  /** 이 PC 안 AI에게 불일치를 다시 묻는다. 없으면 규칙 판정만 */
  ask?: ((prompt: string) => Promise<string>) | null;
}

export const RECHECK_SCHEMA = JSON.stringify({ type: "object", properties: { same: { type: "boolean" }, why: { type: "string" } }, required: ["same", "why"] });

export function recheckPrompt(f: FactResult) {
  return `자기소개서 문장과 면접 답변 문장이 같은 경험에 대한 이야기인지 판단하라.

자기소개서: "${f.sentence}"
답변: "${f.answerSentence}"

자기소개서에는 ${f.text}, 답변에는 ${f.said}라고 되어 있다.
두 문장이 같은 경험·같은 대상을 말하면서 숫자나 역할이 서로 다르면 same=true, 다른 경험이거나 다른 대상(예: 기간 vs 인원)이면 same=false.
출력: {"same": true 또는 false, "why": "한 문장 이유"}`;
}

/** 답변 전체(질문별 받아쓰기)와 자소서 사실을 대조한다 */
export async function checkFacts(facts: Fact[], answers: string[], deps: CheckDeps = {}): Promise<{ rows: FactResult[]; mode: "model" | "fallback" }> {
  const sents: { q: number; text: string }[] = [];
  answers.forEach((a, q) => splitSentences(normalizeSpoken(a ?? "")).forEach((text) => sents.push({ q, text })));
  const factSents = [...new Set(facts.map((f) => f.sentence))];
  const { sim, mode } = await similarity(factSents, sents.map((s) => s.text));
  const tau = SAME_TOPIC[mode];
  const allText = sents.map((s) => s.text).join(" ");

  const rows: FactResult[] = facts.map((f) => {
    const row: FactResult = { ...f, verdict: "말 안 함", said: "", answerSentence: "", q: -1, note: "" };
    const simRow = sim[factSents.indexOf(f.sentence)] ?? [];
    // 같은 경험을 말한 답변 문장: 뜻이 비슷하거나 핵심 낱말이 2개 이상 겹침
    const related = sents
      .map((s, i) => ({ ...s, score: simRow[i] ?? 0, shared: sharedKeywords(f.sentence, s.text) }))
      .filter((s) => s.score >= tau || s.shared >= 2)
      .sort((a, b) => b.score - a.score);
    const hit = (s: { q: number; text: string }, verdict: Verdict, note: string, said = "") =>
      Object.assign(row, { verdict, note, said, answerSentence: s.text, q: s.q });

    if (f.kind === "기간" || f.kind === "숫자") {
      const [n, unit] = f.value.split("|");
      const re = new RegExp(`(\\d+(?:\\.\\d+)?)\\s?${unit === "%" ? "%" : unit}`, "g");
      const exact = sents.find((s) => [...s.text.matchAll(re)].some((m) => m[1] === n));
      if (exact) return hit(exact, "일치", "같은 숫자를 말함");
      for (const s of related) {
        const other = [...s.text.matchAll(re)].map((m) => m[1]).find((x) => x !== n);
        if (other) return hit(s, "불일치", "같은 경험 문장에서 다른 숫자", `${other}${unit}`);
      }
      return Object.assign(row, { note: related.length ? "같은 경험은 말했지만 이 숫자는 안 말함" : "관련 답변 없음" });
    }
    if (f.kind === "역할") {
      if (f.value.startsWith("duty|")) {
        const duty = f.value.slice(5);
        const s = sents.find((x) => sharedKeywords(duty, x.text) >= Math.min(2, keywords(duty).size));
        return s ? hit(s, "일치", "같은 일을 맡았다고 말함") : Object.assign(row, { note: "맡은 일을 말하지 않음" });
      }
      for (const s of [...related, ...sents]) {
        const words = Object.entries(ROLE_GROUPS).flatMap(([g, ws]) => ws.filter((w) => s.text.includes(w)).map((w) => ({ g, w })));
        const same = words.find((x) => x.g === f.value);
        if (same) return hit(s, "일치", `답변에 '${same.w}' 있음`);
      }
      for (const s of related) {
        const other = Object.entries(ROLE_GROUPS).find(([g, ws]) => g !== f.value && ws.some((w) => new RegExp(`${w}(으로|로|이었|였|을 맡|를 맡)`).test(s.text)));
        if (other) return hit(s, "불일치", "같은 경험에서 다른 역할", ROLE_LABEL[other[0]]);
      }
      return Object.assign(row, { note: "역할을 말하지 않음" });
    }
    // 프로젝트
    const m = nameMatch(f.text, allText);
    if (m) {
      const s = sents.find((x) => nameMatch(f.text, x.text) === m) ?? sents[0];
      return hit(s, m, m === "일치" ? "이름을 말함" : "비슷한 이름 (받아쓰기 오류일 수 있음)");
    }
    return Object.assign(row, { note: "이름을 말하지 않음" });
  });

  // 불일치만 이 PC 안 AI가 '정말 같은 경험인가' 다시 본다
  if (deps.ask)
    for (const r of rows.filter((x) => x.verdict === "불일치")) {
      try {
        const raw = (await deps.ask(recheckPrompt(r))).replace(/<think>[\s\S]*?<\/think>/g, "");
        const j = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
        if (j.same === false) Object.assign(r, { verdict: "확인 필요", note: `AI: 다른 경험 이야기일 수 있음 (${norm(String(j.why ?? "")).slice(0, 60)})` });
        else r.note += " · AI도 같은 경험으로 판단";
      } catch {
        /* AI가 안 되면 규칙 판정 유지 */
      }
    }
  return { rows, mode };
}
