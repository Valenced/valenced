package app.valenced.xposed.tweaks.phoenix

import app.valenced.xposed.phoenix.AccessPatch
import app.valenced.xposed.phoenix.GatewayHook
import app.valenced.xposed.phoenix.PhoenixRuntime
import app.valenced.xposed.tweak
import app.valenced.xposed.tweaks.PhoenixForce
import app.valenced.xposed.tweaks.onLaunchDecision
import app.valenced.xposed.tweaks.phoenixForce
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private const val POLL_MS = 100L
private const val DEADLINE_MS = 30_000L

/**
 * Patches Phoenix's client library once Discord maps it.
 *
 * The access gate only runs when the loader is set to force Phoenix, since an account with the
 * rollout needs nothing. The gateway registry swap always runs, and costs one atomic load per
 * event no plugin listens to.
 *
 * Discord loads `liblibdiscord_wasm_host.so` after the launch decision, so both are retried until
 * it shows up. The access check itself runs once the gateway identifies, well after that.
 */
val phoenixNativeHooks by tweak {
    onLaunchDecision { phoenix ->
        if (!phoenix) return@onLaunchDecision

        CoroutineScope(Dispatchers.IO).launch {
            var access = phoenixForce != PhoenixForce.PHOENIX
            var gateway = false
            var waited = 0L

            while (!access || !gateway) {
                if (!access) {
                    val result = PhoenixRuntime.patchAccessGate(modulePath, appInfo)
                    if (result != AccessPatch.NOT_LOADED) {
                        log.i("Access gate: ${result.name.lowercase()}")
                        access = true
                    }
                }

                if (!gateway) {
                    val result = PhoenixRuntime.hookGateway()
                    if (result != GatewayHook.NOT_LOADED) {
                        log.i("Gateway registry: ${result.name.lowercase()}")
                        gateway = true
                    }
                }

                if (waited >= DEADLINE_MS) {
                    log.w("Phoenix never loaded its client library, its native hooks are not installed")
                    return@launch
                }

                delay(POLL_MS)
                waited += POLL_MS
            }
        }
    }
}
