// 자료 분석: 규칙 → (Gemini) 필요역량 → 자소서 대조 → 브라우저 안 AI 질문 3개. 카메라 세팅과 동시에 돈다.
import { checkResume, findCompetencies, requiredFromRules, type Coverage, type Hit } from "./competency";
import { summarizeRequired } from "./gemini";
import { aiQuestions, preloadLlm } from "./llm";
import { addSemantic } from "./semantic";
import { preloadEmbedder } from "../report/embed";
import { parseAiQuestions, ruleQuestions, type Question } from "./questions";

// 목표 시간 (검증 페이지 기준). 자소서 질문은 로컬 AI가 꼭 쓰도록(2026-10-12 결정) 시간이 지나도 규칙으로 넘기지 않고 기다린다.
// 규칙 질문은 AI를 아예 못 쓸 때(그래픽 가속 없음·오류)만, 화면에 그렇게 표시하고 쓴다.
export const AI_DEADLINE_SEC = 60;
// 뜻 비교 모델(처음 한 번 약 150MB)을 기다리는 최대 시간. 넘으면 단어·문맥 규칙 결과로 질문을 만든다 (다음 번엔 캐시돼서 빠름)
export const SEMANTIC_WAIT_MS = 6000;

export interface PrepInput {
  posting: string;
  resume: string;
  geminiKey: string;
}

export type StepState = "wait" | "run" | "done" | "skip" | "fail";
export interface PrepState {
  steps: { rules: StepState; gemini: StepState; resume: StepState; questions: StepState };
  note: Partial<Record<"gemini" | "questions" | "resume", string>>;
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

  void preloadEmbedder();
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
    // 3) 자소서 대조 (이 PC 안): 단어 → 문맥 규칙 → 뜻 비교
    s.coverage = checkResume(required, input.resume);
    s.steps.resume = "run";
    emit();
    const sem = await Promise.race([addSemantic(s.coverage, input.resume), new Promise<null>((r) => setTimeout(() => r(null), SEMANTIC_WAIT_MS))]);
    if (!sem) s.note.resume = "뜻 비교 모델을 받는 중이라 단어·문맥 규칙으로만 대조했어요";
    else if (sem.mode === "fallback") s.note.resume = "뜻 비교 모델을 못 받아 단어·문맥 규칙으로만 대조했어요";
    else {
      s.coverage = sem.coverage;
      if (sem.added) s.note.resume = `뜻 비교로 근거 ${sem.added}개 더 찾음`;
    }
    s.timings.resume = sec();
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
      const fallback = ruleQuestions(input.resume, s.coverage);
      let { questions, aiCount } = parseAiQuestions(await aiQuestions(input.resume, s.coverage), input.resume, fallback);
      if (aiCount < 3) {
        // 검사에 떨어진 자리만 한 번 더 받아 채운다
        const again = parseAiQuestions(await aiQuestions(input.resume, s.coverage), input.resume, fallback);
        questions = questions.map((q, i) => (q.source === "ai" ? q : again.questions[i]));
        aiCount = questions.filter((q) => q.source === "ai").length;
      }
      s.questions = questions;
      if (aiCount < 3) s.note.questions = `AI 질문 ${aiCount}개 + 규칙 질문 ${3 - aiCount}개 (AI 답이 검사에 두 번 떨어진 자리)`;
      finish(aiCount ? "ai" : "rules");
    } catch (e) {
      s.note.questions = (e as Error).message;
      finish("rules");
    }
  })();
  return s;
}
