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
    }

    ' 1) registry
    reg = CreateObject("roRegistrySection", "screentinker")
    if reg.Exists("server_url") then cfg.server_url = reg.Read("server_url")
    if reg.Exists("device_id") then cfg.device_id = reg.Read("device_id")
    if reg.Exists("sync_backend") then cfg.sync_backend = reg.Read("sync_backend")
    if reg.Exists("output_mode") then cfg.output_mode = reg.Read("output_mode")

    ' 2) a JSON file on the card wins — that is how a batch gets imaged without touching each box
    ba = CreateObject("roByteArray")
    if ba.ReadFile("SD:/screentinker.json") then
        json = ParseJson(ba.ToAsciiString())
        if json <> invalid then
            if json.server_url <> invalid then cfg.server_url = json.server_url
            if json.device_id <> invalid then cfg.device_id = json.device_id
            if json.sync_backend <> invalid then cfg.sync_backend = json.sync_backend
            if json.output_mode <> invalid then cfg.output_mode = json.output_mode
            if json.inspector <> invalid then cfg.inspector = json.inspector
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
        storage_path: "/cache"                  ' DIRECTORY NAME for the local storage cache
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

Function FullScreenRect() As Object
    vm = CreateObject("roVideoMode")
    return CreateObject("roRectangle", 0, 0, vm.GetResX(), vm.GetResY())
End Function

'=== main ===================================================================================

Sub Main()
    cfg = LoadConfig()

    ' Crash dumps land here if the widget ever falls over — cheap, and the only forensic trail
    ' available on a panel nobody can reach.
    dir = CreateDirectory("SD:/brightsign-dumps")

    ' Must happen BEFORE the widget starts: it can reboot.
    EnsurePtpDomain(cfg)

    port = CreateObject("roMessagePort")

    ' Second output. XC2055/XC4055 and XT245/XT1145/XT2145 expose more than one HDMI connector;
    ' every other model is single-output and must fall through to it. GetResX/GetResY only ever
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
                print "[st] load-error ("; retries; "): "; data.url
                sleep(ChooseBackoff(retries))
                if retries >= 3 then
                    ' The server URL rides along so the fallback page can name it on screen and
                    ' keep probing it — the page has no other way to learn where home is.
                    widget = RebuildWidget(widget, "file:/SD:/offline.html?server=" + cfg.server_url, rect, port, cfg)
                else
                    widget = RebuildWidget(widget, PlayerUrl(cfg, 1), rect, port, cfg)
                end if

            else if data.reason = "message" then
                m = data.message
                lastBeat.Mark()

                if m.type = "heartbeat" then
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
                    if m.clear = true then
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
