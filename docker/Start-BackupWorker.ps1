param(
  [Parameter(Mandatory=$true)][string]$ConfigPath,
  [string]$NodePath = (Get-Command node -ErrorAction Stop).Source
)
$ErrorActionPreference = 'Stop'
$profilePath = (Resolve-Path -LiteralPath $ConfigPath).Path
$profile = Get-Content -LiteralPath $profilePath -Raw | ConvertFrom-Json
$workerPath = Join-Path $PSScriptRoot 'backup-worker.mjs'
$taskPort = if ($profile.port) { [int]$profile.port } else { 18970 }
if (Get-NetTCPConnection -LocalPort $taskPort -State Listen -ErrorAction SilentlyContinue) {
  throw "Port $taskPort is already in use. Inspect the existing worker before starting another instance."
}
$logDirectory = [IO.Path]::GetFullPath([string]$profile.directory)
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls $logDirectory '/inheritance:r' '/grant:r' "${identity}:(OI)(CI)F" 'SYSTEM:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Cannot protect the backup directory ACL.' }
$arguments = '"' + $workerPath + '" --config "' + $profilePath + '"'
$worker = Start-Process -FilePath $NodePath -ArgumentList $arguments -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logDirectory 'worker.stdout.log') -RedirectStandardError (Join-Path $logDirectory 'worker.stderr.log')
@{ pid=$worker.Id; port=$taskPort; mode=$profile.mode; config=$profilePath } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $logDirectory 'worker-process.json') -Encoding UTF8
Write-Output "Backup worker started with PID $($worker.Id), loopback port $taskPort."
