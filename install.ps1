[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$repoZip = 'https://github.com/yuval-kahan/youchords-local/archive/refs/heads/main.zip'
$installRoot = Join-Path $env:LOCALAPPDATA 'YouChordsLocal'
$stateRoot = Join-Path $env:LOCALAPPDATA 'YouChordsLocalData'
$tokenPath = Join-Path $stateRoot 'pairing-token.txt'
$downloadPath = Join-Path $env:TEMP 'youchords-local-main.zip'
$extractRoot = Join-Path $env:TEMP 'youchords-local-install'

function New-PairingToken {
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return ([BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
}

function Assert-SafeInstallPath([string]$Path) {
    $resolvedParent = [IO.Path]::GetFullPath((Split-Path -Parent $Path))
    $expectedParent = [IO.Path]::GetFullPath($env:LOCALAPPDATA)
    if ($resolvedParent -ne $expectedParent -or (Split-Path -Leaf $Path) -ne 'YouChordsLocal') {
        throw "Refusing to replace unexpected path: $Path"
    }
}

Write-Host 'YouChords Local setup' -ForegroundColor Cyan

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw 'Docker Desktop is required. Install it from https://www.docker.com/products/docker-desktop/ and run this command again.'
}
docker info *> $null
if ($LASTEXITCODE -ne 0) {
    throw 'Docker Desktop is installed but not running. Start it and run this command again.'
}

New-Item -ItemType Directory -Force -Path $stateRoot | Out-Null
if (Test-Path -LiteralPath $tokenPath) {
    $pairingToken = (Get-Content -LiteralPath $tokenPath -Raw).Trim()
} else {
    $pairingToken = New-PairingToken
    Set-Content -LiteralPath $tokenPath -Value $pairingToken -Encoding ascii
}

if (Test-Path -LiteralPath $extractRoot) {
    Remove-Item -LiteralPath $extractRoot -Recurse -Force
}
Remove-Item -LiteralPath $downloadPath -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $extractRoot | Out-Null

Write-Host 'Downloading the open-source release...'
Invoke-WebRequest -Uri $repoZip -OutFile $downloadPath
Expand-Archive -LiteralPath $downloadPath -DestinationPath $extractRoot -Force
$sourceRoot = Get-ChildItem -LiteralPath $extractRoot -Directory | Select-Object -First 1
if (-not $sourceRoot) { throw 'Downloaded release did not contain the project directory.' }

Assert-SafeInstallPath $installRoot
if (Test-Path -LiteralPath $installRoot) {
    Remove-Item -LiteralPath $installRoot -Recurse -Force
}
Move-Item -LiteralPath $sourceRoot.FullName -Destination $installRoot

$configExample = Join-Path $installRoot 'apps\extension\config\local-config.example.js'
$configPath = Join-Path $installRoot 'apps\extension\config\local-config.js'
$config = (Get-Content -LiteralPath $configExample -Raw).Replace('REPLACE_DURING_INSTALL', $pairingToken)
Set-Content -LiteralPath $configPath -Value $config -Encoding utf8

$env:YOUCHORDS_PAIRING_TOKEN = $pairingToken
Write-Host 'Building and starting the local chord engine. The first build can take several minutes...'
docker compose --project-directory $installRoot -f (Join-Path $installRoot 'compose.yaml') up --build -d
if ($LASTEXITCODE -ne 0) { throw 'Docker could not start the YouChords Local companion.' }

$headers = @{ Authorization = "Bearer $pairingToken" }
$healthy = $false
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    try {
        $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8765/v1/health' -Headers $headers -TimeoutSec 2
        if ($health.ok) { $healthy = $true; break }
    } catch {
        Start-Sleep -Seconds 1
    }
}
if (-not $healthy) { throw 'The local companion started but did not pass its health check.' }

$extensionPath = Join-Path $installRoot 'apps\extension'
Set-Clipboard -Value $extensionPath
if ($env:YOUCHORDS_SKIP_OPEN_BROWSER -ne '1') {
    Start-Process 'chrome://extensions/'
}

Write-Host ''
Write-Host 'Local engine is ready.' -ForegroundColor Green
Write-Host 'Chrome requires one final manual step for unpacked extensions:'
Write-Host '  1. Enable Developer mode.'
Write-Host '  2. Click Load unpacked.'
Write-Host "  3. Select: $extensionPath"
Write-Host 'The extension path is already copied to your clipboard.' -ForegroundColor Cyan

Remove-Item -LiteralPath $downloadPath -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $extractRoot -Recurse -Force -ErrorAction SilentlyContinue
