# 이 컴퓨터에서 시뮬레이션 서버를 띄운다(GPU로 L2). 저장소 어디서 실행해도 된다.
#   .\server\run_local.ps1                 # L2, 포트 8765, 5배속
#   .\server\run_local.ps1 -Solver l0      # GPU 없이 간단한 모델
# 웹 화면은 주소 끝에 ?server=ws://127.0.0.1:8765/ws 를 붙이거나 "로컬 서버" 단추에 그 주소를 넣는다.
param(
  [ValidateSet('l0', 'l1', 'l2')] [string]$Solver = 'l2',
  [int]$Port = 8765,
  [double]$Speed = 5,
  [string[]]$Origin = @()
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$manifest = Join-Path $root 'server\data\sensor_manifest.json'
if (-not (Test-Path $manifest)) { throw "매니페스트가 없다: $manifest" }
$args = @('--manifest', $manifest, '--solver', $Solver, '--port', $Port, '--speed', $Speed)
foreach ($o in $Origin) { $args += @('--origin', $o) }
if ($Solver -eq 'l0') {
  Set-Location (Join-Path $root 'sim\sensors')
  uv run --python 3.13 --extra serve python -m dct_sensors.serve @args --data-dir (Join-Path $root 'web\viewer\public\data')
} else {
  # L1, L2는 Warp(와 L2는 scikit-learn)가 있는 환경에서 돈다. websockets는 이 실행에만 임시로 더한다.
  Set-Location (Join-Path $root 'experiments\omniverse_probe')
  $env:PYTHONPATH = Join-Path $root 'sim\sensors'
  uv run --python 3.13 --with websockets python -m dct_sensors.serve @args
}
