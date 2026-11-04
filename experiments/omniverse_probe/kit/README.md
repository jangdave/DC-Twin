# Omniverse Kit 실증 스크립트

Omniverse Kit 110.4.0 안에서 실행하는 확인 스크립트와, 그 환경을 만든 방법이다. 결과는 [E0 결과 문서](../../results/E0_omniverse_capability_probe.md)의 2.6~2.8장.

## Kit 앱 만들기 (한 번만)
1. 약관 검토: NVIDIA Software License Agreement와 Omniverse 제품별 약관. **약관 동의는 사용자가 직접 한다.**
2. 템플릿 받기 (이 저장소와 다른 폴더에서):
   ```
   git clone --depth 1 https://github.com/NVIDIA-Omniverse/kit-app-template.git D:\omniverse-kit\kit-app-template
   ```
3. 앱 정의 만들기. 대화형 마법사(`repo.bat template new`)는 실제 콘솔이 필요하다. 마법사를 쓰지 않을 때는 템플릿의 `templates\apps\kit_base_editor\kit_base_editor.kit`을 `source\apps\dctwin.base_editor.kit`으로 복사하고 `{{ application_display_name }}`과 `{{ version }}`을 채운다.
4. 빌드: `cd D:\omniverse-kit\kit-app-template` 후 `.\repo.bat build` (Kit 커널과 도구를 내려받는다, 약 1분)

## 스크립트 실행
`_build\windows-x86_64\release` 폴더에서 `--exec`로 스크립트를 지정한다. 첫 실행은 확장을 내려받느라 4분 정도 걸리고, 이후는 12초 정도다.
```
kit\kit.exe apps\dctwin.base_editor.kit --/app/file/ignoreUnsavedOnExit=true --exec "<저장소>/experiments/omniverse_probe/kit/kit_probe.py"
```
- `ignoreUnsavedOnExit=true`가 없으면 종료할 때 저장 확인 창이 떠서 프로세스가 남는다.
- 실행하면 Kit 창이 실제로 화면에 나타난다.

| 스크립트 | 하는 일 | 결과 |
|---|---|---|
| `kit_probe.py` | 확장 확인, 우리 USD 열기, Kit 안의 Warp 실행, 뷰포트 캡처 | `out/kit/kit_probe_result.json`, `kit_viewport.png` |
| `kit_probe_flow.py` | Flow 확장 켜기, USD Flow 스키마 확인 | `out/kit/kit_flow_result.json` |
| `kit_explore_flow.py` | Flow 관련 명령과 API 이름 조사 | `out/kit/kit_explore_flow.json` |
| `kit_flow_sim.py` | Flow 열 플룸 시뮬레이션, OpenVDB 내보내기, FPS 측정 | `out/kit/kit_flow_sim_result.json` |

`kit_flow_sim.py`는 환경 변수로 조절한다: `DCT_EXPORT=0`(내보내기 끄기), `DCT_FRAMES`, `DCT_SNAPS`(화면 저장 프레임), `DCT_EYE`, `DCT_TARGET`(카메라).
**주의:** 내보내기를 켜면 몇 분에 수 GB의 `.vdb` 파일이 생긴다. 실행 후 `out/kit/flow_vdb`를 정리한다. (`*.vdb`는 Git에서 제외된다.)
| `kit_list_exts.py` | Kit 확장 레지스트리 전체 조회(685개 이름), 시뮬레이션 관련 키워드 검색 | `out/kit/kit_list_exts.json` |
| `kit_npy_to_vdb.py` | numpy 온도 프레임을 OpenVDB(`.vdb`)로 변환(`omni.volume`의 `openvdb` 모듈 사용) | `out/frames/vdb/*.vdb`, `out/kit/kit_npy_to_vdb_result.json` |
| `kit_vdb_roundtrip.py` | 변환한 `.vdb`를 다시 읽어 원본과 비교(float, half) | `out/kit/kit_vdb_roundtrip_result.json` |
| `kit_hall60.py` | Kit이 USD 장면을 열고, Kit의 Warp로 `hall60_sim.py`를 그대로 실행 | `out/kit/hall60_kit/` (센서 CSV, 요약, 온도 프레임) |
| `kit_sensors.py` | Kit 안에서 센서 값 생성기(`dct_sensors`, 기본 L1)를 실행해 녹화(.jsonl) 생성 | `out/kit/sensors_kit.jsonl` |
| `compare_kit_run.py` | 두 녹화(.jsonl)를 줄 단위로 비교(독립 실행과 Kit 실행이 같은지) | 표준 출력 |

**Kit에는 scipy가 없다**(numpy, PIL, Warp는 있음). 위 두 스크립트를 쓰려면 저장소 밖에 Kit 파이썬(3.12)용 scipy를 한 번 받는다:
```
uv pip install --target D:/omniverse-kit/pydeps --python-version 3.12 --python-platform windows --no-deps scipy
```
`kit_sensors.py`는 환경 변수 `DCT_ARGS`(생성기 인자), `DCT_JSONL`(출력)로 시나리오와 솔버(l0, l1, l2)를 바꾼다. 스크립트 경로가 없으면 Kit이 끝나지 않고 남으니 경로를 먼저 확인한다.
| `kit_flow_anchors.py` | Row01 랙 뒤에 Flow 방출기를 만들고 온도 채널을 OpenVDB로 내보내 센서 앵커 위치 값을 읽음(`FLOW_ANCHORS_NOTES.md`, E0 2.25장) | `out/kit/flow_anchors/` |
| `kit_flow_anchors_probe.py` | Flow 프리셋의 모든 속성 이름과 값을 덤프 | `out/kit/flow_anchors/probe_attrs.json` |
