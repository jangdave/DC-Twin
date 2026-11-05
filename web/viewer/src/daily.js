// 하루 사용량(더미 데이터). 실제 측정값이 아니라 화면에 하루 흐름을 보이기 위한 가짜 부하 곡선이다(시각화 목적).
// 이전의 "누적 전력량"은 녹화나 시뮬레이션이 재생되는 동안만 늘어서, 전력량 창을 띄워 놓았을 때만 증가했다.
// 이 값은 재생과 상관없이 컴퓨터 시계(현지 시각)만으로 정해지므로 창을 닫아 둬도 하루 동안 이어서 늘어난다.
import { mulberry32 } from './citytex.js';

export const DAY_BASE_KW = 520; // 설비 전력의 기준(정상 시나리오의 설비 전력 약 498 kW보다 조금 높은 값에서 출발)

// 시간별 설비 전력(kW) 24개. 새벽에 낮고 오후 2시 무렵에 가장 높은 완만한 곡선에 고정 시드 잡음을 더했다.
export function dailyProfile(seed = 7, base = DAY_BASE_KW) {
  const rng = mulberry32(seed);
  return Array.from({ length: 24 }, (_, h) => {
    const wave = 0.93 + 0.06 * Math.cos(((h - 14) / 24) * Math.PI * 2);
    return Math.round(base * (wave + (rng() - 0.5) * 0.03) * 10) / 10;
  });
}

// 0시부터 hourFloat(0~24)시까지 쓴 전력량(kWh). 한 시간 안에서는 그 시간의 전력으로 일정하다고 본다.
export function usedKwh(profile, hourFloat) {
  const t = Math.min(Math.max(hourFloat, 0), 24);
  const full = Math.floor(t);
  let sum = 0;
  for (let h = 0; h < full; h++) sum += profile[h];
  if (full < 24) sum += profile[full] * (t - full);
  return sum;
}

export const hourOf = (date = new Date()) => date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600;

const PROFILE = dailyProfile();

// 지금(시계) 기준 오늘 사용량: { kwh, hour, profile, total }. total은 하루 전체(예상 포함) 합계다.
export function todayUsage(date = new Date()) {
  const hour = hourOf(date);
  return { kwh: usedKwh(PROFILE, hour), hour, profile: PROFILE, total: usedKwh(PROFILE, 24) };
}
