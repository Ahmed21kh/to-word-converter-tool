<#
 Installs the FREE local AI reader (Ollama + a vision model) on Windows, on the drive you choose.
 Everything is resumable: if your connection drops, run the script again and it continues.

   powershell -ExecutionPolicy Bypass -File scripts/setup-local-ai.ps1 -Model qwen2.5vl:7b -InstallDir E:\ollama
   add -DryRun to only print what would happen

 Models: qwen2.5vl:7b  (about 6 GB, best accuracy, needs a GPU with 8 GB VRAM to be fast)
         qwen2.5vl:3b  (about 3.2 GB, lighter, for 4-6 GB GPUs or slow CPU-only machines)
#>
param(
  [string]$Model = 'qwen2.5vl:7b',
  [string]$InstallDir = 'E:\ollama',
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$modelsDir = Join-Path $InstallDir 'models'
$installer = Join-Path $InstallDir 'OllamaSetup.exe'
$needGb = if ($Model -match '3b') { 11 } else { 14 }

function Step($t) { Write-Host ""; Write-Host "== $t" -ForegroundColor Cyan }
function Run($desc, [scriptblock]$code) { if ($DryRun) { Write-Host "[dry run] $desc" } else { Write-Host $desc; & $code } }
function OllamaExe {
  $c = Get-Command ollama -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  return (Join-Path $InstallDir 'app\ollama.exe')
}

Step "Checking disk space on $([IO.Path]::GetPathRoot($InstallDir))"
$drive = Get-PSDrive -Name ([IO.Path]::GetPathRoot($InstallDir).Substring(0, 1))
$freeGb = [math]::Round($drive.Free / 1GB, 1)
Write-Host "free: $freeGb GB, needed about $needGb GB (installer + program + model)"
if ($freeGb -lt $needGb) { throw 'Not enough free space on that drive. Pick another -InstallDir.' }

Run "creating $InstallDir" { New-Item -ItemType Directory -Force $InstallDir, $modelsDir | Out-Null }

Step 'Ollama'
$have = Get-Command ollama -ErrorAction SilentlyContinue
if ($have) { Write-Host "already installed: $($have.Source)" }
else {
  Run "downloading the installer (about 1.5 GB, resumable) to $installer" {
    & curl.exe -L -C - --retry 30 --retry-delay 5 -o $installer 'https://ollama.com/download/OllamaSetup.exe'
    if ((Get-Item $installer).Length -lt 1GB) { throw 'The installer download is incomplete: run this script again to resume.' }
  }
  Run "installing silently into $InstallDir\app" {
    Start-Process -FilePath $installer -ArgumentList '/SILENT', '/NORESTART', "/DIR=$InstallDir\app" -Wait
  }
}

Step 'Where models are stored'
Run "setting OLLAMA_MODELS=$modelsDir (user environment variable)" {
  [Environment]::SetEnvironmentVariable('OLLAMA_MODELS', $modelsDir, 'User')
  $env:OLLAMA_MODELS = $modelsDir
}

Step 'Reading several lines at once (about 1.7x faster)'
Run 'setting OLLAMA_NUM_PARALLEL=3 (user environment variable)' {
  [Environment]::SetEnvironmentVariable('OLLAMA_NUM_PARALLEL', '3', 'User')
  $env:OLLAMA_NUM_PARALLEL = '3'
}

Step 'Starting the Ollama service'
Run 'starting ollama serve if it is not running' {
  try { Invoke-RestMethod http://localhost:11434/api/tags -TimeoutSec 3 | Out-Null; Write-Host 'already running' }
  catch {
    Start-Process -FilePath (OllamaExe) -ArgumentList 'serve' -WindowStyle Hidden
    for ($i = 0; $i -lt 30; $i++) {
      Start-Sleep 1
      try { Invoke-RestMethod http://localhost:11434/api/tags -TimeoutSec 2 | Out-Null; break } catch { }
    }
  }
}

Step "Downloading the model $Model (resumable)"
Run "ollama pull $Model" { & (OllamaExe) pull $Model }

Step 'Done. Next:'
Write-Host "  1) measure the accuracy on one of your pages (from the backend folder):"
Write-Host "       `$env:VISION_PROVIDER='ollama'; `$env:VISION_MODEL='$Model'"
Write-Host "       node scripts/ai-eval.mjs `"<your.pdf>`" 8 test/fixtures/truth-page8.txt"
Write-Host "  2) use it in the app (backend .env or environment):"
Write-Host "       VISION_PROVIDER=ollama"
Write-Host "       VISION_MODEL=$Model"
Write-Host "     then choose  Reading engine -> AI  in the options."
