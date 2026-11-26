package com.myco.multicast

import android.app.Activity
import android.content.Context
import android.net.wifi.WifiManager
import android.util.Log
import android.webkit.WebView
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Plugin

/**
 * Holds a Wi-Fi multicast lock while the app runs. Android filters multicast packets out for apps that hold no
 * lock, so without this an mDNS browse (the debug link's discovery) never hears a tool's announcement.
 * Not reference counted: one acquire, one release.
 */
@TauriPlugin
class MulticastPlugin(private val activity: Activity) : Plugin(activity) {
    private var lock: WifiManager.MulticastLock? = null

    override fun load(webView: WebView) {
        acquire()
    }

    override fun onDestroy() {
        release()
    }

    private fun acquire() {
        if (lock?.isHeld == true) return
        try {
            val wifi = activity.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
            lock = wifi?.createMulticastLock(TAG)?.also {
                it.setReferenceCounted(false)
                it.acquire()
            }
        } catch (e: Exception) {
            // Discovery then hears nothing; a typed address still pairs.
            Log.w(TAG, "could not take the multicast lock", e)
        }
    }

    private fun release() {
        try {
            if (lock?.isHeld == true) lock?.release()
        } catch (e: Exception) {
            Log.w(TAG, "could not release the multicast lock", e)
        }
        lock = null
    }

    private companion object {
        const val TAG = "myco-debug"
    }
}
