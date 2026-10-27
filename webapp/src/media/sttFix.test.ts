import { describe, expect, it } from "vitest";
import { editDistance, fixTerms, termVocab } from "./sttFix";

const resume = "ISMS-P 인증체계와 기술적 보안 점검을 연계하는 GRC 자동화 프로젝트에 참여했습니다. AI와 API를 다뤘습니다.";

describe("받아쓰기 영문 용어 고치기", () => {
  it("자소서에서 영문 용어를 뽑는다", () => {
    expect(termVocab([resume])).toEqual(["ISMS-P", "GRC", "AI", "API"]);
  });

  it("10/27 실사용 오타를 고친다", () => {
    const v = termVocab([resume]);
    const r = fixTerms("grc 프로그램을 만들었습니다 의무에 대한 imfp를 고객 안내서 imsp 관리", v);
    expect(r.text).toBe("GRC 프로그램을 만들었습니다 의무에 대한 ISMS-P를 고객 안내서 ISMS-P 관리");
    expect(r.fixes).toHaveLength(3);
  });

  it("한글로 받아써진 약어도 (3글자 이상만)", () => {
    const v = termVocab([resume]);
    expect(fixTerms("지알씨 자동화", v).text).toBe("GRC 자동화");
    expect(fixTerms("아이 때부터", v).text).toBe("아이 때부터"); // AI는 건드리지 않음
  });

  it("짧은 낱말은 정확히 같을 때만, 모르는 영어는 그대로", () => {
    const v = ["AES", "SQL"];
    expect(fixTerms("aws 서버", v).text).toBe("aws 서버");
    expect(fixTerms("python으로", v).text).toBe("python으로");
    expect(fixTerms("sql 튜닝", v).text).toBe("SQL 튜닝");
  });

  it("편집 거리", () => {
    expect(editDistance("imfp", "ismsp")).toBe(2);
    expect(editDistance("", "abc")).toBe(3);
  });
});
