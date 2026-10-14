import { describe, expect, it } from "vitest";
import { checkAiFollowup, chooseIssue, findIssues, followupPrompt, makeFollowup, templateQuestion } from "./followup";
import type { Question } from "./questions";

// poc/face-realtime/test_followup_gen.py와 같은 예시
const MAIN: Question = { type: "경험", question: "물류 프로젝트에서 맡은 일을 말해 주세요.", evidence: "6개월 동안 팀장을 맡아 배송 지연률을 12% 줄였습니다.", source: "ai" };
const ANSWER = "저희 팀이 함께 6개월 동안 지연률을 20% 줄였습니다. 우리가 열심히 노력했습니다.";
const SOFT = "저희 팀이 함께 6개월 동안 지연률을 12% 줄였습니다. 우리가 열심히 노력했습니다."; // 숫자는 맞음
const names = (m: Question, a: string) => findIssues(m, a).map((i) => i.name);
const first = () => 0;

describe("꼬리질문 규칙: 답변의 빈 곳", () => {
  it("빈 곳을 우선순위대로 모두 찾음", () => {
    expect(names(MAIN, ANSWER)).toEqual(["mismatch", "no_role", "vague"]);
  });
  it("답변 내용의 빈 곳에는 인용할 답변 문장이 붙음", () => {
    const vague = findIssues(MAIN, ANSWER).find((i) => i.name === "vague")!;
    expect(vague.slots.quote).toBe("우리가 열심히 노력했습니다");
    expect(findIssues(MAIN, ANSWER).find((i) => i.name === "no_role")!.slots.quote).toContain("저희 팀이 함께");
  });
  it("답변 내용의 빈 곳이 자소서 숫자 누락보다 먼저", () => {
    const issues = findIssues(MAIN, "제가 지연률을 12% 줄였는데 우리가 열심히 노력했습니다.");
    expect(issues.map((i) => i.name)).toEqual(["vague", "missing_fact"]);
    expect(chooseIssue(issues, first).name).toBe("vague");
  });
  it("받아쓴 답이 없으면 자소서로 묻지 않고 다시 말해 달라고 함", () => {
    expect(names(MAIN, "")).toEqual(["no_text"]);
    expect(templateQuestion(chooseIssue(findIssues(MAIN, ""), first), first)).toContain("다시");
  });
  it("빈 곳이 없으면 답변의 가장 긴 문장을 짚음", () => {
    const main = { ...MAIN, type: "직무", evidence: "분석 역량이 있습니다." };
    const issue = chooseIssue(findIssues(main, "제가 직접 고객 데이터를 분석해서 보고서를 썼습니다."), first, new Set(), "제가 직접 고객 데이터를 분석해서 보고서를 썼습니다.");
    expect(issue.name).toBe("generic");
    expect(templateQuestion(issue, first)).toContain("고객 데이터를");
  });
  it("'퍼센트'도 %로 봄", () => {
    expect(names(MAIN, "제가 6개월 동안 지연률을 12퍼센트 줄였습니다.")).not.toContain("mismatch");
  });
  it("자소서 숫자를 말하지 않음", () => {
    expect(findIssues(MAIN, "제가 팀장으로 지연률을 12% 줄였습니다.")[0]).toMatchObject({ name: "missing_fact", slots: { doc: "6개월" } });
  });
  it("날짜(2023년 3월)는 숫자 확인 대상이 아님", () => {
    expect(findIssues({ ...MAIN, evidence: "2023년 3월부터 6개월 동안 팀장을 맡았습니다." }, "제가 팀장을 6개월 했고 30% 줄였습니다.")).toEqual([]);
  });
  it("경험 질문인데 결과 숫자가 없음", () => {
    expect(names({ ...MAIN, evidence: "팀장을 맡아 배송 문제를 해결했습니다." }, "제가 팀장으로 문제를 해결했습니다.")).toEqual(["no_result"]);
  });
  it("'우리·팀'만 많음", () => {
    expect(names({ ...MAIN, type: "직무", evidence: "분석 역량이 있습니다." }, "제가 참여했고 우리 팀이 분석했고 저희가 함께 발표했습니다.")).toEqual(["team_heavy"]);
  });
  it("숫자 확인이 있으면 그것부터 묻고, 전에 물은 것은 피함", () => {
    const issues = findIssues(MAIN, ANSWER);
    expect(chooseIssue(issues, Math.random).name).toBe("mismatch");
    expect(chooseIssue(findIssues(MAIN, SOFT), first).name).toBe("no_role");
  });
  it("정해진 문장: 숫자 두 개와 받침에 맞는 조사", () => {
    const q = templateQuestion(chooseIssue(findIssues(MAIN, ANSWER), first), first);
    expect(q).toBe("자기소개서에는 12%라고 쓰셨는데 방금 20%라고 하셨습니다. 어느 쪽이 맞나요?");
    const q2 = templateQuestion({ name: "missing_fact", slots: { doc: "6개월", quote: "제가 팀장을 맡았습니다" } }, first);
    expect(q2).toBe("'제가 팀장을 맡았습니다'라고 하셨는데, 자기소개서에 적은 6개월과는 어떻게 이어지나요?");
  });
});

describe("꼬리질문 AI 검사", () => {
  const vague = { name: "vague" as const, slots: { quote: "우리가 열심히 노력했습니다." } };
  it("프롬프트에는 규칙이 고른 이유 하나와 답변만 (자소서 전체는 안 넣음)", () => {
    const p = followupPrompt(MAIN, SOFT, vague, []);
    expect(p).toContain("모호한 표현");
    expect(p).toContain(SOFT);
  });
  it("통과", () => {
    expect(checkAiFollowup('{"question":"열심히 노력하셨다는 건 구체적으로 어떤 행동이었나요?"}', vague, MAIN, SOFT)).toContain("행동");
  });
  it.each([
    ['{"question":"3개월 만에 어떻게 줄이셨나요?"}', "없던 숫자"],
    [`{"question":"열심히 ${"가".repeat(80)}요?"}`, "너무 김"],
    ['{"question":"팀장이었습니다."}', "존댓말 물음"],
    ["JSON 아님", "형식"],
  ])("떨어짐: %s", (raw, why) => {
    expect(() => checkAiFollowup(raw, vague, MAIN, SOFT)).toThrow(why);
  });
  it("숫자 확인인데 그 숫자를 안 물으면 떨어짐", () => {
    const miss = { name: "missing_fact" as const, slots: { doc: "6개월" } };
    expect(() => checkAiFollowup('{"question":"그때 본인 역할은 무엇이었나요?"}', miss, MAIN, "제가 12% 줄였습니다.")).toThrow("숫자");
  });
});

describe("꼬리질문 만들기", () => {
  it("AI가 쓴 문장을 씀", async () => {
    const q = "팀이 지연률을 줄일 때 본인이 직접 맡았던 일은 무엇이었나요?";
    const f = await makeFollowup(MAIN, SOFT, { ask: async () => JSON.stringify({ question: q }), rand: first });
    expect(f).toMatchObject({ source: "ai", reason: "no_role", question: q });
  });
  it("AI가 답변과 상관없는 질문을 쓰면 답변을 인용한 정해진 문장", async () => {
    const f = await makeFollowup(MAIN, SOFT, { ask: async () => '{"question":"본인의 장점은 무엇인가요?"}', rand: first });
    expect(f.source).toBe("rule");
    expect(f.error).toContain("짚지");
    expect(f.question).toContain("저희 팀이 함께");
  });
  it("AI가 늦으면 정해진 문장으로, 이유를 남김", async () => {
    const t0 = performance.now();
    const f = await makeFollowup(MAIN, SOFT, { ask: () => new Promise((r) => setTimeout(() => r("{}"), 1000)), maxMs: 100, rand: first });
    expect(f.source).toBe("rule");
    expect(f.error).toContain("초과");
    expect(performance.now() - t0).toBeLessThan(600);
  });
  it("AI가 없거나 받아쓴 답이 없으면 정해진 문장", async () => {
    expect((await makeFollowup(MAIN, SOFT, { ask: null })).source).toBe("rule");
    expect((await makeFollowup(MAIN, "", { ask: async () => '{"question":"무엇을 하셨나요?"}' })).error).toContain("받아쓴");
  });
  it("전에 한 질문과 같으면 정해진 문장", async () => {
    const q = "본인이 직접 맡았던 일은 무엇이었나요?";
    const f = await makeFollowup(MAIN, SOFT, { ask: async () => JSON.stringify({ question: q }), history: [q], rand: first });
    expect(f.source).toBe("rule");
  });
});
