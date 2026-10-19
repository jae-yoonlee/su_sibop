import { describe, expect, it, vi } from "vitest";

// 테스트에서는 뜻 비교 모델을 받지 않는다 (받지 못한 경우와 같음)
vi.mock("../report/embed", async (orig) => {
  const m = await orig<typeof import("../report/embed")>();
  return { ...m, preloadEmbedder: async () => null, similarity: async (a: string[], b: string[]) => ({ sim: a.map((x) => b.map((y) => m.charSim(x, y))), mode: "fallback" as const }) };
});
import { checkResume, findCompetencies, requiredFromRules } from "./competency";
import { parseRequired } from "./gemini";
import { parseAiQuestions, questionPrompt, questionProblem, questionSlots, quoteClause, ruleQuestions, styleProblem } from "./questions";
import { runPrep, type PrepState } from "./pipeline";

const POSTING = `[자격요건] 다양한 부서와 원활하게 협업할 수 있는 분.
데이터 분석을 바탕으로 문제를 해결하고 개선안을 제시할 수 있는 분.
[인재상] 동료와 사이좋게 지내며 책임감 있게 일하는 사람.
고객 앞에서 발표하고 설득하는 일이 많습니다.`;
const RESUME = `저는 2023년 3월부터 6개월 동안 캡스톤 프로젝트에서 팀장을 맡았습니다.
팀원 4명과 협업하며 일정 관리를 담당했고, 사용자 이탈률을 30% 줄였습니다.
새로운 기술을 배우는 것을 좋아합니다.`;

describe("역량 규칙", () => {
  it("채용공고에서 협업·문제해결·책임감을 찾음", () => {
    const ids = findCompetencies(POSTING).map((h) => h.id);
    expect(ids).toContain("interpersonal");
    expect(ids).toContain("problem");
    expect(ids).toContain("ethics");
  });

  it("'사이좋게' 같은 표현도 대인관계로 잡음", () => {
    expect(findCompetencies("동료와 사이좋게 지냈으면 좋겠어요").map((h) => h.id)).toContain("interpersonal");
  });

  it("자소서 대조: 협업·책임감(맡았·담당)은 근거 있음, 의사소통은 근거 없음", () => {
    const cov = checkResume(requiredFromRules(POSTING), RESUME);
    expect(cov.find((c) => c.name === "대인관계·협업")!.found).toContain("협업");
    expect(cov.find((c) => c.name === "직업윤리·책임감")!.found).toContain("담당");
    expect(cov.find((c) => c.name === "의사소통")!.found).toEqual([]);
  });
});

describe("Gemini 응답", () => {
  it("JSON 배열을 필요역량으로 바꿈", () => {
    const r = parseRequired(JSON.stringify([{ name: "협업", reason: "다양한 부서와 원활하게 협업", words: ["협업", "팀원"] }, { name: "", reason: "", words: [] }]));
    expect(r).toEqual([{ name: "협업", reason: "다양한 부서와 원활하게 협업", words: ["협업", "팀원"] }]);
  });
});

describe("질문", () => {
  const cov = checkResume(requiredFromRules(POSTING), RESUME);
  const fallback = ruleQuestions(RESUME, cov);

  it("규칙 질문 3개: 자소서 문장 인용 + 근거 없는 역량 질문", () => {
    expect(fallback).toHaveLength(3);
    expect(fallback[0].question).toContain("자기소개서에");
    expect(fallback[1].question).toContain("의사소통");
    expect(fallback[1].question).toMatch(/을|를/);
  });

  it("근거 문장은 규칙이 고름: 경험=숫자+역할 문장, 서로 다른 문장", () => {
    const slots = questionSlots(RESUME, cov);
    expect(slots[0].evidence).toContain("팀장");
    expect(slots[1].evidence).not.toBe(slots[0].evidence);
    expect(slots[2].evidence).not.toContain("좋아합니다"); // 경험이 아닌 문장으로 갈등을 묻지 않음
    expect(slots[1].competency).toBe("의사소통");
    expect(questionPrompt(RESUME, cov)).not.toContain("새로운 기술을 배우는 것을 좋아합니다.\n저는"); // 자소서 전체를 넣지 않음
  });

  it("AI 답 검사: 지어낸 숫자·물음이 아닌 문장은 규칙 질문으로, 근거는 규칙이 고른 문장", () => {
    const text = JSON.stringify({
      questions: ["캡스톤 프로젝트 6개월 동안 팀장으로서 맡은 역할을 말씀해 주세요.", "해외 인턴 12개월 경험에서 배운 점은 무엇인가요?", "팀원과 협업하다 갈등이 생겼을 때 어떻게 하셨나요?"],
    });
    const { questions, aiCount } = parseAiQuestions(`<think>\n\n</think>\n${text}`, RESUME, fallback);
    expect(aiCount).toBe(2);
    expect(questions[0]).toMatchObject({ source: "ai", evidence: fallback[0].evidence });
    expect(questions[1]).toEqual(fallback[1]);
    expect(questions[2].source).toBe("ai");
  });

  it("여진 검증에서 나온 이상한 질문은 탈락 (평서문·반말·3인칭·없는 낱말)", () => {
    const R15 = "자동차 부품 회사에서 3개월 동안 품질팀 현장실습을 했습니다. 특정 라인에서만 치수 불량이 많이 나와, 6주 동안 작업 시간대별 불량 데이터를 모아 분석했습니다. 현장 반장님들께 데이터를 보여 드리며 설명했습니다.";
    expect(styleProblem("자동차 부품 회사에서 3개월 동안 품질팀 현장실습을 했었고, 품질 관리 역량을 실천해왔습니다.", R15)).toBe("존댓말 물음이 아님");
    expect(styleProblem("그때 레진으로 치수불량을 분석한 적이 있었어?", R15)).not.toBe("");
    expect(styleProblem("지원자가 현장 반장님들께 데이터를 보여 드렸어?", R15)).not.toBe("");
    expect(styleProblem("지원자가 현장 반장님들께 데이터를 보여 드렸나요?", R15)).toBe("3인칭으로 부름");
    expect(styleProblem("그때 레진으로 치수불량을 분석하셨나요?", R15)).toContain("레진");
    // 정상 질문은 통과
    expect(styleProblem("6주 동안 시간대별 불량 데이터를 어떻게 모으셨나요?", R15)).toBe("");
    expect(styleProblem("현장 반장님들을 설득할 때 가장 어려웠던 점은 무엇이었습니까?", R15)).toBe("");
    expect(styleProblem("품질팀 현장실습에서 맡은 역할을 구체적으로 말씀해 주세요.", R15)).toBe("");
  });

  it("질문 인용은 중간에 자르지 않음: 긴 문장은 숫자 있는 구절을 골라 '~다'로 맺음", () => {
    expect(quoteClause("저는 2023년 3월부터 6개월 동안 캡스톤 프로젝트에서 팀장을 맡았습니다.")).toBe("2023년 3월부터 6개월 동안 캡스톤 프로젝트에서 팀장을 맡았습니다");
    expect(quoteClause("팀원 4명과 협업하며 일정 관리를 담당했고, 사용자 이탈률을 30% 줄였습니다. 그리고 많은 것을 배웠습니다")).not.toContain("…");
    expect(quoteClause("새로운 서비스를 기획하면서 팀원 4명과 매주 회의하며 일정 관리를 담당했고, 사용자 이탈률을 30% 줄였습니다.")).toBe("새로운 서비스를 기획하면서 팀원 4명과 매주 회의하며 일정 관리를 담당했다");
    for (const q of fallback) expect(q.question).not.toMatch(/…|\.\.\./);
  });

  it("AI 질문이 말을 자르거나 막연하면 떨어뜨림", () => {
    expect(questionProblem("자기소개서에 '캡스톤 프로젝트에서…'라고 쓰셨는데 역할은 무엇이었나요?", RESUME)).toBe("말을 중간에 자름");
    expect(questionProblem("팀장 경험에 대해 어떻게 생각하시나요?", RESUME)).toBe("막연한 물음");
  });

  it("AI 답이 깨지면 모두 규칙 질문", () => {
    expect(parseAiQuestions("죄송합니다", RESUME, fallback).aiCount).toBe(0);
  });
});

describe("분석 흐름", () => {
  it("키·그래픽 가속이 없어도 규칙만으로 질문까지 끝남", async () => {
    let last: PrepState | null = null;
    runPrep({ posting: POSTING, resume: RESUME, geminiKey: "" }, (s) => (last = s));
    await new Promise((r) => setTimeout(r, 50));
    expect(last!.done).toBe(true);
    expect(last!.questionsBy).toBe("rules");
    expect(last!.steps.gemini).toBe("skip");
    expect(last!.questions).toHaveLength(3);
    expect(last!.coverage.length).toBeGreaterThan(0);
  });
});

describe("문맥 규칙: 명사만으로는 역량 인정 안 함 (2026-10-19)", () => {
  const ids = (t: string) => findCompetencies(t, true).map((h) => h.id);
  it("'재고'라는 단어만으로는 자원관리가 아님", () => {
    expect(ids("물류센터에서 재고 입고 기록을 남기는 작은 프로그램을 만들었습니다.")).not.toContain("resource");
  });
  it("재고를 줄이거나 비용을 아낀 행동은 자원관리", () => {
    expect(ids("매주 발주량을 조정해 재고를 30% 줄였습니다.")).toContain("resource");
  });
  it("'하게 되었다'만으로는 자기개발이 아님", () => {
    expect(ids("그 결과 다른 팀과 함께 일하게 되었습니다.")).not.toContain("self");
  });
});
