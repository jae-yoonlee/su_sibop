// 종합 피드백: 규칙이 사실을 골라 짧은 목록으로 만들고, 이 PC 안 AI(Qwen3)는 그 사실만으로 문장을 쓴다 (2026-10-12 결정).
// AI가 목록에 없는 숫자를 쓰거나 길이가 맞지 않으면 버리고 규칙 문장으로 대신한다.

export interface FeedbackInput {
  alerts: { label: string; count: number; grade: "ok" | "warn" | "bad" }[]; // 경고 종류별 4문항 합계
  facts: { kind: string; text: string; verdict: string; said: string }[]; // 사실 대조
  comps: { name: string; verdict: string }[]; // 필요역량: 자소서/답변
  issues: string[]; // 꼬리질문이 짚은 빈 곳 (예: 결과를 말하지 않음)
}

/** AI에게 줄 사실 목록. 순서 = 중요한 것부터 */
export function feedbackFacts(f: FeedbackInput): { good: string[]; fix: string[] } {
  const good: string[] = [];
  const fix: string[] = [];
  const bad = f.alerts.filter((a) => a.grade === "bad"), warn = f.alerts.filter((a) => a.grade === "warn");
  for (const a of bad) fix.push(`${a.label} ${a.count}회로 많았음`);
  for (const a of warn) fix.push(`${a.label} ${a.count}회 있었음`);
  if (!bad.length && !warn.length) good.push("자세와 목소리 경고가 거의 없었음");
  const mism = f.facts.filter((x) => x.verdict === "불일치");
  for (const m of mism.slice(0, 2)) fix.push(`자소서에는 ${m.kind} '${m.text}'라고 썼는데 답변에서는 '${m.said}'라고 말함`);
  const same = f.facts.filter((x) => x.verdict === "일치").length;
  if (same) good.push(`자소서 내용 ${same}개를 답변에서 같게 말함`);
  const onlyResume = f.comps.filter((c) => c.verdict === "자소서만").map((c) => c.name);
  if (onlyResume.length) fix.push(`자소서에 있는 ${onlyResume.join(", ")} 역량이 답변에서는 드러나지 않음`);
  const both = f.comps.filter((c) => c.verdict === "둘 다").map((c) => c.name);
  if (both.length) good.push(`${both.join(", ")} 역량을 답변에서도 보여 줌`);
  for (const i of [...new Set(f.issues)].slice(0, 2)) fix.push(`꼬리질문에서 짚은 점: ${i}`);
  return { good, fix: fix.slice(0, 4) };
}

export const FEEDBACK_SCHEMA = JSON.stringify({ type: "object", properties: { feedback: { type: "string" } }, required: ["feedback"] });

export function feedbackPrompt(p: { good: string[]; fix: string[] }) {
  return [
    "면접 연습을 마친 지원자에게 줄 종합 피드백을 쓰세요.",
    "아래 사실만 쓰고, 없는 사실이나 숫자를 지어내지 마세요.",
    `잘한 점: ${p.good.join(" / ") || "없음"}`,
    `고칠 점: ${p.fix.join(" / ") || "없음"}`,
    "3~4문장, 존댓말. 잘한 점 1문장, 고칠 점 1~2문장, 다음 연습에서 해 볼 것 1문장.",
    '목록이나 기호 없이 문장으로만. JSON으로 답하세요: {"feedback": "..."}',
  ].join("\n");
}

const NUM = /\d+(?:\.\d+)?/g;

/** AI 답 검사: 사실 목록에 없는 숫자, 너무 짧거나 긴 글, 목록 기호는 탈락 */
export function feedbackProblem(text: string, p: { good: string[]; fix: string[] }): string | null {
  if (text.length < 40) return "너무 짧음";
  if (text.length > 400) return "너무 김";
  if (/^\s*[-*•\d]+[.)]?\s/m.test(text)) return "목록 꼴";
  const allowed = new Set([...p.good, ...p.fix].join(" ").match(NUM) ?? []);
  const extra = (text.match(NUM) ?? []).filter((n) => !allowed.has(n));
  if (extra.length) return `없는 숫자 ${extra.join(", ")}`;
  return null;
}

export function parseFeedback(raw: string): string {
  try {
    const t = raw.replace(/<think>[\s\S]*?<\/think>/g, "");
    return String(JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1)).feedback ?? "").trim();
  } catch {
    return "";
  }
}

/** AI를 못 쓰거나 검사에 떨어졌을 때 규칙 문장 */
export function ruleFeedback(p: { good: string[]; fix: string[] }) {
  const g = p.good[0] ? `잘한 점: ${p.good[0]}.` : "";
  const f = p.fix.slice(0, 2).map((x) => `${x}.`).join(" ");
  const next = p.fix.length ? "다음 연습에서는 위 고칠 점 하나만 정해 신경 써 보세요." : "다음 연습에서는 답변마다 결과를 한 가지씩 더 말해 보세요.";
  return [g, f && `고칠 점: ${f}`, next].filter(Boolean).join(" ");
}

export interface Feedback {
  text: string;
  by: "ai" | "rule";
  note: string; // 규칙 문장을 쓴 이유
  facts: { good: string[]; fix: string[] };
  raw: string;
  ms: number;
}

export async function makeFeedback(input: FeedbackInput, ask: ((prompt: string) => Promise<string>) | null): Promise<Feedback> {
  const facts = feedbackFacts(input);
  const t0 = performance.now();
  if (!ask) return { text: ruleFeedback(facts), by: "rule", note: "이 PC에서 AI를 쓸 수 없음", facts, raw: "", ms: 0 };
  let raw = "";
  try {
    raw = await ask(feedbackPrompt(facts));
  } catch (e) {
    return { text: ruleFeedback(facts), by: "rule", note: `AI 오류: ${(e as Error).message}`, facts, raw, ms: performance.now() - t0 };
  }
  const text = parseFeedback(raw);
  const bad = text ? feedbackProblem(text, facts) : "답을 읽지 못함";
  const ms = performance.now() - t0;
  return bad ? { text: ruleFeedback(facts), by: "rule", note: `AI 글이 검사에 떨어짐 (${bad})`, facts, raw, ms } : { text, by: "ai", note: "", facts, raw, ms };
}
