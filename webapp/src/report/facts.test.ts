import { describe, expect, it, vi } from "vitest";

// 테스트에서는 의미 모델을 받지 않고 글자 비교(대체 방식)만 쓴다
vi.mock("./embed", async (orig) => {
  const m = await orig<typeof import("./embed")>();
  return { ...m, similarity: async (a: string[], b: string[]) => ({ sim: a.map((x) => b.map((y) => m.charSim(x, y))), mode: "fallback" as const }) };
});
import { checkFacts, extractFacts, normalizeSpoken } from "./facts";

const RESUME = "2023년 3월부터 6개월 동안 '모두의 식탁' 캡스톤 프로젝트에서 팀장을 맡았습니다. 설문 응답 120명을 분석해 이탈률을 12% 줄였습니다. 저는 데이터 수집을 담당했습니다.";

describe("말투 맞추기", () => {
  it("한글 숫자를 숫자로", () => {
    expect(normalizeSpoken("세 달 동안 했습니다")).toContain("3개월");
    expect(normalizeSpoken("삼십 퍼센트 줄였어요")).toContain("30%");
    expect(normalizeSpoken("육 개월")).toContain("6개월");
    expect(normalizeSpoken("백이십 명을 조사")).toContain("120명");
    expect(normalizeSpoken("스무 명")).toContain("20명");
    expect(normalizeSpoken("12 프로")).toContain("12%");
  });
  it("숫자가 아닌 말은 그대로", () => {
    expect(normalizeSpoken("이번 일은 사람이 중요")).toBe("이번 일은 사람이 중요");
    expect(normalizeSpoken("구분하고 사주를 봤다")).toBe("구분하고 사주를 봤다");
    expect(normalizeSpoken("육개월 동안")).toContain("6개월");
    expect(normalizeSpoken("오 명이")).toContain("5명");
    expect(normalizeSpoken("제가 한 개발과 네 명확히")).toBe("제가 한 개발과 네 명확히");
    expect(normalizeSpoken("세 번째로 두 개를")).toBe("3번째로 2개를");
  });
});

describe("자소서에서 사실 뽑기", () => {
  const facts = extractFacts(RESUME);
  const texts = facts.map((f) => `${f.kind}:${f.text}`);
  it("기간·숫자·역할·프로젝트", () => {
    expect(texts).toContain("기간:6개월");
    expect(texts).toContain("숫자:120명");
    expect(texts).toContain("숫자:12%");
    expect(texts).toContain("역할:팀장");
    expect(texts).toContain("프로젝트:모두의 식탁");
    expect(texts.some((t) => t.startsWith("역할:데이터 수집"))).toBe(true);
  });
  it("연도·월은 기간이 아님", () => {
    expect(texts).not.toContain("기간:2023년");
    expect(texts.some((t) => t.includes("3월"))).toBe(false);
  });
});

describe("대조", () => {
  const facts = extractFacts(RESUME);
  const by = (rows: Awaited<ReturnType<typeof checkFacts>>["rows"], text: string) => rows.find((r) => r.text === text)!;

  it("말투가 달라도 같은 숫자면 일치", async () => {
    const { rows, mode } = await checkFacts(facts, ["캡스톤 프로젝트에서 육 개월 동안 팀장으로 일했습니다. 모두의 식탁이라는 서비스였습니다."]);
    expect(mode).toBe("fallback");
    expect(by(rows, "6개월").verdict).toBe("일치");
    expect(by(rows, "팀장").verdict).toBe("일치");
    expect(by(rows, "모두의 식탁").verdict).toBe("일치");
    expect(by(rows, "12%").verdict).toBe("말 안 함");
  });

  it("같은 경험에서 다른 숫자·역할이면 불일치", async () => {
    const { rows } = await checkFacts(facts, ["설문 응답을 분석해서 이탈률을 이십 퍼센트 줄였습니다.", "캡스톤 프로젝트에서 저는 팀원으로 참여했습니다."]);
    const r = by(rows, "12%");
    expect(r.verdict).toBe("불일치");
    expect(r.said).toBe("20%");
    expect(r.q).toBe(0);
    expect(by(rows, "팀장").verdict).toBe("불일치");
  });

  it("관련 없는 문장의 숫자는 불일치로 안 봄", async () => {
    const { rows } = await checkFacts(facts, ["저는 주말마다 5% 정도 시간을 운동에 씁니다."]);
    expect(by(rows, "12%").verdict).toBe("말 안 함");
  });

  it("비슷한 이름은 확인 필요 (받아쓰기 오류)", async () => {
    const { rows } = await checkFacts(facts, ["모두의 시탁 프로젝트를 했습니다."]);
    expect(by(rows, "모두의 식탁").verdict).toBe("확인 필요");
  });

  it("AI가 다른 경험이라 하면 불일치 → 확인 필요", async () => {
    const ask = vi.fn(async () => '{"same": false, "why": "다른 수치"}');
    const { rows } = await checkFacts(facts, ["설문 응답을 분석해서 이탈률을 20% 줄였습니다."], { ask });
    expect(ask).toHaveBeenCalled();
    expect(by(rows, "12%").verdict).toBe("확인 필요");
  });

  it("AI가 고장 나도 규칙 판정 유지", async () => {
    const { rows } = await checkFacts(facts, ["설문 응답을 분석해서 이탈률을 20% 줄였습니다."], { ask: async () => "garbage" });
    expect(by(rows, "12%").verdict).toBe("불일치");
  });
});

describe("2026-10-19 고친 것", () => {
  it("'6개월'에서 숫자 '6개'를 따로 뽑지 않음", () => {
    const f = extractFacts("6개월 동안 사과 3개를 팔았습니다.");
    expect(f.map((x) => x.text)).toEqual(["6개월", "3개"]);
  });
  it("말투 숫자를 바꿀 때 앞 띄어쓰기를 지우지 않음", () => {
    expect(normalizeSpoken("맡았습니다. 여섯 달 동안")).toBe("맡았습니다. 6개월 동안");
  });
});
