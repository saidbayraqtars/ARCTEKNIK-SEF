param()

$ErrorActionPreference = 'Stop'
$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$StartTime  = Get-Date

Write-Host ""
Write-Host "==========================================" -ForegroundColor DarkCyan
Write-Host "   Teknik Servis - Build Script           " -ForegroundColor DarkCyan
Write-Host "==========================================" -ForegroundColor DarkCyan
Write-Host ""

# ── 1. Versiyonu artir ──────────────────────────────────────────────────────
$desktopPkgPath = "$ScriptDir\desktop\package.json"
$rootPkgPath    = "$ScriptDir\package.json"

# BOM olmadan UTF-8 ile oku/yaz. ÖNEMLI: PowerShell 5.1'de "Get-Content -Raw"
# encoding belirtilmezse dosyayi sistem ANSI kod sayfasiyla (Turkce'de 1254) okur;
# bu da UTF-8 Turkce karakterleri (ör. "İ", "ö") bozar ve her build'de katlanir.
# Bu yuzden dosyayi yazdigimiz encoding (UTF-8, BOM'suz) ile okuyoruz.
$enc = New-Object System.Text.UTF8Encoding($false)

$rawDesktop = [System.IO.File]::ReadAllText($desktopPkgPath, $enc)
if ($rawDesktop -match '"version"\s*:\s*"(\d+)\.(\d+)\.(\d+)"') {
    $major = [int]$Matches[1]
    $minor = [int]$Matches[2]
    $patch = [int]$Matches[3]
} else {
    throw "Versiyon okunamadi: $desktopPkgPath"
}

$oldVersion = "$major.$minor.$patch"
$patch++
$newVersion = "$major.$minor.$patch"

Write-Host "Versiyon: $oldVersion  ->  $newVersion" -ForegroundColor Yellow

$updatedDesktop = $rawDesktop -replace '"version"\s*:\s*"[^"]*"', "`"version`": `"$newVersion`""
[System.IO.File]::WriteAllText($desktopPkgPath, $updatedDesktop, $enc)

$rawRoot     = [System.IO.File]::ReadAllText($rootPkgPath, $enc)
$updatedRoot = $rawRoot -replace '"version"\s*:\s*"[^"]*"', "`"version`": `"$newVersion`""
[System.IO.File]::WriteAllText($rootPkgPath, $updatedRoot, $enc)

Write-Host "package.json dosyalari guncellendi." -ForegroundColor Green
Write-Host ""

# ── 2. Client build (desktop modu) ─────────────────────────────────────────
Write-Host "[1/2] Client build ediliyor (desktop modu)..." -ForegroundColor Cyan
Set-Location $ScriptDir
npm run build:desktop
if ($LASTEXITCODE -ne 0) { throw "Client build basarisiz oldu." }
Write-Host "Client build tamamlandi." -ForegroundColor Green
Write-Host ""

# ── 3. Electron installer ───────────────────────────────────────────────────
Write-Host "[2/2] Electron installer olusturuluyor..." -ForegroundColor Cyan
Set-Location "$ScriptDir\desktop"
npm run dist
if ($LASTEXITCODE -ne 0) { throw "Electron build basarisiz oldu." }
Write-Host "Electron build tamamlandi." -ForegroundColor Green
Write-Host ""

# ── 4. EXE'yi masaustune kopyala ───────────────────────────────────────────
# Bu surumun kurulum dosyasini bul (productName'den bagimsiz; __uninstaller haric).
$desktopFolder = [Environment]::GetFolderPath('Desktop')
# NOT: artifactName surumu/bosluklari icermez (ör. "Bayraktar_Yazilim_Suite_Setup.exe").
# Bu yuzden surumle degil, "*Setup*.exe" deseni + en yeni dosya ile bul; uninstaller'i ele.
$found = Get-ChildItem "$ScriptDir\desktop\release" -Filter "*Setup*.exe" -ErrorAction SilentlyContinue |
         Where-Object { $_.Name -notlike '*uninstall*' } |
         Sort-Object LastWriteTime -Descending |
         Select-Object -First 1
if (-not $found) {
    throw "Kurulum EXE bulunamadi: $ScriptDir\desktop\release\*Setup*.exe"
}
$exeSource = $found.FullName
$exeDest   = "$desktopFolder\$($found.Name)"

Copy-Item $exeSource $exeDest -Force

$elapsed = [math]::Round(((Get-Date) - $StartTime).TotalSeconds)
Write-Host "==========================================" -ForegroundColor DarkGreen
Write-Host "  Build tamamlandi!  ($elapsed saniye)"    -ForegroundColor DarkGreen
Write-Host "  Versiyon : $newVersion"                  -ForegroundColor DarkGreen
Write-Host "  EXE      : $exeDest"                     -ForegroundColor DarkGreen
Write-Host "==========================================" -ForegroundColor DarkGreen
Write-Host ""
