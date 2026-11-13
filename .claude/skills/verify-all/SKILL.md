---
name: verify-all
description: PR 전에 이 프로젝트의 시험과 점검을 순서대로 돌린다(웹 단위, 빌드, 화면, 글자 대비, 데이터 정합성, 파이썬, Warp, 서버). "전체 검증", "PR 전 확인", "시험 다 돌려줘" 요청에 사용.
---

# 전체 검증

변경한 곳에 해당하는 것만 돌려도 된다. 하나라도 실패하면 **시험을 약하게 바꾸지 말고** 원인을 찾는다(코드가 틀렸는지, 시험이 틀렸는지 구분해서 보고).

## 순서와 명령
| # | 대상 | 명령(폴더) | 시간 | 언제 |
|---|---|---|---|---|
| 1 | 웹 단위 | `npx vitest run` (`web/viewer`) | 몇 초 | 웹 코드, 데이터를 바꿨을 때 |
| 2 | 파이썬(센서, 서버, 외부 변환) | `uv run --python 3.13 --extra serve python -m pytest tests` (`sim/sensors`) | 1분 | `sim/sensors`, `server/`를 바꿨을 때 |
| 3 | Warp 열 계산 | `uv run --python 3.13 python -m pytest tests` (`experiments/omniverse_probe`, GPU) | 1분 | `hall60_sim.py`를 바꿨을 때, 장면(`hall01.config.json`)이나 형상 사본을 바꿨을 때(`test_check_geometry.py`, docs/30 M11) |
| 4 | 웹 빌드와 용량 | `npm run build` (`web/viewer`) | 1분 | 화면 시험 앞에 항상 |
| 5 | 데이터 정합성 | `node tools/check_data.mjs` | 몇 초 | 녹화, 라이브러리, 센서 정의를 바꿨을 때. 원본에서 다시 만들어 같은지도 본다 |
| 6 | 화면 시험 | `node tools/ui_check.mjs` | 2~3분 | 화면을 바꿨을 때. **도구의 120초 제한을 넘으니 백그라운드로 돌리고 끝나면 읽는다** |
| 7 | 글자 대비 | `node tools/contrast_check.mjs` | 1분 | 색, 화면 구성을 바꿨을 때 |
| 7b | 누름 점검 | `node tools/interact_check.mjs` | 몇 분 | 단추, 패널, 모바일 배치를 바꿨을 때. **백그라운드로 돌린다.** 종료 코드 1이면 가려지거나 눌러도 변화 없는 요소가 있다 |
| 7c | 기기별 화면 | `node tools/device_check.mjs [화면 폴더]` | 약 10분 | 배치(CSS), 머리글, 패널, 대화상자를 바꿨을 때. 갤럭시·아이폰·태블릿 10종 x 세로·가로 x 상태 9개에서 화면 밖, 겹침, 가로 스크롤, 글자 꺾임을 찾는다. **백그라운드로.** 종료 코드 1이면 문제 있음 |

화면 시험 결과는 `통과`와 `실패`로 시작하는 줄이다. `grep -c '^통과'`로 개수를 세고 `grep '^실패'`로 실패를 본다.

## 앞으로 붙일 점검 (`docs/31` 구현 중)
- Kit 서버(2a 이후): Kit 앱으로 서버를 띄워 실제 연결로 확인한다. 끝나면 `kit.exe` 프로세스를 반드시 끝낸다.
- OpenFOAM 단계(2c 이후): 한 번에 하나만 돌린다(동시에 돌리면 20배 넘게 느려짐). 약 10분 걸리므로 백그라운드로 돌리고, WSL의 `~/foam_runs/` 결과 폴더를 정리한다.

## 데이터를 다시 만들 때
- 웹 자료: `node tools/build_data.mjs`(원본: `sim/out`, 정의: `sim/library.json`). 만든 뒤 반드시 5번.
- 미리 계산한 모음 녹화: `experiments/omniverse_probe`에서 `uv run --python 3.13 python ../../scripts/make_sim_library.py`(GPU, scikit-learn).
- 파이썬↔웹 간이 계산 일치 기준 자료: `sim/sensors`에서 `uv run --python 3.13 python ../../web/viewer/tools/make_sim_fixture.py`(모델 식을 바꾸면 다시 만든다).

## 실제 연결로 확인할 때 (모의가 아닌 것)
서버를 직접 띄우고(`server/run_local.ps1 -Solver l0 -Port 187xx`) 브라우저(puppeteer)로 `?server=ws://127.0.0.1:187xx/ws`에 접속해 값, 조작, 데이터 출처를 본다. 모의 서버 시험이 통과해도 실제 연결에서 결함이 나온 적이 있다(Docker 경로 오류, 브라우저 사전 확인). 끝나면 서버 프로세스를 끝낸다(`Get-NetTCPConnection -LocalPort <포트> -State Listen`으로 찾아 `Stop-Process`).

## 정리와 보고
- 띄운 서버, 브라우저, Kit(`kit.exe`) 프로세스와 임시 파일(.vdb 등 대용량)을 정리한다.
- 보고는 개수와 함께 **실패, 건너뜀, 확인하지 못한 것**을 따로 쓴다(예: 실제 휴대폰, Firefox, Safari는 확인하지 못했다).
