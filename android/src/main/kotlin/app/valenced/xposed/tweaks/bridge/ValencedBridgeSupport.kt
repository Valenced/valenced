package app.valenced.xposed.tweaks.bridge

import de.robv.android.xposed.XposedBridge.hookAllConstructors
import de.robv.android.xposed.XposedHelpers.getStaticObjectField
import app.valenced.Logger
import app.valenced.bridge.ValencedBridge
import app.valenced.logger
import app.valenced.xposed.*
import app.valenced.xposed.tweaks.bridge.ValencedBridgeRegistry.dispatchScope
import app.valenced.xposed.tweaks.bridge.ValencedBridgeRegistry.jsCallableLock
import app.valenced.xposed.tweaks.bridge.ValencedBridgeRegistry.toNativeObject
import app.valenced.xposed.tweaks.phoenixLaunched
import kotlinx.coroutines.*
import java.lang.ref.WeakReference
import java.lang.reflect.Method
import java.util.concurrent.ConcurrentHashMap

typealias MethodCallback = (args: List<Any?>) -> Any?
typealias AsyncMethodCallback = suspend (args: List<Any?>) -> Any?

object ValencedBridgeRegistry : ValencedBridge {
    internal val log: Logger = logger("valencedBridge")

    // Registered from the main thread, read from the React threads.
    private val methods: MutableMap<String, MethodCallback> = ConcurrentHashMap()
    private val asyncMethods: MutableMap<String, AsyncMethodCallback> = ConcurrentHashMap()

    /** Pending [callJSMethod] replies. Positional: guarded by [jsCallableLock]. */
    private val jsCallableReturnQueue = ArrayDeque<CompletableDeferred<Any?>>()
    private val jsCallableLock = Any()

    /** Executes async method handlers off the React native-modules thread. */
    private val dispatchScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    @Volatile
    private var reactInstance: WeakReference<Any>? = null

    @Volatile
    private var reactInstanceCallFunctionOnModule: Method? = null

    @Volatile
    private var argumentsMakeNativeObject: Method? = null

    @Volatile
    // @TODO: Can be null on <341202, once that passes stable, we can non-null assert at callsites
    private var argumentsInstance: Any? = null

    @Volatile
    private var readableMapToHashMap: Method? = null

    internal const val JS_CALLABLE_MODULE_NAME = "ValencedBridge"
    internal const val NATIVE_CALL_DATA_KEY = "valenced"
    internal const val NATIVE_METHOD_NAME_KEY = "method"
    internal const val NATIVE_METHOD_ARGS_KEY = "args"

    /** Delivers a JS-callable invocation. Set by the Phoenix runtime, null under React Native. */
    @Volatile
    internal var jsTransport: ((module: String, method: String, args: List<Any?>) -> Unit)? = null

    override val isReady: Boolean
        get() = jsTransport != null ||
            (reactInstanceCallFunctionOnModule != null && reactInstance?.get() != null)

    override fun registerMethod(name: String, handler: MethodCallback) {
        if (methods.containsKey(name) || asyncMethods.containsKey(name))
            log.w("Bridge method already exists and will be overridden: $name")
        methods[name] = handler
    }

    override fun registerAsyncMethod(name: String, handler: AsyncMethodCallback) {
        if (methods.containsKey(name) || asyncMethods.containsKey(name))
            log.w("Bridge method already exists and will be overridden: $name")
        asyncMethods[name] = handler
    }

    override suspend fun callJSMethod(name: String, args: List<Any?>): Any? {
        val transport = jsTransport
        val callFn = if (transport != null) null
        else reactInstanceCallFunctionOnModule
            ?: error("Bridge not ready; no captured method ReactInstance.callFunctionOnModule")
        val instance = if (transport != null) null
        else reactInstance?.get()
            ?: error("Bridge not ready; no captured ReactInstance")

        val deferred = CompletableDeferred<Any?>()

        // Enqueue + invoke atomically.
        // Replies are matched positionally, so the JS-side call order must equal the queue order,
        // and a failed invoke must not leave an orphan deferred behind (that would cross-complete every later reply).
        synchronized(jsCallableLock) {
            jsCallableReturnQueue.addLast(deferred)
            try {
                // JS-side errors surface asynchronously on the CPP thread and are uncatchable here.
                // [args.toNativeObject()] can throw however, so we catch it and remove the deferred.
                if (transport != null) transport(JS_CALLABLE_MODULE_NAME, name, args)
                else callFn!!.invoke(instance, JS_CALLABLE_MODULE_NAME, name, args.toNativeObject())
            } catch (e: Throwable) {
                jsCallableReturnQueue.remove(deferred)
                throw e
            }
        }
        return deferred.await()
    }

    /**
     * Runs a sync bridge method and returns the `{result | error}` payload.
     *
     * The Phoenix transport marshals through JSON, so unlike [tryDispatchNative] this returns
     * plain Kotlin values rather than React's native object graph.
     */
    internal fun dispatch(name: String, args: List<Any?>): Map<String, Any?> = try {
        val handler = methods[name] ?: throw Error(
            if (name in asyncMethods) "Native bridge method is async-only: $name"
            else "Native bridge method not registered: $name"
        )
        mapOf("result" to handler(args))
    } catch (e: Throwable) {
        mapOf("error" to e.stackTraceToString())
    }

    /** [dispatch], off the caller's thread when [name] was registered with [registerAsyncMethod]. */
    internal fun dispatchAsync(name: String, args: List<Any?>, complete: (Map<String, Any?>) -> Unit) {
        val handler = asyncMethods[name]
        if (handler == null) {
            complete(dispatch(name, args))
            return
        }

        dispatchScope.launch {
            val response = try {
                mapOf("result" to handler(args))
            } catch (e: Throwable) {
                mapOf("error" to e.stackTraceToString())
            }
            try {
                complete(response)
            } catch (e: Throwable) {
                log.e("Failed to deliver async bridge result for $name", e)
            }
        }
    }

    internal fun clearMethods() {
        methods.clear()
        asyncMethods.clear()
    }

    internal fun captureReactInstance(instance: Any) {
        reactInstance = WeakReference(instance)
    }

    internal fun setReflectiveMethods(
        callFunctionOnModule: Method,
        argumentsInstance: Any?,
        makeNativeObject: Method,
        toHashMap: Method,
    ) {
        reactInstanceCallFunctionOnModule = callFunctionOnModule
        ValencedBridgeRegistry.argumentsInstance = argumentsInstance
        argumentsMakeNativeObject = makeNativeObject
        readableMapToHashMap = toHashMap
    }

    /**
     * Returns the wrapped `{result | error}` payload if [rawCallData] was for Valenced bridge,
     * or `null` if it wasn't ours (should let the original method run).
     */
    @Suppress("UNCHECKED_CAST")
    internal fun tryDispatchNative(rawCallData: Any): Map<String, Any?>? {
        val hm = readableMapToHashMap?.invoke(rawCallData) as? HashMap<String, Any?> ?: return null
        val callData = hm[NATIVE_CALL_DATA_KEY] as? HashMap<String, Any?> ?: return null

        return try {
            val name = callData[NATIVE_METHOD_NAME_KEY] as? String
                ?: throw Error("Invalid native bridge call data")
            val handler = methods[name] ?: throw Error(
                if (name in asyncMethods) "Native bridge method is async-only: $name"
                else "Native bridge method not registered: $name"
            )
            val args = callData[NATIVE_METHOD_ARGS_KEY] as? List<Any?>
                ?: throw Error("Invalid native bridge args (expected List)")

            val result = handler(args).toNativeObject()
            mapOf("result" to result)
        } catch (e: Throwable) {
            mapOf("error" to e.stackTraceToString())
        }
    }

    /**
     * Async-capable dispatch for the promise-based bridge path.
     *
     * Returns `false` if [rawCallData] wasn't ours (should let the original method run).
     * Returns `true` when handled. [complete] receives the `{result | error}` payload synchronously
     * for [registerMethod] handlers (preserving their threading), or later from [dispatchScope] for [registerAsyncMethod] handlers.
     */
    @Suppress("UNCHECKED_CAST")
    internal fun tryDispatchNativeAsync(rawCallData: Any, complete: (Map<String, Any?>) -> Unit): Boolean {
        val hm = readableMapToHashMap?.invoke(rawCallData) as? HashMap<String, Any?> ?: return false
        val callData = hm[NATIVE_CALL_DATA_KEY] as? HashMap<String, Any?> ?: return false

        try {
            val name = callData[NATIVE_METHOD_NAME_KEY] as? String
                ?: throw Error("Invalid native bridge call data")
            val args = callData[NATIVE_METHOD_ARGS_KEY] as? List<Any?>
                ?: throw Error("Invalid native bridge args (expected List)")

            val asyncHandler = asyncMethods[name]
            if (asyncHandler != null) {
                dispatchScope.launch {
                    val response = try {
                        mapOf("result" to asyncHandler(args).toNativeObject())
                    } catch (e: Throwable) {
                        mapOf("error" to e.stackTraceToString())
                    }
                    try {
                        complete(response)
                    } catch (e: Throwable) {
                        log.e("Failed to deliver async bridge result for $name", e)
                    }
                }
            } else {
                val handler = methods[name] ?: throw Error("Native bridge method not registered: $name")
                complete(mapOf("result" to handler(args).toNativeObject()))
            }
        } catch (e: Throwable) {
            complete(mapOf("error" to e.stackTraceToString()))
        }
        return true
    }

    /**
     * Completes the next pending [CompletableDeferred] in the JS-callable return queue.
     * Used by the built-in `valenced.__callableReturn` bridge method registered in [valencedBridgeSupport].
     */
    internal fun completeNextJSCallable(result: Any?, error: Any?) {
        val deferred = synchronized(jsCallableLock) { jsCallableReturnQueue.removeFirstOrNull() } ?: return
        if (error != null) deferred.completeExceptionally(Error("JS returned error: $error"))
        else deferred.complete(result)
    }

    /**
     * Converts a value to React's native object graph.
     *
     * Without the host bridge there is nothing to convert to, so the value passes through. That only
     * happens off-device, since a bridge call cannot arrive before [setReflectiveMethods].
     */
    internal fun Any?.toNativeObject(): Any? {
        val value = if (this == Unit) null else this
        if (phoenixLaunched == true) return value
        val makeNativeObject = argumentsMakeNativeObject ?: return value
        return makeNativeObject.invoke(argumentsInstance, value)
    }
}


val valencedBridgeSupport by tweak {
    ValencedBridgeRegistry.clearMethods()

    val arguments = classLoader.loadClass("com.facebook.react.bridge.Arguments")
    val readableMap = classLoader.loadClass("com.facebook.react.bridge.ReadableMap")
    val promise = classLoader.loadClass("com.facebook.react.bridge.Promise")

    val promiseResolve = promise.method("resolve", Any::class.java)
    val makeNativeObject = arguments.method("makeNativeObject", Any::class.java)
    val toHashMap = readableMap.method("toHashMap")
    val reactInstanceClass = classLoader.loadClass("com.facebook.react.runtime.ReactInstance")
    val nativeArrayClass = classLoader.loadClass("com.facebook.react.bridge.NativeArray")
    val callFunctionOnModule = reactInstanceClass.method(
        "callFunctionOnModule",
        String::class.java,
        String::class.java,
        nativeArrayClass,
    )

    ValencedBridgeRegistry.setReflectiveMethods(
        callFunctionOnModule,
        runCatching { getStaticObjectField(arguments, "INSTANCE") }.getOrNull(),
        makeNativeObject,
        toHashMap,
    )

    // JS -> native (sync)
    runCatching {
        classLoader.loadClass("com.horcrux.svg.RNSVGRenderableManager")
            .method("getBBox", Double::class.javaObjectType, readableMap)
            .hook {
                before {
                    val callData = args[1] ?: return@before
                    val response = ValencedBridgeRegistry.tryDispatchNative(callData) ?: return@before
                    result = runCatching { response.toNativeObject() }.getOrNull()
                }
            }
    }.onFailure { log.w("RNSVGRenderableManager not available; getBBox bridge path disabled.") }

    // JS -> native (async)
    classLoader.loadClass("com.facebook.react.modules.blob.FileReaderModule")
        .method("readAsDataURL", readableMap, promise)
        .hook {
            before {
                val callData = args[0] ?: return@before
                val promiseObj = args[1]!!
                val handled = ValencedBridgeRegistry.tryDispatchNativeAsync(callData) { response ->
                    promiseResolve.invoke(promiseObj, runCatching { response.toNativeObject() }.getOrNull())
                }
                if (handled) result = null
            }
        }

    // Native -> JS
    // Hook every constructor, since R8 renames or drops some of the parameter types.
    hookAllConstructors(
        reactInstanceClass,
        methodHook {
            after {
                log.i("Captured ReactInstance for ValencedBridge")
                ValencedBridgeRegistry.captureReactInstance(thisObject!!)
            }
        }.build(),
    )

    // Native -> JS return (async, `valenced.__callableReturn`)
    ValencedBridgeRegistry.registerMethod("valenced.__callableReturn") { args ->
        @Suppress("UNCHECKED_CAST")
        val data = args.firstOrNull() as? Map<String, Any?> ?: emptyMap()
        ValencedBridgeRegistry.completeNextJSCallable(
            result = data["result"],
            error = data["error"],
        )
        null
    }

    ValencedBridgeRegistry.registerMethod("valenced.info") {
        mapOf(
            "name" to ValencedConstants.LOADER_NAME,
            "version" to ValencedConstants.LOADER_VERSION,
        )
    }
}
