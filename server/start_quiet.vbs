' Запуск GM Whispers Core без окна, со значком в трее. Используется автозагрузкой (tools\autostart.bat).
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
exe = dir & "\.venv\Scripts\pythonw.exe"
If Not fso.FileExists(exe) Then
  MsgBox "GM Whispers: сначала запусти server\setup.bat", 48, "GM Whispers Core"
  WScript.Quit 1
End If
' Если сервер уже запущен — второй экземпляр не нужен.
On Error Resume Next
Set http = CreateObject("MSXML2.XMLHTTP")
http.Open "GET", "http://127.0.0.1:8765/", False
http.Send
If Err.Number = 0 And http.Status = 200 Then WScript.Quit 0
On Error GoTo 0
sh.Run """" & exe & """ -m gmw --tray", 0, False
