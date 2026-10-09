import { describe, expect, it } from "vitest";
import raw from "../../../data/eval/cases.json";
import { blindSheets, caseInput, competencyEval, csv, parseCsv, scoreAiAnswer, scoreSheets, summarize, type Dataset, type QuestionRun } from "./metrics";

const ds = raw as Dataset;

describe("검증 자료", () => {
  it("모든 자소서가 있는 채용공고를 가리키고, 라벨이 정해진 역량 이름만 씀", () => {
    const ids = Object.keys(raw.competencyIds);
    for (const c of ds.cases) {
      expect(ds.postings.some((p) => p.id === c.posting)).toBe(true);
      c.labels.forEach((l) => expect(ids).toContain(l));
    }
  });
});

describe("역량 찾기 지표", () => {
  it("정확도·재현율을 0~1로 계산", () => {
    const r = competencyEval(ds.cases);
    expect(r.precision).toBeGreaterThan(0);
    expect(r.precision).toBeLessThanOrEqual(1);
    expect(r.recall).toBeLessThanOrEqual(1);
  });
});

describe("질문 지표", () => {
  const c = ds.cases[0];
  const { fallback } = caseInput(ds, c);
  const ev = "Python과 FastAPI로 주문 API를 만들고 PostgreSQL로 데이터베이스를 설계했습니다.";

  it("근거 문장 복사 여부와 채택 수를 셈", () => {
    const raw = JSON.stringify({ questions: [
      { type: "경험", question: "주문 API를 설계할 때 맡은 역할을 말해 주세요.", evidence: ev },
      { type: "직무", question: "클라우드 배포 경험이 있나요?", evidence: "지어낸 문장입니다." },
      { type: "상황", question: "짧음", evidence: "" },
    ] });
    const s = scoreAiAnswer(raw, c.resume, fallback);
    expect(s.jsonOk).toBe(true);
    expect(s.evidenceGiven).toBe(2);
    expect(s.evidenceExact).toBe(1);
    expect(s.aiCount).toBe(1);
  });

  it("JSON이 아니면 실패로 셈", () => {
    expect(scoreAiAnswer("질문을 만들 수 없습니다", c.resume, fallback).jsonOk).toBe(false);
  });

  it("요약: 마감 안 비율과 중간값", () => {
    const base = { caseId: "r01", run: 1, jsonOk: true, aiCount: 3, evidenceGiven: 1, evidenceExact: 1, questions: fallback, raw: "" };
    const runs: QuestionRun[] = [10, 20, 90].map((s) => ({ ...base, model: "m", ms: s * 1000 }));
    const [m] = summarize(runs, 60000);
    expect(m.medianMs).toBe(20000);
    expect(m.inDeadline).toBeCloseTo(2 / 3);
  });
});

describe("사람 채점지", () => {
  it("모델 이름이 채점지엔 없고, 채점 후 모델별 평균이 나옴", () => {
    const { fallback } = caseInput(ds, ds.cases[0]);
    const runs: QuestionRun[] = ["모델A", "모델B"].map((model) => ({ caseId: "r01", model, run: 1, ms: 0, jsonOk: true, aiCount: 0, evidenceGiven: 0, evidenceExact: 0, questions: fallback, raw: "" }));
    const { sheet, key } = blindSheets(runs, ds);
    expect(JSON.stringify(sheet)).not.toContain("모델A");
    // 엑셀에서 채운 것처럼: 모델A 질문엔 5점, 모델B엔 3점
    const modelOf = new Map(key.slice(1).map((r) => [r[0], r[1]]));
    const filled = sheet.map((r, i) => (i === 0 ? r : [...r.slice(0, 5), ...(modelOf.get(r[0]) === "모델A" ? [5, 5, 5] : [3, 3, 3]), "메모, 쉼표 포함"]));
    const back = parseCsv(csv(filled));
    const { result } = scoreSheets(back, parseCsv(csv(key)));
    expect(result.find((r) => r.model === "모델A")!.means).toEqual([5, 5, 5]);
    expect(result.find((r) => r.model === "모델B")!.scored).toBe(3);
  });
});
