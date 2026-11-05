// 화질 단계 (docs/23). 저사양 노트북과 모바일에서도 돌도록 단계마다 그림자, 해상도, 입자 수, 도시 규모를 줄인다.
export const TIERS = ['low', 'mid', 'high'];

// maxPixels: 한 장면을 그리는 화소 수 상한. 일반(보통) 기준은 FHD(1920 x 1080)이다. 화면이 더 크면(QHD, 4K) 그리는 해상도를 낮춰 상한에 맞춘다.
// texScale: 도시 질감 그림 배율(외벽 256 -> 512 -> 1024 px, 바닥 포장과 풀, 법선 지도는 보통부터), aniso: 비스듬히 볼 때 선명도(비등방성 필터링 상한).
// detail: 건물 모델 질감 위에 겹치는 미세 디테일의 세기(0이면 끔). 가까이서만 보이고 멀어지면 사라진다.
// bloom: 빛 번짐 세기(0이면 끔, 표시등, 알람, 저녁 창이 번진다), ao: 접촉 그림자(SSAO). 후처리는 화면을 한 번 더 그리므로 낮은 단계는 끈다.
export const FHD = 1920 * 1080;
export const SETTINGS = {
  low: { pixelRatio: 1, maxPixels: 1280 * 720, shadow: 0, particles: 2500, cityRings: 2, cars: 0, trees: 200, reflection: false, hallModels: true, bloom: 0, ao: false, texScale: 1, aniso: 2, detail: 0 },
  mid: { pixelRatio: 1.5, maxPixels: FHD, shadow: 2048, particles: 5000, cityRings: 3, cars: 60, trees: 600, reflection: false, hallModels: true, bloom: 0.3, ao: false, texScale: 2, aniso: 8, detail: 0.6 },
  high: { pixelRatio: 2, maxPixels: 2560 * 1440, shadow: 4096, particles: 7000, cityRings: 3, cars: 120, trees: 1200, reflection: true, hallModels: true, bloom: 0.4, ao: true, texScale: 4, aniso: 16, detail: 1 },
};

// 화면(CSS 크기 w x h)에서 실제로 그릴 배율: 기기 배율, 단계의 배율 상한, 화소 수 상한 중 가장 작은 값(0.5 아래로는 내리지 않는다).
export function pixelRatioFor(setting, w, h, dpr = 1) {
  const area = Math.max(w * h, 1);
  return Math.max(Math.min(dpr, setting.pixelRatio, Math.sqrt(setting.maxPixels / area)), 0.5);
}

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
