import { describe, expect, it } from "vitest";
import { addJudge, judgeIds, judgePrompt, parseJudge, weakSentences } from "./judge";
import type { Coverage } from "./competency";

const resume = "처음 해 보는 일이라 실패한 게시물도 많았지만, 매주 숫자를 기록하며 다음 시도를 정했습니다. 저는 커피를 좋아합니다.";

describe("애매한 문장 AI 판정", () => {
  it("규칙 1점짜리 문장만 고른다", () => {
    const w = weakSentences("self", resume);
    expect(w).toHaveLength(1);
    expect(w[0].sentence).toContain("실패한 게시물");
    expect(weakSentences("technology", resume)).toEqual([]);
  });
  it("이미 규칙으로 인정된 역량은 묻지 않는다", () => {
    expect(weakSentences("self", "독학으로 디자인을 공부했습니다. 그 과정에서 많이 배웠습니다.")).toEqual([]);
  });
  it("AI 답 읽기 (생각 태그, 깨진 답)", () => {
    expect(parseJudge('<think>음</think>{"yes": true, "why": "실패에서 배움"}')).toEqual({ yes: true, why: "실패에서 배움" });
    expect(parseJudge("모르겠어요").yes).toBeNull();
  });
  it("질문에 NCS 정의와 문장이 들어간다", () => {
    const p = judgePrompt("self", "문장");
    expect(p).toContain("자기개발");
    expect(p).toContain('"문장"');
  });
  it("yes면 근거 없던 칸을 AI 근거로 채우고 원문을 남긴다", async () => {
    const cov: Coverage[] = [{ id: "self", name: "자기개발", reason: "", words: [], found: [], evidence: "" }];
    const r = await addJudge(cov, resume, async () => '{"yes": true, "why": "실패 뒤 다시 시도"}');
    expect(r.added).toBe(1);
    expect(r.coverage[0].via).toBe("AI");
    expect(r.judgments[0].raw).toContain("yes");
    const no = await addJudge(cov, resume, async () => '{"yes": false, "why": "행동 없음"}');
    expect(no.added).toBe(0);
    expect(no.judgments[0].yes).toBe(false);
  });
  it("AI 오류는 판정 없음으로 남기고 멈추지 않는다", async () => {
    const js = await judgeIds(["self"], resume, async () => {
      throw new Error("끊김");
    });
    expect(js[0].yes).toBeNull();
    expect(js[0].raw).toContain("끊김");
  });
});
