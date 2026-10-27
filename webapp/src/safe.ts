// 보안 도우미: 화면에 넣는 글 이스케이프, 불러온 파일 검사.
import type { Dataset } from "./eval/metrics";

// innerHTML에 넣는 모든 바깥 글(자소서, 받아쓰기, 오류 메시지, 불러온 파일)은 이걸 거친다.
export const esc = (t: unknown) =>
  String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export const MAX_DATASET_BYTES = 20 * 1024 * 1024; // 브라우저가 멈추지 않을 정도
const MAX_TEXT = 50_000; // 자소서·공고 한 건 글자 수 상한

const str = (v: unknown, max = MAX_TEXT) => typeof v === "string" && v.length <= max;

// 검증 페이지에 사용자가 넣는 JSON. 모양이 다르면 이유를 담아 던진다.
export function parseDataset(text: string): Dataset {
  if (text.length > MAX_DATASET_BYTES) throw new Error("파일이 너무 커요 (20MB 이하)");
  const d = JSON.parse(text) as Partial<Dataset>;
  if (!d || !Array.isArray(d.cases) || !Array.isArray(d.postings)) throw new Error("cases, postings 목록이 없어요");
  d.postings.forEach((p, i) => {
    if (!p || !str(p.id, 100) || !str(p.text) || (p.title !== undefined && !str(p.title, 300)))
      throw new Error(`postings[${i}] 모양이 달라요 (id, text는 글자)`);
  });
  const ids = new Set(d.postings.map((p) => p.id));
  d.cases.forEach((c, i) => {
    if (!c || !str(c.id, 100) || !str(c.posting, 100) || !str(c.resume) || !Array.isArray(c.labels) || !c.labels.every((l) => str(l, 50)))
      throw new Error(`cases[${i}] 모양이 달라요 (id, posting, resume, labels)`);
    if (!ids.has(c.posting)) throw new Error(`cases[${i}]가 없는 채용공고 ${c.posting.slice(0, 20)}를 가리켜요`);
  });
  return d as Dataset;
}

// 보안 정책(CSP)에 막힌 주소를 모아 둔다. 실제 브라우저에서 모델이 안 받아지면 '측정 정보'에서 확인한다.
export const cspBlocked: string[] = [];
if (typeof document !== "undefined")
  document.addEventListener("securitypolicyviolation", (e) => {
    const what = `${e.effectiveDirective} ${e.blockedURI}`;
    if (!cspBlocked.includes(what)) cspBlocked.push(what), console.warn("보안 정책이 막음:", what);
  });
