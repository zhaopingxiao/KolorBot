# KolorBot 启停脚本：停掉正在跑的实例，然后后台拉起新的。
#
#   .\restart.cmd                      # 重启（默认 host 100.87.104.6:3399）
#   .\restart.cmd stop                 # 只停
#   .\restart.cmd status               # 看状态
#   .\restart.cmd restart -Port 3400   # 换端口
#   .\restart.cmd start -Foreground    # 前台跑，方便看报错
#
# 新实例用 tsx 直接跑源码（等价 npm run web），日志在 logs\kolor-web.log。

[CmdletBinding()]
param(
  [ValidateSet('restart', 'start', 'stop', 'status')]
  [string]$Action = 'restart',

  # 默认监听 Tailscale 地址；局域网可用 0.0.0.0，本机用 127.0.0.1。
  [string]$BindHost = '100.87.104.6',

  [int]$Port = 3399,

  # 等待 /api/config 就绪的秒数。
  [int]$TimeoutSeconds = 60,

  # 前台运行（前台时 Ctrl+C 即退出，不写日志）
  [switch]$Foreground
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $root 'package.json'))) {
  throw "找不到项目根目录（$PSScriptRoot 的上层没有 package.json）"
}

$logDir = Join-Path $root 'logs'
$logFile = Join-Path $logDir 'kolor-web.log'
$pidFile = Join-Path $logDir 'kolor-web.pid'
$url = "http://${BindHost}:${Port}"

# ---------------------------------------------------------------- 进程查找

# 占用该端口的监听进程。
function Get-KolorListeners {
  $ids = @()
  try {
    $ids = @(
      Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop |
        Select-Object -ExpandProperty OwningProcess -Unique
    )
  } catch {
    $ids = @(
      netstat -ano | Select-String ":$Port\s" | ForEach-Object {
        $parts = @(($_.ToString() -split '\s+') | Where-Object { $_ -ne '' })
        if ($parts.Length -ge 5 -and $parts[3] -eq 'LISTENING') { [int]$parts[4] }
      } | Sort-Object -Unique
    )
  }
  return @($ids | Where-Object { $_ -gt 0 })
}

# 端口没占住但还活着的残留实例（例如启动失败卡住）。
function Get-KolorStrays {
  return @(
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
      Where-Object {
        $_.CommandLine -and
        $_.CommandLine -match 'kolor-web[\\/](src[\\/]bin\.ts|dist[\\/]src[\\/]bin\.js)'
      } |
      Select-Object -ExpandProperty ProcessId
  )
}

function Get-KolorPids {
  # 注意：函数返回值会被展开，单元素时就是标量，所以这里显式累加。
  $all = @()
  $all += @(Get-KolorListeners)
  $all += @(Get-KolorStrays)
  return @($all | Where-Object { $_ -gt 0 } | Sort-Object -Unique)
}

# ---------------------------------------------------------------- 停止

function Stop-Kolor {
  $targets = @(Get-KolorPids)
  if ($targets.Count -eq 0) {
    Write-Host "· 端口 $Port 上没有正在运行的实例"
    return
  }

  foreach ($procId in $targets) {
    Write-Host "· 停止 PID $procId"
    # /T 带上 tsx 和 cmd 的子进程树，/F 强制
    & taskkill.exe /PID $procId /T /F 2>&1 | Out-Null
  }

  # 等端口真正释放（TIME_WAIT 不影响监听，只看 LISTENING）
  for ($i = 0; $i -lt 100; $i++) {
    if (@(Get-KolorListeners).Count -eq 0) { break }
    Start-Sleep -Milliseconds 100
  }

  $left = @(Get-KolorListeners)
  if ($left.Count -gt 0) {
    throw "端口 $Port 仍被 PID $($left -join ', ') 占用，停止失败"
  }
  if (Test-Path $pidFile) { Remove-Item $pidFile -Force -ErrorAction SilentlyContinue }
  Write-Host "· 端口 $Port 已释放"
}

# ---------------------------------------------------------------- 启动

function Start-Kolor {
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null

  $tsx = Join-Path $root 'node_modules\.bin\tsx.cmd'
  if (-not (Test-Path $tsx)) {
    throw "找不到 $tsx，先执行 pnpm install"
  }

  $serverArgs = @(
    '--tsconfig', 'tsconfig.dev.json',
    'packages/kolor-web/src/bin.ts',
    '--host', $BindHost,
    '--port', "$Port"
  )

  if ($Foreground) {
    Write-Host "· 前台启动：$url（Ctrl+C 退出）"
    Push-Location $root
    try {
      & $tsx @serverArgs
    } finally {
      Pop-Location
    }
    return
  }

  # 轮转上一次的日志，便于对比本次启动
  if (Test-Path $logFile) {
    Move-Item -Force $logFile (Join-Path $logDir 'kolor-web.prev.log')
  }

  # 用一个小的 cmd 包装文件启动：避开 Start-Process 的引号问题，
  # 同时把 stdout/stderr 合并进同一个日志。
  $launcherCmd = Join-Path $logDir 'launch.cmd'
  $batch = @(
    '@echo off',
    "cd /d `"$root`"",
    "`"$tsx`" --tsconfig tsconfig.dev.json packages/kolor-web/src/bin.ts --host $BindHost --port $Port >> `"$logFile`" 2>&1"
  )
  Set-Content -Path $launcherCmd -Value $batch -Encoding ascii

  $launcher = Start-Process -FilePath $env:ComSpec -ArgumentList @('/c', "`"$launcherCmd`"") `
    -WorkingDirectory $root -WindowStyle Hidden -PassThru

  Set-Content -Path $pidFile -Value $launcher.Id -Encoding ascii
  Write-Host "· 已启动（PID $($launcher.Id)），等待 $url 就绪…"

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $launcher.Refresh()
    if ($launcher.HasExited) {
      Write-Host "· 进程启动后立即退出（退出码 $($launcher.ExitCode)）" -ForegroundColor Red
      Show-LogTail
      throw '启动失败，日志见上面几行'
    }
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri "$url/api/config" -TimeoutSec 3
      if ($response.StatusCode -eq 200) {
        $config = $response.Content | ConvertFrom-Json
        $model = if ($config.hasModel) { $config.activeModel.label } else { '未配置（去 Web 的「模型」页添加提供商）' }
        Write-Host ""
        Write-Host "✔ KolorBot 已就绪" -ForegroundColor Green
        Write-Host "  地址  $url"
        Write-Host "  版本  $($config.version)"
        Write-Host "  模型  $model"
        Write-Host "  日志  $logFile"
        return
      }
    } catch {
      Start-Sleep -Milliseconds 300
    }
  }

  Write-Host "· 等了 $TimeoutSeconds 秒还没就绪" -ForegroundColor Yellow
  Show-LogTail
  throw '启动超时，看日志确认原因'
}

function Show-LogTail {
  if (-not (Test-Path $logFile)) {
    Write-Host '（没有日志文件）'
    return
  }
  Write-Host "---- $logFile (最后 25 行) ----"
  Get-Content -Path $logFile -Tail 25 | ForEach-Object { Write-Host $_ }
  Write-Host '--------------------------------'
}

# ---------------------------------------------------------------- 状态

function Show-Status {
  $pids = @(Get-KolorListeners)
  if ($pids.Count -eq 0) {
    Write-Host "· 端口 $Port 没有监听进程（未运行）"
    return
  }
  Write-Host "· 端口 $Port 监听中，PID $($pids -join ', ')"
  try {
    $config = (Invoke-WebRequest -UseBasicParsing -Uri "$url/api/config" -TimeoutSec 3).Content |
      ConvertFrom-Json
    $model = if ($config.hasModel) { $config.activeModel.label } else { '未配置' }
    Write-Host "  地址  $url"
    Write-Host "  版本  $($config.version)"
    Write-Host "  模型  $model"
  } catch {
    Write-Host "  $url 没有响应：$($_.Exception.Message)" -ForegroundColor Yellow
  }
  if (Test-Path $logFile) {
    Write-Host "  日志  $logFile"
  }
}

# ---------------------------------------------------------------- 入口

switch ($Action) {
  'status' {
    Show-Status
  }
  'stop' {
    Stop-Kolor
  }
  'start' {
    Start-Kolor
  }
  'restart' {
    Stop-Kolor
    Start-Kolor
  }
}
