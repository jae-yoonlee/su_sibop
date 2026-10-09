// 채용공고·자소서에서 역량 근거 단어 찾기 (규칙). 뼈대는 NCS 직업기초능력 10개 영역.
// 단어는 '어간'으로 적어 활용형(협업/협업한/협업하며)을 함께 잡는다. AI 없이도 항상 동작하는 1차 판정.

export interface Competency {
  id: string;
  name: string; // 화면에 보일 이름
  words: string[];
}

export const COMPETENCIES: Competency[] = [
  { id: "communication", name: "의사소통", words: ["의사소통", "커뮤니케이션", "소통", "설득", "발표", "보고서", "문서 작성", "문서작성", "경청", "전달력", "프레젠테이션", "협의", "조율"] },
  { id: "math", name: "수리·데이터", words: ["수리", "데이터 분석", "데이터분석", "통계", "지표", "수치", "엑셀", "정량", "SQL", "분석력", "%", "퍼센트", "배 증가", "건수"] },
  { id: "problem", name: "문제해결", words: ["문제해결", "문제 해결", "개선", "해결", "원인 분석", "원인분석", "논리적", "분석적", "창의", "아이디어", "기획력", "트러블슈팅", "줄였", "높였", "단축", "개선했"] },
  { id: "self", name: "자기개발", words: ["자기개발", "자기계발", "성장", "학습", "배우", "도전", "열정", "주도적", "자기주도", "능동적", "적극적"] },
  { id: "resource", name: "자원관리", words: ["일정 관리", "일정관리", "시간 관리", "시간관리", "예산", "우선순위", "효율", "비용", "자원"] },
  { id: "interpersonal", name: "대인관계·협업", words: ["협업", "협력", "팀워크", "팀플레이", "대인관계", "사이좋", "원만", "배려", "갈등", "화합", "동료", "함께", "리더십", "리더", "공감"] },
  { id: "information", name: "정보 활용", words: ["정보 수집", "정보수집", "리서치", "조사", "트렌드", "정보 활용", "자료 조사"] },
  { id: "technology", name: "기술·전문성", words: ["개발", "프로그래밍", "코딩", "Python", "파이썬", "Java", "자바", "AI", "인공지능", "머신러닝", "클라우드", "설계", "시스템", "기술", "전문성", "자격증"] },
  { id: "organization", name: "조직이해", words: ["조직", "회사 이해", "비즈니스", "고객", "서비스 이해", "산업", "시장", "직무 이해", "업무 프로세스"] },
  { id: "ethics", name: "직업윤리·책임감", words: ["책임감", "책임", "성실", "윤리", "정직", "신뢰", "약속", "꼼꼼", "주인의식", "근면", "규정 준수", "준법", "맡았", "담당", "끝까지"] },
];

export interface Hit {
  id: string;
  name: string;
  words: string[]; // 찾은 근거 단어
  sentences: string[]; // 그 단어가 들어 있는 문장 (최대 2개)
}

export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?。])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 1);
}

export function findCompetencies(text: string): Hit[] {
  const sents = sentences(text);
  const lower = text.toLowerCase();
  const hits: Hit[] = [];
  for (const c of COMPETENCIES) {
    const words = c.words.filter((w) => lower.includes(w.toLowerCase()));
    if (!words.length) continue;
    const ev = sents.filter((s) => words.some((w) => s.toLowerCase().includes(w.toLowerCase()))).slice(0, 2);
    hits.push({ id: c.id, name: c.name, words, sentences: ev });
  }
  // 근거 단어가 많은 역량부터
  return hits.sort((a, b) => b.words.length - a.words.length);
}

export interface Required {
  name: string; // 필요역량 이름
  reason: string; // 공고의 근거 문장
  words: string[]; // 자소서에서 찾을 단어
}

export interface Coverage extends Required {
  found: string[]; // 자소서에서 찾은 단어
  evidence: string; // 자소서 근거 문장
}

/** 필요역량마다 자소서에 관련 단어가 있는지 */
export function checkResume(required: Required[], resume: string): Coverage[] {
  const sents = sentences(resume);
  const lower = resume.toLowerCase();
  return required.map((r) => {
    const found = r.words.filter((w) => w && lower.includes(w.toLowerCase()));
    const evidence = sents.find((s) => found.some((w) => s.toLowerCase().includes(w.toLowerCase()))) ?? "";
    return { ...r, found, evidence };
  });
}

/** AI 없이 규칙만으로 필요역량 목록 만들기 (Gemini 키가 없거나 실패했을 때) */
export function requiredFromRules(posting: string, max = 5): Required[] {
  return findCompetencies(posting)
    .slice(0, max)
    .map((h) => ({
      name: h.name,
      reason: h.sentences[0] ?? h.words.join(", "),
      words: COMPETENCIES.find((c) => c.id === h.id)!.words,
    }));
}
