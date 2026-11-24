package app.valenced.xposed.tweaks.phoenix

import app.valenced.xposed.Tweak
import app.valenced.xposed.api.registerNativeMethod
import app.valenced.xposed.hook
import app.valenced.xposed.loadClassOrNull
import app.valenced.xposed.method
import app.valenced.xposed.phoenix.FrameVerdict
import app.valenced.xposed.phoenix.PhoenixRuntime
import app.valenced.xposed.tweak
import java.lang.reflect.Method
import java.lang.reflect.Modifier

private const val GUEST_HOST = "com.discord.nativeapp.bridge.GuestHost"

/**
 * Forwards Phoenix's UI op frames to JS, which may drop or replace them.
 *
 * Phoenix sends ops out through `GuestHost.applyOps` and `GuestHost.invoke`, and takes taps and
 * text back in through the native `WasmRuntime.nativeDispatch`. The hooks are inert until
 * [PhoenixRuntime] is running, so React Native launches are unaffected.
 */
val phoenixFrames by tweak {
    val applyOps = findApplyOps()
    if (applyOps == null) log.w("No GuestHost.applyOps(byte[], int), outgoing op frames are not hooked")
    else applyOps.hook {
        before {
            val verdict = PhoenixRuntime.applyOps(args[0] as? ByteArray, args[1] as? Int ?: 0) ?: return@before
            if (FrameVerdict.isDrop(verdict)) result = null
            else FrameVerdict.payload(verdict)?.let {
                args[0] = it
                args[1] = it.size
            }
        }
    }

    val invoke = findInvoke()
    if (invoke == null) log.w("No GuestHost.invoke(byte[]), guest calls are not hooked")
    else invoke.hook {
        before {
            val verdict = PhoenixRuntime.invoke(args[0] as? ByteArray) ?: return@before
            if (FrameVerdict.isDrop(verdict)) result = null
            else FrameVerdict.payload(verdict)?.let { args[0] = it }
        }
    }

    val dispatch = findDispatch()
    if (dispatch == null) log.w("No native dispatch method, incoming frames are not hooked")
    else dispatch.hook {
        before {
            val verdict = PhoenixRuntime.dispatch(args[0] as? Long ?: 0L, args[1] as? ByteArray) ?: return@before
            val payload = FrameVerdict.payload(verdict)
            if (payload != null) args[1] = payload
            else result = FrameVerdict.isTrue(verdict)
        }
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

/**
 * Resolves a frame method by its documented name first, since JNI-registered natives keep theirs,
 * then by shape for builds where R8 renamed it.
 */
private fun Tweak.findApplyOps(): Method? =
    classLoader.loadClassOrNull(GUEST_HOST)
        ?.let { runCatching { it.method("applyOps", ByteArray::class.java, Int::class.javaPrimitiveType) }.getOrNull() }
        ?: dexFinder.findMethod {
            matcher {
                name("applyOps")
                returnType("void")
                paramTypes("byte[]", "int")
            }
        }

private fun Tweak.findInvoke(): Method? =
    classLoader.loadClassOrNull(GUEST_HOST)
        ?.let { runCatching { it.method("invoke", ByteArray::class.java) }.getOrNull() }
        ?: dexFinder.findMethod {
            matcher {
                name("invoke")
                returnType("byte[]")
                paramTypes("byte[]")
            }
        }

private fun Tweak.findDispatch(): Method? =
    dexFinder.findMethod {
        matcher {
            name("nativeDispatch")
            modifiers(Modifier.NATIVE)
            returnType("boolean")
            paramTypes("long", "byte[]")
        }
    }
