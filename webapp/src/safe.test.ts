import { describe, expect, it } from "vitest";
import { esc, parseDataset } from "./safe";

describe("보안 도우미", () => {
  it("태그와 따옴표를 글자로 바꿈", () => {
    expect(esc(`<img src=x onerror="alert(1)">'`)).toBe("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&#39;");
    expect(esc("-->")).toBe("--&gt;");
    expect(esc(undefined)).toBe("");
  });
  it("모양이 맞는 자료만 받음", () => {
    const ok = { postings: [{ id: "p1", title: "t", text: "공고" }], cases: [{ id: "r1", posting: "p1", resume: "자소서", labels: ["math"] }] };
    expect(parseDataset(JSON.stringify(ok)).cases).toHaveLength(1);
    expect(() => parseDataset("{}")).toThrow();
    expect(() => parseDataset(JSON.stringify({ ...ok, cases: [{ ...ok.cases[0], labels: [{}] }] }))).toThrow();
    expect(() => parseDataset(JSON.stringify({ ...ok, cases: [{ ...ok.cases[0], posting: "없음" }] }))).toThrow();
  });
});
