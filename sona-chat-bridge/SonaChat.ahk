#Requires AutoHotkey v2.0
#SingleInstance Force
#Warn

; Keep beside index.js in the INSTALLED sona-chat-bridge Pengu plugin folder.
; Auto-save in champion select. F8 there is handled by Sona, not AHK.
; F8 in game sends one line per player. Close chat before pressing F8.
; F7 in game asks Sona for the opponents, then sends fresh enemy analysis.
; F9 copies all saved lines. Escape stops the remaining lines.

messageFile := A_ScriptDir "\team-chat.txt"
datastoreFile := A_ScriptDir "\..\..\datastore"
lastExport := "__unread__"
savedAtUtc := ""
syncError := ""
cooldownMs := 10000
lineDelayMs := 300
lastSendAt := -cooldownMs
maxMessageAgeMin := 120
isSending := false
cancelSend := false
isQueryingEnemy := false

; Pengu 1.1.6 has no PluginFS: read only our export from its native DataStore.
SetTimer SyncExportFile, 1000
SyncExportFile()

ShowStatus(text) {
    ToolTip text
    SetTimer () => ToolTip(), -1000
}

DecodeBase64(encoded) {
    size := 0
    if !DllCall("Crypt32\CryptStringToBinaryW", "Str", encoded, "UInt", 0, "UInt", 1, "Ptr", 0, "UInt*", &size, "Ptr", 0, "Ptr", 0)
        throw Error("分析数据编码无效")
    decoded := Buffer(size)
    if !DllCall("Crypt32\CryptStringToBinaryW", "Str", encoded, "UInt", 0, "UInt", 1, "Ptr", decoded, "UInt*", &size, "Ptr", 0, "Ptr", 0)
        throw Error("分析数据解码失败")
    return StrGet(decoded, size, "UTF-8")
}

ReadBridgeStoreValue(exportKey) {
    global datastoreFile
        raw := FileRead(datastoreFile, "RAW")
        ; This is the transform used in Pengu Loader v1.1.6 v8_datastore.cc.
        key := "A5dgY6lz9fpG9kGNiH1mZ"
        Loop raw.Size {
            offset := A_Index - 1
            NumPut("UChar", NumGet(raw, offset, "UChar") ^ Ord(SubStr(key, Mod(offset, StrLen(key)) + 1, 1)), raw, offset)
        }
        json := StrGet(raw, raw.Size, "UTF-8")
        if !RegExMatch(json, '"' StrReplace(exportKey, ".", "\.") '"\s*:\s*"([A-Za-z0-9+/=]*)"', &match)
            throw Error("尚未发现桥接数据，请安装新版桥接插件并重启联盟客户端")
    return match[1]
}

SyncExportFile() {
    global messageFile, lastExport, savedAtUtc, syncError
    try {
        encoded := ReadBridgeStoreValue("sona-chat-bridge.export.v1")
        if (encoded != lastExport || !FileExist(messageFile)) {
            text := ""
            timestamp := ""
            if (encoded != "") {
                payload := DecodeBase64(encoded)
                newline := InStr(payload, "`n")
                timestamp := SubStr(payload, 1, newline - 1)
                if (newline != 15 || !RegExMatch(timestamp, "^\d{14}$"))
                    throw Error("分析时间戳无效")
                text := SubStr(payload, newline + 1)
            }
            ; Write the text atomically; never modify Pengu's datastore from AHK.
            tempFile := messageFile ".tmp"
            outputHandle := FileOpen(tempFile, "w", "UTF-8-RAW")
            if !outputHandle
                throw Error("无法写入 team-chat.txt，请检查插件目录写入权限")
            outputHandle.Write(text)
            outputHandle.Close()
            FileMove tempFile, messageFile, 1
            savedAtUtc := timestamp
            lastExport := encoded
        }
        syncError := ""
        return true
    } catch Error as err {
        syncError := "同步分析失败：" err.Message
        return false
    }
}

ReadCurrentMessage() {
    global messageFile, maxMessageAgeMin, savedAtUtc, syncError
    if !SyncExportFile() {
        ShowStatus(syncError)
        return ""
    }
    try {
        if (savedAtUtc != "") {
            ageMinutes := DateDiff(A_NowUTC, savedAtUtc, "Minutes")
            if (ageMinutes > maxMessageAgeMin || ageMinutes < -2) {
                ShowStatus("分析数据超过 120 分钟或时间无效，请等待本局自动分析。")
                return ""
            }
        }
        msg := Trim(FileRead(messageFile, "UTF-8"), " `t`r`n" Chr(0xFEFF))
        if (msg = "")
            ShowStatus("本局尚未保存分析，或上局数据已清空，请在选人阶段等待自动保存。")
        return msg
    } catch Error as err {
        ShowStatus("读取消息失败：" err.Message)
        return ""
    }
}

CanContinueSending() {
    global cancelSend
    return !cancelSend && WinActive("ahk_exe League of Legends.exe")
}

SendChatLines(msg) {
    global lastSendAt, cooldownMs, lineDelayMs, isSending, cancelSend
    if isSending
        return
    if (A_TickCount - lastSendAt < cooldownMs) {
        ShowStatus("发送冷却中，请稍后再试。")
        return
    }
    if (msg = "")
        return
    lines := []
    for rawLine in StrSplit(StrReplace(msg, "`r", ""), "`n") {
        line := Trim(StrReplace(rawLine, "`t", " "))
        if (line = "")
            continue
        if (StrLen(line) > 180) {
            ShowStatus("有一行超过 180 字，请按 F9 复制后手动发送。")
            return
        }
        lines.Push(line)
    }
    if (lines.Length = 0)
        return
    isSending := true
    cancelSend := false
    lastSendAt := A_TickCount
    sentCount := 0
    try {
        for index, line in lines {
            if !CanContinueSending()
                break
            ; Chat must be CLOSED at the start. Enter uses the current chat channel.
            SendEvent "{Enter}"
            Sleep 100
            if !CanContinueSending()
                break
            SendText line
            Sleep 100
            if !CanContinueSending()
                break
            SendEvent "{Enter}"
            sentCount++
            if (index < lines.Length)
                Sleep lineDelayMs
        }
        ShowStatus("已执行发送 " sentCount "/" lines.Length " 条，请确认游戏聊天内容。")
    } finally {
        isSending := false
    }
}

ReadEnemyResponse(token) {
    encoded := ReadBridgeStoreValue("sona-chat-bridge.enemy.v1")
    if (encoded = "")
        return []
    parts := StrSplit(DecodeBase64(encoded), "`n", "", 4)
    if (parts.Length != 4 || parts[2] != token)
        return []
    return parts
}

#HotIf WinActive("ahk_exe League of Legends.exe")
F8::{
    global isQueryingEnemy
    KeyWait "F8"
    if isQueryingEnemy
        return
    msg := ReadCurrentMessage()
    if (msg != "")
        SendChatLines(msg)
}

F7::{
    global isQueryingEnemy, isSending, cancelSend
    KeyWait "F7"
    if (isSending || isQueryingEnemy)
        return
    isQueryingEnemy := true
    cancelSend := false
    try {
        token := A_NowUTC "-" A_TickCount
        requestFile := A_ScriptDir "\enemy-request.txt"
        requestHandle := FileOpen(requestFile ".tmp", "w", "UTF-8-RAW")
        if !requestHandle
            throw Error("无法写入敌方查询请求，请检查插件目录权限")
        requestHandle.Write(token)
        requestHandle.Close()
        FileMove requestFile ".tmp", requestFile, 1
        ShowStatus("正在查询敌方战绩，按 Esc 可取消…")
        startedAt := A_TickCount
        while (A_TickCount - startedAt < 45000) {
            if (cancelSend || !WinActive("ahk_exe League of Legends.exe"))
                return
            try {
                response := ReadEnemyResponse(token)
            } catch {
                response := [] ; DataStore may be briefly busy while Pengu commits it.
            }
            if (response.Length = 4) {
                if (response[3] = "error")
                    throw Error(response[4])
                if (response[3] = "ready") {
                    enemyFile := FileOpen(A_ScriptDir "\enemy-chat.txt", "w", "UTF-8-RAW")
                    if !enemyFile
                        throw Error("无法保存 enemy-chat.txt，请检查插件目录权限")
                    enemyFile.Write(response[4])
                    enemyFile.Close()
                    SendChatLines(response[4])
                    return
                }
            }
            Sleep 150
        }
        ShowStatus("敌方查询超时，请检查 Sona 和桥接插件是否已更新并运行。")
    } catch Error as err {
        ShowStatus("敌方查询失败：" err.Message)
    } finally {
        isQueryingEnemy := false
    }
}

~Esc::{
    global cancelSend, isSending, isQueryingEnemy
    if (isSending || isQueryingEnemy)
        cancelSend := true
}
#HotIf

F9::{
    msg := ReadCurrentMessage()
    if (msg = "")
        return
    A_Clipboard := msg
    ShowStatus("已复制完整分析，可手动粘贴发送。")
}
