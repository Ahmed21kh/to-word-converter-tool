<#
 The local AI reader of the desktop app: Qari-OCR (two model files) run by llama-server.exe, which comes with Ollama.
 Run by the installer and by the app itself. Looks first, then installs only what is missing; downloads resume if cut.

   -Check     only look: prints {"server":...,"models":...}; exit code 0 = both found, 1 = something is missing
   -Install   install what is missing: Ollama (about 1.5 GB download) and/or the model files (about 2.9 GB)
   -ModelDir  where to put the model files (default %LOCALAPPDATA%\PdfToWord\qari)
#>
param(
  [switch]$Check,
  [switch]$Install,
  [string]$ModelDir = ''
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$home2 = Join-Path $env:LOCALAPPDATA 'PdfToWord'
$state = Join-Path $home2 'ai.json'
$base = 'https://huggingface.co/mradermacher/Qari-OCR-0.2.2.1-VL-2B-Instruct-merged-GGUF/resolve/main/Qari-OCR-0.2.2.1-VL-2B-Instruct-merged'
$files = @(
  @{ name = 'model.gguf'; url = "$base.Q8_0.gguf"; min = 1GB },
  @{ name = 'mmproj.gguf'; url = "$base.mmproj-f16.gguf"; min = 300MB }
)

function Saved {
  try { return Get-Content $state -Raw | ConvertFrom-Json } catch { return $null }
}

# same places the app and the API look in: the saved path, LLAMA_SERVER_EXE, Ollama on the PATH, its default folder, the running Ollama
function Find-Server {
  $s = Saved
  $cands = @()
  if ($s -and $s.server) { $cands += $s.server }
  if ($env:LLAMA_SERVER_EXE) { $cands += $env:LLAMA_SERVER_EXE }
  $dirs = @($env:PATH -split ';' | Where-Object { $_ })
  $dirs += (Join-Path $env:LOCALAPPDATA 'Programs\Ollama')
  $o = Get-Command ollama -ErrorAction SilentlyContinue
  if ($o) { $dirs += (Split-Path $o.Source) }
  $p = Get-Process ollama -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($p -and $p.Path) { $dirs += (Split-Path $p.Path) }
  foreach ($d in $dirs) { $cands += (Join-Path $d 'lib\ollama\llama-server.exe'); $cands += (Join-Path $d 'llama-server.exe') }
  foreach ($c in $cands) { if ($c -and (Test-Path -LiteralPath $c -PathType Leaf)) { return (Resolve-Path -LiteralPath $c).Path } }
  return $null
}

function Has-Models($dir) {
  if (-not $dir) { return $false }
  foreach ($f in $files) {
    $p = Join-Path $dir $f.name
    if (-not (Test-Path -LiteralPath $p -PathType Leaf) -or (Get-Item -LiteralPath $p).Length -lt $f.min) { return $false }
  }
  return $true
}

# the saved folder, QARI_DIR, the app's own folder, and a "qari" folder next to Ollama (e.g. E:\ollama\app -> E:\ollama\qari)
function Find-Models($server) {
  $s = Saved
  $cands = @($ModelDir, $(if ($s) { $s.models }), $env:QARI_DIR, (Join-Path $home2 'qari'))
  if ($server) {
    $root = Split-Path $server
    if ($server -match '\\lib\\ollama\\llama-server\.exe$') { $root = Split-Path (Split-Path $root) }
    $cands += (Join-Path (Split-Path $root) 'qari')
    $cands += (Join-Path $root 'qari')
  }
  foreach ($c in $cands) { if (Has-Models $c) { return $c } }
  return $null
}

function Save($server, $models) {
  New-Item -ItemType Directory -Force $home2 | Out-Null
  $s = Saved
  $o = [ordered]@{ server = $server; models = $models; declined = $(if ($s) { [bool]$s.declined } else { $false }) }
  [IO.File]::WriteAllText($state, ($o | ConvertTo-Json -Compress))
}

$server = Find-Server
$models = Find-Models $server

if (-not $Install) {
  [ordered]@{ server = $server; models = $models } | ConvertTo-Json -Compress | Write-Output
  if ($server -and $models) { Save $server $models; exit 0 }
  exit 1
}

try {
  $Host.UI.RawUI.WindowTitle = 'PDF to Word - AI reader setup'
  Write-Host ''
  Write-Host 'PDF to Word - local AI reader (Qari-OCR)' -ForegroundColor Cyan
  Write-Host 'Everything is resumable: if the connection drops, run it again and it continues.'

  # ---- llama-server (from Ollama) --------------------------------------------------------------
  if ($server) { Write-Host "`n[ok] llama-server: $server" -ForegroundColor Green }
  else {
    Write-Host "`n== Ollama is not installed: downloading it (about 1.5 GB)" -ForegroundColor Cyan
    $tmp = Join-Path $env:TEMP 'PdfToWord'
    New-Item -ItemType Directory -Force $tmp | Out-Null
    $setup = Join-Path $tmp 'OllamaSetup.exe'
    & curl.exe -L -C - --retry 30 --retry-delay 5 --fail -o $setup 'https://ollama.com/download/OllamaSetup.exe'
    if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 33) { throw "the Ollama download failed (curl exit code $LASTEXITCODE)" }
    Write-Host '== installing Ollama (for this user, no admin rights needed)' -ForegroundColor Cyan
    Start-Process -FilePath $setup -ArgumentList '/VERYSILENT', '/NORESTART', '/SUPPRESSMSGBOXES' -Wait
    $server = Find-Server
    if (-not $server) { throw 'Ollama was installed but llama-server.exe was not found in it (an old Ollama version?). Update Ollama and run this again.' }
    Remove-Item -LiteralPath $setup -ErrorAction SilentlyContinue
    Write-Host "[ok] llama-server: $server" -ForegroundColor Green
  }

  # ---- the model files -------------------------------------------------------------------------
  $models = Find-Models $server
  if ($models) { Write-Host "[ok] model files: $models" -ForegroundColor Green }
  else {
    $dir = if ($ModelDir) { $ModelDir } else { Join-Path $home2 'qari' }
    New-Item -ItemType Directory -Force $dir | Out-Null
    $free = (Get-PSDrive -Name (Split-Path -Qualifier (Resolve-Path $dir).Path).TrimEnd(':')).Free
    if ($free -lt 3.5GB) { throw ("not enough free space on {0}: about 3.5 GB is needed, {1:N1} GB is free" -f $dir, ($free / 1GB)) }
    foreach ($f in $files) {
      $dest = Join-Path $dir $f.name
      if ((Test-Path -LiteralPath $dest) -and (Get-Item -LiteralPath $dest).Length -ge $f.min) { continue }
      Write-Host "`n== downloading $($f.name) to $dir" -ForegroundColor Cyan
      $part = "$dest.part" # a half file never counts as installed
      & curl.exe -L -C - --retry 30 --retry-delay 5 --fail -o $part $f.url
      if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 33) { throw "the download of $($f.name) failed (curl exit code $LASTEXITCODE): run this again to resume" }
      if ((Get-Item -LiteralPath $part).Length -lt $f.min) { throw "$($f.name) is incomplete: run this again to resume" }
      Move-Item -LiteralPath $part -Destination $dest -Force
    }
    $models = $dir
    Write-Host "[ok] model files: $models" -ForegroundColor Green
  }

  Save $server $models
  Write-Host "`nDone: the AI reader is ready. This window closes by itself." -ForegroundColor Green
  Start-Sleep -Seconds 4
  exit 0
} catch {
  Write-Host "`nSetup did not finish: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host 'The converter still works with the standard reader. You can try again later from the app.'
  Read-Host 'Press Enter to close'
  exit 1
}
