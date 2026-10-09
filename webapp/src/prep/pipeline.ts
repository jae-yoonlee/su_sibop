// 자료 분석: 규칙 → (Gemini) 필요역량 → 자소서 대조 → 브라우저 안 AI 질문 3개. 카메라 세팅과 동시에 돈다.
import { checkResume, findCompetencies, requiredFromRules, type Coverage, type Hit } from "./competency";
import { summarizeRequired } from "./gemini";
import { aiQuestions, preloadLlm } from "./llm";
import { parseAiQuestions, ruleQuestions, type Question } from "./questions";

export const AI_DEADLINE_SEC = 60; // 분석 시작 후 이 시간 안에 AI 질문이 안 나오면 규칙 질문으로 시작

export interface PrepInput {
  posting: string;
  resume: string;
  geminiKey: string;
}

export type StepState = "wait" | "run" | "done" | "skip" | "fail";
export interface PrepState {
  steps: { rules: StepState; gemini: StepState; resume: StepState; questions: StepState };
  note: Partial<Record<"gemini" | "questions", string>>;
  hits: Hit[];
  coverage: Coverage[];
  questions: Question[]; // 항상 3개 (처음엔 규칙 질문, AI가 되면 교체)
  requiredBy: "gemini" | "rules";
  questionsBy: "ai" | "rules";
  done: boolean; // 질문 확정
  timings: Record<string, number>; // 초
}

export function runPrep(input: PrepInput, onChange: (s: PrepState) => void): PrepState {
  const t0 = performance.now();
  const sec = () => Math.round((performance.now() - t0) / 100) / 10;
  const s: PrepState = {
    steps: { rules: "run", gemini: input.geminiKey ? "wait" : "skip", resume: "wait", questions: "wait" },
    note: {},
    hits: [],
    coverage: [],
    questions: [],
    requiredBy: "rules",
    questionsBy: "rules",
    done: false,
    timings: {},
  };
  const emit = () => onChange({ ...s, steps: { ...s.steps } });

  // 1) 규칙: 즉시
  s.hits = findCompetencies(input.posting);
  let required = requiredFromRules(input.posting);
  s.steps.rules = "done";
  s.coverage = checkResume(required, input.resume);
  s.questions = ruleQuestions(input.resume, s.coverage);
  s.timings.rules = sec();
  emit();

  const finish = (by: "ai" | "rules") => {
    if (s.done) return;
    s.done = true;
    s.questionsBy = by;
    s.steps.questions = by === "ai" ? "done" : s.steps.questions === "run" ? "fail" : s.steps.questions;
    s.timings.questions = sec();
    emit();
  };
  setTimeout(() => {
    if (!s.done) {
      s.note.questions = `${AI_DEADLINE_SEC}초 안에 AI 질문이 안 나와 규칙 질문을 써요`;
      finish("rules");
    }
  }, AI_DEADLINE_SEC * 1000);

  (async () => {
    // 2) Gemini: 채용공고만 보냄
    if (input.geminiKey) {
      s.steps.gemini = "run";
      emit();
      try {
        const r = await summarizeRequired(input.geminiKey, input.posting, s.hits);
        if (r.length) {
          required = r;
          s.requiredBy = "gemini";
        }
        s.steps.gemini = "done";
      } catch (e) {
        s.steps.gemini = "fail";
        s.note.gemini = `${(e as Error).name === "AbortError" ? "응답이 늦어요" : (e as Error).message} → 규칙으로 정리했어요`;
      }
      s.timings.gemini = sec();
    }
    // 3) 자소서 대조 (이 PC 안)
    s.coverage = checkResume(required, input.resume);
    s.steps.resume = "done";
    if (!s.done) s.questions = ruleQuestions(input.resume, s.coverage);
    emit();

    // 4) 브라우저 안 AI 질문
    s.steps.questions = "run";
    emit();
    try {
      const engine = await preloadLlm();
      if (!engine) throw new Error("이 PC에서는 AI를 쓸 수 없어 규칙 질문을 써요");
      s.timings.model = sec();
      const text = await aiQuestions(input.resume, s.coverage);
      if (s.done) return; // 이미 마감
      const { questions, aiCount } = parseAiQuestions(text, input.resume, ruleQuestions(input.resume, s.coverage));
      s.questions = questions;
      if (aiCount < 3) s.note.questions = `AI 질문 ${aiCount}개 + 규칙 질문 ${3 - aiCount}개`;
      finish(aiCount ? "ai" : "rules");
    } catch (e) {
      s.note.questions = (e as Error).message;
      finish("rules");
    }
  })();
  return s;
}
