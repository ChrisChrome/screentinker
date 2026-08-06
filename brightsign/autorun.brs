' ScreenTinker — BrightSign player host
'
' The ScreenTinker player itself is the ordinary web player (server/player/index.html) running
' in an roHtmlWidget. This script is the HOST around it, and it exists for the things a page
' cannot do for itself:
'
'   1. OWN THE WIDGET LIFECYCLE. A page that calls location.reload() on a BrightSign does not
'      reliably come back — observed in the field on 2026-07-28, where a ScreenTinker deploy
'      reloaded every connected player and the BrightSign was the only one that never returned.
'      So the page NEVER reloads itself here: it posts {type:"restart"} and this script tears the
'      widget down and builds a new one. That is a restart the OS actually performs.
'   2. SURVIVE A DEAD SERVER. load-error retries with backoff and falls back to a local page,
'      instead of leaving a white screen until someone power-cycles the box.
'   3. PERSIST IDENTITY across reboots and content changes, in the registry rather than in
'      localStorage (which is tied to the page's origin and its storage quota).
'   4. REACH BRIGHTSCRIPT-ONLY CAPABILITIES on the page's behalf — video mode, a second output,
'      and native BrightWall synchronisation — over the messageport bridge.
'
' Pair it with st-bridge.js, which is the JavaScript half of the same contract.
'
' SD card layout:  autorun.brs  st-bridge.js  offline.html  [screentinker.json]

'=== storage volume ==========================================================================
' WHERE we are running from is not a given. The obvious answer is the SD card, and every
' BrightSign example assumes it — but this player also boots FLASH:/autorun.brs straight out of
' internal eMMC, which is the ONLY path on a unit whose microSD interface is dead (ours has
' liquid corrosion on the card lines; the host controller probes at 400kHz and no card ever
' answers). Hard-coding "SD:" there means the script loads and then cannot find its own files.
'
' So ask the filesystem instead of assuming: whichever volume holds this script is the volume
' that holds everything else beside it.
Function StorageRoot() As String
    ' Which volume are we actually running from? Everything else is derived from this — the offline
    ' page, the widget's storage directory, the self-update paths — so getting it wrong points the
    ' whole player at a volume that may not physically exist.
    '
    ' Probed in the order the OS itself searches for an autorun script (roStorageHotplug.GetStorages()
    ' documents ["USB1:/", "SD:/", "SD2:/", "SSD:/", "FLASH:/"]), so the answer matches the volume the
    ' player actually booted from. FLASH is last because it is the fallback of last resort: the unit
    ' this was developed on has a dead card slot and boots from internal flash, and an earlier version
    ' of this function knew only FLASH and SD — so fitting real storage to that player and moving the
    ' files onto it would have silently resolved every path to "SD:", a slot with nothing in it.
    '
    ' ReadFile rather than a MatchFiles existence check: MatchFiles takes a DIRECTORY plus a pattern
    ' and returns nothing when the pattern contains a separator, which is why the helper further down
    ' this file never finds anything.
    ba = CreateObject("roByteArray")
    if ba.ReadFile("USB1:/autorun.brs") then return "USB1:"
    if ba.ReadFile("SSD:/autorun.brs") then return "SSD:"
    if ba.ReadFile("SD:/autorun.brs") then return "SD:"
    if ba.ReadFile("SD2:/autorun.brs") then return "SD2:"
    if ba.ReadFile("FLASH:/autorun.brs") then return "FLASH:"
    return "SD:"
End Function

'=== configuration ==========================================================================
' Provisioning order: screentinker.json on the card (imaging a batch) > registry (set once at
' pairing, survives content updates) > the built-in default.

Function LoadConfig() As Object
    cfg = {
        server_url: "https://screentinker.com"
        device_id: ""
        sync_backend: "auto"      ' auto | screentinker | brightsign
        output_mode: "single"     ' single | dual | clone
        inspector: false
        ' Self-update of the host package. Defaults ON: a fleet that cannot be updated remotely is
        ' a fleet that needs a van. The DECISION is still the server's, and it refuses anything it
        ' cannot verify, so "on" does not mean "will apply whatever it is handed".
        self_update: true
        ' Mirrors the Android beta channel. Off by default; an opted-in player also HOLDS a
        ' prerelease of its own core instead of being pulled back to the release.
        allow_prerelease: false
    }

    ' 1) registry
    reg = CreateObject("roRegistrySection", "screentinker")
    if reg.Exists("server_url") then cfg.server_url = reg.Read("server_url")
    if reg.Exists("device_id") then cfg.device_id = reg.Read("device_id")
    if reg.Exists("sync_backend") then cfg.sync_backend = reg.Read("sync_backend")
    if reg.Exists("output_mode") then cfg.output_mode = reg.Read("output_mode")
    if reg.Exists("self_update") then cfg.self_update = (reg.Read("self_update") = "1")
    if reg.Exists("allow_prerelease") then cfg.allow_prerelease = (reg.Read("allow_prerelease") = "1")

    ' 2) a JSON file on the card wins — that is how a batch gets imaged without touching each box
    ba = CreateObject("roByteArray")
    if ba.ReadFile(StorageRoot() + "/screentinker.json") then
        json = ParseJson(ba.ToAsciiString())
        if json <> invalid then
            if json.server_url <> invalid then cfg.server_url = json.server_url
            if json.device_id <> invalid then cfg.device_id = json.device_id
            if json.sync_backend <> invalid then cfg.sync_backend = json.sync_backend
            if json.output_mode <> invalid then cfg.output_mode = json.output_mode
            if json.inspector <> invalid then cfg.inspector = json.inspector
            if json.self_update <> invalid then cfg.self_update = json.self_update
            if json.allow_prerelease <> invalid then cfg.allow_prerelease = json.allow_prerelease
        end if
    end if

    return cfg
End Function

Sub SaveRegistry(key As String, value As String)
    reg = CreateObject("roRegistrySection", "screentinker")
    reg.Write(key, value)
    reg.Flush()
End Sub

'=== player URL =============================================================================
' Identity is carried in the URL so the page knows who it is before it has any storage of its
' own. serial is the stable hardware id; device_id is what ScreenTinker assigned at pairing.

Function PlayerUrl(cfg As Object, screen As Integer) As String
    di = CreateObject("roDeviceInfo")
    url = cfg.server_url + "/player?platform=brightsign"
    url = url + "&serial=" + di.GetDeviceUniqueId()
    url = url + "&model=" + di.GetModel()
    url = url + "&sync_backend=" + cfg.sync_backend
    if cfg.device_id <> "" then url = url + "&device_id=" + cfg.device_id
    if screen > 1 then url = url + "&screen=" + Stri(screen).Trim()
    return url
End Function

'=== widget construction ====================================================================

Function MakeWidget(url As String, rect As Object, port As Object, cfg As Object) As Object
    config = {
        url: url
        nodejs_enabled: true                    ' Node runtime inside the widget
        brightsign_js_objects_enabled: true     ' REQUIRED for require("@brightsign/*") — without
                                                ' this the bridge silently degrades to no-ops and
                                                ' the player loses identity AND restart delegation
        javascript_enabled: true
        security_params: { websecurity: true }
        hwz_default: "on"                       ' hardware z-order — video on its own plane
        ' An ABSOLUTE path on the volume we booted from. "/cache" carries no BrightSign drive
        ' specifier, so it resolves outside the writable volumes and the widget's local storage —
        ' the backing store a service worker, the Cache API and IndexedDB all need — has nowhere to
        ' persist to. The XT245 on alpha exposes navigator.serviceWorker and then refuses to
        ' register one, which is exactly what a widget with no usable storage would do.
        storage_path: StorageRoot() + "/cache"  ' local storage, on the volume we booted from
        storage_quota: "1073741824"             ' 1GB, as a STRING — service-worker offline cache
        port: port
        mouse_enabled: false
    }
    if cfg.inspector then config.inspector_server = { port: 2999 }

    w = CreateObject("roHtmlWidget", rect, config)
    return w
End Function

' SyncManager will not work unless the PTP domain is set, and applying it needs a reboot. Done
' ONLY when this player is actually configured for native sync — a reboot on every boot would be
' a boot loop, and a player using our own protocol has no use for it.
'
' The read-before-write is what makes it safe: it reboots at most once, on the first boot after
' the mode is selected, and is a no-op forever after.
Sub EnsurePtpDomain(cfg As Object)
    if cfg.sync_backend <> "brightsign" then return

    regSec = CreateObject("roRegistrySection", "networking")
    if regSec.Read("ptp_domain") = "0" then
        print "[st] ptp_domain already 0"
    else
        print "[st] setting ptp_domain=0 for SyncManager — rebooting once to apply"
        regSec.Write("ptp_domain", "0")
        regSec.Flush()
        RebootSystem()
    end if
End Sub

' Capture what is ACTUALLY on screen, using the player's own Diagnostic Web Server.
'
' The page cannot do this itself. With hwz enabled, video decodes onto a hardware plane the DOM
' cannot see: drawImage(video) on a canvas returns a fully transparent image and throws nothing,
' so an in-page screenshot silently produces a blank frame. The DWS captures the real framebuffer,
' video included.
'
' It has to happen HERE rather than in the page for two reasons: the DWS is http on localhost and
' the player is served over https, so the page would be blocked as mixed content; and BrightScript
' is subject to neither CORS nor mixed-content rules. The credentials are the documented default —
' user "admin", password = the unit serial — which this script can read directly.
'
' ⚠️ Requires PRIMARY STORAGE. With no card or SSD fitted the endpoint answers
' "No primary storage found", because it writes the full-size capture to disk before returning the
' thumbnail. Reported back as-is rather than swallowed, so the dashboard can say why.
Sub TakeSnapshot(widget As Object, req As Object)
    di = CreateObject("roDeviceInfo")
    serial$ = di.GetDeviceUniqueId()

    w% = 640
    h% = 360
    if req <> invalid and req.width <> invalid then w% = req.width
    if req <> invalid and req.height <> invalid then h% = req.height

    ' BrightScript has NO escape sequences in string literals: "" does not mean an escaped quote,
    ' it ends one string and begins another, so `"{""width"":"` is three literals with no operator
    ' between them — a compile error that stops the WHOLE SCRIPT loading, not just this function.
    ' A quote has to come from Chr(34). This line is why the player booted to nothing:
    '   ScriptLoadError: Syntax Error. (compile error &h02) in SSD:/autorun.brs(196)
    q$ = Chr(34)
    body$ = "{" + q$ + "width" + q$ + ":" + Stri(w%).Trim() + "," + q$ + "height" + q$ + ":" + Stri(h%).Trim() + "}"

    ut = CreateObject("roUrlTransfer")
    if ut = invalid then
        widget.PostJSMessage({ type: "snapshot-result", ok: false, error: "no roUrlTransfer" })
        return
    end if

    ut.SetUrl("http://localhost/api/v1/snapshot/")
    ut.SetUserAndPassword("admin", serial$)
    ut.AddHeader("Content-Type", "application/json")

    ' PostFromStringWithRetry does not exist — calling it raised "Member function not found" from
    ' inside the event loop, i.e. a snapshot request took the whole player down. And the synchronous
    ' PostFromString() is no use either: it returns only a response CODE and discards the body, which
    ' is where the thumbnail is. The documented way to read a POST response is asynchronous, on a
    ' message port.
    port = CreateObject("roMessagePort")
    ut.SetPort(port)
    if not ut.AsyncPostFromString(body$) then
        widget.PostJSMessage({ type: "snapshot-result", ok: false, error: "could not reach the local DWS" })
        return
    end if

    ' Bounded: a capture that never answers must not wedge the event loop that drives playback.
    ev = Wait(20000, port)
    if type(ev) <> "roUrlEvent" then
        ut.AsyncCancel()
        widget.PostJSMessage({ type: "snapshot-result", ok: false, error: "the local DWS did not answer" })
        return
    end if

    resp$ = ev.GetString()
    if resp$ = "" then
        widget.PostJSMessage({ type: "snapshot-result", ok: false, error: "no response from the local DWS" })
        return
    end if

    json = ParseJson(resp$)
    if json = invalid or json.data = invalid then
        widget.PostJSMessage({ type: "snapshot-result", ok: false, error: "unparseable DWS response" })
        return
    end if

    if json.data.error <> invalid then
        ' e.g. "No primary storage found." — pass the player's own words through; inventing a
        ' friendlier message here would hide the one fact that explains the failure.
        widget.PostJSMessage({ type: "snapshot-result", ok: false, error: json.data.error.message })
        return
    end if

    r = json.data.result
    if r = invalid or r.remotesnapshotthumbnail = invalid then
        widget.PostJSMessage({ type: "snapshot-result", ok: false, error: "DWS returned no thumbnail" })
        return
    end if

    widget.PostJSMessage({ type: "snapshot-result", ok: true, image: r.remotesnapshotthumbnail })
End Sub

' Rotate the OUTPUT, not the DOM.
'
' The web player rotates with a CSS transform, which is correct in a browser and wrong here: with
' hwz enabled the video decodes onto a hardware plane the DOM cannot transform, so a CSS rotation
' turns the images and widgets and leaves the video unrotated. Tizen hit this same wall and routes
' portrait video through AVPlay for exactly this reason.
'
' roVideoMode takes a transform — normal/90/180/270 — and rotating the screen rotates EVERYTHING,
' video included, because it happens below the compositor rather than above it.
'
' Reports success back to the page: if this fails, the page falls back to its CSS transform, which
' rotates most of the content rather than none of it. Silently doing neither would leave a portrait
' panel showing landscape content with no clue why.
Sub SetOrientation(widget As Object, o As String)
    transform$ = "normal"
    if o = "portrait" then transform$ = "90"
    if o = "portrait-flipped" then transform$ = "270"
    if o = "landscape-flipped" then transform$ = "180"

    vm = CreateObject("roVideoMode")
    if vm = invalid then
        widget.PostJSMessage({ type: "orientation-result", ok: false, error: "no roVideoMode" })
        return
    end if

    ' SetMode() takes ONE argument — a mode string. Passing a transform as a second argument was a
    ' "wrong number of function parameters" abort, so this Sub never reached its own reply and the
    ' page never learned to fall back. Rotation lives on SetScreenModes(), whose per-screen config
    ' carries a `transform` of normal|90|180|270 and rotates EVERYTHING including the video plane.
    ' Implemented in BOS 9.0.15+; an older player simply has no method here and is told so.
    ' FindMemberFunction is the guard BrightSign's own scripts use for a method that may not exist
    ' on this OS version — safer than naming a member directly, which would attempt the call.
    if FindMemberFunction(vm, "GetScreenModes") = invalid or FindMemberFunction(vm, "SetScreenModes") = invalid then
        print "[st] orientation: this OS has no SetScreenModes — the page keeps its CSS fallback"
        widget.PostJSMessage({ type: "orientation-result", ok: false, error: "SetScreenModes unavailable" })
        return
    end if

    configs = vm.GetScreenModes()
    if configs = invalid or configs.Count() = 0 then
        widget.PostJSMessage({ type: "orientation-result", ok: false, error: "no screen configuration" })
        return
    end if

    ' ⚠️ SetScreenModes REBOOTS the player when it changes the screen configuration. A playlist push
    ' repeats the current orientation on every update, so applying it unconditionally would reboot
    ' the display every time the server spoke to it. Only a real change is worth a reboot.
    changed = false
    for each c in configs
        if c.transform <> transform$ then
            c.transform = transform$
            changed = true
        end if
    end for

    if not changed then
        print "[st] orientation already "; transform$; " — nothing to do"
        widget.PostJSMessage({ type: "orientation-result", ok: true, transform: transform$ })
        return
    end if

    ' Tell the page BEFORE the call: the reboot may take the player out mid-sentence, and a display
    ' that rotates without ever confirming looks like the command was ignored.
    widget.PostJSMessage({ type: "orientation-result", ok: true, transform: transform$, rebooting: true })
    print "[st] orientation "; o; " -> transform "; transform$; " (the player will now reboot)"
    sleep(1000)
    vm.SetScreenModes(configs)
End Sub

'=== capability probe =======================================================================
' What this unit can actually do, answered by the only component that can see it.
'
' The page cannot determine any of this. There is no JavaScript API for device storage —
' @brightsign/storage exposes format/eject and nothing that enumerates volumes — so a player asked
' "do you have a disk?" could only guess. It matters because the DWS snapshot endpoint writes the
' full-size capture to disk before returning a thumbnail: with no card or SSD fitted it answers
' "No primary storage found", which is exactly what our XT245 does today. Declaring
' remote.screenshot on such a unit puts a button in the dashboard that cannot work.
'
' FLASH: is deliberately NOT counted. This player boots from internal flash because its card
' interface is physically dead, and the DWS still refuses the capture — internal flash is not
' "primary storage" as that endpoint means it. Counting it would re-create the exact lie this
' probe exists to prevent.
Function StorageProbe() As Object
    result = { present: false, volume: "", free_mb: 0, total_mb: 0 }

    ' "USB:" not "USB1:" — the docs warn that GetStorageStatus() results are UNRELIABLE when called
    ' with a "USBn:" parameter, and list "USB:", "SD:", "SSD:", "SD2:/", "Flash:" as the drive
    ' strings it understands. One roStorageHotplug for the whole loop rather than one per volume.
    hp = CreateObject("roStorageHotplug")
    ' Ask the platform which volumes exist rather than guessing; the static list is the fallback for
    ' an OS without the enumerator. Same shape BrightSign's own boilerplate uses.
    volumes = ["SSD:", "SD:", "SD2:", "USB:"]
    if hp <> invalid and FindMemberFunction(hp, "GetStorages") <> invalid then
        found = hp.GetStorages()
        if found <> invalid and found.Count() > 0 then volumes = found
    end if
    for each v in volumes
        mounted = false
        if hp <> invalid then
            st = hp.GetStorageStatus(v)
            if st <> invalid and st.mounted then mounted = true
        end if

        if mounted then
            result.present = true
            result.volume = v
            si = CreateObject("roStorageInfo", v)
            if si <> invalid then
                ' Real device capacity. The widget's storage quota — all the page can see via
                ' navigator.storage.estimate() — is the cache budget, not the disk.
                result.free_mb = si.GetFreeInMegabytes()
                result.total_mb = si.GetSizeInMegabytes()
            end if
            return result
        end if
    end for

    return result
End Function

' Everything the page cannot ask the hardware directly.
Sub SendProbeResult(widget As Object)
    di = CreateObject("roDeviceInfo")
    storage = StorageProbe()

    osVer$ = ""
    model$ = ""
    if di <> invalid then
        osVer$ = di.GetVersion()
        model$ = di.GetModel()
    end if

    widget.PostJSMessage({
        type: "probe-result"
        storage_present: storage.present
        storage_volume: storage.volume
        storage_free_mb: storage.free_mb
        storage_total_mb: storage.total_mb
        os_version: osVer$
        model: model$
    })
End Sub

Function FullScreenRect() As Object
    vm = CreateObject("roVideoMode")
    return CreateObject("roRectangle", 0, 0, vm.GetResX(), vm.GetResY())
End Function

'=== self-update ============================================================================
'
' The package (autorun.zip) can replace THIS SCRIPT. That makes it the most dangerous thing the
' player does: a truncated or half-applied autorun.brs is a dark panel and a site visit, because
' there is no app underneath to fall back to.
'
' The ordering below is the safety, and it is deliberate at every step:
'
'   1. Download to autorun.zip.part — never straight to autorun.zip. A file that is still
'      downloading, or that stopped halfway, must never be a candidate for extraction.
'   2. Verify sha256 AND size before promoting. A captive portal that answers with a login page
'      produces a perfectly well-formed small file; the size floor catches it, the hash catches
'      everything else.
'   3. Only then promote: delete the .done marker, rename .part -> autorun.zip, reboot.
'      The marker MUST go first — leaving it would make ApplyPendingPackage skip the new archive
'      on the next boot and the update would silently never happen.
'   4. Extraction failure renames the archive to .bad rather than retrying forever. A zip that
'      cannot be unpacked will not unpack on the tenth attempt either, and retrying it on every
'      boot is a loop that looks exactly like a hardware fault.
'
' THE VERSION IS BAKED IN, not stored in a side file. A version record that can disagree with the
' code actually running is the OTA-loop condition in another guise: the player applies an update,
' reports the old version, is offered it again, forever. Stamped at build time by both
' scripts/build-autorun-zip.sh and server/lib/brightsign-package.js.

Function PackageVersion() As String
    return "0.0.0-dev"   ' ST_PACKAGE_VERSION (stamped at build time — do not edit by hand)
End Function

' Does [name] exist in directory [dir]?
'
' MatchFiles takes a DIRECTORY plus a pattern, and returns nothing when the pattern contains a
' separator. The previous version passed a full path as both arguments, so it answered "no" for
' every file on every player — which silently disabled this entire self-update path: the pending
' package was never seen, the .part file was never cleaned up, and the .done marker was never
' noticed. Two arguments, so there is no path-splitting to get wrong.
Function FileExists(dir As String, name As String) As Boolean
    files = MatchFiles(dir, name)
    if files = invalid then return false
    return files.Count() > 0
End Function

' Unpack a package that is sitting on storage waiting to be applied. Runs BEFORE the widget so a
' pending update lands before the player starts, not halfway through a playlist.
'
' Note this duplicates autozip.brs on purpose. autozip.brs handles the FIRST install, where a bare
' card holds nothing but autorun.zip and the OS processes it. Once autorun.brs exists at the
' storage root the OS no longer auto-processes the archive — so from then on the host has to do it
' itself, or self-update would work exactly once.
Sub ApplyPendingPackage(root As String)
    dir$ = root + "/"
    zipPath$ = root + "/autorun.zip"
    donePath$ = root + "/autorun.zip.done"
    badPath$ = root + "/autorun.zip.bad"
    stage$ = root + "/st-staging"

    if not FileExists(dir$, "autorun.zip") then return
    if FileExists(dir$, "autorun.zip.done") then return  ' already unpacked; again is the boot loop

    print "[st-update] unpacking pending package"

    package = CreateObject("roBrightPackage", zipPath$)
    if package = invalid then
        print "[st-update] ERROR: archive unreadable — parking it as .bad"
        MoveFile(zipPath$, badPath$)
        return
    end if

    ' ⚠️ Unpack() DELETES everything already in its target directory: "Providing a destination path
    ' of SD:/ will wipe all preexisting files from the card". Unpacking straight to the volume root
    ' would therefore erase this player's provisioning and its entire content pool on every update —
    ' the update would work and the display would come back empty and unpaired.
    '
    ' So it goes to a staging directory of its own, and the files are moved into place afterwards.
    ' The wipe is then a FEATURE: it clears any half-extracted remains of a previous attempt.
    CreateDirectory(stage$)
    package.Unpack(stage$ + "/")

    ' Unpack() returns Void, so success is proven by looking for what should now exist rather than
    ' by testing a return value that was never there.
    if not FileExists(stage$ + "/", "autorun.brs") then
        print "[st-update] ERROR: extract produced no autorun.brs — parking it as .bad"
        MoveFile(zipPath$, badPath$)
        return
    end if

    ' screentinker.json is deliberately NOT copied over: it carries THIS player's provisioning
    ' (server URL, device id), and the copy inside a package carries the build's defaults. Letting
    ' an update overwrite it would re-point or unpair the display as a side effect of a routine
    ' upgrade — silently, and on every player at once.
    moved% = 0
    for each name in MatchFiles(stage$, "*")
        if name <> "screentinker.json" then
            if MoveFile(stage$ + "/" + name, root + "/" + name) then moved% = moved% + 1
        end if
    end for
    print "[st-update] installed "; moved%; " file(s)"

    if not MoveFile(zipPath$, donePath$) then
        ' Refusing to reboot without the marker: we would extract and reboot forever.
        print "[st-update] ERROR: could not mark done — not rebooting"
        return
    end if

    print "[st-update] package applied — rebooting into it"
    sleep(2000)
    RebootSystem()
End Sub

' Ask the server what to do, and do exactly that. The DECISION lives on the server
' (server/lib/brightsign-update.js, which is unit-tested); this only executes it. Re-implementing
' the version comparison here would put the prerelease trap somewhere it cannot be tested.
Sub CheckPackageUpdate(cfg As Object, root As String)
    if cfg.server_url = "" then return

    partPath$ = root + "/autorun.zip.part"
    reg = CreateObject("roRegistrySection", "screentinker")
    attempts% = 0
    if reg.Exists("pkg_attempts") then attempts% = Val(reg.Read("pkg_attempts"))

    url$ = cfg.server_url + "/api/brightsign/package?version=" + PackageVersion()
    url$ = url$ + "&attempts=" + Stri(attempts%).Trim()
    if cfg.allow_prerelease then url$ = url$ + "&allow_prerelease=1"

    xfer = CreateObject("roUrlTransfer")
    if xfer = invalid then return
    xfer.SetUrl(url$)
    xfer.EnablePeerVerification(true)
    body$ = xfer.GetToString()
    if body$ = "" then return                  ' unreachable server: keep running what works

    manifest = ParseJson(body$)
    if manifest = invalid then return
    if manifest.action = invalid then return
    if manifest.action <> "download" then
        if manifest.reason <> invalid then print "[st-update] no action: "; manifest.reason
        return
    end if

    print "[st-update] downloading package "; manifest.version

    ' Any earlier partial is deleted first: resuming into an existing file would concatenate two
    ' downloads into something that hashes to neither.
    if FileExists(root + "/", "autorun.zip.part") then DeleteFile(partPath$)

    dl = CreateObject("roUrlTransfer")
    if dl = invalid then return
    dl.SetUrl(cfg.server_url + manifest.url)
    dl.EnablePeerVerification(true)
    if dl.GetToFile(partPath$) <> 200 then
        print "[st-update] download failed"
        RecordPackageAttempt(reg, attempts% + 1)
        DeleteFile(partPath$)
        return
    end if

    ' Verify before promoting. This is the gate that stops a truncated file becoming the boot script.
    if not VerifyPackage(partPath$, manifest.sha256, manifest.size) then
        print "[st-update] VERIFICATION FAILED — discarding, staying on "; PackageVersion()
        RecordPackageAttempt(reg, attempts% + 1)
        DeleteFile(partPath$)
        return
    end if

    ' Promote. Marker first — see the ordering note above.
    if FileExists(root + "/", "autorun.zip.done") then DeleteFile(root + "/autorun.zip.done")
    if FileExists(root + "/", "autorun.zip") then DeleteFile(root + "/autorun.zip")
    if not MoveFile(partPath$, root + "/autorun.zip") then
        print "[st-update] ERROR: could not stage the package — staying put"
        RecordPackageAttempt(reg, attempts% + 1)
        return
    end if

    ' A clean attempt counter, so the next version starts from zero rather than inheriting this
    ' version's failures and being refused before it is ever tried.
    RecordPackageAttempt(reg, 0)
    print "[st-update] staged "; manifest.version; " — rebooting to apply"
    sleep(2000)
    RebootSystem()
End Sub

Sub RecordPackageAttempt(reg As Object, n As Integer)
    if reg = invalid then return
    reg.Write("pkg_attempts", Stri(n).Trim())
    reg.Flush()
End Sub

' sha256 + size. Both matter: the hash proves the bytes are the ones we were promised, the size
' floor catches an error page or captive-portal login saved under the package's name.
Function VerifyPackage(path As String, expected As String, expectedSize As Integer) As Boolean
    ' Guard the arguments before the type declarations do it for us: a manifest missing sha256 or
    ' size passes `invalid` into an `As String`/`As Integer` parameter, which is a runtime error at
    ' the CALL — before any check inside the function could help.
    if expected = "" then return false

    ' roByteArray + roHashGenerator. The previous version used roFileSystem.Stat/OpenInputFile and
    ' roMessageDigest — all three are Roku objects that do not exist on BrightSign, so this function
    ' returned false unconditionally and every self-update failed verification and burned an
    ' attempt. The package is tens of kilobytes, so reading it whole is cheaper than the streaming
    ' loop it replaces.
    ba = CreateObject("roByteArray")
    if ba = invalid then return false
    if not ba.ReadFile(path) then
        print "[st-update] package unreadable at "; path
        return false
    end if

    size% = ba.Count()
    if size% < 1024 then
        print "[st-update] package is implausibly small ("; size%; " bytes)"
        return false
    end if
    if expectedSize > 0 and size% <> expectedSize then
        print "[st-update] size mismatch: got "; size%; " expected "; expectedSize
        return false
    end if

    hg = CreateObject("roHashGenerator", "sha256")
    if hg = invalid then return false
    digest = hg.Hash(ba)
    if digest = invalid then return false

    ' Hash() answers with an roByteArray, not a string.
    return LCase(digest.ToHexString()) = LCase(expected)
End Function

'=== main ===================================================================================

Sub Main()
    cfg = LoadConfig()

    ' Crash dumps land here if the widget ever falls over — cheap, and the only forensic trail
    ' available on a panel nobody can reach.
    dir = CreateDirectory(StorageRoot() + "/brightsign-dumps")

    ' Must happen BEFORE the widget starts: it can reboot.
    EnsurePtpDomain(cfg)

    ' A package staged by a previous run lands here, before anything is on screen. Doing it after
    ' the widget started would mean rebooting out of a playing playlist, and the panel would blink
    ' mid-content for a reason nobody watching could explain.
    ApplyPendingPackage(StorageRoot())

    port = CreateObject("roMessagePort")

    ' Second output. The XC5 family exposes more than one HDMI connector (XC2055 dual, XC4055
    ' quad). Do NOT trust the series-level spec blurb here: it credits the whole XT5 family with
    ' "dual HDMI outputs", but an XT245 in hand is single-output — that phrase appears to cover
    ' HDMI in + out. Check the individual model, not the family.
    '
    ' Every single-output model must fall through this cleanly. GetResX/GetResY only ever
    ' describe output 1, so a second widget is created ONLY when the config asks for it — an
    ' unsupported model then keeps working as a normal single-screen player rather than failing
    ' to start. Screen 2 loads the SAME player with &screen=2, so the server can hand it its own
    ' playlist ("dual" = independent) or the same one ("clone").
    dual = (cfg.output_mode = "dual" or cfg.output_mode = "clone")

    rect = FullScreenRect()
    widget = MakeWidget(PlayerUrl(cfg, 1), rect, port, cfg)
    widget.Show()

    widget2 = invalid
    if dual then
        screen2 = 2
        if cfg.output_mode = "clone" then screen2 = 1
        widget2 = MakeWidget(PlayerUrl(cfg, screen2), rect, port, cfg)
        if widget2 <> invalid then widget2.Show()
    end if

    retries = 0
    lastBeat = CreateObject("roTimespan")
    lastBeat.Mark()

    ' Update check runs AFTER the widget is up, deliberately. A slow or unreachable server must
    ' never delay first frame — content on screen is the job, updating is housekeeping. It also
    ' runs on a timer rather than only at boot, because a panel that is never power-cycled would
    ' otherwise never see an update at all.
    lastPkgCheck = CreateObject("roTimespan")
    lastPkgCheck.Mark()
    PKG_CHECK_MS = 6 * 60 * 60 * 1000    ' 6h: this replaces the boot script, so rarely is right
    if cfg.self_update then CheckPackageUpdate(cfg, StorageRoot())

    ' A watchdog on TOP of load-error: a page can load fine and then wedge (dead socket, JS
    ' exception, decoder stall) without the OS ever reporting an error. st-bridge.js posts a
    ' heartbeat every 30s; three missed beats and we rebuild the widget. This is the difference
    ' between a panel that recovers on its own and one that needs a site visit.
    WATCHDOG_MS = 120000

    while true
        msg = wait(5000, port)

        if type(msg) = "roHtmlWidgetEvent" then
            data = msg.GetData()

            if data.reason = "load-finished" then
                retries = 0
                lastBeat.Mark()
                print "[st] player loaded"

            else if data.reason = "load-error" then
                ' Back off, then fall back to the local page so the screen says something
                ' truthful instead of showing white. The local page keeps retrying the server.
                retries = retries + 1
                ' The key is `uri` on a load-error; `url` belongs to download-request. Printing
                ' the wrong one meant the single diagnostic that names the failing resource always
                ' printed "invalid".
                print "[st] load-error ("; retries; "): "; data.uri
                sleep(ChooseBackoff(retries))
                if retries >= 3 then
                    ' The server URL rides along so the fallback page can name it on screen and
                    ' keep probing it — the page has no other way to learn where home is.
                    widget = RebuildWidget(widget, "file:/" + StorageRoot() + "/offline.html?server=" + cfg.server_url, rect, port, cfg)
                else
                    widget = RebuildWidget(widget, PlayerUrl(cfg, 1), rect, port, cfg)
                end if

            else if data.reason = "message" then
                m = data.message
                lastBeat.Mark()

                ' A missing member is `invalid`, and comparing invalid to a literal is a TYPE
                ' MISMATCH that aborts the script — taking the whole player down with it. Every
                ' field is existence-checked before it is compared.
                if m = invalid or m.type = invalid then
                    ' nothing addressable in this message
                else if m.type = "heartbeat" then
                    ' nothing to do — marking the timespan above IS the handling

                else if m.type = "restart" then
                    ' The page asks to be restarted (deploy, version change, unrecoverable
                    ' error). NEVER let the page do this with location.reload().
                    print "[st] restart requested: "; m.reason
                    widget = RebuildWidget(widget, PlayerUrl(cfg, 1), rect, port, cfg)

                else if m.type = "identity" then
                    ' Pairing completed in the page — persist it where a reboot can find it.
                    ' clear:true is the operator reset; the registry must forget the display or
                    ' the next boot re-adopts it and the reset silently does nothing.
                    if m.clear <> invalid and m.clear = true then
                        SaveRegistry("device_id", "")
                        cfg.device_id = ""
                    end if
                    if m.device_id <> invalid then
                        SaveRegistry("device_id", m.device_id)
                        cfg.device_id = m.device_id
                    end if
                    if m.server_url <> invalid then
                        SaveRegistry("server_url", m.server_url)
                        cfg.server_url = m.server_url
                    end if

                else if m.type = "probe" then
                    ' Asked once during boot, before the player registers: the answer decides which
                    ' controls the dashboard is allowed to offer for this display.
                    SendProbeResult(widget)

                else if m.type = "set-orientation" then
                    if m.orientation <> invalid then SetOrientation(widget, m.orientation)

                else if m.type = "snapshot" then
                    TakeSnapshot(widget, m)

                else if m.type = "set-video-mode" then
                    vm = CreateObject("roVideoMode")
                    if m.mode <> invalid then vm.SetMode(m.mode)

                else if m.type = "set-sync-backend" then
                    ' The server decided which protocol this deployment uses (see
                    ' server/lib/sync-backend.js). Persist it so a cold boot with no network
                    ' still starts in the right mode.
                    if m.backend <> invalid then
                        SaveRegistry("sync_backend", m.backend)
                        cfg.sync_backend = m.backend
                    end if

                else if m.type = "reboot" then
                    print "[st] reboot requested"
                    RebootSystem()
                end if
            end if
        end if

        ' watchdog
        if lastBeat.TotalMilliseconds() > WATCHDOG_MS then
            print "[st] watchdog: no heartbeat in "; WATCHDOG_MS; "ms — rebuilding widget"
            widget = RebuildWidget(widget, PlayerUrl(cfg, 1), rect, port, cfg)
            lastBeat.Mark()
        end if

        ' Periodic package check. Marked BEFORE the call, not after: a check that blocks on a slow
        ' server would otherwise be retried immediately on the next tick and hammer it.
        if cfg.self_update and lastPkgCheck.TotalMilliseconds() > PKG_CHECK_MS then
            lastPkgCheck.Mark()
            CheckPackageUpdate(cfg, StorageRoot())
        end if
    end while
End Sub

Function ChooseBackoff(retries As Integer) As Integer
    if retries <= 1 then return 5000
    if retries = 2 then return 15000
    if retries = 3 then return 30000
    return 60000
End Function

' Tear the old widget down explicitly before building the new one. Dropping the reference alone
' leaves the old widget composited and holding its decoder until GC gets to it, which shows up
' as two players fighting over the screen.
Function RebuildWidget(old As Object, url As String, rect As Object, port As Object, cfg As Object) As Object
    if old <> invalid then
        old.Hide()
        old = invalid
    end if
    w = MakeWidget(url, rect, port, cfg)
    w.Show()
    return w
End Function
