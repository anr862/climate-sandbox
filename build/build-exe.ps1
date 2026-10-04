# Build PlanetaryClimateSim.exe
#
# Uses the .NET Framework compiler that ships with Windows (csc.exe), so no SDK,
# no npm and no network access are required.
#
#   powershell -ExecutionPolicy Bypass -File build\build-exe.ps1
#
# Output: dist\PlanetaryClimateSim.exe  (plus a copy of the app next to it)

param(
    [string]$OutDir = "dist",
    [switch]$ConsoleOnly
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root $OutDir

Write-Host "== Planetary Climate Sim :: exe build ==" -ForegroundColor Cyan
Write-Host "Project root: $root"

# ---- locate csc.exe ---------------------------------------------------------
$candidates = @(
    "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
    "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe"
)
$csc = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $csc) {
    throw "csc.exe not found (.NET Framework 4.x compiler). Expected at $($candidates[0])."
}
Write-Host "Compiler    : $csc"

New-Item -ItemType Directory -Force -Path $out | Out-Null

$common = @(
    "/nologo",
    "/platform:anycpu",
    "/optimize+",
    "/langversion:5",
    "/reference:System.dll",
    "/reference:System.Drawing.dll",
    "/reference:System.Windows.Forms.dll",
    (Join-Path $PSScriptRoot "launcher.cs")
)

# ---- windowed executable ----------------------------------------------------
$exe = Join-Path $out "PlanetaryClimateSim.exe"
$argsWin = @("/target:winexe", "/out:$exe") + $common
Write-Host "Compiling   : windowed -> $exe" -ForegroundColor Yellow
& $csc $argsWin
if ($LASTEXITCODE -ne 0) { throw "compile failed (exit $LASTEXITCODE)" }

# ---- console variant --------------------------------------------------------
$exeCon = Join-Path $out "PlanetaryClimateSim-console.exe"
$argsCon = @("/target:exe", "/out:$exeCon") + $common
Write-Host "Compiling   : console  -> $exeCon" -ForegroundColor Yellow
& $csc $argsCon
if ($LASTEXITCODE -ne 0) { throw "console compile failed (exit $LASTEXITCODE)" }

# ---- stage the app next to the exe -----------------------------------------
Write-Host "Staging app files..." -ForegroundColor Yellow
$appDir = Join-Path $out "app"
if (Test-Path $appDir) { Remove-Item $appDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $appDir | Out-Null

foreach ($f in @("index.html", "README.md", "serve.mjs")) {
    $src = Join-Path $root $f
    if (Test-Path $src) { Copy-Item $src $appDir -Force }
}
foreach ($d in @("src", "styles", "tests", "scripts")) {
    $src = Join-Path $root $d
    if (Test-Path $src) { Copy-Item $src $appDir -Recurse -Force }
}

# The launcher looks for index.html beside itself first, so also mirror the app
# at the top level: dist\index.html + dist\src, which is the simplest layout.
Copy-Item (Join-Path $appDir "index.html") $out -Force
foreach ($d in @("src", "styles", "tests")) {
    $dst = Join-Path $out $d
    if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
    Copy-Item (Join-Path $appDir $d) $out -Recurse -Force
}

# ---- report -----------------------------------------------------------------
$sizeKb = [math]::Round((Get-Item $exe).Length / 1KB)
Write-Host ""
Write-Host "Done." -ForegroundColor Green
Write-Host ("  {0}  ({1} kB)" -f $exe, $sizeKb)
Write-Host ("  {0}  (console variant)" -f $exeCon)
Write-Host ("  app files copied to {0}" -f $out)
Write-Host ""
Write-Host "Double-click the exe: it starts a local server and opens the browser." -ForegroundColor Cyan
Write-Host "The whole '$OutDir' folder is portable and runs offline - no Node needed."
if ($ConsoleOnly) { Write-Host "(ConsoleOnly flag is accepted for compatibility; both variants are built.)" }
