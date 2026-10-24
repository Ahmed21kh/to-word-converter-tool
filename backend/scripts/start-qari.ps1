# Starts the local Qari-OCR server (Arabic OCR model trained on diacritised text) with the llama-server.exe that ships with Ollama.
#   .\start-qari.ps1 [-ModelDir E:\ollama\qari] [-Port 8081] [-Parallel 3] [-Download] [-Stop]
# Then set in backend\.env:   VISION_PROVIDER=llamacpp   (and LLAMA_URL=http://127.0.0.1:8081 if you changed the port)
# Files (from huggingface.co/mradermacher/Qari-OCR-0.2.2.1-VL-2B-Instruct-merged-GGUF): model.gguf (Q8_0, 1.6 GB) and mmproj.gguf (f16, 1.3 GB).
param(
  [string]$ModelDir = 'E:\ollama\qari',
  [int]$Port = 8081,
  [int]$Parallel = 4,        # text lines read at the same time; the context is 3072 tokens per line (use 2 or 1 on a small GPU)
  [int]$IdleSeconds = 120,   # the server gives its memory back after this many idle seconds and reloads on the next request (0 = never)
  [switch]$Download,         # fetch the two model files first (resumable)
  [switch]$Stop
)
$ErrorActionPreference = 'Stop'

if ($Stop) {
  Get-CimInstance Win32_Process -Filter "name='llama-server.exe'" | Where-Object { $_.CommandLine -match 'qari|model.gguf' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; "stopped $($_.ProcessId)" }
  return
}

$ollama = (Get-Command ollama -ErrorAction SilentlyContinue).Source
if (-not $ollama) { $ollama = Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe' }
$lib = Join-Path (Split-Path $ollama) 'lib\ollama'
$server = Join-Path $lib 'llama-server.exe'
if (-not (Test-Path $server)) { throw "llama-server.exe not found next to Ollama ($server). Install Ollama first (scripts\setup-local-ai.ps1)." }

New-Item -ItemType Directory -Force $ModelDir | Out-Null
if ($Download) {
  $base = 'https://huggingface.co/mradermacher/Qari-OCR-0.2.2.1-VL-2B-Instruct-merged-GGUF/resolve/main/Qari-OCR-0.2.2.1-VL-2B-Instruct-merged'
  & curl.exe -L -C - -o (Join-Path $ModelDir 'model.gguf') "$base.Q8_0.gguf"
  & curl.exe -L -C - -o (Join-Path $ModelDir 'mmproj.gguf') "$base.mmproj-f16.gguf"
}
$model = Join-Path $ModelDir 'model.gguf'
$mmproj = Join-Path $ModelDir 'mmproj.gguf'
foreach ($f in $model, $mmproj) { if (-not (Test-Path $f)) { throw "$f is missing: run with -Download" } }

try { Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 2 | Out-Null; Write-Host "already running on port $Port"; return } catch {}

# the CUDA backend sits in a sub-folder of Ollama's lib directory
$cuda = Join-Path $lib 'cuda_v12'
$env:GGML_BACKEND_PATH = Join-Path $cuda 'ggml-cuda.dll'
$env:PATH = "$cuda;$lib;$env:PATH"
$args = @('-m', $model, '--mmproj', $mmproj, '-ngl', '99', '-c', [string](3072 * $Parallel), '-np', [string]$Parallel, '-lm', 'none', '--host', '127.0.0.1', '--port', [string]$Port)
if ($IdleSeconds -gt 0) { $args += @('--sleep-idle-seconds', [string]$IdleSeconds) }
Start-Process -FilePath $server -ArgumentList $args -WindowStyle Hidden -WorkingDirectory $lib | Out-Null

Write-Host 'starting Qari-OCR ...' -NoNewline
for ($i = 0; $i -lt 90; $i++) {
  Start-Sleep -Seconds 2
  try { Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 2 | Out-Null; Write-Host " ready on http://127.0.0.1:$Port"; return } catch { Write-Host '.' -NoNewline }
}
throw 'the server did not become ready in 3 minutes'
