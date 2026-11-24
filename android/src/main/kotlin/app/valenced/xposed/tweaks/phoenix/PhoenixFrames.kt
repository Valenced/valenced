package app.valenced.xposed.tweaks.phoenix

import android.os.Handler
import android.os.Looper
import android.util.Base64
import app.valenced.xposed.api.registerNativeAsyncMethod
import app.valenced.xposed.api.registerNativeMethod
import app.valenced.xposed.hook
import app.valenced.xposed.loadClassOrNull
import app.valenced.xposed.method
import app.valenced.xposed.phoenix.FrameVerdict
import app.valenced.xposed.phoenix.PhoenixRuntime
import app.valenced.xposed.tweak
import de.robv.android.xposed.XposedBridge
import java.lang.reflect.Modifier

private const val GUEST_HOST = "com.discord.nativeapp.bridge.GuestHost"

val phoenixFrames by tweak {
    // By name first, since JNI-registered natives keep theirs, then by shape for R8-renamed builds.
    val applyOps = classLoader.loadClassOrNull(GUEST_HOST)
        ?.let { runCatching { it.method("applyOps", ByteArray::class.java, Int::class.javaPrimitiveType) }.getOrNull() }
        ?: dexFinder.findMethod {
            matcher {
                name("applyOps")
                returnType("void")
                paramTypes("byte[]", "int")
            }
        }
    var guest: Handler? = null
    if (applyOps == null) log.w("No GuestHost.applyOps(byte[], int), outgoing op frames are not hooked")
    else applyOps.hook {
        before {
            if (guest == null) Looper.myLooper()?.let { guest = Handler(it) }
            val verdict = PhoenixRuntime.applyOps(args[0] as? ByteArray, args[1] as? Int ?: 0) ?: return@before
            if (FrameVerdict.isDrop(verdict)) result = null
            else FrameVerdict.payload(verdict)?.let {
                args[0] = it
                args[1] = it.size
            }
        }
    }

    val invoke = classLoader.loadClassOrNull(GUEST_HOST)
        ?.let { runCatching { it.method("invoke", ByteArray::class.java) }.getOrNull() }
        ?: dexFinder.findMethod {
            matcher {
                name("invoke")
                returnType("byte[]")
                paramTypes("byte[]")
            }
        }
    var guestHost: Any? = null
    if (invoke == null) log.w("No GuestHost.invoke(byte[]), guest calls are not hooked")
    else invoke.hook {
        before {
            guestHost = thisObject
            val verdict = PhoenixRuntime.invoke(args[0] as? ByteArray) ?: return@before
            if (FrameVerdict.isDrop(verdict)) result = null
            else FrameVerdict.payload(verdict)?.let { args[0] = it }
        }
    }

    // Skips the hook, so plugin requests don't reach the frame listeners again
    if (invoke != null) registerNativeAsyncMethod("valenced.phoenix.http.invoke") { args ->
        val host = guestHost
        if (host == null && !Modifier.isStatic(invoke.modifiers)) throw Error("Phoenix has not sent a request yet")
        XposedBridge.invokeOriginalMethod(invoke, host, arrayOf(Base64.decode(args[0] as String, Base64.NO_WRAP)))
        null
    }

    val dispatch = dexFinder.findMethod {
        matcher {
            name("nativeDispatch")
            modifiers(Modifier.NATIVE)
            returnType("boolean")
            paramTypes("long", "byte[]")
        }
    }
    var runtime = 0L
    if (dispatch == null) log.w("No native dispatch method, incoming frames are not hooked")
    else dispatch.hook {
        before {
            if (Looper.myLooper() == guest?.looper) runtime = args[0] as? Long ?: 0L
            val verdict = PhoenixRuntime.dispatch(args[0] as? Long ?: 0L, args[1] as? ByteArray) ?: return@before
            val payload = FrameVerdict.payload(verdict)
            if (payload != null) args[1] = payload
            else result = FrameVerdict.isTrue(verdict)
        }
    }

    // Runs on the guest thread like Discord's own frames, and skips the hook like plugin requests
    if (dispatch != null) registerNativeAsyncMethod("valenced.phoenix.dispatch") { args ->
        val handler = guest.takeIf { runtime != 0L } ?: throw Error("Phoenix has not received a frame yet")
        val frame = Base64.decode(args[0] as String, Base64.NO_WRAP)
        handler.post { XposedBridge.invokeOriginalMethod(dispatch, null, arrayOf(runtime, frame)) }
        null
    }

    val uiProps by lazy {
        val field = dexFinder.findField {
            matcher {
                modifiers(Modifier.STATIC)
                type("java.lang.String[]")
                declaredClass { usingStrings("accessibilityActions", "lineHeightExact", "activeBackground") }
            }
        }
        if (field == null) log.w("No UI prop name table, op props stay unnamed")
        field?.apply { isAccessible = true }?.get(null) as? Array<*>
    }
    registerNativeMethod("valenced.phoenix.uiProps") { uiProps?.toList() }
}
