# Teknik Servis - Windows masaüstü kurulum paketi oluşturur
# Lisans dosyalarını obfuscate eder, ardından Electron NSIS paketi üretir.
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

Write-Host "=== Teknik Servis Masaustu Kurulum Paketi ===" -ForegroundColor Cyan

# ─── 1. Server bağımlılıkları ────────────────────────────────────────────────
Write-Host "`n[1/5] Server bagimliliklari..." -ForegroundColor Yellow
Set-Location "$Root\server"
npm install --omit=dev

# ─── 2. Client (masaüstü modu) ───────────────────────────────────────────────
Write-Host "`n[2/5] Client (masaustu modu)..." -ForegroundColor Yellow
Set-Location "$Root\client"
npm install
npm run build:desktop

# ─── 3. Lisans dosyalarını obfuscate et ──────────────────────────────────────
Write-Host "`n[3/5] Lisans dosyalari obfuscate ediliyor..." -ForegroundColor Yellow

$licenseFiles = @(
    "server\services\license.js",
    "server\middleware\licenseGuard.js",
    "server\routes\license.js"
)

# javascript-obfuscator aracını kontrol et / kur
$obfuscatorBin = "$Root\server\node_modules\.bin\javascript-obfuscator.cmd"
if (-not (Test-Path $obfuscatorBin)) {
    Write-Host "  javascript-obfuscator yukluyor..." -ForegroundColor DarkYellow
    Set-Location "$Root\server"
    npm install --save-dev javascript-obfuscator --loglevel=error
}

# Orijinal dosyaları yedekle
$backupPaths = @{}
foreach ($rel in $licenseFiles) {
    $full = "$Root\$rel"
    $bak  = "$full.bak"
    Copy-Item $full $bak -Force
    $backupPaths[$full] = $bak
}

$buildSuccess = $false
try {
    # Her dosyayı yerinde obfuscate et
    foreach ($rel in $licenseFiles) {
        $full = "$Root\$rel"
        Write-Host "  Obfuscate: $rel" -ForegroundColor DarkGray
        & $obfuscatorBin $full `
            --output $full `
            --compact true `
            --identifier-names-generator hexadecimal `
            --string-array true `
            --string-array-threshold 0.8 `
            --string-array-rotate true `
            --string-array-shuffle true `
            --string-array-index-shift true `
            --string-array-encoding base64 `
            --split-strings true `
            --split-strings-chunk-length 4 `
            --numbers-to-expressions true `
            --transform-object-keys true `
            --unicode-escape-sequence false `
            --control-flow-flattening false `
            --dead-code-injection false
        if ($LASTEXITCODE -ne 0) { throw "Obfuscation basarisiz: $rel" }
    }

    # ─── 4. Electron bağımlılıkları ──────────────────────────────────────────
    Write-Host "`n[4/5] Electron..." -ForegroundColor Yellow
    Set-Location "$Root\desktop"
    npm install

    # ─── 5. NSIS kurulum paketi ───────────────────────────────────────────────
    Write-Host "`n[5/5] NSIS kurulum dosyasi olusturuluyor..." -ForegroundColor Yellow
    npm run dist

    $buildSuccess = $true

} finally {
    # Orijinal kaynak dosyaları geri yükle (build başarılı olsa da olmasa da)
    foreach ($full in $backupPaths.Keys) {
        $bak = $backupPaths[$full]
        if (Test-Path $bak) {
            Move-Item $bak $full -Force
        }
    }
    if ($buildSuccess) {
        Write-Host "`n  Kaynak dosyalar geri yuklendi." -ForegroundColor DarkGray
    } else {
        Write-Host "`n  HATA: Build basarisiz. Kaynak dosyalar geri yuklendi." -ForegroundColor Red
    }
}

# ─── Özet ────────────────────────────────────────────────────────────────────
Write-Host "`nTamamlandi! Kurulum dosyasi:" -ForegroundColor Green
Write-Host "$Root\desktop\release\" -ForegroundColor White
Write-Host "Lisans yonetim paneli: cd license-manager && node server.js" -ForegroundColor DarkCyan

Set-Location $Root
