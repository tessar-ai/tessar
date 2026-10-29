$ErrorActionPreference = 'Stop'
$targetRoot = 'D:\tessar-implement'
$sourceRoot = $PSScriptRoot
$archive = 'D:\tessar\dist\release\tessar-opentelemetry-0.1.0.tgz'
if (-not (Test-Path -LiteralPath $archive)) { throw "Missing package archive: $archive" }
$hashes = Get-Content -LiteralPath (Join-Path $sourceRoot 'original-hashes.json') -Raw | ConvertFrom-Json
$files = @('package.json', 'src/session.ts', '.env.telemetry.example')
foreach ($relative in $files) {
  $target = Join-Path $targetRoot $relative
  if ($null -eq $hashes.$relative) {
    if (Test-Path -LiteralPath $target) { throw "A new file already exists; review it before applying: $target" }
    continue
  }
  $actual = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash
  if ($actual -ne $hashes.$relative) {
    throw "File changed since preparation; review it before applying: $target"
  }
}
foreach ($relative in $files) {
  Copy-Item -LiteralPath (Join-Path $sourceRoot $relative) -Destination (Join-Path $targetRoot $relative)
}
Push-Location -LiteralPath $targetRoot
try {
  pnpm add "@tessar/opentelemetry@file:../tessar/dist/release/tessar-opentelemetry-0.1.0.tgz" --force
  if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed' }
  pnpm exec tsc --ignoreConfig --noEmit --module NodeNext --target ESNext --strict --exactOptionalPropertyTypes --skipLibCheck src/session.ts
  if ($LASTEXITCODE -ne 0) { throw 'Session typecheck failed' }
  Write-Host 'Ready. Run: pnpm run session'
} finally {
  Pop-Location
}

