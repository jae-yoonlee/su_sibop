import { describe, expect, it } from "vitest";
import { DEMO_GROUPS, demo, demoPick } from "./demo";

const sets = DEMO_GROUPS.flatMap((g) => g.sets);

describe("시연 모드 세트", () => {
  it("8세트, 3그룹 (3·3·2)", () => {
    expect(sets.map((s) => s.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(DEMO_GROUPS.map((g) => g.sets.length)).toEqual([3, 3, 2]);
  });
  it("본질문이 짚은 문장은 자소서에 그대로 있음", () => {
    for (const s of sets) if (s.evidence) expect(s.resume).toContain(s.evidence);
  });
  it("세트 4 자소서는 2025년으로 시작", () => expect(sets[3].resume.startsWith("2025년")).toBe(true));
  it("본질문 문장은 사용자가 준 그대로", () => {
    expect(sets[0].question).toBe("저희는 대인관계와 협업을 중요하게 보는데, 자기소개서에서는 잘 드러나지 않았어요. 그 역량을 보여 준 경험을 하나 말씀해 주세요.");
    expect(sets[3].question).toBe("자기소개서에 '2025년 캡스톤 디자인에서 6개월 동안 4명이 팀을 이루어 동아리 모임 예약 서비스 '모아요'를 만들었다'라고 쓰셨는데, 그 일에서 구체적으로 무엇을 하셨고 결과는 어땠나요?");
  });
  it("같은 세트를 다시 누르면 해제", () => {
    demoPick(2);
    expect(demo.set?.id).toBe(2);
    demoPick(2);
    expect(demo.set).toBeNull();
  });
});
