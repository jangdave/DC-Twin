// 검사를 통과한 메시지를 저장소에 반영한다. 라이브 연결(live.js)과 브라우저 시뮬레이션(sim/runner.js)이 같이 쓴다.
export function applyMessage(store, m) {
  switch (m.kind) {
    case 'snapshot':
      store.applySnapshot(m);
      break;
    case 'sample':
      store.setSample(m);
      break;
    case 'alarm': {
      store.setAlarm(m.sensorId, m.to);
      const entry = { ts: m.ts, sensorId: m.sensorId, from: m.from, to: m.to, value: m.value };
      if (m.t !== undefined) entry.t = m.t; // 시뮬레이션은 경과 초를 같이 준다
      store.alarmLog.push(entry);
      if (store.alarmLog.length > 200) store.alarmLog.shift();
      break;
    }
    case 'aggregate':
      store.aggregates[m.name] = m.value;
      store.version++;
      break;
    case 'scenario':
      // 게이트웨이는 새 시나리오 시작에서 상태를 초기화하고 snapshot을 다시 보내지 않는다. 화면도 같이 비운다.
      if (m.event === 'start') store.clear();
      store.scenario = m.event === 'end' ? null : m.name;
      store.version++;
      break;
  }
}
