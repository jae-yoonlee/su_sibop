import { describe, expect, it } from "vitest";
import { pickAlternative } from "./stt";

describe("받아쓰기 후보 고르기", () => {
  it("자소서 단어가 들어간 후보를 고른다 (띄어쓰기 무시)", () => {
    expect(pickAlternative(["물류 최적화 프로젝트에서", "물류 최적 와 프로젝트에서", "물류최적화 프로젝트"], ["물류 최적화 프로젝트"])).toBe("물류 최적화 프로젝트에서");
    expect(pickAlternative(["배송 지연률을 이십 퍼센트", "배송 지연률을 12%"], ["12%"])).toBe("배송 지연률을 12%");
  });
  it("힌트가 없거나 아무것도 안 맞으면 1순위", () => {
    expect(pickAlternative(["가", "나"], [])).toBe("가");
    expect(pickAlternative(["가나다", "라마바"], ["사아자"])).toBe("가나다");
    expect(pickAlternative([], ["x"])).toBe("");
  });
});
