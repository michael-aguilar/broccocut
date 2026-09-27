[CmdletBinding()]
param(
    [string]$PackagePath,
    [switch]$VerifyOnly
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -AssemblyName System.IO.Compression.FileSystem

# Keep this path stable: the Start menu and optional MP4 folder launcher use it.
$programsRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Programs'))
$installPath = Join-Path $programsRoot 'Broccocut'
$backupRoot = Join-Path $programsRoot 'Broccocut-backups'
$stagePath = Join-Path $programsRoot ('.Broccocut-stage-' + [Guid]::NewGuid().ToString('N'))
$requiredFiles = @('broccocut.exe', 'resources/app.asar', 'resources/ffmpeg.exe', 'resources/ffprobe.exe')

function Assert-SafeLocation([string]$Path) {
    $fullPath = [IO.Path]::GetFullPath($Path)
    if (-not $fullPath.StartsWith($programsRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "Path is outside the Programs folder: $fullPath"
    }
    # Refuse redirected directories, including a junction in a parent path.
    $cursor = $fullPath
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "Refusing to update through a symbolic link or junction: $cursor"
            }
        }
        $parent = [IO.Directory]::GetParent($cursor)
        if ($null -eq $parent) { break }
        $cursor = $parent.FullName
    }
}

function Assert-AppClosed {
    $running = @(Get-CimInstance Win32_Process -Filter "Name = 'broccocut.exe'" | Where-Object {
        $_.ExecutablePath -and $_.ExecutablePath.StartsWith($installPath + '\', [StringComparison]::OrdinalIgnoreCase)
    })
    if ($running.Count) { throw 'Close Broccocut first, then run this command again. Your open work has not been interrupted.' }
}

# The .llc fileAssociations in package.json are only registered by installer
# targets; a ZIP install has none, so register the project type for this user.
# Another app's claim on .llc and choices made in Default apps are kept.
function Register-ProjectFiles([string]$ExePath) {
    $progId = 'Broccocut.Project'
    # CreateSubKey opens existing keys without clearing them, unlike New-Item -Force.
    function Set-ClassValue([string]$SubKey, [string]$Name, $Value, $Kind = [Microsoft.Win32.RegistryValueKind]::String) {
        $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey("Software\Classes\$SubKey")
        try { $key.SetValue($Name, $Value, $Kind) } finally { $key.Dispose() }
    }
    Set-ClassValue $progId '' 'Broccocut project'
    Set-ClassValue "$progId\DefaultIcon" '' "`"$ExePath`",0"
    Set-ClassValue "$progId\shell\open\command" '' "`"$ExePath`" `"%1`""
    Set-ClassValue '.llc\OpenWithProgids' $progId ([byte[]]@()) ([Microsoft.Win32.RegistryValueKind]::None)
    $extension = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Software\Classes\.llc')
    try {
        $current = $extension.GetValue('')
        if (-not $current -or $current -eq $progId) {
            $extension.SetValue('', $progId)
            Write-Output '.llc project files open in Broccocut.'
        } else { Write-Output ".llc files still open with $current; Broccocut is listed under Open with." }
    } finally { $extension.Dispose() }
    # Let Explorer pick up the change without signing out.
    Add-Type -Namespace Broccocut -Name Shell -MemberDefinition '[DllImport("shell32.dll")] public static extern void SHChangeNotify(int eventId, uint flags, IntPtr item1, IntPtr item2);'
    [Broccocut.Shell]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)
}

if (-not $PackagePath) {
    if ($VerifyOnly) { throw 'Use -PackagePath with -VerifyOnly.' }
    Assert-AppClosed
    $repoRoot = Split-Path -Parent $PSScriptRoot
    $yarnPath = Join-Path $repoRoot '.yarn/releases/yarn-4.18.0.cjs'
    if (-not (Test-Path -LiteralPath $yarnPath)) { throw 'Run this script from the Broccocut source checkout.' }
    $savedSigning = $env:CSC_IDENTITY_AUTO_DISCOVERY
    Push-Location $repoRoot
    try {
        $env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
        & node $yarnPath pack-win --publish never
        if ($LASTEXITCODE -ne 0) { throw 'Windows build failed. The installed app was not changed.' }
    } finally {
        $env:CSC_IDENTITY_AUTO_DISCOVERY = $savedSigning
        Pop-Location
    }
    $PackagePath = Join-Path $repoRoot 'dist/broccocut-win-x64.zip'
}

$resolvedPackage = (Resolve-Path -LiteralPath $PackagePath).Path
$archive = [IO.Compression.ZipFile]::OpenRead($resolvedPackage)
try {
    $names = @($archive.Entries | ForEach-Object { $_.FullName.Replace('\', '/') })
    foreach ($required in $requiredFiles) {
        $entry = @($archive.Entries | Where-Object { $_.FullName.Replace('\', '/') -ceq $required })
        if ($entry.Count -ne 1 -or $entry[0].Length -eq 0) { throw "Incomplete package: $required" }
    }
    foreach ($entry in $archive.Entries) {
        if ($entry.FullName.Contains(':') -or [IO.Path]::IsPathRooted($entry.FullName)) { throw 'Package contains an absolute path.' }
        $entryPath = [IO.Path]::GetFullPath((Join-Path $stagePath $entry.FullName))
        if (-not $entryPath.StartsWith($stagePath + '\', [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Package contains a path outside its extraction directory.'
        }
    }
} finally { $archive.Dispose() }

if ($VerifyOnly) {
    Write-Output "Verified Windows package: $resolvedPackage"
    return
}

Assert-SafeLocation $installPath
Assert-SafeLocation $backupRoot
Assert-SafeLocation $stagePath
Assert-AppClosed
New-Item -ItemType Directory -Path $programsRoot -Force | Out-Null
$backupPath = $null
$oldMoved = $false
$newMoved = $false
try {
    [IO.Compression.ZipFile]::ExtractToDirectory($resolvedPackage, $stagePath)
    foreach ($required in $requiredFiles) {
        if (-not (Test-Path -LiteralPath (Join-Path $stagePath $required) -PathType Leaf)) { throw "Extracted package is missing $required" }
    }
    # Check again in case the app was opened while extracting.
    Assert-AppClosed
    if (Test-Path -LiteralPath $installPath) {
        New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
        $backupPath = Join-Path $backupRoot ((Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
        Assert-SafeLocation $installPath
        Assert-SafeLocation $backupPath
        Move-Item -LiteralPath $installPath -Destination $backupPath
        $oldMoved = $true
    }
    Assert-SafeLocation $stagePath
    Assert-SafeLocation $installPath
    Move-Item -LiteralPath $stagePath -Destination $installPath
    $newMoved = $true

    $shortcutFolder = Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs'
    $shortcutFile = Join-Path $shortcutFolder 'Broccocut.lnk'
    New-Item -ItemType Directory -Path $shortcutFolder -Force | Out-Null
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutFile)
    $shortcut.TargetPath = Join-Path $installPath 'broccocut.exe'
    $shortcut.WorkingDirectory = $installPath
    $shortcut.IconLocation = $shortcut.TargetPath + ',0'
    $shortcut.Description = 'Broccocut video editor'
    $shortcut.Save()
    try { Register-ProjectFiles (Join-Path $installPath 'broccocut.exe') }
    catch { Write-Warning "Broccocut is updated, but .llc files could not be associated: $_" }
    Write-Output "Updated Broccocut at $installPath"
    if ($backupPath) { Write-Output "Previous version retained at $backupPath" }
    Write-Output 'Your profile, MP4 folder launcher, and default-app selection are unchanged.'
} catch {
    if ($oldMoved -and -not $newMoved -and -not (Test-Path -LiteralPath $installPath)) {
        Assert-SafeLocation $backupPath
        Assert-SafeLocation $installPath
        Move-Item -LiteralPath $backupPath -Destination $installPath
        Write-Warning 'Installation failed; the previous app has been restored.'
    }
    throw
} finally {
    if (Test-Path -LiteralPath $stagePath) {
        Assert-SafeLocation $stagePath
        Remove-Item -LiteralPath $stagePath -Recurse -Force
    }
}
