; The app shows as "MepMail" while the install keeps its first internal name
; (productName "MepMail Correio": install folder, uninstall key and updater
; stay the same, so every installed copy keeps updating in place). Only what
; people see changes: the Start menu and desktop shortcuts and the name in
; Settings > Apps.
!ifndef MEPMAIL_DISPLAYNAME
  !define MEPMAIL_DISPLAYNAME "MepMail"
!endif

; Moves a shortcut the installer made under the product name to the display
; name, replacing an older one there.
!macro MEPMAIL_RENAME_SHORTCUT FOLDER
  ${If} ${FileExists} "${FOLDER}\${PRODUCTNAME}.lnk"
    Delete "${FOLDER}\${MEPMAIL_DISPLAYNAME}.lnk"
    Rename "${FOLDER}\${PRODUCTNAME}.lnk" "${FOLDER}\${MEPMAIL_DISPLAYNAME}.lnk"
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayName" "${MEPMAIL_DISPLAYNAME}"
  ; The Start menu shortcut exists by now; so does the desktop one in silent
  ; and passive installs (the updater's). An update without shortcuts leaves
  ; the renamed ones alone.
  !insertmacro MEPMAIL_RENAME_SHORTCUT "$SMPROGRAMS"
  !insertmacro MEPMAIL_RENAME_SHORTCUT "$DESKTOP"
!macroend

; In the windowed installer the desktop shortcut comes from the finish page,
; after the install section: rename it when that page closes.
Function .onGUIEnd
  !insertmacro MEPMAIL_RENAME_SHORTCUT "$DESKTOP"
FunctionEnd

; Uninstalling removes the renamed shortcuts too (an update keeps them).
!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
    !insertmacro IsShortcutTarget "$SMPROGRAMS\${MEPMAIL_DISPLAYNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      !insertmacro UnpinShortcut "$SMPROGRAMS\${MEPMAIL_DISPLAYNAME}.lnk"
      Delete "$SMPROGRAMS\${MEPMAIL_DISPLAYNAME}.lnk"
    ${EndIf}
    !insertmacro IsShortcutTarget "$DESKTOP\${MEPMAIL_DISPLAYNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      !insertmacro UnpinShortcut "$DESKTOP\${MEPMAIL_DISPLAYNAME}.lnk"
      Delete "$DESKTOP\${MEPMAIL_DISPLAYNAME}.lnk"
    ${EndIf}
  ${EndIf}
!macroend
