---
name: clean-room-check
description: 커밋·공개 전에 재직 회사 프로젝트의 자산/명칭, 외부 CFD 도구(상용 포함)의 결과, 서버 토큰 같은 비밀 값이 저장소에 섞였는지 점검한다. "클린룸 점검", "커밋 전 확인", "공개 전 검사" 요청에 사용.
---

# 클린룸 점검

정책 원문: `docs/04_clean_room_policy.md`

## 절차
1. 금지어 검색: 로컬 파일 `.claude/cleanroom-terms.local.txt`(한 줄에 한 단어, gitignore됨)를 읽어 `Grep -i "<단어1>|<단어2>|..."`로 저장소 전체를 검색한다(`unreal/Intermediate`·`Saved`, 해당 목록 파일 자체는 제외). 목록 파일이 없으면 사용자에게 만들어 달라고 요청한다.
2. 파일명/폴더명에 같은 단어가 있는지 `Glob`으로 확인.
3. 바이너리 에셋(`.uasset`, `.usd`, 이미지)은 출처가 `docs/ASSET_LICENSES.md`에 있는지 대조. 출처 없는 에셋은 보고.
4. 새 C++ 클래스가 회사 프로젝트 클래스명과 겹치는지 확인(`D:\UnrealProject\*\Source`는 읽기 전용 비교만).
5. **외부 CFD 도구(Reality DC 등 상용 포함)의 결과가 섞였는지** 확인한다. 추적 파일에 `*.vtk`, `*.vtu`, `*.vti`, `*.room`, 폴더 `external_pack`, `external_demo`가 없어야 한다(`git ls-files | grep -iE '\.(vtk|vtu|vti|room)$|external_pack|external_demo'`). 공개 목록(`web/viewer/public/data/index.json`, `library.json`, `rec/*.json`)에 `source: external`, `group: external`, `ext_` id가 없어야 한다. `npx vitest run test/external_guard.test.js`(`web/viewer`)가 이 두 가지를 검사한다.
6. **비밀 값이 섞였는지** 확인한다: `git diff --cached | grep -iE "DCT_TOKEN=|token['\"]?\s*[:=]\s*['\"][A-Za-z0-9_-]{16,}"`가 0건이어야 하고, `.env` 파일이 추적되지 않아야 한다(`git ls-files | grep -E '(^|/)\.env'`).
7. 결과를 "발견 N건 / 없음"으로 보고하고, 발견 시 파일·줄을 나열한다. 임의로 삭제하지 않는다.

## 주의
- Reality DC 사용은 라이선스 확인 전까지 보류다(2026-11-04). 그 결과나 화면, 모델 파일이 보이면 즉시 보고한다.
- 회사 프로젝트 파일 내용을 인용·복사해서 보고하지 않는다. 일치 여부와 위치만 말한다.
