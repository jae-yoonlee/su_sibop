// 꼬리질문: 규칙이 답변의 빈 곳과 '인용할 답변 문장'을 고르고(빠름·항상 같은 결과), 브라우저 안 AI(Qwen3)는 그 문장을 짚는 질문 한 문장만 쓴다.
// 2026-10-14: 꼬리질문은 반드시 방금 답변을 인용한다 (자소서 숫자만 보고 묻던 것이 '답변을 안 본다'는 지적을 받음).
// poc/face-realtime/followup_gen.py의 규칙·문장 틀·검사를 옮김. 차이: 파이썬은 사실 확인(숫자)을 AI 없이 틀 문장으로 물었지만,
// 여기서는 자소서 관련 질문은 로컬 AI가 쓰도록(2026-10-12 결정) AI에 정해진 이유 하나만 주고, 검사에 떨어지거나 늦을 때만 틀 문장을 쓴다.
import { styleProblem, type Question } from "./questions";

export const FOLLOWUP_TARGET_SEC = 5; // 답변이 끝나고 이 안에 꼬리질문을 띄우는 것이 목표
export const FOLLOWUP_MAX_SEC = 12; // AI가 이때까지도 못 쓰면 틀 문장 (화면·결과에 표시)
const MAX_LEN = 80; // 답변 인용이 들어가므로 본질문(70자)보다 조금 길게
const QUOTE_LEN = 28; // 인용은 이 글자 수까지
const ANSWER_CHARS = 500; // AI에 넣는 답변 길이 상한 (짧을수록 빠름)

const UNITS = "(%|퍼센트|프로|개월|년|월|주|일|명|배|건|개|원|시간|분)";
const NUM_UNIT = new RegExp(`(\\d+(?:[.,]\\d+)?)\\s*${UNITS}`, "g");
const UNIT_ALIAS: Record<string, string> = { 퍼센트: "%", 프로: "%" };
const VAGUE = ["열심히", "최선을", "많이 배웠", "노력했", "노력하", "다양한", "여러 가지", "성실하", "잘 해결", "좋은 경험"];
const SELF = /(제가|저는|저도|직접|맡아|맡았|담당)/g;
const TEAM = /(우리|저희|팀이|팀원들이|다 같이|함께)/g;
const RESULT_WORDS = /\d|절반|두\s?배|세\s?배/;

export type IssueName = "mismatch" | "missing_fact" | "no_result" | "no_role" | "team_heavy" | "vague" | "generic" | "no_text";
export interface Issue { name: IssueName; slots: Record<string, string> }

export const ISSUE_LABELS: Record<IssueName, string> = {
  mismatch: "숫자가 자기소개서와 다름",
  missing_fact: "자기소개서에 적은 숫자를 말하지 않음",
  no_result: "결과를 말하지 않음",
  no_role: "본인이 한 일을 말하지 않음",
  team_heavy: "'우리'나 '팀' 위주라 본인이 한 일이 흐릿함",
  vague: "모호한 표현",
  generic: "답변 한 부분을 더 깊게",
  no_text: "답변을 받아쓰지 못함",
};

// AI에 줄 '무엇을 물을지' 지시 (이유마다 한 줄)
const INTENT: Record<IssueName, (s: Record<string, string>) => string> = {
  mismatch: (s) => `자기소개서에는 ${s.doc}, 답변에서는 ${s.said}라고 했다. 어느 쪽이 맞는지 확인하라.`,
  missing_fact: (s) => `답변의 '${s.quote}' 부분과 자기소개서에 적은 ${s.doc}가 어떻게 연결되는지 물어라.`,
  no_result: (s) => `답변의 '${s.quote}' 부분에 결과가 없다. 그래서 어떻게 되었는지 묻는다.`,
  no_role: (s) => `답변의 '${s.quote}' 부분에서 본인이 직접 한 일이 안 보인다. 본인 역할을 묻는다.`,
  team_heavy: (s) => `답변의 '${s.quote}'처럼 '우리·팀' 이야기뿐이라 본인 기여가 불분명하다. 본인 기여 비중을 묻는다.`,
  vague: (s) => `답변의 '${s.quote}'라는 모호한 표현에서 실제로 무엇을 했는지 묻는다.`,
  generic: (s) => `답변의 '${s.quote}' 부분을 더 깊게 묻는다 (어려웠던 점, 판단 이유, 구체적 행동 중 하나).`,
  no_text: () => "답변을 받아쓰지 못했다. 방금 답변의 핵심을 다시 묻는다.",
};

const TEMPLATES: Record<IssueName, string[]> = {
  mismatch: [
    "자기소개서에는 {doc_라고} 쓰셨는데 방금 {said_라고} 하셨습니다. 어느 쪽이 맞나요?",
    "방금 {said_라고} 하셨는데 자기소개서에는 {doc_로} 되어 있습니다. 설명해 주시겠어요?",
  ],
  missing_fact: [
    "'{quote}'라고 하셨는데, 자기소개서에 적은 {doc_와}는 어떻게 이어지나요?",
    "'{quote}' 부분에서, 자기소개서의 {doc_는} 어떻게 나온 숫자인가요?",
  ],
  no_result: ["'{quote}'라고 하셨는데, 그래서 결과는 어땠나요?", "'{quote}' 이후에 무엇이 달라졌나요?"],
  no_role: ["'{quote}'라고 하셨는데, 그중 본인이 직접 한 일은 무엇이었나요?", "'{quote}' 부분에서 본인이 맡은 역할을 말씀해 주시겠어요?"],
  team_heavy: ["'{quote}'라고 하셨는데, 그중 본인 기여는 어느 정도였나요?", "'{quote}' 부분에서 팀원들과 달리 본인만 맡은 일은 무엇인가요?"],
  vague: ["'{quote}'라고 하셨는데, 구체적으로 어떤 행동을 하셨나요?", "'{quote}'라고 하셨는데, 그때 실제로 어떤 일을 하셨나요?"],
  generic: ["'{quote}'라고 하셨는데, 그때 가장 어려웠던 점은 무엇이었나요?", "'{quote}' 부분을 조금 더 구체적으로 말씀해 주시겠어요?"],
  no_text: ["방금 답변이 잘 들리지 않았어요. 다시 한번 말씀해 주시겠어요?"],
};

const norm = (s: string) => (s ?? "").replace(/\s+/g, " ").trim();

// 실제 면접관은 '무엇을 했고 어떻게 되었는지'를 묻지, '숫자로 말하라'처럼 답하는 방법을 시키지 않는다.
// 근거: 행동면접 가이드(켄터키대 HR BBI quick guide, CodeSignal 'Probing with STAR')의 후속질문 예시는
// "결과는 어땠나요?", "본인 역할은 무엇이었나요?"처럼 내용을 묻고, 답을 유도하는 질문은 피하라고 함 (2026-10-19)
export const COACHING = /(숫자|수치|퍼센트|한 문장|두 문장|세 문장|짧게|간단히|STAR)[^?.!]{0,8}?(말씀해|답해|설명해|바꿔|표현해|정리해)/;

/** '12%', '6개월' 같은 숫자+단위 → 단위별 숫자 집합 */
export function facts(text: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const m of (text ?? "").matchAll(NUM_UNIT)) {
    const unit = UNIT_ALIAS[m[2]] ?? m[2];
    // 날짜(2023년, 3월)는 성과 숫자가 아니라서 묻지 않는다
    if (unit === "월" || (unit === "년" && Number(m[1]) >= 1900)) continue;
    if (!out.has(unit)) out.set(unit, new Set());
    out.get(unit)!.add(m[1].replace(",", ""));
  }
  return out;
}

const splitSentences = (t: string) => norm(t).split(/(?<=[.?!다요죠])\s+/).filter(Boolean);

/** 답변 문장을 인용 길이로 자른다 (어절 단위) */
export function shortQuote(sentence: string) {
  const t = norm(sentence).replace(/[.?!]+$/, "");
  if (t.length <= QUOTE_LEN) return t;
  let out = "";
  for (const w of t.split(" ")) {
    if ((out + " " + w).trim().length > QUOTE_LEN) break;
    out = (out + " " + w).trim();
  }
  return (out || t.slice(0, QUOTE_LEN)) + "…";
}

const RESULT_VERB = /(줄였|늘렸|높였|낮췄|개선|달성|성공|완성|만들었|해결)/;
const longest = (ss: string[]) => ss.reduce((a, b) => (b.length > a.length ? b : a), "");

/** 답변의 빈 곳을 우선순위 순서로 모두 찾는다. 모든 빈 곳에 '인용할 답변 문장'(quote)을 붙인다. */
export function findIssues(main: Pick<Question, "type" | "evidence">, answer: string): Issue[] {
  const a = norm(answer);
  if (!a) return [{ name: "no_text", slots: {} }];
  const sents = splitSentences(a);
  const q = (pred: (s: string) => boolean) => shortQuote(sents.find(pred) ?? longest(sents));
  const doc = facts(main.evidence), said = facts(a);
  const issues: Issue[] = [];
  const first = (s: Set<string>) => [...s].sort()[0];
  for (const [unit, nums] of doc) {
    const got = said.get(unit);
    if (got && ![...nums].some((n) => got.has(n))) issues.push({ name: "mismatch", slots: { doc: first(nums) + unit, said: first(got) + unit } });
  }
  if (main.type === "경험" && !RESULT_WORDS.test(a)) issues.push({ name: "no_result", slots: { quote: q((s) => RESULT_VERB.test(s)) } });
  const nSelf = (a.match(SELF) ?? []).length, nTeam = (a.match(TEAM) ?? []).length;
  if (nSelf === 0) issues.push({ name: "no_role", slots: { quote: q(() => false) } });
  else if (nTeam >= 2 && nTeam >= 2 * nSelf) issues.push({ name: "team_heavy", slots: { quote: q((s) => /(우리|저희|팀이|팀원들이|다 같이|함께)/.test(s)) } });
  for (const s of sents) {
    const w = VAGUE.find((v) => s.includes(v));
    if (w) {
      issues.push({ name: "vague", slots: { quote: s.length <= QUOTE_LEN ? s.replace(/[.?!]+$/, "") : w } });
      break;
    }
  }
  // 자소서 숫자를 답변에서 안 말한 것은 '답변 내용'이 아니라서 맨 뒤 (다른 빈 곳이 없을 때만)
  for (const [unit, nums] of doc) if (!said.has(unit)) issues.push({ name: "missing_fact", slots: { doc: first(nums) + unit, quote: q(() => false) } });
  return issues;
}

/** 빈 곳이 없을 때: 답변에서 가장 긴 문장을 짚어 더 깊게 묻는다 */
export function genericIssue(answer: string): Issue {
  const sents = splitSentences(norm(answer));
  return sents.length ? { name: "generic", slots: { quote: shortQuote(longest(sents)) } } : { name: "no_text", slots: {} };
}

const keyOf = (i: Issue) => i.name + JSON.stringify(i.slots);

/** 우선순위: 숫자 불일치(답변이 자소서와 다름) → 답변 내용의 빈 곳(무작위) → 자소서 숫자 누락 → 일반. 전에 물은 것은 피한다. */
export function chooseIssue(issues: Issue[], rand: () => number, askedKeys: Set<string> = new Set(), answer = ""): Issue {
  if (!issues.length) return genericIssue(answer);
  const tiers = [["mismatch", "no_text"], ["no_result", "no_role", "team_heavy", "vague"], ["missing_fact"]];
  const pool = tiers.map((t) => issues.filter((i) => t.includes(i.name))).find((p) => p.length)!;
  const fresh = pool.filter((i) => !askedKeys.has(keyOf(i)));
  const from = fresh.length ? fresh : pool;
  return from[Math.floor(rand() * from.length)];
}

// 숫자·글자 뒤 조사 (받침에 맞춤)
const DIGIT_FINAL: Record<string, string> = { "0": "ㅇ", "1": "ㄹ", "2": "", "3": "ㅁ", "4": "", "5": "", "6": "ㄱ", "7": "ㄹ", "8": "ㄹ", "9": "" };
function finalOf(word: string) {
  const c = (word || " ").slice(-1);
  if (c === "%") return "";
  if (c in DIGIT_FINAL) return DIGIT_FINAL[c];
  const code = c.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) {
    const f = (code - 0xac00) % 28;
    return f === 0 ? "" : f === 8 ? "ㄹ" : "있음";
  }
  return "";
}
const JOSA: Record<string, [string, string]> = { 라고: ["이라고", "라고"], 로: ["으로", "로"], 와: ["과", "와"], 는: ["은", "는"] };
function withJosa(slots: Record<string, string>) {
  const out: Record<string, string> = { ...slots };
  for (const [k, v] of Object.entries(slots))
    for (const [kind, [withF, without]] of Object.entries(JOSA)) {
      const f = finalOf(v);
      out[`${k}_${kind}`] = v + (kind === "로" && f === "ㄹ" ? without : f ? withF : without);
    }
  return out;
}

export function templateQuestion(issue: Issue, rand: () => number, asked: Set<string> = new Set()) {
  const full = withJosa(issue.slots);
  const texts = TEMPLATES[issue.name].map((t) => t.replace(/\{([^}]+)\}/g, (_, k) => full[k] ?? ""));
  const fresh = texts.filter((t) => !asked.has(t));
  const from = fresh.length ? fresh : texts;
  return from[Math.floor(rand() * from.length)];
}

/** AI에 줄 짧은 프롬프트: 이유는 규칙이 이미 골랐고, AI는 문장만 쓴다 (짧을수록 빠름) */
export function followupPrompt(main: Question, answer: string, issue: Issue, previous: string[]) {
  return `너는 한국 기업의 면접관이다. 아래 지시대로 꼬리질문 1개를 써라.

방금 한 질문: ${main.question}
자기소개서 근거: ${main.evidence || "(없음)"}
지원자 답변: """${norm(answer).slice(0, ANSWER_CHARS)}"""

지시: ${INTENT[issue.name](issue.slots)}
${previous.length ? `이미 한 질문과 비슷하게 묻지 마라: ${previous.slice(-3).join(" / ")}\n` : ""}
규칙: 지원자가 방금 한 말을 짧게 인용하거나 짚어서 묻는다. 존댓말 한 문장, 70자 이내. 답변과 자기소개서에 없는 숫자·사실을 지어내지 않는다.\n'숫자로', '한 문장으로', '구체적인 수치로'처럼 답하는 방법을 시키지 말고, 실제 면접관처럼 무엇을 했고 어떻게 되었는지를 묻는다.
출력: {"question": "..."}`;
}

export const FOLLOWUP_SCHEMA = JSON.stringify({
  type: "object",
  properties: { question: { type: "string" } },
  required: ["question"],
});

/** AI 답 검사. 통과하면 질문, 아니면 오류 */
const STOP = new Set(["그리", "그래", "그때", "그것", "제가", "저는", "저희", "우리", "있었", "했습", "했고", "하는", "하고", "있습", "합니", "그런", "이런", "정말"]);
export function sharesWord(q: string, quote: string) {
  const words = quote.replace(/…/g, "").split(/[\s,.!?'"()]+/).filter((w) => w.length >= 2).map((w) => w.slice(0, 2)).filter((w) => !STOP.has(w));
  return words.some((w) => q.includes(w));
}

export function checkAiFollowup(raw: string, issue: Issue, main: Question, answer: string): string {
  let q = "";
  try {
    const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    q = norm(JSON.parse(cleaned.slice(cleaned.indexOf("{"), cleaned.lastIndexOf("}") + 1))?.question);
  } catch {
    throw new Error("형식이 다름");
  }
  if (!q || q.length > MAX_LEN) throw new Error("빈 질문이거나 너무 김");
  const style = styleProblem(q, `${main.question} ${main.evidence ?? ""} ${answer} ${issue.slots.quote ?? ""} ${issue.slots.doc ?? ""}`);
  if (style) throw new Error(style);
  const allowed = new Set(`${main.evidence ?? ""} ${answer}`.match(/\d+/g) ?? []);
  const made = (q.match(/\d+/g) ?? []).filter((n) => !allowed.has(n));
  if (made.length) throw new Error(`없던 숫자를 만듦: ${made.join(",")}`);
  // 숫자 사실 확인은 그 숫자를 실제로 물어야 함 (AI가 주제를 바꾸지 못하게)
  if (issue.name === "mismatch" || issue.name === "missing_fact") {
    const num = issue.slots.doc.match(/\d+/)?.[0];
    if (num && !q.includes(num)) throw new Error("확인해야 할 숫자를 빠뜨림");
  }
  // 답변을 짚었는지: 인용 문장의 낱말(앞 2글자)이 질문에 하나라도 있어야 함
  if (issue.slots.quote && issue.name !== "missing_fact" && !sharesWord(q, issue.slots.quote)) throw new Error("답변 내용을 짚지 않음");
  return q;
}

export interface Followup {
  question: string;
  reason: IssueName;
  issues: IssueName[]; // 규칙이 찾은 것 전부
  source: "ai" | "rule";
  error: string;
  ms: number;
}

export interface FollowupDeps {
  ask: ((prompt: string) => Promise<string>) | null; // 로컬 AI 호출 (없으면 틀 문장)
  history?: string[]; // 같은 자소서로 전에 한 꼬리질문
  rand?: () => number;
  maxMs?: number;
}

export async function makeFollowup(main: Question, answer: string, deps: FollowupDeps): Promise<Followup> {
  const t0 = performance.now();
  const rand = deps.rand ?? Math.random;
  const history = deps.history ?? [];
  const issues = findIssues(main, answer);
  const issue = chooseIssue(issues, rand, new Set(), answer);
  const fallback = templateQuestion(issue, rand, new Set(history));
  const out: Followup = { question: fallback, reason: issue.name, issues: issues.map((i) => i.name), source: "rule", error: "", ms: 0 };
  if (!deps.ask) out.error = "이 PC에서 AI를 쓸 수 없어 정해진 문장을 썼어요";
  else if (!norm(answer)) out.error = "받아쓴 답변이 없어 정해진 문장을 썼어요";
  else {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const raw = await Promise.race([
        deps.ask(followupPrompt(main, answer, issue, history)),
        new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Error(`${(deps.maxMs ?? FOLLOWUP_MAX_SEC * 1000) / 1000}초 초과`)), deps.maxMs ?? FOLLOWUP_MAX_SEC * 1000))),
      ]);
      const q = checkAiFollowup(raw, issue, main, answer);
      if (history.includes(q)) throw new Error("전에 한 질문과 같음");
      out.question = q;
      out.source = "ai";
    } catch (e) {
      out.error = (e as Error).message;
    } finally {
      clearTimeout(timer);
    }
  }
  out.ms = performance.now() - t0;
  return out;
}

// ── 같은 자소서로 전에 한 꼬리질문 (이 브라우저에만, 자소서 원문 대신 짧은 지문으로 구분) ──
const HISTORY_KEY = "sibop.followups";
export function resumeId(resume: string) {
  let h = 2166136261;
  for (const ch of norm(resume)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return (h >>> 0).toString(36);
}
export function loadHistory(resume: string): string[] {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "{}")[resumeId(resume)] ?? [];
  } catch {
    return [];
  }
}
export function saveHistory(resume: string, q: string) {
  try {
    const all = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "{}");
    all[resumeId(resume)] = [...(all[resumeId(resume)] ?? []), q].slice(-30);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(all));
  } catch {
    /* 저장 안 돼도 이번 연습엔 지장 없음 */
  }
}
