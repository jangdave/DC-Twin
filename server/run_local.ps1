# 이 컴퓨터에서 시뮬레이션 서버를 띄운다(GPU로 L2). 저장소 어디서 실행해도 된다.
#   .\server\run_local.ps1                 # L2, 포트 8765, 5배속
#   .\server\run_local.ps1 -Solver l0      # GPU 없이 간단한 모델
#   .\server\run_local.ps1 -Cac            # 냉기 통로 격리(CAC) 장면으로(L1/L2, CAC 보정 모델을 쓴다, docs/34 6장)
#   .\server\run_local.ps1 -Kit           # Omniverse Kit 안에서 서버 + 시뮬레이션 작업(OpenFOAM 흐름 + 우리 온도 계산, docs/31)
# 웹 화면은 주소 끝에 ?server=ws://127.0.0.1:8765/ws 를 붙이거나 "로컬 서버" 단추에 그 주소를 넣는다.
param(
  [ValidateSet('l0', 'l1', 'l2')] [string]$Solver = 'l2',
  [int]$Port = 8765,
  [double]$Speed = 5,
  [string[]]$Origin = @(),
  [switch]$Kit,
  [switch]$Cac,
  [string]$KitDir = 'D:\omniverse-kit\kit-app-template\_build\windows-x86_64\release'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$manifest = Join-Path $root 'server\data\sensor_manifest.json'
if (-not (Test-Path $manifest)) { throw "매니페스트가 없다: $manifest" }
$args = @('--manifest', $manifest, '--solver', $Solver, '--port', $Port, '--speed', $Speed)
foreach ($o in $Origin) { $args += @('--origin', $o) }
if ($Cac) {
  if ($Solver -eq 'l0') { throw '-Cac는 L1, L2에서만 된다(간단한 모델 L0은 장면을 읽지 않는다)' }
  $scene = Join-Path $root 'usd\scenes\_hall01_cac.usda'
  if (-not (Test-Path $scene)) { throw "CAC 장면이 없다: $scene (scripts\usd_tools에서 build_scene.py ..\..\usd\scenes\hall01_cac.config.json ..\..\usd\scenes\_hall01_cac.usda)" }
  $args += @('--scene', $scene)
}
if ($Kit) {
  # Kit이 장면 USD를 열고 같은 프로세스에서 서버를 돌린다(server/kit_server.py). 시뮬레이션 작업(--jobs)도 켠다.
  $kitExe = Join-Path $KitDir 'kit\kit.exe'
  if (-not (Test-Path $kitExe)) { throw "Kit 앱이 없다: $kitExe (experiments/omniverse_probe/kit/README.md)" }
  $env:DCT_SERVER_ARGS = (($args + @('--jobs')) | ForEach-Object { if ("$_" -match '\s') { "`"$_`"" } else { "$_" } }) -join ' '
  $env:DCT_REPO = $root
  $stop = Join-Path $root 'sim\out\kit_server.stop'
  Write-Host "Kit 서버를 띄운다(창 없음). 첫 시작은 30초쯤 걸린다. 끝내려면 Ctrl+C."
  $p = Start-Process -FilePath $kitExe -WorkingDirectory $KitDir -NoNewWindow -PassThru -ArgumentList @('apps\dctwin.base_editor.kit', '--no-window', '--/app/file/ignoreUnsavedOnExit=true', '--exec', (Join-Path $root 'server\kit_server.py'))
  try { $p.WaitForExit() } finally {
    if (-not $p.HasExited) {
      New-Item -ItemType File -Force $stop | Out-Null   # 서버에 끝내라고 알리고, 15초 안에 안 끝나면 끝낸다
      if (-not $p.WaitForExit(15000)) { Stop-Process -Id $p.Id -Force }
    }
  }
  return
}
if ($Solver -eq 'l0') {
  Set-Location (Join-Path $root 'sim\sensors')
  uv run --python 3.13 --extra serve python -m dct_sensors.serve @args --data-dir (Join-Path $root 'web\viewer\public\data')
} else {
  # L1, L2는 Warp(와 L2는 scikit-learn)가 있는 환경에서 돈다. websockets는 이 실행에만 임시로 더한다.
  Set-Location (Join-Path $root 'experiments\omniverse_probe')
  $env:PYTHONPATH = Join-Path $root 'sim\sensors'
  uv run --python 3.13 --with websockets python -m dct_sensors.serve @args
}
