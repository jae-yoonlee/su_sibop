import { describe, expect, it, vi } from "vitest";
vi.mock("@mediapipe/tasks-audio", () => ({}));
const { soundGroup } = await import("./sound");

describe("소리 종류 묶기", () => {
  it("YAMNet 이름을 화면용 묶음으로", () => {
    expect(soundGroup("Television")).toBe("다른 사람 목소리, TV");
    expect(soundGroup("Music")).toBe("음악");
    expect(soundGroup("Computer keyboard")).toBe("키보드, 클릭");
    expect(soundGroup("Mechanical fan")).toBe("기계 소리(선풍기, 에어컨)");
    expect(soundGroup("Silence")).toBe("");
    expect(soundGroup("Glass")).toBe("기타 소리");
  });
});
