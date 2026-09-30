Option Explicit
Dim shell, files, baseDir, nodeExe, command
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
baseDir = files.GetParentFolderName(WScript.ScriptFullName)
nodeExe = shell.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe"
If Not files.FileExists(nodeExe) Then nodeExe = "C:\nvm4w\nodejs\node.exe"
command = Chr(34) & nodeExe & Chr(34) & " " & Chr(34) & baseDir & "\bridge.mjs" & Chr(34)
Do
  shell.Run command, 0, True
  WScript.Sleep 30000
Loop
