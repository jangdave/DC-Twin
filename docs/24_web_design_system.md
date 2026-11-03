# 24. 웹 화면의 디자인 시스템 적용

- 상태: 채택 (2026-11-03)
- 목적: Figma의 "[Platform] DT Design System"(파일 `5lYYupVkD5zF85Y1bOa1oT`)의 토큰과 컴포넌트를 웹 보기 화면(`web/viewer`)에 적용한 방법과 벗어난 점을 남긴다.
- 읽은 범위: Figma 파일의 `Ver 0.3` 페이지(Foundation: Typography, Color, Cursor, Icon, 규칙 문서, 컴포넌트 23종)의 구조 전체와 변수(토큰) 전체. 컴포넌트는 Button, Tab, Tag, Select, Selection Controls, Badge, Progress, Alert, Chip, Table의 화면을 보고 Button, Tag, Select는 값을 코드로 읽었다. `GUI Guide` 페이지는 비어 있었고 `Legacy` 페이지는 읽지 않았다.
- 관련: [18 웹 보기](18_web_viewer_spec.md), [22 외관과 공기 흐름](22_web_exterior_airflow_spec.md), [23 도심과 화질](23_web_city_and_quality.md)

## 1. 적용한 토큰 (`web/viewer/src/tokens.css`)

| 종류 | 디자인 시스템 값 | 변수 |
|---|---|---|
| 글꼴 | Pretendard Variable (`font/family/basic`) | `--font-basic` |
| 글자 크기 | 10/12, 12/16, 14/20, 16/24, 18/28, 20/28 (크기/줄 높이) | `--text-xxs` ... `--text-xl` |
| 브랜드 색 | main_deepblue 100~5 (기본 70M `#0d47a1`, 호버 60 `#2162c3`, 눌림 50 `#3c79d7`) | `--brand-*` |
| 회색 | brand-gray 100~5 (글자 `#131416`, 선 `#aeb9c2`, 배경 `#f2f3f5`) | `--gray-*` |
| 상태 색 | danger, analyzing, warning, caution, normal, scheduled, disabled, blocked, emergency (strong과 subtle) | `--danger` ... `--emergency-subtle` |
| 글자 색 | primary, secondary, tertiary, disabled, placeholder, inverse, brand, action, error, success | `--text-*` |
| 모서리 | medium 6, large 8, max 100 | `--radius-*` |
| 간격 | 4, 6, 8, 10, 12, 16 | `--p-*` |
| 그림자 | md: 0 4 6 -1, 색 `rgba(5,27,60,0.2)` | `--shadow-md` |

## 2. 적용한 컴포넌트 (`web/viewer/src/style.css`)

| 디자인 시스템 | 우리 화면 |
|---|---|
| Button tertiary md (높이 28, 모서리 6, 선 1px, 호버 `#ebedf0`, 눌림 `#ced5db`, 비활성 반투명) | 모든 보통 단추 |
| Button primary lg (높이 36, 모서리 8, 브랜드 색, 호버, 눌림) | "홀 들어가기", 서버 "연결" |
| Tab-Border (알약 모양, 선택하면 브랜드 색 채움) | 보기 방식(녹화 재생, 직접 시뮬레이션, 로컬 서버), 재생 속도, 켜진 단추(`aria-pressed`) |
| Tag L (높이 20, 알약, 연한 배경) | 신뢰 등급(ok, caution, low, 보정 없음), 알람 상태, 보기 상태 표시 |
| Select (높이 28, 모서리 6, 선 `#aeb9c2`, 화살표) | 시나리오, 화질 선택 |
| Selection Controls | 보기 값 라디오, 반복 체크 (파란 `#256ef4`) |
| Slider (파란 손잡이) | 시간 막대와 시뮬레이션 슬라이더 |
| Popover, Select menu (흰 면, 모서리 8, 그림자 md, 배경 흐림 5px) | 도움말과 서버 연결 대화 상자, 3D 화면 위의 카드(보기 값, 외관 카드) |
| Alert (연한 면, 상태 색 막대) | 서버 연결 오류 |
| Empty State (회색 면의 안내 문구) | 선택한 장비, 알람, 조작 기록이 비었을 때 |
| Cursor (기본, 포인터, 잡기) | 3D 화면은 잡기(누르면 잡는 중), 건물 위는 포인터 |
| Input | 서버 주소 입력 (높이 36, 모서리 8) |

글꼴은 Pretendard Variable의 동적 부분 집합(92조각, OFL 1.1)이다. 화면에 나온 글자의 조각만 받으므로 한 화면에서 몇 개만 받는다(`src/fonts.css`, `public/fonts/subset/`, 라이선스 `public/fonts/LICENSE-Pretendard.txt`). 용량 검사에서는 조각 하나를 200 KB 이하로 제한하고 합계에서는 뺀다.

## 3. 디자인 시스템과 다르게 한 곳과 이유

| 곳 | 한 일 | 이유 |
|---|---|---|
| 태그 글자 색 | status 색 대신 더 어두운 값(`--tag-*-text`)을 쓴다 | 연한 배경 위 12px 글자의 명암비가 4.5:1에 못 미친다(주의 노랑 약 3.6:1, 위험 약 3.1:1, 정상 초록 약 3.3:1). 접근성 우선 |
| 3D 장면의 색 | 온도 색 곡선, 알람 테두리, 신뢰 막대 색은 그대로 둔다 | Unreal의 `DCTTempGradient`, `DCTConfidence`와 같은 규칙이라 두 화면이 같아야 한다([18 5.3장](18_web_viewer_spec.md)) |
| 3D 화면 바탕 | 어두운 색을 유지한다 | 공기 흐름 선(가산 혼합)과 온도 색이 어두운 배경에서만 잘 보인다. 주변 카드와 패널은 밝은 디자인 시스템 모양이다 |
| 제목 글꼴 | Spoqa Han Sans Neo(디자인 시스템의 title, subtitle)는 쓰지 않는다 | 이 화면에 큰 제목이 없다. Pretendard로 통일해 글꼴 용량을 줄였다 |
| 아이콘 | 아이콘 세트는 가져오지 않았다 | 화면이 글자 단추 중심이다. 필요해지면 따로 한다 |
| 회사 로고와 이름 | 가져오지 않았다 | Alert 예시 화면에 업무용으로 보이는 로고와 이름이 있다. [회사 자산 분리 규칙](04_clean_room_policy.md) 때문에 그 화면은 참고하지 않았고 글자와 구성만 새로 만들었다 |

## 4. 아직 적용하지 않은 컴포넌트

Date Picker, Table, Pagination, Tree UI, Stepper, List(알람 목록은 직접 만든 목록), Dropdown Menu, Filter, Textarea, Chip, Loading, Graph, Badge(숫자). 우리 화면에 쓰는 곳이 없어서 하지 않았다. 추이 그래프는 캔버스로 직접 그리며 색만 디자인 시스템 값(브랜드, 회색, caution, emergency)으로 바꿨다.

## 5. 확인

- 단위 시험 129개, 화면 확인 63개(좁은 화면 390px 포함) 통과.
- 확인하지 못한 것: Figma 화면과 픽셀 단위 비교(화면 캡처로 눈으로만 비교했다), 키보드와 화면 읽기 프로그램 전체 점검, 실제 모바일 기기.

## 6. 유지하는 법

- 토큰이 바뀌면 `tokens.css`만 고친다. `style.css`에 색이나 크기 숫자를 직접 쓰지 않는다(3D 장면 색 제외).
- 글꼴 조각은 `https://cdn.jsdelivr.net/npm/pretendard@1.3.9/dist/web/variable/woff2-dynamic-subset/`에서 받고 `pretendardvariable-dynamic-subset.css`의 글자 범위를 `src/fonts.css`에 옮겼다.
