# Push local HEAD to GitHub via the Git Database API using ONLY PowerShell.
#
# Why: on this machine node's `execFileSync('git'|'gh')` fails with EBUSY, so
# tools/gh-push.mjs cannot run, and direct `git push` is blocked by the proxy.
# PowerShell can talk to both `git` (local, read-only) and `gh` (HTTPS) fine.
#
# Flow: resolve remote base -> compare remote tree vs local HEAD tree (API) ->
#       POST /git/blobs for changed files -> POST /git/trees (base_tree) ->
#       POST /git/commits -> PATCH /git/refs/heads/<branch> (force:false).
# ASCII only (a .ps1 saved without BOM would garble non-ASCII literals).
#
# Usage:  powershell -File tools/gh-push-ps.ps1 [-Repo owner/name] [-Branch main] [-Message "..."]

param(
  [string]$Repo = 'lzfxisxji/yuanqi-warriors',
  [string]$Branch = 'main',
  [string]$Message = ''
)

$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
$utf8 = New-Object System.Text.UTF8Encoding($false)
$tmp = Join-Path $env:TEMP ('ghpush-' + [guid]::NewGuid().ToString('N') + '.json')

function GhJson {
  param([string]$Path, [string]$Method, [string]$BodyFile)
  $a = @('api', $Path, '-X', $Method)
  if ($BodyFile) { $a += @('--input', $BodyFile) }
  $out = & gh @a
  if ($LASTEXITCODE -ne 0) { throw ("gh api $Method $Path failed (exit $LASTEXITCODE)") }
  $text = ($out | Out-String).Trim()
  if (-not $text) { return $null }
  return ($text | ConvertFrom-Json)
}

function WriteBody {
  param([string]$Json)
  [System.IO.File]::WriteAllText($tmp, $Json, $utf8)
  return $tmp
}

Write-Output '== resolve remote base =='
$ref = GhJson "/repos/$Repo/git/ref/heads/$Branch" 'GET' $null
$baseSha = $ref.object.sha
$baseCommit = GhJson "/repos/$Repo/git/commits/$baseSha" 'GET' $null
$baseTree = $baseCommit.tree.sha
Write-Output ("base commit: " + $baseSha)
Write-Output ("base tree:   " + $baseTree)

Write-Output '== diff remote tree vs local HEAD =='
# core.quotepath=false is REQUIRED: with the default (true) git renders non-ASCII
# paths as "\346\226\260..." wrapped in double quotes, so the paths never match the
# remote tree keys and every Chinese-named file (role/*.png) looks "changed".
$localSha = @{}
$localMode = @{}
foreach ($line in (& git -c core.quotepath=false ls-tree -r HEAD)) {
  if ($line -notmatch '^(\d+)\s+\w+\s+([0-9a-f]+)\t(.+)$') { continue }
  $localMode[$Matches[3]] = $Matches[1]
  $localSha[$Matches[3]] = $Matches[2]
}
$remoteSha = @{}
$remoteTree = GhJson "/repos/$Repo/git/trees/$baseTree`?recursive=1" 'GET' $null
foreach ($e in $remoteTree.tree) { if ($e.type -eq 'blob') { $remoteSha[$e.path] = $e.sha } }

$paths = @(($localSha.Keys + $remoteSha.Keys) | Sort-Object -Unique)
$changed = @()
$deleted = @()
foreach ($p in $paths) {
  if ($localSha[$p] -ne $remoteSha[$p]) {
    if ($localSha[$p]) { $changed += $p } else { $deleted += $p }
  }
}
Write-Output ("changed: " + $changed.Count + "  deleted(kept remote): " + $deleted.Count)
foreach ($p in $deleted) { Write-Output ("  KEEP-REMOTE " + $p) }

if (-not $Message) {
  $Message = (& git log -1 --pretty=format:%s HEAD)
  if (-not $Message) { $Message = 'sync' }
}

Write-Output '== upload blobs =='
$entries = @()
foreach ($p in $changed) {
  $full = Join-Path (Get-Location) ($p -replace '/', '\')
  if (-not (Test-Path -LiteralPath $full)) { Write-Output ("  SKIP (missing locally): " + $p); continue }
  $b64 = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($full))
  $body = @{ content = $b64; encoding = 'base64' } | ConvertTo-Json -Compress
  $blob = GhJson "/repos/$Repo/git/blobs" 'POST' (WriteBody $body)
  Write-Output ("  blob " + $blob.sha.Substring(0, 8) + "  " + $p)
  $entries += @{ path = $p; mode = $localMode[$p]; type = 'blob'; sha = $blob.sha }
}

if ($entries.Count -eq 0) {
  Write-Output 'nothing to push (remote tree already matches HEAD)'
  exit 0
}

Write-Output '== create tree / commit / move ref =='
$treeBody = @{ base_tree = $baseTree; tree = $entries } | ConvertTo-Json -Compress -Depth 6
$newTree = GhJson "/repos/$Repo/git/trees" 'POST' (WriteBody $treeBody)
Write-Output ("new tree:   " + $newTree.sha)

$commitBody = @{ message = $Message; tree = $newTree.sha; parents = @($baseSha) } | ConvertTo-Json -Compress
$newCommit = GhJson "/repos/$Repo/git/commits" 'POST' (WriteBody $commitBody)
Write-Output ("new commit: " + $newCommit.sha)

$refBody = @{ sha = $newCommit.sha; force = $false } | ConvertTo-Json -Compress
$moved = GhJson "/repos/$Repo/git/refs/heads/$Branch" 'PATCH' (WriteBody $refBody)
Write-Output ("ref moved:  " + $moved.object.sha)

if (Test-Path -LiteralPath $tmp) { [System.IO.File]::Delete($tmp) }
Write-Output 'PUSH-DONE'
