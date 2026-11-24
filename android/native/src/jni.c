#include "valenced.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define VL_EXPORT(ret, name) JNIEXPORT ret JNICALL Java_app_valenced_xposed_phoenix_PhoenixRuntime_##name
#define VL_MAX_STACK (512 * 1024)
#define VL_CALLABLES_GLOBAL "__valencedCallableModules"

static VlRuntime *vl_handle(jlong handle) {
    return (VlRuntime *)(intptr_t)handle;
}

/* Returns a Java string holding the pending exception's message, or NULL when there is none. */
static jstring vl_take_error(VlRuntime *r, JNIEnv *env) {
    JSValue exc = JS_GetException(r->ctx);
    JSValue stack = JS_GetPropertyStr(r->ctx, exc, "stack");

    const char *message = JS_ToCString(r->ctx, exc);
    const char *trace = JS_IsUndefined(stack) ? NULL : JS_ToCString(r->ctx, stack);

    size_t size = strlen(message ? message : "") + strlen(trace ? trace : "") + 2;
    char *text = malloc(size);
    if (text) snprintf(text, size, "%s%s%s", message ? message : "", trace ? "\n" : "", trace ? trace : "");

    jstring out = text ? (*env)->NewStringUTF(env, text) : NULL;

    free(text);
    if (trace) JS_FreeCString(r->ctx, trace);
    if (message) JS_FreeCString(r->ctx, message);
    JS_FreeValue(r->ctx, stack);
    JS_FreeValue(r->ctx, exc);
    return out;
}

VL_EXPORT(jint, nativePatchAccessGate)(JNIEnv *env, jobject thiz) {
    (void)env;
    (void)thiz;

    return vl_access_patch();
}

VL_EXPORT(jint, nativeHookGateway)(JNIEnv *env, jobject thiz, jlong handle) {
    (void)env;
    (void)thiz;

    VlRuntime *r = vl_handle(handle);
    return r ? vl_gateway_hook(r) : VL_GATEWAY_NOT_LOADED;
}

VL_EXPORT(jlong, nativeCreate)(JNIEnv *env, jobject thiz, jobject host) {
    (void)thiz;

    VlRuntime *r = calloc(1, sizeof(VlRuntime));
    if (!r) return 0;

    if ((*env)->GetJavaVM(env, &r->vm) != JNI_OK) {
        free(r);
        return 0;
    }

    jclass cls = (*env)->GetObjectClass(env, host);
    r->call_sync = (*env)->GetMethodID(env, cls, "callSyncFromJS", "(Ljava/lang/String;)Ljava/lang/String;");
    r->call_async = (*env)->GetMethodID(env, cls, "callAsyncFromJS", "(Ljava/lang/String;J)V");
    (*env)->DeleteLocalRef(env, cls);

    if (!r->call_sync || !r->call_async) {
        (*env)->ExceptionClear(env);
        vl_log(VL_LOG_ERROR, "The host object is missing callSyncFromJS or callAsyncFromJS");
        free(r);
        return 0;
    }

    r->host = (*env)->NewGlobalRef(env, host);
    if (!r->host) {
        free(r);
        return 0;
    }

    r->rt = JS_NewRuntime();
    if (!r->rt) {
        (*env)->DeleteGlobalRef(env, r->host);
        free(r);
        return 0;
    }

    JS_SetMaxStackSize(r->rt, VL_MAX_STACK);
    JS_SetRuntimeOpaque(r->rt, r);

    r->ctx = JS_NewContext(r->rt);
    if (!r->ctx) {
        JS_FreeRuntime(r->rt);
        (*env)->DeleteGlobalRef(env, r->host);
        free(r);
        return 0;
    }

    pthread_mutexattr_t attr;
    pthread_mutexattr_init(&attr);
    pthread_mutexattr_settype(&attr, PTHREAD_MUTEX_RECURSIVE);
    pthread_mutex_init(&r->lock, &attr);
    pthread_mutexattr_destroy(&attr);

    pthread_mutex_init(&r->pump_lock, NULL);
    pthread_cond_init(&r->pump_cv, NULL);

    vl_install_globals(r);
    vl_pump_start(r);

    vl_log(VL_LOG_INFO, "Started the Phoenix JS runtime");
    return (jlong)(intptr_t)r;
}

VL_EXPORT(void, nativeDestroy)(JNIEnv *env, jobject thiz, jlong handle) {
    (void)thiz;

    VlRuntime *r = vl_handle(handle);
    if (!r) return;

    vl_pump_stop(r);

    vl_enter(r);
    vl_timers_free(r);
    JS_FreeValue(r->ctx, r->pending);
    JS_FreeContext(r->ctx);
    JS_FreeRuntime(r->rt);
    vl_leave(r);

    (*env)->DeleteGlobalRef(env, r->host);

    pthread_cond_destroy(&r->pump_cv);
    pthread_mutex_destroy(&r->pump_lock);
    pthread_mutex_destroy(&r->lock);
    free(r);

    vl_log(VL_LOG_INFO, "Stopped the Phoenix JS runtime");
}

VL_EXPORT(jstring, nativeEvaluate)(JNIEnv *env, jobject thiz, jlong handle, jbyteArray source, jstring filename) {
    (void)thiz;

    VlRuntime *r = vl_handle(handle);
    if (!r || !source) return NULL;

    /* JS_Eval needs a zero terminated buffer, and the asset arrives without one. */
    jsize size = (*env)->GetArrayLength(env, source);
    char *text = malloc((size_t)size + 1);
    if (!text) return (*env)->NewStringUTF(env, "Out of memory reading the bundle");
    (*env)->GetByteArrayRegion(env, source, 0, size, (jbyte *)text);
    text[size] = 0;

    const char *name = filename ? (*env)->GetStringUTFChars(env, filename, NULL) : NULL;

    vl_enter(r);
    JSValue ret = JS_Eval(r->ctx, text, (size_t)size, name ? name : "valenced.js", JS_EVAL_TYPE_GLOBAL);
    jstring error = JS_IsException(ret) ? vl_take_error(r, env) : NULL;
    JS_FreeValue(r->ctx, ret);
    vl_drain_jobs(r);
    vl_leave(r);

    if (name) (*env)->ReleaseStringUTFChars(env, filename, name);
    free(text);

    vl_pump_wake(r);
    return error;
}

VL_EXPORT(jstring, nativeCallJS)(JNIEnv *env, jobject thiz, jlong handle, jstring module, jstring method, jstring argsJson) {
    (void)thiz;

    VlRuntime *r = vl_handle(handle);
    if (!r) return NULL;

    const char *module_name = (*env)->GetStringUTFChars(env, module, NULL);
    const char *method_name = (*env)->GetStringUTFChars(env, method, NULL);
    const char *args_text = argsJson ? (*env)->GetStringUTFChars(env, argsJson, NULL) : NULL;
    jstring error = NULL;

    vl_enter(r);
    JSContext *ctx = r->ctx;

    JSValue g = JS_GetGlobalObject(ctx);
    JSValue modules = JS_GetPropertyStr(ctx, g, VL_CALLABLES_GLOBAL);
    JS_FreeValue(ctx, g);

    JSValue target = JS_IsObject(modules) ? JS_GetPropertyStr(ctx, modules, module_name) : JS_UNDEFINED;
    JS_FreeValue(ctx, modules);

    JSValue fn = JS_IsObject(target) ? JS_GetPropertyStr(ctx, target, method_name) : JS_UNDEFINED;

    if (!JS_IsFunction(ctx, fn)) {
        char text[256];
        snprintf(text, sizeof(text), "No callable JS method %s.%s", module_name, method_name);
        error = (*env)->NewStringUTF(env, text);
    } else {
        JSValue args = args_text
            ? JS_ParseJSON(ctx, args_text, strlen(args_text), "valenced-args.json")
            : JS_NewArray(ctx);

        if (JS_IsException(args)) {
            error = vl_take_error(r, env);
        } else {
            int64_t argc = 0;
            JSValue length = JS_GetPropertyStr(ctx, args, "length");
            JS_ToInt64(ctx, &argc, length);
            JS_FreeValue(ctx, length);
            if (argc < 0) argc = 0;
            if (argc > 32) argc = 32;

            JSValue argv[32];
            for (int64_t i = 0; i < argc; i++) argv[i] = JS_GetPropertyUint32(ctx, args, (uint32_t)i);

            JSValue ret = JS_Call(ctx, fn, target, (int)argc, (JSValueConst *)argv);
            if (JS_IsException(ret)) error = vl_take_error(r, env);

            JS_FreeValue(ctx, ret);
            for (int64_t i = 0; i < argc; i++) JS_FreeValue(ctx, argv[i]);
        }
        JS_FreeValue(ctx, args);
    }

    JS_FreeValue(ctx, fn);
    JS_FreeValue(ctx, target);
    vl_drain_jobs(r);
    vl_leave(r);

    if (args_text) (*env)->ReleaseStringUTFChars(env, argsJson, args_text);
    (*env)->ReleaseStringUTFChars(env, method, method_name);
    (*env)->ReleaseStringUTFChars(env, module, module_name);
    return error;
}

VL_EXPORT(void, nativeResolve)(JNIEnv *env, jobject thiz, jlong handle, jlong callId, jstring resultJson) {
    (void)thiz;

    VlRuntime *r = vl_handle(handle);
    if (!r) return;

    const char *text = resultJson ? (*env)->GetStringUTFChars(env, resultJson, NULL) : NULL;

    vl_enter(r);
    vl_bridge_resolve(r, (int64_t)callId, text);
    vl_drain_jobs(r);
    vl_leave(r);

    if (text) (*env)->ReleaseStringUTFChars(env, resultJson, text);
    vl_pump_wake(r);
}

VL_EXPORT(jbyteArray, nativeApplyOps)(JNIEnv *env, jobject thiz, jlong handle, jbyteArray frame, jint length) {
    (void)thiz;

    VlRuntime *r = vl_handle(handle);
    if (!r) return NULL;

    vl_enter(r);
    jbyteArray out = vl_frame_bytes(r, env, "onApplyOps", NULL, frame, length);
    vl_drain_jobs(r);
    vl_leave(r);
    return out;
}

VL_EXPORT(jbyteArray, nativeInvoke)(JNIEnv *env, jobject thiz, jlong handle, jbyteArray frame) {
    (void)thiz;

    VlRuntime *r = vl_handle(handle);
    if (!r) return NULL;

    vl_enter(r);
    jbyteArray out = vl_frame_bytes(r, env, "onInvoke", NULL, frame, -1);
    vl_drain_jobs(r);
    vl_leave(r);
    return out;
}

VL_EXPORT(jbyteArray, nativeDispatch)(JNIEnv *env, jobject thiz, jlong handle, jlong target, jbyteArray frame) {
    (void)thiz;

    VlRuntime *r = vl_handle(handle);
    if (!r) return NULL;

    int64_t to = target;
    vl_enter(r);
    jbyteArray out = vl_frame_bytes(r, env, "onDispatch", &to, frame, -1);
    vl_drain_jobs(r);
    vl_leave(r);
    return out;
}
