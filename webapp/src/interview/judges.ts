// 면접관 3명 (2026-11-07 사용자 요청). 촬영한 영상이 없어서 코드로 그린 그림(SVG) 캐릭터를 쓴다. 실제 사람을 본뜨지 않음.
// 3D(WebGL)는 질문 만드는 AI(WebLLM)·얼굴 인식과 그래픽 칩을 나눠 써서 꼬리질문이 늦어질 수 있어, 그림 + CSS 움직임만 쓴다.
// 움직임: 숨쉬기, 눈 깜빡임(평소), 입 움직임 + 고개 끄덕임(질문을 읽는 동안). 생각하는 표정·미소는 넣지 않음 (사용자 결정).

export interface Judge {
  name: string;
  side: -1 | 0 | 1; // 화면에서 앉은 쪽 (왼쪽 −1, 가운데 0, 오른쪽 1). 시선 판정에 씀
  voice: { pitch: number; rate: number }; // 같은 목소리라도 높낮이·빠르기로 구분. 영상 인물에 맞춤: 1 젊은 남자, 2 여자, 3 안경 쓴 중년 남자
  look: { skin: string; hair: string; suit: string; shirt: string; tie?: string; glasses?: boolean; hairStyle: "short" | "bob" | "side" };
}

export const JUDGES: Judge[] = [
  { name: "면접관 1", side: -1, voice: { pitch: 0.85, rate: 1.05 }, look: { skin: "#efc6a4", hair: "#3a2f2a", suit: "#46516d", shirt: "#ffffff", tie: "#3457f0", hairStyle: "short" } },
  { name: "면접관 2", side: 0, voice: { pitch: 1.1, rate: 1.0 }, look: { skin: "#e8b893", hair: "#2b2321", suit: "#8c735f", shirt: "#f4efe6", glasses: true, hairStyle: "bob" } },
  { name: "면접관 3", side: 1, voice: { pitch: 0.75, rate: 0.95 }, look: { skin: "#f2cfb4", hair: "#5a4636", suit: "#2f5d50", shirt: "#ffffff", hairStyle: "side" } },
];

/** 질문마다 면접관을 무작위로 고른다. 같은 사람이 연달아 묻지 않게 바로 앞 사람은 뺀다 */
export function pickJudge(prev: number | undefined, rnd = Math.random): number {
  const pool = [0, 1, 2].filter((i) => i !== prev);
  return pool[Math.floor(rnd() * pool.length) % pool.length];
}

/** 받침에 맞는 조사 (면접관 1이, 면접관 2가, 면접관 3이) */
export const subj = (i: number) => `${JUDGES[i].name}${i === 1 ? "가" : "이"}`;

const HAIR_BACK: Record<Judge["look"]["hairStyle"], string> = {
  short: "",
  bob: `<path d="M54 100 C50 50 80 40 100 40 C122 40 152 50 146 100 L150 150 C138 160 124 156 122 150 L78 150 C74 156 60 160 50 150 Z"/>`,
  side: "",
};
const HAIR_FRONT: Record<Judge["look"]["hairStyle"], string> = {
  short: `<path d="M59 98 C55 60 78 46 100 46 C124 46 146 60 141 98 C136 80 122 70 100 70 C80 70 64 80 59 98 Z"/>`,
  bob: `<path d="M58 104 C56 62 78 48 100 48 C124 48 146 62 142 104 C134 86 126 74 108 70 C96 82 76 86 58 104 Z"/>`,
  side: `<path d="M59 100 C54 58 80 44 104 46 C130 48 146 66 141 100 C138 84 130 76 120 72 C104 80 80 78 59 100 Z"/>`,
};

function judgeSvg(j: Judge, i: number) {
  const l = j.look;
  return `<svg viewBox="0 0 200 240" role="img" aria-label="${j.name}">
    <g class="body" style="animation-delay:-${i * 1.3}s">
      <rect x="87" y="136" width="26" height="40" rx="10" fill="${l.skin}"/>
      <path d="M26 240 C28 192 60 168 100 168 C140 168 172 192 174 240 Z" fill="${l.suit}"/>
      <path d="M84 168 L100 202 L116 168 Z" fill="${l.shirt}"/>
      ${l.tie ? `<path d="M96 178 L104 178 L107 214 L100 222 L93 214 Z" fill="${l.tie}"/>` : ""}
      <path d="M84 168 L100 202 L92 206 L74 174 Z M116 168 L100 202 L108 206 L126 174 Z" fill="rgba(0,0,0,0.12)"/>
      <g class="head">
        <g fill="${l.hair}">${HAIR_BACK[l.hairStyle]}</g>
        <ellipse cx="60" cy="106" rx="7" ry="10" fill="${l.skin}"/><ellipse cx="140" cy="106" rx="7" ry="10" fill="${l.skin}"/>
        <ellipse cx="100" cy="100" rx="40" ry="47" fill="${l.skin}"/>
        <g fill="${l.hair}">${HAIR_FRONT[l.hairStyle]}</g>
        <path d="M76 92 Q84 88 92 91 M108 91 Q116 88 124 92" stroke="${l.hair}" stroke-width="3" stroke-linecap="round" fill="none"/>
        <g class="eyes" style="animation-delay:-${i * 1.7}s" fill="#2a2524"><ellipse cx="84" cy="104" rx="4" ry="5"/><ellipse cx="116" cy="104" rx="4" ry="5"/></g>
        ${l.glasses ? `<g stroke="#4a4442" stroke-width="2.2" fill="none"><circle cx="84" cy="104" r="12"/><circle cx="116" cy="104" r="12"/><path d="M96 104 L104 104"/></g>` : ""}
        <path d="M100 108 Q96 120 101 122" stroke="rgba(120,70,50,0.45)" stroke-width="2.2" fill="none" stroke-linecap="round"/>
        <circle cx="74" cy="122" r="7" fill="rgba(230,120,110,0.18)"/><circle cx="126" cy="122" r="7" fill="rgba(230,120,110,0.18)"/>
        <path class="mouth-closed" d="M90 133 Q100 137 110 133" stroke="#a5574a" stroke-width="3" fill="none" stroke-linecap="round"/>
        <ellipse class="mouth-open" cx="100" cy="134" rx="9" ry="6.5" fill="#7a3b34"/>
      </g>
    </g>
  </svg>`;
}

// 실사 영상 (2026-11-07 사용자 요청 "진짜 사람처럼"): public/judges/ 에 면접관마다 대기·말하기 반복 영상을 넣으면 그림 대신 영상을 쓴다.
// 파일 이름: j1-idle.mp4, j1-talk.mp4 … j3-talk.mp4. 없거나 못 읽으면 그 면접관은 그림으로 보여 준다.
// 질문은 매번 새로 만들어지므로 입 모양을 문장에 맞추지는 않고, 음성이 나오는 동안 '말하기' 영상을 돌린다.
const clipUrl = (i: number, kind: "idle" | "talk") => `${import.meta.env.BASE_URL}judges/j${i + 1}-${kind}.mp4`;

/** 면접실 전체 (벽, 면접관 3명, 책상, 이름표). 한 번만 만들고 클래스만 바꾼다 */
export function judgesHtml() {
  const clips = (i: number) =>
    `<video class="clip-idle" data-src="${clipUrl(i, "idle")}" muted loop playsinline preload="auto"></video><video class="clip-talk" data-src="${clipUrl(i, "talk")}" muted loop playsinline preload="auto"></video>`;
  return `<div class="room-wall"></div>
    <div class="judge-row">${JUDGES.map((j, i) => `<div class="judge" data-j="${i}">${judgeSvg(j, i)}${clips(i)}</div>`).join("")}</div>
    <div class="desk"><div class="plates">${JUDGES.map((j, i) => `<span class="plate" data-j="${i}"><b>${j.name}</b></span>`).join("")}</div></div>`;
}

/** 영상 파일을 불러 본다. 대기·말하기 둘 다 읽히면 그 면접관은 영상으로 (.real) */
export function loadJudgeClips(root: HTMLElement | null) {
  if (!root) return;
  root.querySelectorAll<HTMLElement>(".judge").forEach((el) => {
    const vids = [...el.querySelectorAll<HTMLVideoElement>("video")];
    let ok = 0;
    for (const v of vids) {
      v.addEventListener("loadeddata", () => ++ok === vids.length && (el.classList.add("real"), root.classList.add("real")), { once: true });
      v.addEventListener("error", () => el.classList.remove("real"), { once: true });
      v.src = v.dataset.src!;
    }
  });
}

/** active: 이번 질문을 맡은 면접관, talking: 지금 말하는 중, still: AI가 꼬리질문을 만드는 동안 움직임 멈춤 (그래픽 칩 양보) */
export function setJudges(root: HTMLElement | null, s: { active: number | null; talking: boolean; still: boolean }) {
  if (!root) return;
  root.classList.toggle("still", s.still);
  root.querySelectorAll<HTMLElement>("[data-j]").forEach((el) => {
    const on = Number(el.dataset.j) === s.active;
    el.classList.toggle("on", on);
    el.classList.toggle("talk", on && s.talking);
    if (!el.classList.contains("real")) return;
    // 영상: 말하는 동안만 말하기 영상, 꼬리질문을 만드는 동안은 둘 다 멈춤 (영상 풀기도 그래픽 칩을 씀)
    const talk = on && s.talking;
    el.querySelectorAll<HTMLVideoElement>("video").forEach((v) => {
      const want = !s.still && v.classList.contains("clip-talk") === talk;
      if (want && v.paused) void v.play().catch(() => {});
      else if (!want && !v.paused) v.pause();
    });
  });
}
