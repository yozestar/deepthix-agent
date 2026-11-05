<#
Annule la migration faite par migrate.ps1 : remet C:\Dev en C:\Claude, restaure
les fichiers de configuration sauvegardes et les noms de dossiers d'origine.

Attention : les fichiers de configuration reviennent a leur etat du moment de
la migration (les changements faits depuis dans l'agent sont perdus).

A lancer AGENT FERME :
  powershell -ExecutionPolicy Bypass -File "C:\Dev\claude_agent\deploy\rename-claude-to-dev\rollback.ps1"
Option : -BackupDir <dossier> (par defaut, la sauvegarde la plus recente).
#>
param([string]$BackupDir)

$ErrorActionPreference = 'Stop'
Set-Location $env:USERPROFILE
$HomeDir = $env:USERPROFILE

if (-not $BackupDir) {
    $latest = Get-ChildItem $HomeDir -Directory -Force -Filter '.claude-to-dev-backup-*' |
        Sort-Object Name -Descending | Select-Object -First 1
    if (-not $latest) { Write-Host "Aucune sauvegarde .claude-to-dev-backup-* trouvee." -ForegroundColor Red; exit 1 }
    $BackupDir = $latest.FullName
}
$manifestPath = Join-Path $BackupDir 'manifest.json'
if (-not (Test-Path $manifestPath)) { Write-Host "manifest.json introuvable dans $BackupDir." -ForegroundColor Red; exit 1 }
$m = Get-Content $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
Write-Host "Retour arriere depuis $BackupDir (migration du $($m.created))"

$blocking = @(Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -and (
        ($_.Name -eq 'app.exe' -and $_.ExecutablePath -match '(?i)Elyone|Deepthix') -or
        ($_.Name -eq 'claude.exe' -and $_.ExecutablePath -notmatch '(?i)\\WindowsApps\\') -or
        ($_.ExecutablePath -like "$($m.newRoot)\*")
    )
})
if ($blocking.Count -gt 0) {
    Write-Host "Programmes a fermer avant de continuer :" -ForegroundColor Red
    $blocking | ForEach-Object { Write-Host "   - $($_.Name) (PID $($_.ProcessId)) $($_.ExecutablePath)" }
    exit 1
}

foreach ($pair in @($m.historyDirs)) {
    if ((Test-Path $pair[1]) -and -not (Test-Path $pair[0])) { [IO.Directory]::Move($pair[1], $pair[0]) }
}
Write-Host "Historiques Claude Code : noms d'origine remis."

foreach ($pair in @($m.projectDirs)) {
    if ((Test-Path $pair[1]) -and -not (Test-Path $pair[0])) { [IO.Directory]::Move($pair[1], $pair[0]) }
}
Write-Host "Dossiers d'etat des projets : noms d'origine remis."

foreach ($rel in @($m.files)) {
    Copy-Item -LiteralPath (Join-Path (Join-Path $BackupDir 'files') $rel) -Destination (Join-Path $HomeDir $rel) -Force
}
Write-Host "Fichiers de configuration restaures ($(@($m.files).Count))."

if ($m.junction -and (Test-Path $m.oldRoot)) {
    $item = Get-Item $m.oldRoot -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        # rmdir on a junction removes the link only, never the target's content.
        cmd /c rmdir "$($m.oldRoot)"
    } else {
        Write-Host "$($m.oldRoot) n'est pas une jonction : arret par prudence." -ForegroundColor Red
        exit 1
    }
}
if ($m.rootMoved -and (Test-Path $m.newRoot) -and -not (Test-Path $m.oldRoot)) {
    [IO.Directory]::Move($m.newRoot, $m.oldRoot)
}
Write-Host "Termine : $($m.oldRoot) est de retour. Vous pouvez rouvrir l'agent." -ForegroundColor Green
