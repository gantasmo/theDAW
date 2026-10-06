<#
.SYNOPSIS
    Configures, builds and installs thedaw-vst-host.exe.

.DESCRIPTION
    Builds out of source and copies only the finished binary back into the
    worktree at native/vst-host/bin/, which is gitignored.

    The build tree defaults to native/vst-host/build, gitignored beside it, so
    the script works on a machine that has nothing but a system drive. Put it
    somewhere else - a scratch volume, a faster disk - with -BuildDir or the
    THEDAW_VST_BUILD_DIR environment variable; -BuildDir wins over both.

    The CMake generator is chosen here, never left to CMake's default: a CMake
    whose default is Ninja (the WinLibs build of CMake is one) would
    otherwise pick up whatever compiler is first on PATH and reject the
    platform argument outright. The newest Visual Studio that has the C++
    toolset, found through vswhere, gets its own generator with -A x64. -Generator
    or $env:CMAKE_GENERATOR names one explicitly; Ninja and NMake take no -A and
    need cl.exe on PATH, which a Visual Studio developer prompt provides.

.EXAMPLE
    .\build.ps1
    .\build.ps1 -Vst3 OFF
    .\build.ps1 -Clean -BuildDir D:\scratch\vst-host
    .\build.ps1 -ConfigureOnly -BuildDir D:\scratch\vst-host
    .\build.ps1 -Generator Ninja     # from a VS developer prompt
#>
[CmdletBinding()]
param(
    # ON by default: the host is only useful with the VST3 layer linked in. -Vst3 OFF still
    # builds the engine alone (null plugin + protocol), which is what the engine tests need when
    # no plugin is involved.
    [ValidateSet('ON', 'OFF')]
    [string]$Vst3 = 'ON',

    # Empty on purpose: the real default needs $here, which does not exist yet
    # at parameter-binding time. Resolved just below, in this order: -BuildDir,
    # then $env:THEDAW_VST_BUILD_DIR, then <this directory>\build.
    [string]$BuildDir = '',

    [ValidateSet('Release', 'Debug', 'RelWithDebInfo')]
    [string]$Config = 'Release',

    [switch]$Clean,

    [switch]$NoWerror,

    # Configure the build tree and stop: nothing is compiled and nothing is
    # copied into bin/.
    [switch]$ConfigureOnly,

    # A CMake generator name, e.g. 'Visual Studio 17 2022' or 'Ninja'. Empty
    # picks one; see the description above.
    [string]$Generator = ''
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

function Resolve-Cmake {
    # PATH first: whatever `cmake` the user's shell resolves is the one every
    # other tool of theirs uses, and it is the one theDAW.bat tested for before
    # it offered this build. The absolute paths below are only a fallback for
    # installs that never put CMake on PATH.
    $found = Get-Command cmake -ErrorAction SilentlyContinue
    if ($found) { return $found.Source }
    $candidates = @(
        'C:\Program Files\Python313\Scripts\cmake.exe',
        'C:\Program Files\CMake\bin\cmake.exe'
    )
    foreach ($candidate in $candidates) {
        if (Test-Path $candidate) { return $candidate }
    }
    throw 'cmake was not found. Install CMake or add it to PATH.'
}

function Find-VisualStudio {
    # Every complete Visual Studio instance that has the x64 C++ toolset,
    # newest first. vswhere ships with the Visual Studio installer at a fixed
    # path, Build Tools included.
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (-not (Test-Path $vswhere)) { return @() }
    $json = (& $vswhere -products '*' -requires 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64' -format json) | Out-String
    if (-not $json.Trim()) { return @() }
    # Windows PowerShell 5.1 passes a parsed JSON array down the pipeline as ONE
    # object, so on a machine with two Visual Studio installs the sort below
    # would get one array as its only item. Piping the parsed variable
    # enumerates it in 5.1 and in 7.
    $parsed = ConvertFrom-Json -InputObject $json
    $instances = @($parsed | ForEach-Object { $_ })
    return @($instances | Sort-Object { [version]$_.installationVersion } -Descending)
}

function Get-CachedGenerator($dir) {
    # The generator an existing build tree was configured with. CMake refuses
    # to reconfigure a tree with a different one, and a configure that failed
    # still leaves its generator behind in the cache.
    $cache = Join-Path $dir 'CMakeCache.txt'
    if (-not (Test-Path $cache)) { return $null }
    $hit = Select-String -Path $cache -Pattern '^CMAKE_GENERATOR:INTERNAL=(.*)$' | Select-Object -First 1
    if ($hit) { return $hit.Matches[0].Groups[1].Value }
    return $null
}

function Resolve-Generator($cmake, $cached) {
    # Returns @{ Name = <generator>; Instance = <VS install path or $null> }.
    $haveCl = [bool](Get-Command cl.exe -ErrorAction SilentlyContinue)
    $explicit = if ($Generator) { $Generator } else { $env:CMAKE_GENERATOR }
    if ($explicit) {
        return @{ Name = $explicit; Instance = $null }
    }
    # A tree configured from a developer prompt with Ninja or NMake keeps its
    # generator while that prompt's compiler is still here.
    if ($cached -and $cached -notlike 'Visual Studio*' -and $haveCl) {
        return @{ Name = $cached; Instance = $null }
    }
    $known = (& $cmake --help) | Out-String
    $installed = Find-VisualStudio
    foreach ($vs in $installed) {
        $major = ([version]$vs.installationVersion).Major
        # The name is read out of this cmake's own generator list. Building it
        # from catalog.productLineVersion worked while that was the year: for
        # Visual Studio 2026 it is "18", "Visual Studio 18 18" is a generator
        # no cmake has, and the newest install was passed over for an older one.
        $hit = [regex]::Match($known, "Visual Studio $major \d{4}")
        if ($hit.Success) {
            return @{ Name = $hit.Value; Instance = $vs.installationPath }
        }
    }
    if ($installed.Count -gt 0) {
        throw ("Visual Studio $($installed[0].installationVersion) is installed, but $cmake is too old " +
            'to generate projects for it. Install a newer CMake, or pass -Generator.')
    }
    if ($haveCl) {
        if (Get-Command ninja -ErrorAction SilentlyContinue) { return @{ Name = 'Ninja'; Instance = $null } }
        return @{ Name = 'NMake Makefiles'; Instance = $null }
    }
    throw ('No Visual Studio with the C++ build tools was found. Install the Visual Studio Build Tools ' +
        'with the "Desktop development with C++" workload, then run this again.')
}

# -BuildDir beats the environment, which beats the gitignored tree beside the
# sources. Nothing here assumes a drive that this machine may not have.
if (-not $BuildDir) { $BuildDir = $env:THEDAW_VST_BUILD_DIR }
if (-not $BuildDir) { $BuildDir = Join-Path $here 'build' }

$cmake = Resolve-Cmake
Write-Host "cmake:     $cmake"
Write-Host "source:    $here"
Write-Host "build dir: $BuildDir"
Write-Host "vst3:      $Vst3"

if ($Clean -and (Test-Path $BuildDir)) {
    Write-Host "Removing the existing build tree..."
    Remove-Item -Recurse -Force $BuildDir
}
if (-not (Test-Path $BuildDir)) {
    New-Item -ItemType Directory -Force -Path $BuildDir | Out-Null
}

$werror = if ($NoWerror) { 'OFF' } else { 'ON' }

$cached = Get-CachedGenerator $BuildDir
$gen = Resolve-Generator $cmake $cached
$isVs = $gen.Name -like 'Visual Studio*'
Write-Host "generator: $($gen.Name)"

if ($cached -and $cached -ne $gen.Name) {
    # What CMake itself asks for in this case: the cache and CMakeFiles go,
    # the rest of the tree stays.
    Write-Host "The build tree was configured for '$cached'; configuring it again for '$($gen.Name)'."
    Remove-Item -Force (Join-Path $BuildDir 'CMakeCache.txt')
    $cmakeFiles = Join-Path $BuildDir 'CMakeFiles'
    if (Test-Path $cmakeFiles) { Remove-Item -Recurse -Force $cmakeFiles }
}

$configureArgs = @(
    '-S', $here,
    '-B', $BuildDir,
    '-G', $gen.Name
)
if ($isVs) {
    # Only the Visual Studio generators take a platform. Ninja and NMake build
    # for whatever the developer prompt's cl.exe targets.
    $configureArgs += @('-A', 'x64')
    if ($gen.Instance) { $configureArgs += "-DCMAKE_GENERATOR_INSTANCE=$($gen.Instance)" }
} else {
    if (-not (Get-Command cl.exe -ErrorAction SilentlyContinue)) {
        throw ("The '$($gen.Name)' generator builds with the compiler on PATH, and cl.exe is not on PATH. " +
            'Run this from an "x64 Native Tools Command Prompt for VS", or leave -Generator empty.')
    }
    # Named, so a MinGW g++ earlier on PATH is never picked up instead.
    $configureArgs += '-DCMAKE_CXX_COMPILER=cl.exe'
}
$configureArgs += @(
    "-DTHEDAW_VST3=$Vst3",
    "-DTHEDAW_WERROR=$werror",
    "-DCMAKE_BUILD_TYPE=$Config"
)

$started = Get-Date
& $cmake @configureArgs
if ($LASTEXITCODE -ne 0) { throw "cmake configure failed with exit code $LASTEXITCODE" }

if ($ConfigureOnly) {
    Write-Host ''
    Write-Host "configured  $BuildDir"
    return
}

& $cmake --build $BuildDir --config $Config --parallel
if ($LASTEXITCODE -ne 0) { throw "cmake build failed with exit code $LASTEXITCODE" }

$candidates = @(
    (Join-Path $BuildDir "$Config\thedaw-vst-host.exe"),
    (Join-Path $BuildDir 'thedaw-vst-host.exe')
)
$exe = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $exe) { throw "the build finished but thedaw-vst-host.exe was not found under $BuildDir" }

$binDir = Join-Path $here 'bin'
if (-not (Test-Path $binDir)) { New-Item -ItemType Directory -Force -Path $binDir | Out-Null }
$target = Join-Path $binDir 'thedaw-vst-host.exe'
Copy-Item -Force $exe $target

$elapsed = (Get-Date) - $started
$sizeKb = [math]::Round((Get-Item $target).Length / 1KB, 1)
Write-Host ''
Write-Host "built  $target"
Write-Host ("size   {0} KB" -f $sizeKb)
Write-Host ("time   {0:n1} s" -f $elapsed.TotalSeconds)
