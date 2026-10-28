; Runs at the end of the installation: looks for the local AI reader (llama-server from Ollama + the Qari-OCR model files)
; and, only when something is missing, asks whether to download it now. A silent install (/S) never asks.
!macro customInstall
  IfSilent ai_done
  DetailPrint "Checking the local AI reader..."
  nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\resources\ai\setup-ai.ps1" -Check'
  Pop $0
  StrCmp $0 "0" ai_done
  MessageBox MB_YESNO|MB_ICONQUESTION|MB_RIGHT|MB_RTLREADING "قارئ الذكاء الاصطناعي المحلي غير مثبَّت على هذا الجهاز.$\r$\n$\r$\nهل تريد تنزيله وتثبيته الآن؟ (حتى 4.5 جيجابايت: Ollama ونموذج القراءة، حسب الناقص منهما)$\r$\n$\r$\nيعمل البرنامج بدونه بالمحرك القياسي، ويمكنك تثبيته لاحقًا من البرنامج نفسه." IDNO ai_done
  ExecWait 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\resources\ai\setup-ai.ps1" -Install' $0
  ai_done:
!macroend
