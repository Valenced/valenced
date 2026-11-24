#include "valenced.h"

#include <stdlib.h>

#define VL_FRAMES_GLOBAL "__valencedPhoenixFrames"

/* Returns the frame handler, or JS_UNDEFINED when the bundle has not registered one. */
static JSValue vl_frame_handler(VlRuntime *r, const char *name) {
    JSContext *ctx = r->ctx;

    JSValue g = JS_GetGlobalObject(ctx);
    JSValue frames = JS_GetPropertyStr(ctx, g, VL_FRAMES_GLOBAL);
    JS_FreeValue(ctx, g);

    if (!JS_IsObject(frames)) {
        JS_FreeValue(ctx, frames);
        return JS_UNDEFINED;
    }

    JSValue handler = JS_GetPropertyStr(ctx, frames, name);
    JS_FreeValue(ctx, frames);

    if (!JS_IsFunction(ctx, handler)) {
        JS_FreeValue(ctx, handler);
        return JS_UNDEFINED;
    }
    return handler;
}

/* Copies the first [length] bytes of [in] into a Uint8Array, all of it when [length] is negative. Returns JS_EXCEPTION on failure. */
static JSValue vl_frame_input(VlRuntime *r, JNIEnv *env, jbyteArray in, int32_t length) {
    if (!in) return JS_NewUint8ArrayCopy(r->ctx, NULL, 0);

    jsize size = (*env)->GetArrayLength(env, in);
    if (length >= 0 && length < size) size = length;
    void *bytes = (*env)->GetPrimitiveArrayCritical(env, in, NULL);
    if (!bytes) return JS_EXCEPTION;

    JSValue out = JS_NewUint8ArrayCopy(r->ctx, (const uint8_t *)bytes, (size_t)size);
    (*env)->ReleasePrimitiveArrayCritical(env, in, bytes, JNI_ABORT);
    return out;
}

jbyteArray vl_frame_bytes(VlRuntime *r, JNIEnv *env, const char *handler, const int64_t *target, jbyteArray in, int32_t length) {
    JSContext *ctx = r->ctx;

    JSValue fn = vl_frame_handler(r, handler);
    if (JS_IsUndefined(fn)) return NULL;

    JSValue argv[2];
    int argc = 0;
    if (target) argv[argc++] = JS_NewInt64(ctx, *target);
    argv[argc++] = vl_frame_input(r, env, in, length);
    if (JS_IsException(argv[argc - 1])) {
        for (int i = 0; i < argc; i++) JS_FreeValue(ctx, argv[i]);
        JS_FreeValue(ctx, fn);
        return NULL;
    }

    JSValue ret = JS_Call(ctx, fn, JS_UNDEFINED, argc, (JSValueConst *)argv);
    for (int i = 0; i < argc; i++) JS_FreeValue(ctx, argv[i]);
    JS_FreeValue(ctx, fn);

    if (JS_IsException(ret)) {
        vl_report_exception(r, "A Phoenix frame handler failed");
        JS_FreeValue(ctx, ret);
        return NULL;
    }

    jbyteArray out = NULL;

    if (JS_IsBool(ret)) {
        out = (*env)->NewByteArray(env, 1);
        if (out) {
            jbyte tag = JS_ToBool(ctx, ret) ? 2 : 0;
            (*env)->SetByteArrayRegion(env, out, 0, 1, &tag);
        }
    } else {
        size_t size = 0;
        uint8_t *payload = JS_GetUint8Array(ctx, &size, ret);
        if (payload) {
            out = (*env)->NewByteArray(env, (jsize)size + 1);
            if (out) {
                jbyte tag = 1;
                (*env)->SetByteArrayRegion(env, out, 0, 1, &tag);
                (*env)->SetByteArrayRegion(env, out, 1, (jsize)size, (const jbyte *)payload);
            }
        } else {
            /* JS_GetUint8Array throws when the value is not a Uint8Array. */
            JS_FreeValue(ctx, JS_GetException(ctx));
        }
    }

    JS_FreeValue(ctx, ret);
    return out;
}
