; theDAW custom NSIS include.
;
; electron-builder auto-includes ${buildResources}/installer.nsh (buildResources is
; "resources" here) and invokes the customInstall / customUnInstall macros. We use
; them to register a per-user (HKCU, no elevation) "Convert with theDAW" cascading
; context menu on audio / video / image files. Each sub-item runs the bundled ffmpeg
; through resources\convert-with-thedaw.ps1.

; Parent cascading entry for a Windows perceived type (audio / video / image).
; SubCommands "" enables the nested shell\ cascade (the modern submenu pattern).
!macro ConvParent KIND
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\${KIND}\shell\theDAWConvert" "MUIVerb" "Convert with theDAW"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\${KIND}\shell\theDAWConvert" "Icon" "$INSTDIR\theDAW.exe,0"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\${KIND}\shell\theDAWConvert" "SubCommands" ""
!macroend

; One target-format sub-item under a parent.
!macro ConvSub KIND ID LABEL FMT
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\${KIND}\shell\theDAWConvert\shell\${ID}" "MUIVerb" "${LABEL}"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\${KIND}\shell\theDAWConvert\shell\${ID}\command" "" 'powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "$INSTDIR\resources\convert-with-thedaw.ps1" -Format ${FMT} -Source "%1"'
!macroend

!macro customInstall
  ; AUDIO files
  !insertmacro ConvParent "audio"
  !insertmacro ConvSub "audio" "wav"  "To WAV"  "wav"
  !insertmacro ConvSub "audio" "mp3"  "To MP3"  "mp3"
  !insertmacro ConvSub "audio" "flac" "To FLAC" "flac"
  !insertmacro ConvSub "audio" "ogg"  "To OGG"  "ogg"
  !insertmacro ConvSub "audio" "m4a"  "To M4A"  "m4a"

  ; VIDEO files
  !insertmacro ConvParent "video"
  !insertmacro ConvSub "video" "mp4"  "To MP4"            "mp4"
  !insertmacro ConvSub "video" "mov"  "To MOV"            "mov"
  !insertmacro ConvSub "video" "webm" "To WebM"           "webm"
  !insertmacro ConvSub "video" "gif"  "To GIF"            "gif"
  !insertmacro ConvSub "video" "mp3"  "Extract audio (MP3)" "mp3"

  ; IMAGE files
  !insertmacro ConvParent "image"
  !insertmacro ConvSub "image" "png"  "To PNG"  "png"
  !insertmacro ConvSub "image" "jpg"  "To JPG"  "jpg"
  !insertmacro ConvSub "image" "webp" "To WebP" "webp"
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\audio\shell\theDAWConvert"
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\video\shell\theDAWConvert"
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\image\shell\theDAWConvert"
!macroend
