!macro customInstall
  ; ── STANDALONE: ArcTeknik Sef (Restoran Otomasyon) tek basina kurulum ────────
  ; Ayni monolit exe; yalnizca restoran modu kisayolu olusturulur. ERP/POS
  ; kisayollari OLUSTURULMAZ (bagimsiz urun deneyimi). Server icin 51234 acilir.
  CreateDirectory "$SMPROGRAMS\${PRODUCT_NAME}"

  CreateShortCut "$DESKTOP\ArcTeknik Sef.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--mode=restaurant" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
  CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}\ArcTeknik Sef.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--mode=restaurant" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0

  ; Kontrol Paneli (yonetim) — ayri pencere, satis terminalinden bagimsiz
  CreateShortCut "$DESKTOP\ArcTeknik Sef Yonetim.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--mode=control" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
  CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}\ArcTeknik Sef Yonetim.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--mode=control" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0

  ; Self-Servis Kasa (masa bypass — fast-food/kahveci) + Musteri Cagri Ekrani
  ; (tavan TV numaratoru) — yalnizca Baslat menusu; isteyen masaustune tasir.
  CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}\ArcTeknik Self-Servis Kasa.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--mode=selfservice" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
  CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}\ArcTeknik Cagri Ekrani.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--mode=cagri" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0

  ; Mutfak Ekrani (KDS) — ayri mutfak cihazinda tam ekran
  CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}\ArcTeknik Mutfak Ekrani.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--mode=kitchen" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0

  ; (Opsiyonel) Yedekleme Merkezi — yalnizca Baslat menusu
  CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}\ARC Yedekleme Merkezi.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "--backup-mode" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0

  ; Ayni agdaki tablet/telefonlar (garson el terminali) icin 51234 portunu ac
  nsExec::Exec 'netsh advfirewall firewall delete rule name="ArcTeknikSef"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="ArcTeknikSef" dir=in action=allow protocol=TCP localport=51234 profile=any'

  nsExec::Exec 'ie4uinit.exe -show'
!macroend

!macro customUnInstall
  Delete "$DESKTOP\ArcTeknik Sef.lnk"
  Delete "$SMPROGRAMS\${PRODUCT_NAME}\ArcTeknik Sef.lnk"
  Delete "$DESKTOP\ArcTeknik Sef Yonetim.lnk"
  Delete "$SMPROGRAMS\${PRODUCT_NAME}\ArcTeknik Sef Yonetim.lnk"
  Delete "$SMPROGRAMS\${PRODUCT_NAME}\ArcTeknik Self-Servis Kasa.lnk"
  Delete "$SMPROGRAMS\${PRODUCT_NAME}\ArcTeknik Cagri Ekrani.lnk"
  Delete "$SMPROGRAMS\${PRODUCT_NAME}\ArcTeknik Mutfak Ekrani.lnk"
  Delete "$SMPROGRAMS\${PRODUCT_NAME}\ARC Yedekleme Merkezi.lnk"
  RMDir "$SMPROGRAMS\${PRODUCT_NAME}"

  nsExec::Exec 'netsh advfirewall firewall delete rule name="ArcTeknikSef"'
!macroend
