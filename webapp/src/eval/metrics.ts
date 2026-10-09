// 검증 페이지의 계산 부분 (화면과 분리해 테스트한다).
import { COMPETENCIES, checkResume, findCompetencies, requiredFromRules } from "../prep/competency";
import { parseAiQuestions, ruleQuestions, type Question } from "../prep/questions";

export interface Posting { id: string; title: string; text: string }
export interface Case { id: string; posting: string; resume: string; labels: string[]; facts?: Record<string, string> }
export interface Dataset { postings: Posting[]; cases: Case[] }

// ── 역량 찾기: 규칙 사전이 자소서에서 찾은 역량 vs 사람이 붙인 정답 ──────────

export interface CompetencyScore { id: string; name: string; tp: number; fp: number; fn: number; precision: number; recall: number }

const ratio = (a: number, b: number) => (b ? a / b : NaN);

export function competencyEval(cases: Case[]) {
  const per = new Map(COMPETENCIES.map((c) => [c.id, { tp: 0, fp: 0, fn: 0 }]));
  const rows = cases.map((c) => {
    const found = findCompetencies(c.resume).map((h) => h.id);
    const gold = new Set(c.labels);
    for (const id of per.keys()) {
      const p = per.get(id)!;
      const f = found.includes(id), g = gold.has(id);
      if (f && g) p.tp++;
      else if (f) p.fp++;
      else if (g) p.fn++;
    }
    return { id: c.id, found, missed: c.labels.filter((l) => !found.includes(l)), extra: found.filter((f) => !gold.has(f)) };
  });
  const scores: CompetencyScore[] = COMPETENCIES.map((c) => {
    const p = per.get(c.id)!;
    return { id: c.id, name: c.name, ...p, precision: ratio(p.tp, p.tp + p.fp), recall: ratio(p.tp, p.tp + p.fn) };
  });
  const sum = [...per.values()].reduce((a, p) => ({ tp: a.tp + p.tp, fp: a.fp + p.fp, fn: a.fn + p.fn }), { tp: 0, fp: 0, fn: 0 });
  return { rows, scores, precision: ratio(sum.tp, sum.tp + sum.fp), recall: ratio(sum.tp, sum.tp + sum.fn) };
}

// ── 질문 생성: 앱과 같은 입력(규칙 필요역량 + 자소서 대조)으로 만든다 ─────────

export function caseInput(ds: Dataset, c: Case) {
  const posting = ds.postings.find((p) => p.id === c.posting);
  if (!posting) throw new Error(`${c.id}: 채용공고 ${c.posting}이(가) 없어요`);
  const coverage = checkResume(requiredFromRules(posting.text), c.resume);
  return { posting, coverage, fallback: ruleQuestions(c.resume, coverage) };
}

export interface QuestionRun {
  caseId: string;
  model: string; // "규칙" 또는 모델 이름
  run: number;
  ms: number; // 생성 시간 (규칙은 0)
  jsonOk: boolean; // AI 답을 JSON으로 읽을 수 있었나
  aiCount: number; // 규칙 검사를 통과한 AI 질문 수 (0~3)
  evidenceGiven: number; // AI가 근거 문장을 낸 수
  evidenceExact: number; // 그중 자소서에 글자 그대로 있는 수
  questions: Question[];
  raw: string;
}

const norm = (s: string) => (s ?? "").replace(/\s+/g, " ").trim();

export function scoreAiAnswer(raw: string, resume: string, fallback: Question[]) {
  let items: Record<string, string>[] = [];
  let jsonOk = false;
  try {
    const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    const data = JSON.parse(cleaned.slice(cleaned.indexOf("{"), cleaned.lastIndexOf("}") + 1));
    if (Array.isArray(data?.questions)) {
      items = data.questions;
      jsonOk = true;
    }
  } catch {
    /* jsonOk = false */
  }
  const body = norm(resume);
  const given = items.slice(0, 3).map((it) => norm(it?.evidence)).filter(Boolean);
  const { questions, aiCount } = parseAiQuestions(raw, resume, fallback);
  return { jsonOk, aiCount, evidenceGiven: given.length, evidenceExact: given.filter((e) => body.includes(e)).length, questions };
}

export function summarize(runs: QuestionRun[], deadlineMs: number) {
  const by = new Map<string, QuestionRun[]>();
  runs.forEach((r) => by.set(r.model, [...(by.get(r.model) ?? []), r]));
  return [...by.entries()].map(([model, rs]) => {
    const ms = rs.map((r) => r.ms).sort((a, b) => a - b);
    const given = rs.reduce((a, r) => a + r.evidenceGiven, 0);
    return {
      model,
      runs: rs.length,
      jsonRate: rs.filter((r) => r.jsonOk).length / rs.length,
      aiRate: rs.reduce((a, r) => a + r.aiCount, 0) / (rs.length * 3), // 질문 3개 중 AI 질문으로 쓰인 비율
      evidenceRate: given ? rs.reduce((a, r) => a + r.evidenceExact, 0) / given : NaN,
      medianMs: ms[Math.floor(ms.length / 2)],
      maxMs: ms[ms.length - 1],
      inDeadline: rs.filter((r) => r.ms <= deadlineMs).length / rs.length,
    };
  });
}

// ── 사람 채점용 파일: 모델 이름을 숨기고 순서를 섞는다 (아는 모델에 점수를 후하게 주는 것 방지) ──

export const SCORE_COLS = ["구체성(1-5)", "자소서 연결(1-5)", "자연스러움(1-5)", "메모"];

export function csv(rows: (string | number)[][]) {
  const cell = (v: string | number) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return "﻿" + rows.map((r) => r.map(cell).join(",")).join("\r\n"); // BOM: 엑셀에서 한글이 안 깨지게
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cur = "", q = false;
  const t = text.replace(/^﻿/, "");
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) {
      if (ch === '"' && t[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cur); cur = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && t[i + 1] === "\n") i++;
      row.push(cur); rows.push(row); row = []; cur = "";
    } else cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}

/** 채점지(모델 숨김)와 정답 키(코드→모델)를 만든다. seed가 같으면 같은 순서. */
export function blindSheets(runs: QuestionRun[], ds: Dataset, seed = 1) {
  const items = runs.flatMap((r) => r.questions.map((q, i) => ({ r, q, i })));
  let s = seed;
  const rand = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  const sheet: (string | number)[][] = [["코드", "자소서", "채용공고", "질문 종류", "질문", ...SCORE_COLS]];
  const key: (string | number)[][] = [["코드", "모델", "회차", "AI/규칙", "근거 문장"]];
  items.forEach(({ r, q }, n) => {
    const code = `Q${String(n + 1).padStart(3, "0")}`;
    const c = ds.cases.find((x) => x.id === r.caseId)!;
    const p = ds.postings.find((x) => x.id === c.posting)!;
    sheet.push([code, c.id, p.title, q.type, q.question, "", "", "", ""]);
    key.push([code, r.model, r.run, q.source === "ai" ? "AI" : "규칙", q.evidence]);
  });
  return { sheet, key };
}

/** 채점한 파일 + 정답 키 → 모델별 평균 점수 */
export function scoreSheets(sheet: string[][], key: string[][]) {
  const modelOf = new Map(key.slice(1).map((r) => [r[0], r[1]]));
  const head = sheet[0];
  const cols = SCORE_COLS.slice(0, 3).map((c) => head.indexOf(c));
  if (cols.some((i) => i < 0)) throw new Error("채점 파일에 점수 열이 없어요. 내려받은 파일의 첫 줄(열 이름)을 지우지 마세요.");
  const acc = new Map<string, { n: number[]; sum: number[] }>();
  let unknown = 0;
  for (const r of sheet.slice(1)) {
    const model = modelOf.get(r[0]);
    if (!model) { unknown++; continue; }
    const a = acc.get(model) ?? { n: [0, 0, 0], sum: [0, 0, 0] };
    cols.forEach((ci, k) => {
      const v = Number(r[ci]);
      if (v >= 1 && v <= 5) { a.n[k]++; a.sum[k] += v; }
    });
    acc.set(model, a);
  }
  const result = [...acc.entries()].map(([model, a]) => ({
    model,
    scored: Math.min(...a.n),
    means: a.sum.map((s, k) => (a.n[k] ? s / a.n[k] : NaN)),
  }));
  return { result, unknown };
}
