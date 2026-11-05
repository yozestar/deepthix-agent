<#
Renomme C:\Claude en C:\Dev et met a jour la configuration de l'agent Elyone
et de Claude Code. Laisse une jonction cachee C:\Claude -> C:\Dev pour que les
anciens scripts qui contiennent C:\Claude continuent de fonctionner.

Par defaut : SIMULATION, rien n'est modifie. Ajouter -Apply pour executer.
A lancer AGENT FERME, depuis PowerShell :
  powershell -ExecutionPolicy Bypass -File "C:\Claude\claude_agent\deploy\rename-claude-to-dev\migrate.ps1"
  powershell -ExecutionPolicy Bypass -File "C:\Claude\claude_agent\deploy\rename-claude-to-dev\migrate.ps1" -Apply

Retour arriere : rollback.ps1 (dans C:\Dev\claude_agent\deploy\rename-claude-to-dev\).
#>
param([switch]$Apply)

$ErrorActionPreference = 'Stop'
Set-Location $env:USERPROFILE

$OldRoot     = 'C:\Claude'
$NewRoot     = 'C:\Dev'
$HomeDir     = $env:USERPROFILE
$Elyone      = Join-Path $HomeDir '.elyone'
$ClaudeDir   = Join-Path $HomeDir '.claude'
$HistoryRoot = Join-Path $ClaudeDir 'projects'
$StateRoot   = Join-Path $Elyone 'projects'
$Stamp       = Get-Date -Format 'yyyyMMdd-HHmmss'
$BackupDir   = Join-Path $HomeDir ".claude-to-dev-backup-$Stamp"
$HelperSrc   = Join-Path $PSScriptRoot 'project_ids.rs'
$HelperExe   = Join-Path $env:TEMP "elyone_project_ids_$Stamp.exe"
$Utf8NoBom   = New-Object System.Text.UTF8Encoding $false

# C:\Claude / C:\\Claude / C:/Claude (JSON-escaped or not), not C:\ClaudeX.
$PathRegex = New-Object System.Text.RegularExpressions.Regex '(?i)(?<![A-Za-z0-9])C:((?:\\|/)+)Claude(?![A-Za-z0-9_.\-])'
# Claude Code history folder names: C--Claude-<project>.
$HashRegex = New-Object System.Text.RegularExpressions.Regex '(?i)(?<![A-Za-z0-9])C--Claude(?=-|[\\/"]|$)'
$ProjectPathRegex = '(?i)^(\\\\\?\\)?C:\\Claude(\\|$)'

$script:Problems = New-Object System.Collections.Generic.List[string]
function Step($msg)    { Write-Host ""; Write-Host "== $msg" -ForegroundColor Cyan }
function Info($msg)    { Write-Host "   $msg" }
function Problem($msg) { $script:Problems.Add($msg); Write-Host "   PROBLEME : $msg" -ForegroundColor Red }

function Read-Text($path) {
    $bytes = [IO.File]::ReadAllBytes($path)
    $bom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
    $start = 0
    if ($bom) { $start = 3 }
    return @{ Text = $Utf8NoBom.GetString($bytes, $start, $bytes.Length - $start); Bom = $bom }
}

function Write-Text($path, $text, $bom) {
    $enc = $Utf8NoBom
    if ($bom) { $enc = New-Object System.Text.UTF8Encoding $true }
    [IO.File]::WriteAllText($path, $text, $enc)
}

function Get-BlockingProcesses {
    Get-CimInstance Win32_Process | Where-Object {
        $_.ExecutablePath -and (
            ($_.Name -eq 'app.exe' -and $_.ExecutablePath -match '(?i)Elyone|Deepthix') -or
            ($_.Name -eq 'claude.exe' -and $_.ExecutablePath -notmatch '(?i)\\WindowsApps\\') -or
            ($_.ExecutablePath -like "$OldRoot\*")
        )
    }
}

function Get-CandidateFiles {
    $list = New-Object System.Collections.Generic.List[string]
    $skip = @('import-from-deepthix.json', 'coach-messages.json')
    Get-ChildItem $Elyone -File -Filter *.json |
        Where-Object { ($skip -notcontains $_.Name) -and ($_.Name -notlike 'sauvegarde_*') } |
        ForEach-Object { $list.Add($_.FullName) }
    if (Test-Path $StateRoot) {
        Get-ChildItem $StateRoot -Directory | ForEach-Object {
            Get-ChildItem $_.FullName -File -Filter *.json | ForEach-Object { $list.Add($_.FullName) }
        }
    }
    foreach ($sub in 'coach-workspace\memory', 'workflows', 'mcp') {
        $d = Join-Path $Elyone $sub
        if (Test-Path $d) {
            Get-ChildItem $d -Recurse -File -Include *.json, *.md | ForEach-Object { $list.Add($_.FullName) }
        }
    }
    foreach ($f in (Join-Path $HomeDir '.claude.json'), (Join-Path $ClaudeDir 'history.jsonl')) {
        if (Test-Path $f) { $list.Add($f) }
    }
    return $list
}

Write-Host ""
if ($Apply) {
    Write-Host "MODE EXECUTION : C:\Claude va etre renomme en C:\Dev" -ForegroundColor Yellow
} else {
    Write-Host "MODE SIMULATION : rien ne sera modifie" -ForegroundColor Green
}

# ---------------------------------------------------------------- checks
Step "Verifications"
if (-not (Test-Path $OldRoot)) {
    Problem "$OldRoot n'existe pas."
} elseif ((Get-Item $OldRoot -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
    Problem "$OldRoot est deja une jonction : la migration semble deja faite."
}
if (Test-Path $NewRoot) { Problem "$NewRoot existe deja." }

$blocking = @(Get-BlockingProcesses)
if ($blocking.Count -gt 0) {
    Problem "Programmes a fermer avant de continuer (agent, sessions Claude Code, programmes lances depuis C:\Claude) :"
    $blocking | ForEach-Object { Info "   - $($_.Name) (PID $($_.ProcessId)) $($_.ExecutablePath)" }
} else {
    Info "Aucun agent ni session Claude Code en cours."
}

# ---------------------------------------------------------------- project ids
Step "Identifiants des projets de l'agent"
$projFile = Join-Path $Elyone 'projects.json'
$idMap = @{}
$projects = (ConvertFrom-Json (Read-Text $projFile).Text).projects
$moving = @($projects | Where-Object { $_.path -match $ProjectPathRegex })
Info "$($projects.Count) projets dans l'agent, dont $($moving.Count) sous $OldRoot."

if ($moving.Count -gt 0) {
    if (-not (Get-Command rustc -ErrorAction SilentlyContinue)) {
        Problem "rustc introuvable : impossible de recalculer les identifiants de projets."
    } else {
        & rustc -O -o $HelperExe $HelperSrc
        if ($LASTEXITCODE -ne 0) { Problem "Compilation de project_ids.rs echouee." }
    }
}

if ($moving.Count -gt 0 -and (Test-Path $HelperExe)) {
    $oldPaths = [string[]]($moving | ForEach-Object { $_.path })
    $newPaths = [string[]]($moving | ForEach-Object { $_.path -replace '(?i)^((?:\\\\\?\\)?)C:\\Claude', '${1}C:\Dev' })
    $tmp = Join-Path $env:TEMP "elyone_paths_$Stamp.txt"
    [IO.File]::WriteAllLines($tmp, [string[]]($oldPaths + $newPaths), $Utf8NoBom)
    $hashed = @(& $HelperExe $tmp)
    Remove-Item $tmp
    if ($hashed.Count -ne 2 * $moving.Count) {
        Problem "Calcul des identifiants incomplet ($($hashed.Count) lignes au lieu de $(2 * $moving.Count))."
    } else {
        for ($i = 0; $i -lt $moving.Count; $i++) {
            $oldId = ($hashed[$i] -split "`t")[0]
            $newId = ($hashed[$i + $moving.Count] -split "`t")[0]
            if ($oldId -ne $moving[$i].id) {
                Problem "Identifiant inattendu pour $($moving[$i].path) : enregistre $($moving[$i].id), recalcule $oldId."
                continue
            }
            $idMap[$oldId] = $newId
            if ($projects | Where-Object { $_.id -eq $newId }) {
                Problem "Le nouvel identifiant $newId existe deja dans la liste de projets."
            }
            if (Test-Path (Join-Path $StateRoot $newId)) {
                Problem "Le dossier d'etat $StateRoot\$newId existe deja."
            }
        }
        Info "$($idMap.Count) identifiants recalcules et verifies."
    }
}

# ---------------------------------------------------------------- history folders
Step "Historiques de conversations Claude Code ($HistoryRoot)"
$historyMoves = @()
if (Test-Path $HistoryRoot) {
    Get-ChildItem $HistoryRoot -Directory | Where-Object { $_.Name -match '(?i)^(-*)C--Claude(?=-|$)' } | ForEach-Object {
        $newName = $_.Name -replace '(?i)^(-*)C--Claude', '${1}C--Dev'
        $target = Join-Path $HistoryRoot $newName
        if (Test-Path $target) {
            Problem "Le dossier d'historique $newName existe deja."
        } else {
            $historyMoves += ,@($_.FullName, $target)
        }
    }
}
Info "$($historyMoves.Count) dossiers a renommer (C--Claude-... -> C--Dev-...)."

# ---------------------------------------------------------------- config files
Step "Fichiers de configuration a mettre a jour"
$idFiles = @($projFile, (Join-Path $Elyone 'project-icons.json'))
$changes = @()
foreach ($f in (Get-CandidateFiles)) {
    $r = Read-Text $f
    $t = $PathRegex.Replace($r.Text, 'C:${1}Dev')
    $t = $HashRegex.Replace($t, 'C--Dev')
    if ($idFiles -contains $f) {
        foreach ($old in $idMap.Keys) { $t = $t.Replace('"' + $old + '"', '"' + $idMap[$old] + '"') }
    }
    if ($t -ne $r.Text) {
        $n = $PathRegex.Matches($r.Text).Count + $HashRegex.Matches($r.Text).Count
        $changes += ,@($f, $t, $r.Bom)
        Info ("{0,4} chemin(s)  {1}" -f $n, $f.Substring($HomeDir.Length + 1))
    }
}
Info "$($changes.Count) fichiers seront modifies (une copie de chacun est sauvegardee avant)."

# ---------------------------------------------------------------- decision
Step "Bilan"
if ($script:Problems.Count -gt 0) {
    Write-Host "   $($script:Problems.Count) probleme(s) : rien n'a ete modifie." -ForegroundColor Red
    if (Test-Path $HelperExe) { Remove-Item $HelperExe -ErrorAction SilentlyContinue }
    exit 1
}
if (-not $Apply) {
    Info "Tout est pret. Rien n'a ete modifie."
    Info "Pour executer : relancer la meme commande avec -Apply a la fin."
    if (Test-Path $HelperExe) { Remove-Item $HelperExe -ErrorAction SilentlyContinue }
    exit 0
}

# ---------------------------------------------------------------- apply
$manifest = [ordered]@{
    created     = (Get-Date).ToString('o')
    oldRoot     = $OldRoot
    newRoot     = $NewRoot
    rootMoved   = $false
    junction    = $false
    files       = @()
    projectDirs = @()
    historyDirs = @()
}
$manifestPath = Join-Path $BackupDir 'manifest.json'
function Save-Manifest { [IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 5), $Utf8NoBom) }

Step "Sauvegarde dans $BackupDir"
New-Item -ItemType Directory -Path $BackupDir | Out-Null
foreach ($c in $changes) {
    $rel = $c[0].Substring($HomeDir.Length + 1)
    $dest = Join-Path (Join-Path $BackupDir 'files') $rel
    New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
    Copy-Item -LiteralPath $c[0] -Destination $dest
    $manifest.files += $rel
}
Save-Manifest
Info "$($changes.Count) fichiers sauvegardes."

Step "Renommage $OldRoot -> $NewRoot"
try {
    [IO.Directory]::Move($OldRoot, $NewRoot)
} catch {
    Write-Host "   ECHEC : $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "   Un programme utilise encore C:\Claude (Explorateur, VS Code, terminal...)." -ForegroundColor Red
    Write-Host "   Rien d'autre n'a ete modifie. Fermez-le et relancez." -ForegroundColor Red
    exit 1
}
$manifest.rootMoved = $true
Save-Manifest
Info "OK"

Step "Jonction cachee $OldRoot -> $NewRoot"
New-Item -ItemType Junction -Path $OldRoot -Target $NewRoot | Out-Null
$j = Get-Item $OldRoot -Force
$j.Attributes = $j.Attributes -bor [IO.FileAttributes]::Hidden
$manifest.junction = $true
Save-Manifest
Info "OK"

Step "Mise a jour des fichiers de configuration"
foreach ($c in $changes) { Write-Text $c[0] $c[1] $c[2] }
Info "$($changes.Count) fichiers mis a jour."

Step "Dossiers d'etat des projets de l'agent"
foreach ($old in $idMap.Keys) {
    $from = Join-Path $StateRoot $old
    if (Test-Path $from) {
        $to = Join-Path $StateRoot $idMap[$old]
        [IO.Directory]::Move($from, $to)
        $manifest.projectDirs += ,@($from, $to)
    }
}
Save-Manifest
Info "$($manifest.projectDirs.Count) dossiers renommes."

Step "Dossiers d'historique Claude Code"
foreach ($m in $historyMoves) {
    [IO.Directory]::Move($m[0], $m[1])
    $manifest.historyDirs += ,@($m[0], $m[1])
}
Save-Manifest
Info "$($manifest.historyDirs.Count) dossiers renommes."

Remove-Item $HelperExe -ErrorAction SilentlyContinue
Step "Termine"
Info "Vos projets sont maintenant dans $NewRoot. Vous pouvez rouvrir l'agent."
Info "Sauvegarde et journal : $BackupDir"
Info "Retour arriere : powershell -ExecutionPolicy Bypass -File `"$NewRoot\claude_agent\deploy\rename-claude-to-dev\rollback.ps1`""
