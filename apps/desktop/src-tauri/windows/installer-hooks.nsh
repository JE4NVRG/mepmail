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

; Email links (mailto:): MepMail is offered in Settings > Default apps for
; MAILTO. Windows lets the person choose it there; it never takes over email
; links on its own. The link reaches the app as its first argument.
!ifndef MEPMAIL_MAILTO_PROGID
  !define MEPMAIL_MAILTO_PROGID "MepMail.mailto"
!endif
!ifndef MEPMAIL_CLIENT_KEY
  !define MEPMAIL_CLIENT_KEY "Software\Clients\Mail\MepMail"
!endif
!macro MEPMAIL_REGISTER_MAILTO
  WriteRegStr SHCTX "Software\Classes\${MEPMAIL_MAILTO_PROGID}" "" "URL:MailTo Protocol"
  WriteRegStr SHCTX "Software\Classes\${MEPMAIL_MAILTO_PROGID}" "URL Protocol" ""
  WriteRegStr SHCTX "Software\Classes\${MEPMAIL_MAILTO_PROGID}\DefaultIcon" "" "$INSTDIR\${MAINBINARYNAME}.exe,0"
  WriteRegStr SHCTX "Software\Classes\${MEPMAIL_MAILTO_PROGID}\shell\open\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
  WriteRegStr SHCTX "${MEPMAIL_CLIENT_KEY}" "" "${MEPMAIL_DISPLAYNAME}"
  WriteRegStr SHCTX "${MEPMAIL_CLIENT_KEY}\Capabilities" "ApplicationName" "${MEPMAIL_DISPLAYNAME}"
  WriteRegStr SHCTX "${MEPMAIL_CLIENT_KEY}\Capabilities" "ApplicationDescription" "Correio: email on your own domain, for people and their agents."
  WriteRegStr SHCTX "${MEPMAIL_CLIENT_KEY}\Capabilities\URLAssociations" "mailto" "${MEPMAIL_MAILTO_PROGID}"
  WriteRegStr SHCTX "Software\RegisteredApplications" "${MEPMAIL_DISPLAYNAME}" "${MEPMAIL_CLIENT_KEY}\Capabilities"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayName" "${MEPMAIL_DISPLAYNAME}"
  !insertmacro MEPMAIL_REGISTER_MAILTO
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

; Uninstalling removes the renamed shortcuts and the email-link entry too
; (an update keeps them).
!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
    DeleteRegKey SHCTX "Software\Classes\${MEPMAIL_MAILTO_PROGID}"
    DeleteRegKey SHCTX "${MEPMAIL_CLIENT_KEY}"
    DeleteRegValue SHCTX "Software\RegisteredApplications" "${MEPMAIL_DISPLAYNAME}"
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
