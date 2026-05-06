$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$homeDir = $env:USERPROFILE
$customAppsDir = Join-Path $homeDir "AppData\Roaming\spicetify\CustomApps"
$name = "eternal-jukebox"
$customAppDir = Join-Path $customAppsDir $name
$startupDir = [Environment]::GetFolderPath("Startup")
$startupShortcut = Join-Path $startupDir "EternalJukeboxSeamlessHelper.lnk"
$packagesRoot = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages"
$zipUrl = "https://github.com/Hydrokhrusos/eternal-jukebox/archive/refs/heads/dist.zip"
$zipFile = Join-Path $env:TEMP "spicetifyed-eternal-jukebox.zip"
$tempDir = Join-Path $env:TEMP "spicetifyed-eternal-jukebox"
$helperPort = 43173

function Write-Step {
    param([Parameter(Mandatory = $true)][string]$Message)
    Write-Host "[eternal-jukebox] $Message"
}

function Test-PathUnder {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Root
    )

    try {
        $trimChars = @([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
        $fullPath = [IO.Path]::GetFullPath($Path).TrimEnd($trimChars)
        $fullRoot = [IO.Path]::GetFullPath($Root).TrimEnd($trimChars)
    } catch {
        return $false
    }

    return $fullPath.Equals($fullRoot, [StringComparison]::OrdinalIgnoreCase) -or
        $fullPath.StartsWith("$fullRoot$([IO.Path]::DirectorySeparatorChar)", [StringComparison]::OrdinalIgnoreCase) -or
        $fullPath.StartsWith("$fullRoot$([IO.Path]::AltDirectorySeparatorChar)", [StringComparison]::OrdinalIgnoreCase)
}

function Find-CommandPath {
    param([Parameter(Mandatory = $true)][string[]]$Names)

    foreach ($commandName in $Names) {
        $command = Get-Command -Name $commandName -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
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

function Resolve-ToolPath {
    param(
        [Parameter(Mandatory = $true)][string[]]$CommandNames,
        [Parameter(Mandatory = $true)][string]$FileName
    )

    $fromPath = Find-CommandPath -Names $CommandNames
    if ($fromPath) {
        return $fromPath
    }

    $roots = @(
        $packagesRoot,
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

    return $null
}

function Get-WinGetPath {
    $winget = Find-CommandPath -Names @("winget.exe", "winget")
    if (-not $winget) {
        throw "WinGet was not found. Install Microsoft App Installer from the Microsoft Store, then run this installer again."
    }

    return $winget
}

function Install-WinGetPackage {
    param(
        [Parameter(Mandatory = $true)][string]$Id,
        [Parameter(Mandatory = $true)][string]$DisplayName
    )

    $winget = Get-WinGetPath
    Write-Step "Installing $DisplayName with WinGet"

    $arguments = @(
        "install",
        "--id", $Id,
        "--exact",
        "--source", "winget",
        "--accept-package-agreements",
        "--accept-source-agreements",
        "--disable-interactivity",
        "--silent"
    )

    & $winget @arguments
    if ($LASTEXITCODE -ne 0) {
        throw "WinGet failed to install $DisplayName ($Id)."
    }
}

function Ensure-WinGetTool {
    param(
        [Parameter(Mandatory = $true)][string[]]$CommandNames,
        [Parameter(Mandatory = $true)][string]$FileName,
        [Parameter(Mandatory = $true)][string]$PackageId,
        [Parameter(Mandatory = $true)][string]$DisplayName
    )

    $tool = Resolve-ToolPath -CommandNames $CommandNames -FileName $FileName
    if ($tool) {
        Write-Step "$DisplayName found at $tool"
        return $tool
    }

    Install-WinGetPackage -Id $PackageId -DisplayName $DisplayName
    Start-Sleep -Seconds 2

    $tool = Resolve-ToolPath -CommandNames $CommandNames -FileName $FileName
    if (-not $tool) {
        throw "$DisplayName was installed, but $FileName was not found. Open a new PowerShell window and run this installer again."
    }

    Write-Step "$DisplayName found at $tool"
    return $tool
}

function Ensure-Spicetify {
    $spicetify = Resolve-ToolPath -CommandNames @("spicetify.exe", "spicetify") -FileName "spicetify.exe"
    if ($spicetify) {
        Write-Step "Spicetify found at $spicetify"
        return $spicetify
    }

    Install-WinGetPackage -Id "Spicetify.Spicetify" -DisplayName "Spicetify CLI"
    Start-Sleep -Seconds 2

    $spicetify = Resolve-ToolPath -CommandNames @("spicetify.exe", "spicetify") -FileName "spicetify.exe"
    if (-not $spicetify) {
        throw "Spicetify CLI was installed, but spicetify.exe was not found. Open a new PowerShell window and run this installer again."
    }

    Write-Step "Spicetify found at $spicetify"
    return $spicetify
}

function Stop-ExistingHelper {
    $connections = @(Get-NetTCPConnection -LocalPort $helperPort -State Listen -ErrorAction SilentlyContinue)
    if (-not $connections.Count) {
        return
    }

    foreach ($processId in ($connections | Select-Object -ExpandProperty OwningProcess -Unique)) {
        $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
        if (-not $process) {
            continue
        }

        if ($process.ProcessName -notlike "deno*") {
            throw "Port $helperPort is already used by $($process.ProcessName) (PID $processId). Stop that process and run the installer again."
        }

        Write-Step "Stopping existing seamless helper (PID $processId)"
        Stop-Process -Id $processId -Force
    }
}

function Install-HelperStartupShortcut {
    param([Parameter(Mandatory = $true)][string]$HelperScript)

    if (!(Test-Path -LiteralPath $startupDir)) {
        New-Item -ItemType Directory -Path $startupDir | Out-Null
    }

    $powerShell = Join-Path $PSHOME "powershell.exe"
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($startupShortcut)
    $shortcut.TargetPath = $powerShell
    $shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$HelperScript`""
    $shortcut.WorkingDirectory = Split-Path -Parent $HelperScript
    $shortcut.WindowStyle = 7
    $shortcut.Description = "Starts the Eternal Jukebox seamless audio helper"
    $shortcut.Save()

    Write-Step "Installed Startup shortcut at $startupShortcut"
}

function Start-HelperScript {
    param([Parameter(Mandatory = $true)][string]$HelperScript)

    $powerShell = Join-Path $PSHOME "powershell.exe"
    $arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$HelperScript`""
    Start-Process -FilePath $powerShell -ArgumentList $arguments -WindowStyle Hidden
}

function Wait-HelperHealth {
    param([int]$TimeoutSeconds = 45)

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:$helperPort/health" -TimeoutSec 2
            if ($health.ok) {
                Write-Step "Seamless helper is healthy"
                return
            }
        } catch {
            Start-Sleep -Milliseconds 500
        }
    } while ((Get-Date) -lt $deadline)

    $cache = Join-Path $env:LOCALAPPDATA "SpicetifyEternalJukeboxAudioCache"
    $err = Join-Path $cache "helper.err.log"
    $log = Join-Path $cache "helper.log"
    if (Test-Path -LiteralPath $err) {
        Write-Host "helper.err.log:"
        Get-Content -LiteralPath $err -Tail 40
    }
    if (Test-Path -LiteralPath $log) {
        Write-Host "helper.log:"
        Get-Content -LiteralPath $log -Tail 40
    }

    throw "Seamless helper did not become healthy on http://127.0.0.1:$helperPort/health."
}

if (-not $IsWindows -and $PSVersionTable.PSEdition -eq "Core") {
    throw "This installer currently supports Windows only."
}

Write-Step "Checking required tools"
$spicetify = Ensure-Spicetify
$null = Ensure-WinGetTool -CommandNames @("deno.exe", "deno") -FileName "deno.exe" -PackageId "DenoLand.Deno" -DisplayName "Deno"
$null = Ensure-WinGetTool -CommandNames @("yt-dlp.exe", "yt-dlp") -FileName "yt-dlp.exe" -PackageId "yt-dlp.yt-dlp" -DisplayName "yt-dlp"

Write-Step "Installing app files"
New-Item -ItemType Directory -Force -Path $customAppsDir | Out-Null
$originalLocation = (Get-Location).ProviderPath
$restoreInsideApp = Test-PathUnder -Path $originalLocation -Root $customAppDir
if ($restoreInsideApp) {
    Set-Location -LiteralPath $env:TEMP
}

if (Test-Path -LiteralPath $tempDir) {
    Remove-Item -LiteralPath $tempDir -Recurse -Force
}
if (Test-Path -LiteralPath $zipFile) {
    Remove-Item -LiteralPath $zipFile -Force
}

try {
    Invoke-WebRequest -Uri $zipUrl -OutFile $zipFile
    Expand-Archive -Path $zipFile -DestinationPath $tempDir -Force

    Stop-ExistingHelper

    $payload = Get-ChildItem -LiteralPath $tempDir | Select-Object -First 1
    if (-not $payload) {
        throw "Downloaded archive was empty."
    }

    New-Item -ItemType Directory -Force -Path $customAppDir | Out-Null
    Get-ChildItem -LiteralPath $payload.FullName -Force | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $customAppDir -Recurse -Force
    }
} finally {
    if (Test-Path -LiteralPath $zipFile) {
        Remove-Item -LiteralPath $zipFile -Force
    }
    if (Test-Path -LiteralPath $tempDir) {
        Remove-Item -LiteralPath $tempDir -Recurse -Force
    }
    if ($restoreInsideApp) {
        if (Test-Path -LiteralPath $customAppDir -PathType Container) {
            Set-Location -LiteralPath $customAppDir
        } else {
            Set-Location -LiteralPath $customAppsDir
        }
    }
}

$helperScript = Join-Path $customAppDir "start-seamless-helper.ps1"
if (-not (Test-Path -LiteralPath $helperScript -PathType Leaf)) {
    throw "Helper startup script was not found in the installed app."
}

Install-HelperStartupShortcut -HelperScript $helperScript
Start-HelperScript -HelperScript $helperScript
Wait-HelperHealth

Write-Step "Applying Spicetify custom app"
& $spicetify config custom_apps $name
if ($LASTEXITCODE -ne 0) {
    throw "spicetify config failed."
}

& $spicetify apply
if ($LASTEXITCODE -ne 0) {
    throw "spicetify apply failed."
}

Write-Step "Installation complete"
