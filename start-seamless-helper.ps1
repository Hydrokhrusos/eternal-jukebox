$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Cache = Join-Path $env:LOCALAPPDATA "SpicetifyEternalJukeboxAudioCache"
$Packages = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages"
$Script = Join-Path $Root "seamless-helper.ts"
$Log = Join-Path $Cache "helper.log"
$Err = Join-Path $Cache "helper.err.log"
$Port = 43173

function Get-ConfiguredPath {
    param([Parameter(Mandatory = $true)][string]$Name)

    foreach ($scope in @("Process", "User", "Machine")) {
        $value = [Environment]::GetEnvironmentVariable($Name, $scope)
        if ($value -and (Test-Path -LiteralPath $value -PathType Leaf)) {
            return (Resolve-Path -LiteralPath $value).Path
        }
    }

    return $null
}

function Find-CommandPath {
    param([Parameter(Mandatory = $true)][string[]]$Names)

    foreach ($name in $Names) {
        $command = Get-Command -Name $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($command -and $command.Source -and (Test-Path -LiteralPath $command.Source -PathType Leaf)) {
            return $command.Source
        }
    }

    return $null
}

function Find-ExecutableUnder {
    param(
        [Parameter(Mandatory = $true)][string]$RootPath,
        [Parameter(Mandatory = $true)][string]$FileName
    )

    if (-not (Test-Path -LiteralPath $RootPath -PathType Container)) {
        return $null
    }

    $match = Get-ChildItem -LiteralPath $RootPath -Recurse -Filter $FileName -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1

    if ($match) {
        return $match.FullName
    }

    return $null
}

function Resolve-HelperExecutable {
    param(
        [Parameter(Mandatory = $true)][string]$FileName,
        [Parameter(Mandatory = $true)][string]$EnvName,
        [switch]$Optional
    )

    $configured = Get-ConfiguredPath -Name $EnvName
    if ($configured) {
        return $configured
    }

    $baseName = [IO.Path]::GetFileNameWithoutExtension($FileName)
    $fromPath = Find-CommandPath -Names @($FileName, $baseName)
    if ($fromPath) {
        return $fromPath
    }

    $roots = @(
        $Packages,
        (Join-Path $env:LOCALAPPDATA "Programs"),
        $env:ProgramFiles,
        ${env:ProgramFiles(x86)}
    ) | Where-Object { $_ } | Select-Object -Unique

    foreach ($rootPath in $roots) {
        $found = Find-ExecutableUnder -RootPath $rootPath -FileName $FileName
        if ($found) {
            return $found
        }
    }

    if ($Optional) {
        return $null
    }

    throw "$FileName was not found. Re-run the installer so it can install the helper dependencies."
}

function Test-HelperHealth {
    try {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 1
        return [bool]$health.ok
    } catch {
        return $false
    }
}

function Quote-Argument {
    param([Parameter(Mandatory = $true)][string]$Value)

    if ($Value -notmatch '[\s"]') {
        return $Value
    }

    return '"' + ($Value -replace '"', '\"') + '"'
}

if (Test-HelperHealth) {
    exit 0
}

if (-not (Test-Path -LiteralPath $Script -PathType Leaf)) {
    throw "Helper script was not found at $Script"
}

$Deno = Resolve-HelperExecutable -FileName "deno.exe" -EnvName "EJB_DENO"
$YtDlp = Resolve-HelperExecutable -FileName "yt-dlp.exe" -EnvName "EJB_YTDLP"
$Ffmpeg = Resolve-HelperExecutable -FileName "ffmpeg.exe" -EnvName "EJB_FFMPEG" -Optional

$env:EJB_YTDLP = $YtDlp
if ($Ffmpeg) {
    $env:EJB_FFMPEG = $Ffmpeg
}
$env:EJB_AUDIO_CACHE = $Cache

New-Item -ItemType Directory -Force -Path $Cache | Out-Null

$readRoots = @(
    $Root,
    $Cache,
    (Split-Path -Parent $YtDlp)
)
if ($Ffmpeg) {
    $readRoots += Split-Path -Parent $Ffmpeg
}
if (Test-Path -LiteralPath $Packages -PathType Container) {
    $readRoots += $Packages
}
$allowRead = ($readRoots | Where-Object { $_ } | Select-Object -Unique) -join ","

$arguments = @(
    "run",
    "--no-prompt",
    "--allow-net=127.0.0.1:$Port",
    "--allow-read=$allowRead",
    "--allow-write=$Cache",
    "--allow-run=$YtDlp",
    "--allow-env=LOCALAPPDATA,PATH,EJB_HELPER_PORT,EJB_AUDIO_CACHE,EJB_YTDLP,EJB_FFMPEG",
    $Script
)

$argumentLine = ($arguments | ForEach-Object { Quote-Argument -Value $_ }) -join " "
Start-Process -FilePath $Deno -ArgumentList $argumentLine -WindowStyle Hidden -RedirectStandardOutput $Log -RedirectStandardError $Err
