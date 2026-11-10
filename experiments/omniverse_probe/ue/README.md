# UE 5.7에서 VDB 가져오기 시험 (R6)

부피 데이터(VDB)를 Unreal이 읽는지 확인하는 스크립트다. 결과는 [E0 결과 문서](../../results/E0_omniverse_capability_probe.md) 2.10장.

## 준비 (한 번만)
저장소 밖에 시험 전용 프로젝트를 만든다. `D:\ue_probe\VdbProbe\VdbProbe.uproject`:
```json
{
  "FileVersion": 3,
  "EngineAssociation": "5.7",
  "Plugins": [
    { "Name": "Interchange", "Enabled": true },
    { "Name": "InterchangeEditor", "Enabled": true },
    { "Name": "InterchangeOpenVDB", "Enabled": true },
    { "Name": "PythonScriptPlugin", "Enabled": true },
    { "Name": "EditorScriptingUtilities", "Enabled": true }
  ]
}
```
이 프로젝트는 시험용이라 저장소에 올리지 않는다. (실제 클라이언트 프로젝트는 [이슈 #5](https://github.com/jangdave/DC-Twin/issues/5)에서 만든다.)

## 실행 (저장소 루트에서)
```
.\experiments\omniverse_probe\ue\run_import_probe.ps1 -Files "<파일1.vdb>;<파일2.vdb>"
```
- 에디터를 화면 없이 실행해서 `import_vdb_probe.py`로 파일을 가져오고 결과를 `D:\ue_probe\vdb_import_result.json`에 쓴다. 약 17초 걸린다.
- 에디터 로그: `D:\ue_probe\ue_vdb_import.log`

## 알아둘 점
- `.vdb`는 Interchange가 아니라 **기존 에셋 가져오기 경로**로 가져와진다(스크립트가 둘 다 시도한다).
- `.nvdb`(NanoVDB)는 가져와지지 않는다.
- 파일 이름 끝에 연속된 번호(`Temp_000.vdb`, `Temp_001.vdb`, ...)를 붙이면 UE가 하나의 애니메이션 볼륨(`AnimatedSparseVolumeTexture`)으로 묶는다.
