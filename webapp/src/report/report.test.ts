import { describe, expect, it } from "vitest";
import { answerCompetency, answerText, verdictOf } from "./answerComp";
import { feedbackFacts, feedbackProblem, makeFeedback, ruleFeedback } from "./feedback";
import type { Coverage } from "../prep/competency";

const cov = (id: string, found: string[]): Coverage => ({ id, name: id, reason: "", words: [], found, evidence: "" });

describe("답변에서 역량 찾기", () => {
  it("마침표 없는 받아쓰기를 말 끝으로 나눈다", () => {
    expect(answerText("원인을 찾아 고쳤습니다 그 뒤로 오류가 줄었어요")).toBe("원인을 찾아 고쳤습니다. 그 뒤로 오류가 줄었어요.");
  });
  it("자소서/답변 판정", () => {
    expect(verdictOf(true, false)).toBe("자소서만");
    expect(verdictOf(false, true)).toBe("답변만");
  });
  it("규칙으로 답변 근거와 질문 번호를 찾는다", async () => {
    const r = await answerCompetency([cov("problem", ["해결"]), cov("interpersonal", ["협업"])], ["저는 그냥 열심히 했습니다", "로그를 보며 원인을 찾아 고쳤습니다 그래서 오류가 줄었습니다"]);
    const p = r.rows.find((x) => x.id === "problem")!;
    expect(p.verdict).toBe("둘 다");
    expect(p.q).toBe(1);
    expect(r.rows.find((x) => x.id === "interpersonal")!.verdict).toBe("자소서만");
  });
  it("규칙이 못 잡은 역량은 AI 판정으로", async () => {
    const r = await answerCompetency([cov("self", ["배웠"])], ["처음 해 보는 일이라 실패도 많았지만 매주 기록하며 다음 시도를 정했습니다"], async () => '{"yes": true, "why": "실패 뒤 다시 시도"}');
    expect(r.rows[0].via).toBe("AI");
    expect(r.rows[0].q).toBe(0);
  });
});

describe("종합 피드백", () => {
  const input = {
    alerts: [{ label: "정면을 봐 주세요", count: 5, grade: "bad" as const }],
    facts: [{ kind: "숫자", text: "12%", verdict: "불일치", said: "20%" }, { kind: "기간", text: "6개월", verdict: "일치", said: "" }],
    comps: [{ name: "대인관계와 협업", verdict: "자소서만" }, { name: "문제해결", verdict: "둘 다" }],
    issues: ["결과를 말하지 않음"],
  };
  it("규칙이 사실을 고른다", () => {
    const f = feedbackFacts(input);
    expect(f.fix[0]).toContain("5회");
    expect(f.fix.join(" ")).toContain("12%");
    expect(f.good.join(" ")).toContain("문제해결");
  });
  it("없는 숫자를 쓰면 탈락", () => {
    const f = feedbackFacts(input);
    expect(feedbackProblem("문제해결을 잘 보여 주셨어요. 다만 정면 보기 경고가 7회나 있었고 자소서의 12%와 다르게 말했어요. 다음엔 숫자를 확인해 보세요.", f)).toContain("7");
    expect(feedbackProblem("문제해결을 잘 보여 주셨어요. 다만 정면 보기 경고가 5회 있었고 자소서의 12%와 답변의 20%가 달랐어요. 다음엔 숫자를 먼저 확인해 보세요.", f)).toBeNull();
  });
  it("AI가 없거나 떨어지면 규칙 문장", async () => {
    expect((await makeFeedback(input, null)).by).toBe("rule");
    const r = await makeFeedback(input, async () => '{"feedback": "짧음"}');
    expect(r.by).toBe("rule");
    expect(r.note).toContain("짧음");
    expect(ruleFeedback(feedbackFacts(input))).toContain("고칠 점");
  });
});
