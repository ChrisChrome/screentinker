' ScreenTinker — autorun.zip unpacker.
'
' Ships INSIDE autorun.zip, at its root. The card (or internal flash) carries a single file —
' autorun.zip — and this script unpacks it in place, marks it done so it never re-extracts, and
' reboots into the real host.
'
' That is the whole point of the zip: one file to hand someone, or to drop on a hundred cards,
' instead of four files that must all arrive intact and in the right place. A partially-copied
' set of loose files boots into something broken; a partially-copied zip simply fails to extract
' and leaves the player where it was.
'
' ⚠️ autorun.brs must NOT sit next to autorun.zip on the storage root — its presence stops the zip
' being processed at all. autorun.brs belongs INSIDE the zip, which is where the build script puts
' it (scripts/build-autorun-zip.sh).
'
' Unpacks with roBrightPackage, which is what BrightSign's own tooling uses.
'
' On compression: roBrightPackage supports deflate32 with default options, PPMd, and "no
' compression". What it does NOT support is bzip2, LZMA, Deflate64 and Zip64 (the last being what
' Windows Explorer's built-in zipper produces). We build STORED, which is stricter than required and
' costs nothing at this size — but note that compression was NOT the cause of the deployment failure
' this script was blamed for. That was the MatchFiles bug below.
'
' Requires BrightSignOS 7.0.60+.

' WHERE the archive is. A player may be fed from USB, a card, an SSD, or internal flash — and the
' unit that drove this port boots from FLASH because its card interface is physically dead. Probing
' for the file beats assuming a volume: extracting to "SD:/" on a player with no card writes to a
' volume that does not exist, and the deployment silently does nothing.
Function SourceRoot() As String
    volumes = ["USB1:", "SD:", "SD2:", "SSD:", "FLASH:"]
    for each v in volumes
        if FileExists(v + "/", "autorun.zip") then return v
    end for
    return ""
End Function

Sub Main()
    root$ = SourceRoot()
    if root$ = "" then
        print "[st-autozip] no autorun.zip on any volume — nothing to do"
        return
    end if
    zipPath$ = root$ + "/autorun.zip"
    extractPath$ = root$ + "/"
    donePath$ = root$ + "/autorun.zip.done"

    print "[st-autozip] volume "; root$

    if not FileExists(extractPath$, "autorun.zip") then
        print "[st-autozip] no autorun.zip at "; zipPath$; " — nothing to do"
        return
    end if

    ' Idempotence. Without this the player extracts, reboots, extracts again, reboots again —
    ' a boot loop that looks like a hardware fault.
    if FileExists(extractPath$, "autorun.zip.done") then
        print "[st-autozip] already unpacked (autorun.zip.done present) — leaving it alone"
        return
    end if

    print "[st-autozip] unpacking "; zipPath$

    package = CreateObject("roBrightPackage", zipPath$)
    if package = invalid then
        print "[st-autozip] ERROR: could not open the archive — is it STORED (no compression)?"
        ' Deliberately NOT marking it done: a corrupt, truncated or wrongly-compressed copy should
        ' be retried once someone replaces the file, not silently skipped forever.
        return
    end if

    ' Unpack() returns VOID — there is no boolean to test, and `if not package.Unpack(...)` was a
    ' type error rather than an error check. Success is proven the only way that actually means
    ' anything: the file we came here to install is now on the card.
    package.Unpack(extractPath$)

    if not FileExists(extractPath$, "autorun.brs") then
        print "[st-autozip] ERROR: unpack produced no autorun.brs — leaving the archive for a retry"
        return
    end if

    print "[st-autozip] extracted"

    ' MoveFile/DeleteFile are GLOBAL functions on BrightSign. roFileSystem is a Roku object and does
    ' not exist here, so every one of these calls used to return invalid — which meant the archive
    ' was never marked done and the player never rebooted into the player it had just installed.
    if not MoveFile(zipPath$, donePath$) then
        print "[st-autozip] ERROR: could not rename the archive; refusing to reboot into a loop"
        return
    end if

    print "[st-autozip] rebooting into the unpacked player"
    sleep(2000)
    RebootSystem()
End Sub

' Does [name] exist in directory [dir]?
'
' THE BUG THIS FIXES. The previous version passed a full path as BOTH arguments of MatchFiles.
' MatchFiles takes a DIRECTORY plus a pattern, and the documentation is explicit: "you will get no
' results if the pattern contains a directory separator". So it returned an empty list every time,
' for every file, on every player — and this script reported "no autorun.zip on any volume" while a
' `dir SD:` sat there listing autorun.zip. Reported from a real deployment on an HD1026.
'
' Two arguments rather than one path, so there is no string-splitting to get wrong.
Function FileExists(dir As String, name As String) As Boolean
    files = MatchFiles(dir, name)
    if files = invalid then return false
    return files.Count() > 0
End Function
