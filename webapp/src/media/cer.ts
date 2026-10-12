// 받아쓰기 정확도: 글자 오류율(CER). 띄어쓰기·문장부호는 빼고 글자만 비교한다.

const clean = (s: string) => s.replace(/[\s.,!?'"“”‘’·…]/g, "");

/** 정답 대비 틀린 글자 비율 (0 = 완벽, 1 이상도 가능) */
export function cer(ref: string, hyp: string): number {
  const a = [...clean(ref)], b = [...clean(hyp)];
  if (!a.length) return b.length ? 1 : 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length] / a.length;
}

/** 화면용 정확도 % (0~100) */
export const accuracy = (ref: string, hyp: string) => Math.max(0, Math.round((1 - cer(ref, hyp)) * 100));
