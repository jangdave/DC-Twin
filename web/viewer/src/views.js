// 화면에서 고를 수 있는 "보는 값"(입구 온도, 배기 온도, 전력). 3D 장면과 화면 조각이 같이 쓰는 값이라 어느 쪽에도 두지 않는다.
// 보는 값. 범위는 화면 색 곡선 기준이다(입구 온도는 Unreal과 같은 18~35도).
export const VIEWS = {
  temp_in: { label: '입구 온도', metric: 'temp_in', cold: 18, hot: 35, unit: '°C', digits: 1 },
  temp_out: { label: '배기 온도', metric: 'temp_out', cold: 20, hot: 50, unit: '°C', digits: 1 },
  power: { label: '전력', metric: 'power', cold: 0, hot: 15, unit: 'kW', digits: 1 },
};
