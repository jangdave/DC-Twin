// 값을 색과 막대 길이로 바꾼다 (docs/18 5.3장). Unreal의 Core/DCTTempGradient.h, DCTConfidence.h와 같은 규칙이다.
// 색은 Unreal의 선형 색(FLinearColor) 값을 그대로 쓴다. 화면에 올릴 때 three.js의 선형 색 공간으로 넣어 같은 모양이 되게 한다.

const STOPS = [
  [0.05, 0.25, 1.0], // 파랑
  [0.05, 0.85, 0.25], // 초록
  [1.0, 0.85, 0.05], // 노랑
  [1.0, 0.08, 0.05], // 빨강
];
export const COLOR_NONE = [0.25, 0.25, 0.25]; // 값 없음
export const COLOR_BAD = [0.8, 0.0, 0.8]; // 범위 밖 값(자홍)
export const COLOR_STALE = [0.35, 0.35, 0.35]; // 오래된 값

const lerp = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

// 값을 파랑(cold) - 초록 - 노랑 - 빨강(hot)으로 바꾼다. 범위 밖은 양 끝 색으로 자른다.
export function tempColor(value, cold, hot) {
  const span = Math.max(hot - cold, 1e-4);
  const t = Math.min(Math.max((value - cold) / span, 0), 1);
  const scaled = t * 3;
  const i = Math.min(Math.floor(scaled), 2);
  return lerp(STOPS[i], STOPS[i + 1], scaled - i);
}

// 센서 값 하나의 색. 값이 없으면 회색, 품질이 좋지 않으면 상태 색(FR-13).
export function sampleColor(sample, cold, hot) {
  if (!sample || sample.value === null || sample.value === undefined || !Number.isFinite(sample.value)) return COLOR_NONE;
  if (sample.quality === 'bad') return COLOR_BAD;
  if (sample.quality === 'stale') return COLOR_STALE;
  return tempColor(sample.value, cold, hot);
}

export const CONFIDENCE_COLOR = {
  ok: [0.1, 0.8, 0.3],
  caution: [1.0, 0.8, 0.0],
  low: [1.0, 0.15, 0.1],
  fallback: [0.55, 0.55, 0.55],
};
export const CONFIDENCE_LABEL = { ok: 'ok', caution: 'caution', low: 'low', fallback: '보정 없음' };
export const CONFIDENCE_HELP = {
  ok: '비슷한 조건을 학습해서 믿을 만하다',
  caution: '학습한 조건과 다소 다르다',
  low: '학습에 거의 없던 조건이다. 믿지 말 것',
  fallback: '보정하지 않은 값이다',
};
export const CONF_BY_CODE = [null, 'ok', 'caution', 'low', 'fallback']; // 녹화 파일의 등급 코드

export function confidenceColor(confidence) {
  return CONFIDENCE_COLOR[confidence] ?? [0, 0, 0];
}

// 막대 길이 비율(0~1). 구간 폭이 0이면 1, fullWidth(도) 이상이면 minFraction. 등급이 없으면 0(막대를 숨긴다).
export function barFraction(sample, fullWidth = 4.0, minFraction = 0.15) {
  if (!sample || !sample.confidence) return 0;
  if (!Number.isFinite(sample.lower) || !Number.isFinite(sample.upper)) return minFraction;
  const width = Math.max(sample.upper - sample.lower, 0);
  return Math.min(Math.max(1 - width / Math.max(fullWidth, 1e-8), minFraction), 1);
}

export const ALARM_COLOR = { normal: [0.2, 0.7, 0.3], warn: [1.0, 0.8, 0.0], critical: [1.0, 0.15, 0.1] };
export const ALARM_LABEL = { normal: '정상', warn: '주의', critical: '위험' };
export const ALARM_RANK = { normal: 0, warn: 1, critical: 2 };

export const toCss = ([r, g, b]) => {
  // 선형 → sRGB (화면 글자와 범례가 3D와 같은 색으로 보이게)
  const f = (c) => Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));
  return `rgb(${f(r)}, ${f(g)}, ${f(b)})`;
};
