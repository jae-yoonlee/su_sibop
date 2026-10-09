import { describe, expect, it } from "vitest";
import { checkResume, findCompetencies, requiredFromRules } from "./competency";
import { parseRequired } from "./gemini";
import { parseAiQuestions, ruleQuestions } from "./questions";
import { runPrep, type PrepState } from "./pipeline";

const POSTING = `[자격요건] 다양한 부서와 원활하게 협업할 수 있는 분.
데이터 분석을 바탕으로 문제를 해결하고 개선안을 제시할 수 있는 분.
[인재상] 동료와 사이좋게 지내며 책임감 있게 일하는 사람.`;
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

  it("자소서 대조: 협업은 근거 있음, 책임감은 근거 없음", () => {
    const cov = checkResume(requiredFromRules(POSTING), RESUME);
    expect(cov.find((c) => c.name === "대인관계·협업")!.found).toContain("협업");
    expect(cov.find((c) => c.name === "직업윤리·책임감")!.found).toEqual([]);
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
    expect(fallback[1].question).toMatch(/책임감|문제해결/);
    expect(fallback[1].question).toMatch(/을|를/);
  });

  it("AI 답 검사: 자소서에 없는 근거는 버리고 규칙 질문으로 채움", () => {
    const text = JSON.stringify({
      questions: [
        { type: "경험", question: "팀장으로서 6개월 동안 맡은 역할을 말씀해 주세요.", evidence: "저는 2023년 3월부터 6개월 동안 캡스톤 프로젝트에서 팀장을 맡았습니다." },
        { type: "직무", question: "해외 인턴 경험에서 배운 점은 무엇인가요?", evidence: "해외 인턴을 했습니다." },
        { type: "상황", question: "팀원과 갈등이 생기면 어떻게 하시겠어요?", evidence: "" },
      ],
    });
    const { questions, aiCount } = parseAiQuestions(`<think>\n\n</think>\n${text}`, RESUME, fallback);
    expect(aiCount).toBe(2);
    expect(questions[0].source).toBe("ai");
    expect(questions[1]).toEqual(fallback[1]);
    expect(questions[2].source).toBe("ai");
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
