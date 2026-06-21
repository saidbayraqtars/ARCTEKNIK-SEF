@echo off
setlocal enabledelayedexpansion
title ArcTeknik - Trial Sifirla (TEST makinesi)

echo ==================================================
echo   ArcTeknik / Bayraktar Suite - TRIAL SIFIRLA
echo   (yalnizca KENDI test makineniz icin)
echo ==================================================
echo.
echo Silinecek deneme/lisans izleri:
echo   - HKCU\Software\TeknikServis  (registry: AppInit + AppSentinel)
echo   - %%APPDATA%%\teknik-servis-desktop\  -^> ti, lc, .tslic, license.lic
echo   - %%APPDATA%%\ArcTeknik Sef\          -^> ti, lc, .tslic, license.lic
echo.
echo Korunan: .env, setup.json, veriler, WhatsApp oturumu.
echo.
set "ONAY="
set /p "ONAY=Devam edilsin mi? (E/H): "
if /i not "%ONAY%"=="E" goto :iptal

echo.
echo [1/3] Registry temizleniyor...
reg delete "HKCU\Software\TeknikServis" /f >nul 2>&1
if not errorlevel 1 (echo   - HKCU\Software\TeknikServis silindi) else (echo   - registry anahtari yoktu, atlandi)

call :temizle "%APPDATA%\teknik-servis-desktop" "Suite/ERP"
call :temizle "%APPDATA%\ArcTeknik Sef" "Sef"

echo.
echo TAMAM. Uygulamayi tamamen kapatip yeniden acin -^> taze 15 gun deneme baslar.
goto :son

:temizle
set "DIR=%~1"
set "ETIKET=%~2"
echo [*] %ETIKET% izleri...
if not exist "%DIR%" (echo   - klasor yok, atlandi & goto :eof)
for %%F in (ti lc .tslic license.lic) do (
  if exist "%DIR%\%%F" (
    del /f /q "%DIR%\%%F" >nul 2>&1
    if not exist "%DIR%\%%F" (echo   - %%F silindi)
  )
)
goto :eof

:iptal
echo.
echo Iptal edildi. Hicbir sey silinmedi.

:son
echo.
pause
