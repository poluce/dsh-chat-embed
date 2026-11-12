param(
  [string]$Resources = $env:DSH_RESOURCES,
  [string]$Exe
)

$ErrorActionPreference = 'Continue'

# Find the install without a hard-coded path, so the same script works on any
# machine. -Resources / DSH_RESOURCES override the search.
if (-not $Resources) {
  $candidates = @()
  if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources') }
  $candidates += 'C:\Program Files\DeepSeek Harness\resources'
  $candidates += 'C:\Program Files (x86)\DeepSeek Harness\resources'
  foreach ($candidate in $candidates) {
    if (Test-Path (Join-Path $candidate 'app.asar')) { $Resources = $candidate; break }
  }
}
if (-not $Resources) {
  Write-Host 'watchdog: cannot find the DSH install. Pass -Resources <dir> or set DSH_RESOURCES.'
  exit 1
}
if (-not $Exe) { $Exe = Join-Path (Split-Path -Parent $Resources) 'DeepSeek Harness.exe' }

$res  = $Resources
$asar = Join-Path $res 'app.asar'
$new  = Join-Path $res 'app.asar.new'
$orig = Join-Path $res 'app.asar.orig'
$log  = Join-Path $env:TEMP 'dsh-chat-embed-watchdog.log'
$mark = Join-Path $env:TEMP 'dsh-chat-embed-patched.txt'
$app  = 'DeepSeek Harness'

function Log($message) {
  Add-Content -Path $log -Value ("[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message)
}

Log ('watchdog v4 started (pid ' + $PID + ', event-driven)')

if (Test-Path $mark) { Log 'already patched; exiting'; exit 0 }
if (-not (Test-Path $new)) { Log 'app.asar.new missing; exiting'; exit 1 }

# Pick the Electron main process: a DeepSeek Harness process whose parent is not
# itself another DeepSeek Harness process. Everything else is a child worker.
$alive = @(Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" -ErrorAction SilentlyContinue)
$mainPid = 0
foreach ($proc in $alive) {
  $parent = @($alive | Where-Object { $_.ProcessId -eq $proc.ParentProcessId })
  if ($parent.Count -eq 0) { $mainPid = $proc.ProcessId; break }
}
if ($mainPid -eq 0 -and $alive.Count -gt 0) { $mainPid = ($alive | Select-Object -First 1).ProcessId }

if ($mainPid -ne 0) {
  Log ('waiting on the main process handle (pid ' + $mainPid + ')')
  # Blocks on the process handle (WaitForSingleObject). No polling, no CPU, and
  # no -Timeout (its ceiling on Windows PowerShell is 32767 seconds).
  while ($true) {
    if (-not (Get-Process -Id $mainPid -ErrorAction SilentlyContinue)) { break }
    try {
      Wait-Process -Id $mainPid -ErrorAction Stop
    } catch {
      if (-not (Get-Process -Id $mainPid -ErrorAction SilentlyContinue)) { break }
      Start-Sleep -Milliseconds 200
    }
  }
  Log 'main process exited (handle event)'
} else {
  Log 'the app is not running; patching immediately'
}

# Children can outlive the main process by a moment; wait for the tree to clear.
$deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline) {
  if (-not (Get-Process -Name $app -ErrorAction SilentlyContinue)) { break }
  Start-Sleep -Milliseconds 200
}
if (Get-Process -Name $app -ErrorAction SilentlyContinue) {
  Log 'processes still alive after 30s; nothing changed'
  exit 1
}

# Let Windows drop the memory-mapped asar, then swap with retries.
Start-Sleep -Milliseconds 600

# Pre-flight: re-verify the staged archive against the original before touching it.
$verifyScript = Join-Path $PSScriptRoot 'patch-asar.cjs'
try {
  & 'node' $verifyScript 'verify' '--resources' $res *> $null
  if ($LASTEXITCODE -ne 0) {
    Log 'pre-flight verification failed; nothing changed'
    exit 1
  }
  Log 'pre-flight verification passed (byte-identical except lib/main.js)'
} catch {
  Log ('pre-flight verification unavailable: ' + $_.Exception.Message + '; continuing')
}
$swapped = $false
for ($attempt = 1; $attempt -le 30; $attempt++) {
  try {
    if (Test-Path $orig) { Move-Item -Force $orig ($orig + '.' + (Get-Date -Format 'yyyyMMdd-HHmmss')) }
    Move-Item -Force $asar $orig
    Move-Item -Force $new $asar
    $swapped = $true
    break
  } catch {
    Log ('attempt ' + $attempt + ' failed: ' + $_.Exception.Message)
    if ((-not (Test-Path $asar)) -and (Test-Path $orig)) { Move-Item -Force $orig $asar }
    Start-Sleep -Milliseconds 400
  }
}

if (-not $swapped) { Log 'could not swap app.asar; original preserved'; exit 1 }

$size = (Get-Item $asar).Length
if ($size -lt 213202950) {
  Log ('patched file looks wrong (' + $size + ' bytes); restoring original')
  Move-Item -Force $asar ($asar + '.broken')
  Move-Item -Force $orig $asar
  exit 1
}

Set-Content -Path $mark -Value ('patched ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
Log ('patched: app.asar is now ' + $size + ' bytes; original kept as app.asar.orig')
Log 'done; the app was NOT started - open it yourself when ready'
exit 0
