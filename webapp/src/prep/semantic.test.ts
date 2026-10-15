import { describe, expect, it, vi } from "vitest";

// 뜻 비교는 가짜 점수로: "도와" 들어간 문장만 대인관계 예시와 0.9
let mode: "model" | "fallback" = "model";
vi.mock("../report/embed", async (orig) => {
  const m = await orig<typeof import("../report/embed")>();
  return {
    ...m,
    similarity: async (a: string[], b: string[]) => ({ sim: a.map((p) => b.map((s) => (p.includes("도와") && s.includes("도와") ? 0.9 : 0.7))), mode }),
  };
});
import { checkResume, cueScore, findCompetencies, guessCompetency, sentences } from "./competency";
import { addSemantic, findAll } from "./semantic";

describe("문맥 규칙", () => {
  it("역량 단어 없이 행동·결과 서술로 찾음", () => {
    const t = "배송이 늦어지는 원인을 찾기 위해 기록을 나누어 비교했고, 지연 건수가 18% 줄었습니다.";
    const h = findCompetencies(t, true);
    expect(h.find((x) => x.id === "problem")?.via).toContain("문맥");
    expect(h.find((x) => x.id === "math")?.via).toContain("문맥");
    expect(findCompetencies(t).some((x) => x.id === "problem")).toBe(false); // 단어만으로는 못 찾음
  });
  it("배웠다·하게 되었다 → 자기개발", () => {
    expect(findCompetencies("처음엔 몰랐지만 혼자 공부하며 SQL을 익혔습니다.", true).some((x) => x.id === "self")).toBe(true);
  });
  it("약한 단서 하나만으로는 안 잡음 (2점 기준)", () => {
    const s = sentences("손님이 많은 매장이었습니다.");
    expect(cueScore("organization", s)).toBe(1);
    expect(findCompetencies("손님이 많은 매장이었습니다.", true).some((x) => x.id === "organization")).toBe(false);
  });
  it("채용공고는 단어만 본다", () => {
    expect(findCompetencies("원인을 찾아 해결한 경험이 있는 분", false).every((h) => h.via.every((v) => v === "단어"))).toBe(true);
  });
});

describe("필요역량 대조", () => {
  it("Gemini 역량 이름을 10개 중 하나로 추정", () => {
    expect(guessCompetency({ name: "협업 능력", reason: "", words: ["팀워크", "협력"] })).toBe("interpersonal");
    expect(guessCompetency({ name: "우주 비행", reason: "", words: ["로켓"] })).toBeUndefined();
  });
  it("단어가 없으면 문맥으로 근거를 채움", () => {
    const [c] = checkResume([{ name: "문제해결", reason: "", words: ["문제해결"] }], "오류가 난 원인을 찾아내 설정을 바꿔 고쳤습니다.");
    expect(c.via).toBe("문맥");
    expect(c.evidence).toContain("원인");
  });
});

describe("뜻 비교", () => {
  const resume = "주말마다 후배들의 과제를 도와주었습니다. 매장에서 일했습니다.";
  it("근거 없는 칸만 뜻으로 채움", async () => {
    mode = "model";
    const cov = checkResume([{ id: "interpersonal", name: "대인관계", reason: "", words: ["협업"] }], resume);
    expect(cov[0].found).toHaveLength(0);
    const r = await addSemantic(cov, resume);
    expect(r.added).toBe(1);
    expect(r.coverage[0].via).toBe("뜻");
    expect(r.coverage[0].evidence).toContain("도와");
  });
  it("모델을 못 받으면 아무것도 안 바꿈", async () => {
    mode = "fallback";
    const cov = checkResume([{ id: "interpersonal", name: "대인관계", reason: "", words: ["협업"] }], resume);
    expect((await addSemantic(cov, resume)).added).toBe(0);
    expect((await findAll(resume)).mode).toBe("fallback");
  });
});
