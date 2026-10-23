import { describe, expect, it } from "vitest";
import { addJudge, candidates, judgeIds, judgePrompt, parseJudge, weakSentences } from "./judge";
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

describe("돌려 말한 문장 후보 (뜻 비교로 고르고 AI가 확인)", () => {
  const r = "상대와 생각이 달라 다퉜지만 서로 원하는 것을 받아들였습니다. 저는 커피를 좋아합니다.";
  it("규칙 0점이어도 뜻 점수가 기준 이상이면 후보", () => {
    const c = candidates(["interpersonal", "math"], r, [
      { id: "interpersonal", score: 0.83, sentence: "상대와 생각이 달라 다퉜지만 서로 원하는 것을 받아들였습니다.", passed: false },
      { id: "math", score: 0.76, sentence: "저는 커피를 좋아합니다.", passed: false },
    ]);
    expect(c.map((x) => x.id)).toEqual(["interpersonal"]);
    expect(c[0].cues[0]).toBe("뜻 0.83");
  });
  it("질문에 맞음/아님 예시가 들어간다", () => {
    const p = judgePrompt("interpersonal", "문장");
    expect(p).toContain("맞음 예");
    expect(p).toContain("아님 예");
  });
});
