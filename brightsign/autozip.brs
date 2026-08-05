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
' Unpacks with roBrightPackage, which is what BrightSign's own tooling uses — NOT roUnzip.
' A BrightSign consultant flagged this after our first archive failed his automated deployment:
' the zip reached the player and then could not be opened. Two causes, both fixed:
'   - the archive must be STORED, no compression (scripts/build-autorun-zip.sh now asserts it)
'   - roBrightPackage is the supported reader for a player package
'
' Requires BrightSignOS 7.0.60+.

' WHERE the archive is. A player may be fed from USB, a card, an SSD, or internal flash — and the
' unit that drove this port boots from FLASH because its card interface is physically dead. Probing
' for the file beats assuming a volume: extracting to "SD:/" on a player with no card writes to a
' volume that does not exist, and the deployment silently does nothing.
Function SourceRoot() As String
    volumes = ["USB1:", "SD:", "SSD:", "FLASH:"]
    for each v in volumes
        if DoesFileExist(v + "/autorun.zip") then return v
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

    package = CreateObject("roBrightPackage", zipPath$)
    if package = invalid then
        print "[st-autozip] ERROR: could not open the archive — is it STORED (no compression)?"
        ' Deliberately NOT marking it done: a corrupt, truncated or wrongly-compressed copy should
        ' be retried once someone replaces the file, not silently skipped forever.
        return
    end if

    if not package.Unpack(extractPath$) then
        print "[st-autozip] ERROR: unpack failed"
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
