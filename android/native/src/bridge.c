#include "valenced.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static JNIEnv *vl_env(VlRuntime *r, bool *attached) {
    *attached = false;

    JNIEnv *env = NULL;
    jint ret = (*r->vm)->GetEnv(r->vm, (void **)&env, JNI_VERSION_1_6);
    if (ret == JNI_OK) return env;
    if (ret != JNI_EDETACHED) return NULL;

    if ((*r->vm)->AttachCurrentThreadAsDaemon(r->vm, &env, NULL) != JNI_OK) return NULL;
    *attached = true;
    return env;
}

static void vl_detach(VlRuntime *r, bool attached) {
    if (attached) (*r->vm)->DetachCurrentThread(r->vm);
}

static bool vl_clear_java_exception(JNIEnv *env, const char *where) {
    if (!(*env)->ExceptionCheck(env)) return false;
    vl_log(VL_LOG_ERROR, "%s threw on the Java side", where);
    (*env)->ExceptionDescribe(env);
    (*env)->ExceptionClear(env);
    return true;
}

static char *vl_stringify(JSContext *ctx, JSValueConst value) {
    JSValue json = JS_JSONStringify(ctx, value, JS_UNDEFINED, JS_UNDEFINED);
    if (JS_IsException(json) || JS_IsUndefined(json)) {
        JS_FreeValue(ctx, json);
        return NULL;
    }

    const char *text = JS_ToCString(ctx, json);
    char *copy = text ? strdup(text) : NULL;
    if (text) JS_FreeCString(ctx, text);
    JS_FreeValue(ctx, json);
    return copy;
}

static JSValue vl_js_call_sync(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;
    VlRuntime *r = vl_from(ctx);

    if (argc < 1) return JS_ThrowTypeError(ctx, "A bridge call needs a payload");

    char *payload = vl_stringify(ctx, argv[0]);
    if (!payload) return JS_ThrowTypeError(ctx, "The bridge payload is not JSON serializable");

    bool attached = false;
    JNIEnv *env = vl_env(r, &attached);
    if (!env) {
        free(payload);
        return JS_ThrowInternalError(ctx, "No JNI environment for the bridge call");
    }

    jstring jpayload = (*env)->NewStringUTF(env, payload);
    free(payload);
    if (!jpayload) {
        vl_detach(r, attached);
        return JS_ThrowOutOfMemory(ctx);
    }

    jstring jresult = (*env)->CallObjectMethod(env, r->host, r->call_sync, jpayload);
    (*env)->DeleteLocalRef(env, jpayload);

    if (vl_clear_java_exception(env, "A sync bridge call")) {
        if (jresult) (*env)->DeleteLocalRef(env, jresult);
        vl_detach(r, attached);
        return JS_ThrowInternalError(ctx, "The sync bridge call failed on the Java side");
    }

    JSValue out = JS_UNDEFINED;
    if (jresult) {
        const char *text = (*env)->GetStringUTFChars(env, jresult, NULL);
        if (text) {
            out = JS_ParseJSON(ctx, text, strlen(text), "valenced-bridge.json");
            (*env)->ReleaseStringUTFChars(env, jresult, text);
        }
        (*env)->DeleteLocalRef(env, jresult);
    }

    vl_detach(r, attached);
    return out;
}

static JSValue vl_js_call_async(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;
    VlRuntime *r = vl_from(ctx);

    JSValue funcs[2];
    JSValue promise = JS_NewPromiseCapability(ctx, funcs);
    if (JS_IsException(promise)) return promise;

    char *payload = argc > 0 ? vl_stringify(ctx, argv[0]) : NULL;

    bool attached = false;
    JNIEnv *env = payload ? vl_env(r, &attached) : NULL;
    jstring jpayload = env ? (*env)->NewStringUTF(env, payload) : NULL;
    free(payload);

    if (!jpayload) {
        JSValue error = JS_NewError(ctx);
        JS_SetPropertyStr(ctx, error, "message",
                          JS_NewString(ctx, "The bridge call could not reach the Java side"));
        JSValue ret = JS_Call(ctx, funcs[1], JS_UNDEFINED, 1, (JSValueConst *)&error);
        JS_FreeValue(ctx, ret);
        JS_FreeValue(ctx, error);
        JS_FreeValue(ctx, funcs[0]);
        JS_FreeValue(ctx, funcs[1]);
        if (env) vl_detach(r, attached);
        return promise;
    }

    int64_t id = ++r->next_call_id;
    char key[24];
    snprintf(key, sizeof(key), "%lld", (long long)id);

    JSValue slot = JS_NewArray(ctx);
    JS_SetPropertyUint32(ctx, slot, 0, funcs[0]);
    JS_SetPropertyUint32(ctx, slot, 1, funcs[1]);
    JS_SetPropertyStr(ctx, r->pending, key, slot);

    (*env)->CallVoidMethod(env, r->host, r->call_async, jpayload, (jlong)id);
    (*env)->DeleteLocalRef(env, jpayload);
    vl_clear_java_exception(env, "An async bridge call");
    vl_detach(r, attached);

    return promise;
}

void vl_bridge_resolve(VlRuntime *r, int64_t call_id, const char *result_json) {
    JSContext *ctx = r->ctx;

    char key[24];
    snprintf(key, sizeof(key), "%lld", (long long)call_id);

    JSValue slot = JS_GetPropertyStr(ctx, r->pending, key);
    if (!JS_IsArray(slot)) {
        JS_FreeValue(ctx, slot);
        vl_log(VL_LOG_WARN, "No pending bridge call %lld to reply to", (long long)call_id);
        return;
    }

    JSAtom atom = JS_NewAtom(ctx, key);
    JS_DeleteProperty(ctx, r->pending, atom, 0);
    JS_FreeAtom(ctx, atom);

    JSValue resolve = JS_GetPropertyUint32(ctx, slot, 0);
    JSValue reject = JS_GetPropertyUint32(ctx, slot, 1);
    JS_FreeValue(ctx, slot);

    JSValue value = result_json
        ? JS_ParseJSON(ctx, result_json, strlen(result_json), "valenced-bridge.json")
        : JS_UNDEFINED;

    JSValue target = resolve;
    if (JS_IsException(value)) {
        JS_FreeValue(ctx, value);
        value = JS_GetException(ctx);
        target = reject;
    }

    JSValue ret = JS_Call(ctx, target, JS_UNDEFINED, 1, (JSValueConst *)&value);
    if (JS_IsException(ret)) vl_report_exception(r, "A bridge reply handler failed");

    JS_FreeValue(ctx, ret);
    JS_FreeValue(ctx, value);
    JS_FreeValue(ctx, resolve);
    JS_FreeValue(ctx, reject);
}

void vl_install_bridge(VlRuntime *r) {
    JSContext *ctx = r->ctx;
    JSValue g = JS_GetGlobalObject(ctx);

    r->pending = JS_NewObject(ctx);

    JSValue symbol = JS_GetPropertyStr(ctx, g, "Symbol");
    JSValue symbol_for = JS_GetPropertyStr(ctx, symbol, "for");

    static const char *const kNames[] = {
        "valenced.bridge.call.sync",
        "valenced.bridge.call.async",
    };
    JSCFunction *const kFuncs[] = { vl_js_call_sync, vl_js_call_async };

    for (int i = 0; i < 2; i++) {
        JSValue name = JS_NewString(ctx, kNames[i]);
        JSValue key = JS_Call(ctx, symbol_for, symbol, 1, (JSValueConst *)&name);
        JS_FreeValue(ctx, name);

        if (JS_IsException(key)) {
            vl_report_exception(r, "Symbol.for failed while installing the bridge");
            JS_FreeValue(ctx, key);
            continue;
        }

        JSAtom atom = JS_ValueToAtom(ctx, key);
        JS_FreeValue(ctx, key);
        JS_SetProperty(ctx, g, atom, JS_NewCFunction(ctx, kFuncs[i], kNames[i], 1));
        JS_FreeAtom(ctx, atom);
    }

    JS_FreeValue(ctx, symbol_for);
    JS_FreeValue(ctx, symbol);
    JS_FreeValue(ctx, g);
}
