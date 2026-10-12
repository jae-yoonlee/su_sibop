import { describe, expect, it } from "vitest";
import { accuracy, cer } from "./cer";

describe("받아쓰기 정확도", () => {
  const ref = "안녕하세요. 오늘 면접에서 제 경험을 차분하고 또렷하게 말씀드리겠습니다.";
  it("띄어쓰기·문장부호가 달라도 같으면 100%", () => {
    expect(accuracy(ref, "안녕하세요 오늘 면접에서 제 경험을 차분하고 또렷하게 말씀드리겠습니다")).toBe(100);
  });
  it("한 글자 틀리면 그만큼 깎임", () => {
    expect(cer("가나다라", "가나마라")).toBeCloseTo(0.25);
  });
  it("뒤쪽을 못 받아쓰면 크게 깎임 (문장을 다 읽기 전에 끊긴 경우)", () => {
    expect(accuracy(ref, "안녕하세요 오늘 면접에서")).toBeLessThan(40);
  });
  it("아무것도 없으면 0%", () => {
    expect(accuracy(ref, "")).toBe(0);
  });
});
