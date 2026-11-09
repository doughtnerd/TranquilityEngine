#!/usr/bin/env python3
"""Minimal WebKitGTK browser: opens a URL, prints capability probes and the page's #out text once a second."""
import json, sys
import gi
gi.require_version("Gtk", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import Gtk, GLib, WebKit2

url = sys.argv[1]
win = Gtk.Window()
win.set_default_size(800, 600)
win.move(0, 0)
import os
pol = os.environ.get("AUTOPLAY_POLICY")  # allow | allow-without-sound | deny: WebKitWebsitePolicies autoplay; unset leaves WebKitGTK's default
if pol:
    ap = {"allow": WebKit2.AutoplayPolicy.ALLOW, "allow-without-sound": WebKit2.AutoplayPolicy.ALLOW_WITHOUT_SOUND, "deny": WebKit2.AutoplayPolicy.DENY}[pol]
    view = WebKit2.WebView(website_policies=WebKit2.WebsitePolicies(autoplay=ap))
else:
    view = WebKit2.WebView()
win.add(view)
win.connect("destroy", Gtk.main_quit)

settings = view.get_settings()
print("WEBKITGTK_VERSION %d.%d.%d" % (WebKit2.get_major_version(), WebKit2.get_minor_version(), WebKit2.get_micro_version()), flush=True)
print("media-playback-requires-user-gesture", settings.get_media_playback_requires_user_gesture(), flush=True)

PROBE = """(() => {
  const simd = WebAssembly.validate(new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,10,1,8,0,65,0,253,15,253,98,11]));
  return JSON.stringify({ audioWorklet: typeof AudioWorkletNode !== 'undefined', simd,
    secure: isSecureContext, ua: navigator.userAgent, out: (document.getElementById('out')||{}).textContent });
})()"""

def on_result(src, res, _):
    try:
        v = src.evaluate_javascript_finish(res)
        print("PAGE", v.to_string().replace("\n", " | "), flush=True)
    except Exception as e:
        print("PAGE-ERR", e, flush=True)

def tick():
    view.evaluate_javascript(PROBE, -1, None, None, None, on_result, None)
    return True

view.connect("load-changed", lambda v, ev: print("LOAD", ev.value_nick, flush=True))
view.connect("load-failed", lambda v, ev, uri, err: print("LOAD-FAILED", uri, err.message, flush=True) or False)
view.connect("web-process-terminated", lambda v, r: print("WEB-PROCESS-TERMINATED", r.value_nick, flush=True))
GLib.timeout_add_seconds(1, tick)
win.show_all()
view.load_uri(url)
Gtk.main()
