// 화질 단계 (docs/23). 저사양 노트북과 모바일에서도 돌도록 단계마다 그림자, 해상도, 입자 수, 도시 규모를 줄인다.
export const TIERS = ['low', 'mid', 'high'];

export const SETTINGS = {
  low: { pixelRatio: 1, shadow: 0, particles: 2500, cityRings: 2, cars: 0, trees: 200, reflection: false, hallModels: false },
  mid: { pixelRatio: 1.5, shadow: 2048, particles: 5000, cityRings: 3, cars: 60, trees: 600, reflection: false, hallModels: true },
  high: { pixelRatio: 2, shadow: 4096, particles: 7000, cityRings: 3, cars: 120, trees: 1200, reflection: true, hallModels: true },
};

// 환경 정보(env)로 단계를 고른다. 주소에 q가 있으면 그것을 쓴다.
//   env: { width, coarsePointer, deviceMemory, cores, automated }  (모르는 값은 undefined)
export function detectQuality(requested, env = {}) {
  if (TIERS.includes(requested)) return requested;
  const { width = 1280, coarsePointer = false, deviceMemory, cores, automated = false } = env;
  if (automated) return 'mid'; // 자동 시험 브라우저(소프트웨어 렌더링)는 보통으로 고정해 결과를 일정하게 한다
  if (coarsePointer || width < 700) return 'low';
  if ((deviceMemory != null && deviceMemory <= 4) || (cores != null && cores <= 4)) return 'low';
  if ((deviceMemory == null || deviceMemory >= 8) && (cores == null || cores >= 8)) return 'high';
  return 'mid';
}

export function lowerTier(t) {
  const i = TIERS.indexOf(t);
  return i > 0 ? TIERS[i - 1] : null;
}

export function browserEnv() {
  return {
    width: window.innerWidth,
    coarsePointer: window.matchMedia?.('(pointer: coarse)').matches ?? false,
    deviceMemory: navigator.deviceMemory,
    cores: navigator.hardwareConcurrency,
    automated: !!navigator.webdriver,
  };
}
