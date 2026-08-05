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
' Requires BrightSignOS 7.0.60+ (roUnzip).

Function StorageRoot() As String
    ' Same reasoning as autorun.brs: a player may be booting from internal flash rather than a
    ' card — the only path on a unit whose card interface has failed. Extracting to "SD:/" on such
    ' a player writes to a volume that does not exist.
    if DoesFileExist("FLASH:/autorun.zip") then return "FLASH:"
    return "SD:"
End Function

Sub Main()
    root$ = StorageRoot()
    zipPath$ = root$ + "/autorun.zip"
    extractPath$ = root$ + "/"
    donePath$ = root$ + "/autorun.zip.done"

    print "[st-autozip] volume "; root$

    if not DoesFileExist(zipPath$) then
        print "[st-autozip] no autorun.zip at "; zipPath$; " — nothing to do"
        return
    end if

    ' Idempotence. Without this the player extracts, reboots, extracts again, reboots again —
    ' a boot loop that looks like a hardware fault.
    if DoesFileExist(donePath$) then
        print "[st-autozip] already unpacked (autorun.zip.done present) — leaving it alone"
        return
    end if

    print "[st-autozip] unpacking "; zipPath$

    unzip = CreateObject("roUnzip", zipPath$)
    if unzip = invalid then
        print "[st-autozip] ERROR: could not open the archive"
        return
    end if

    result = unzip.DecompressAllFiles(extractPath$)
    if result <> 0 then
        print "[st-autozip] ERROR: extract failed, code "; result
        ' Deliberately NOT marking it done: a corrupt or truncated copy should be retried after
        ' someone replaces the file, not silently skipped forever.
        return
    end if

    print "[st-autozip] extracted"

    fs = CreateObject("roFileSystem")
    if fs = invalid then
        print "[st-autozip] ERROR: no roFileSystem — cannot mark the archive done"
        return
    end if

    if not fs.Rename(zipPath$, donePath$) then
        print "[st-autozip] ERROR: could not rename the archive; refusing to reboot into a loop"
        return
    end if

    print "[st-autozip] rebooting into the unpacked player"
    sleep(2000)
    RebootSystem()
End Sub

Function DoesFileExist(filePath$ As String) As Boolean
    files = MatchFiles(filePath$, filePath$)
    return files.Count() > 0
End Function
