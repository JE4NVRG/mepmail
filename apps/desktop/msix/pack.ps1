# Builds the Microsoft Store package (MSIX) of MepMail Correio.
#
#   pwsh apps/desktop/msix/pack.ps1            # build the store exe, then pack
#   pwsh apps/desktop/msix/pack.ps1 -SkipBuild # pack the exe already built
#
# Identity values come from msix/identity.json (Partner Center > the app >
# Product identity: Package/Identity/Name, Package/Identity/Publisher,
# Package/Properties/PublisherDisplayName). Without that file the package
# gets placeholder values: it validates, but Partner Center refuses it.
# The Store signs the package itself; no certificate is needed to submit.
# Output: src-tauri/target/msix/MepMail-Correio_<version>_x64.msix
param(
  [switch]$SkipBuild
)
$ErrorActionPreference = "Stop"

$desktop = Split-Path -Parent $PSScriptRoot
$tauri = Join-Path $desktop "src-tauri"
$targetDir = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { Join-Path $tauri "target" }
$exe = Join-Path $targetDir "release\mepmail-correio.exe"

# MSIX versions are four numbers, the first one not 0 and the last one 0
# (reserved for the Store).
$semver = (Get-Content (Join-Path $tauri "tauri.conf.json") -Raw | ConvertFrom-Json).version
if ($semver -notmatch '^(\d+)\.(\d+)\.(\d+)$') { throw "tauri.conf.json version '$semver' is not x.y.z" }
if ([int]$Matches[1] -lt 1) { throw "The Store needs a version of 1.0.0 or later (tauri.conf.json has $semver)" }
$version = "$semver.0"

$identityFile = Join-Path $PSScriptRoot "identity.json"
if (Test-Path $identityFile) {
  $identity = Get-Content $identityFile -Raw | ConvertFrom-Json
  $suffix = ""
} else {
  Write-Warning "msix/identity.json is missing: packing with placeholder identity (not accepted by Partner Center)."
  $identity = [pscustomobject]@{
    identityName = "MepMail.CorreioLocal"
    publisher = "CN=MepMail Local Test"
    publisherDisplayName = "MepMail"
  }
  $suffix = "-local"
}

if (-not $SkipBuild) {
  Push-Location $desktop
  try {
    npx tauri build --no-bundle --features store
    if ($LASTEXITCODE -ne 0) { throw "tauri build failed ($LASTEXITCODE)" }
  } finally {
    Pop-Location
  }
}
if (-not (Test-Path $exe)) { throw "No store build at $exe" }

$out = Join-Path $targetDir "msix"
$layout = Join-Path $out "layout"
if (Test-Path $layout) { Remove-Item -LiteralPath $layout -Recurse -Force }
New-Item -ItemType Directory -Force (Join-Path $layout "Assets") | Out-Null
Copy-Item $exe $layout
foreach ($asset in "StoreLogo", "Square44x44Logo", "Square71x71Logo", "Square150x150Logo") {
  Copy-Item (Join-Path $tauri "icons\$asset.png") (Join-Path $layout "Assets\$asset.png")
}

$escape = { param($value) [System.Security.SecurityElement]::Escape([string]$value) }
$manifest = Get-Content (Join-Path $PSScriptRoot "AppxManifest.xml") -Raw
$manifest = $manifest.Replace("{{IDENTITY_NAME}}", (& $escape $identity.identityName))
$manifest = $manifest.Replace("{{PUBLISHER}}", (& $escape $identity.publisher))
$manifest = $manifest.Replace("{{PUBLISHER_DISPLAY_NAME}}", (& $escape $identity.publisherDisplayName))
$manifest = $manifest.Replace("{{VERSION}}", $version)
if ($manifest -match '\{\{[A-Z_]+\}\}') { throw "Unfilled token in AppxManifest.xml: $($Matches[0])" }
Set-Content -LiteralPath (Join-Path $layout "AppxManifest.xml") -Value $manifest -Encoding utf8NoBOM

$sdk = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin" -Directory |
  Where-Object { Test-Path (Join-Path $_.FullName "x64\makeappx.exe") } |
  Sort-Object { [version]$_.Name } | Select-Object -Last 1
if (-not $sdk) { throw "makeappx.exe not found: install the Windows SDK" }
$makeappx = Join-Path $sdk.FullName "x64\makeappx.exe"

$package = Join-Path $out "MepMail-Correio_${version}_x64$suffix.msix"
$log = & $makeappx pack /d $layout /p $package /o 2>&1
if ($LASTEXITCODE -ne 0) {
  $log | Select-String "error" | ForEach-Object { Write-Error $_.Line -ErrorAction Continue }
  throw "makeappx failed ($LASTEXITCODE)"
}
Write-Output "Packed $package"
