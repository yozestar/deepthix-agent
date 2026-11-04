# Builds the Windows installers (ARM64 + x64) of the release branch in a
# separate folder (C:\Dev\agent-build) from \\Mac\Bureau\.release\agent.bundle.
# Never touches C:\Dev\claude_agent. Never launches claude.
# Updater artifacts are NOT signed here: the signing key stays on the Mac,
# which signs the setup.exe files afterwards.
$ErrorActionPreference = 'Continue'
$share = '\\Mac\Bureau\.release'
$log = "$share\win-build.log"
$src = 'C:\Dev\agent-build'
function Log($m) { Add-Content -Encoding UTF8 $log "$(Get-Date -Format HH:mm:ss) $m" }
Set-Content -Encoding UTF8 $log "start"

if (-not (Test-Path $src)) {
  git clone -q "$share\agent.bundle" $src 2>&1 | ForEach-Object { Log $_ }
}
Set-Location $src
git fetch -q "$share\agent.bundle" HEAD 2>&1 | ForEach-Object { Log $_ }
git checkout -q -f FETCH_HEAD 2>&1 | ForEach-Object { Log $_ }
Log "commit $(git rev-parse --short HEAD)"

cmd /c "npm ci --no-audit --no-fund > $share\win-npm-root.log 2>&1"
Log "npm root exit $LASTEXITCODE"
Set-Location "$src\webview-ui"
cmd /c "npm ci --legacy-peer-deps --no-audit --no-fund > $share\win-npm-ui.log 2>&1"
Log "npm ui exit $LASTEXITCODE"
Set-Location $src

Set-Content -Encoding ASCII "$src\src-tauri\tauri.build-win.json" '{"bundle":{"createUpdaterArtifacts":false}}'
$env:CARGO_BUILD_JOBS = '4'

cmd /c "npx tauri build --bundles nsis --config src-tauri\tauri.build-win.json > $share\win-arm64.log 2>&1"
$a = $LASTEXITCODE; Log "arm64 exit $a"
cmd /c "npx tauri build --target x86_64-pc-windows-msvc --bundles nsis --config src-tauri\tauri.build-win.json > $share\win-x64.log 2>&1"
$b = $LASTEXITCODE; Log "x64 exit $b"

$v = (Get-Content "$src\src-tauri\tauri.conf.json" -Raw | ConvertFrom-Json).version
$arm = Get-ChildItem "$src\src-tauri\target\release\bundle\nsis\*_${v}_arm64-setup.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
$x64 = Get-ChildItem "$src\src-tauri\target\x86_64-pc-windows-msvc\release\bundle\nsis\*_${v}_x64-setup.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($arm) { Copy-Item $arm.FullName "$share\out\Elyone-AI-Desktop-Agent_${v}_arm64-setup.exe"; Log "copied arm64" }
if ($x64) { Copy-Item $x64.FullName "$share\out\Elyone-AI-Desktop-Agent_${v}_x64-setup.exe"; Log "copied x64" }
Set-Content -Encoding UTF8 "$share\win-done.txt" "version=$v arm64=$a x64=$b"
