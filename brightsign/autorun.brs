' ScreenTinker — BrightSign capability probe
'
' Drop this plus probe.html on a FAT32 SD card (root, nothing else), insert, power on.
' It opens the local probe page with Node.js enabled so the @brightsign/* modules are
' injected, then the page reports what actually resolves on THIS model and OS build.
'
' Deliberately local-first: the whole point of the probe is to establish the baseline
' (what a LOCAL page can reach) before testing whether a REMOTE page reaches the same.

Sub Main()
    videoMode = CreateObject("roVideoMode")
    r = CreateObject("roRectangle", 0, 0, videoMode.GetResX(), videoMode.GetResY())

    config = {
        url: "file:///probe.html"
        nodejs_enabled: true          ' REQUIRED for require("@brightsign/*")
        inspector_server: { port: 2999 }   ' remote devtools: http://<player-ip>:2999
        storage_path: "SD:/"
        storage_quota: 1073741824
        javascript_enabled: true
        mouse_enabled: true
    }

    html = CreateObject("roHtmlWidget", r, config)
    html.Show()

    ' Keep the script alive; the page does the work.
    msgPort = CreateObject("roMessagePort")
    html.SetPort(msgPort)
    while true
        msg = wait(0, msgPort)
    end while
End Sub
