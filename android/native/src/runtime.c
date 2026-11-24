#include "valenced.h"

#include <android/log.h>
#include <errno.h>
#include <stdarg.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define VL_TAG "ValencedPhoenix"

struct VlTimer {
    int64_t id;
    int64_t due_ms;
    int64_t interval_ms;
    JSValue fn;
    JSValue *argv;
    int argc;
    VlTimer *next;
};

static const int kAndroidPriority[] = {
    ANDROID_LOG_DEBUG,
    ANDROID_LOG_INFO,
    ANDROID_LOG_WARN,
    ANDROID_LOG_ERROR,
};

void vl_log(int level, const char *fmt, ...) {
    va_list args;
    va_start(args, fmt);
    __android_log_vprint(kAndroidPriority[level], VL_TAG, fmt, args);
    va_end(args);
}

int64_t vl_now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

void vl_enter(VlRuntime *r) {
    pthread_mutex_lock(&r->lock);
    if (r->depth++ == 0) JS_UpdateStackTop(r->rt);
}

void vl_leave(VlRuntime *r) {
    r->depth--;
    pthread_mutex_unlock(&r->lock);
}

void vl_report_exception(VlRuntime *r, const char *where) {
    JSValue exc = JS_GetException(r->ctx);
    const char *message = JS_ToCString(r->ctx, exc);
    JSValue stack = JS_GetPropertyStr(r->ctx, exc, "stack");
    const char *trace = JS_IsUndefined(stack) ? NULL : JS_ToCString(r->ctx, stack);

    vl_log(VL_LOG_ERROR, "%s: %s%s%s", where,
           message ? message : "<unprintable>",
           trace ? "\n" : "", trace ? trace : "");

    if (trace) JS_FreeCString(r->ctx, trace);
    if (message) JS_FreeCString(r->ctx, message);
    JS_FreeValue(r->ctx, stack);
    JS_FreeValue(r->ctx, exc);
}

void vl_drain_jobs(VlRuntime *r) {
    for (;;) {
        JSContext *ctx = NULL;
        int ret = JS_ExecutePendingJob(r->rt, &ctx);
        if (ret == 0) return;
        if (ret < 0) {
            JSValue exc = JS_GetException(ctx ? ctx : r->ctx);
            const char *message = JS_ToCString(r->ctx, exc);
            vl_log(VL_LOG_ERROR, "Uncaught error in a queued job: %s", message ? message : "<unprintable>");
            if (message) JS_FreeCString(r->ctx, message);
            JS_FreeValue(r->ctx, exc);
        }
    }
}

static void vl_timer_free(VlRuntime *r, VlTimer *t) {
    JS_FreeValue(r->ctx, t->fn);
    for (int i = 0; i < t->argc; i++) JS_FreeValue(r->ctx, t->argv[i]);
    free(t->argv);
    free(t);
}

void vl_timers_free(VlRuntime *r) {
    VlTimer *t = r->timers;
    r->timers = NULL;
    while (t) {
        VlTimer *next = t->next;
        vl_timer_free(r, t);
        t = next;
    }
}

static void vl_timers_run_due(VlRuntime *r) {
    int64_t now = vl_now_ms();

    /* A handler can add or clear timers, so the list is re-walked for every due id. */
    int64_t ids[64];
    int count = 0;
    for (VlTimer *t = r->timers; t && count < 64; t = t->next)
        if (t->due_ms <= now) ids[count++] = t->id;

    for (int i = 0; i < count; i++) {
        VlTimer **slot = &r->timers;
        while (*slot && (*slot)->id != ids[i]) slot = &(*slot)->next;
        VlTimer *t = *slot;
        if (!t) continue;

        JSValue fn = JS_DupValue(r->ctx, t->fn);
        int argc = t->argc;
        JSValue *argv = NULL;
        if (argc > 0) {
            argv = malloc(sizeof(JSValue) * (size_t)argc);
            if (!argv) argc = 0;
            else for (int a = 0; a < argc; a++) argv[a] = JS_DupValue(r->ctx, t->argv[a]);
        }

        if (t->interval_ms > 0) {
            t->due_ms = now + t->interval_ms;
        } else {
            *slot = t->next;
            vl_timer_free(r, t);
        }

        JSValue ret = JS_Call(r->ctx, fn, JS_UNDEFINED, argc, argv);
        if (JS_IsException(ret)) vl_report_exception(r, "Uncaught error in a timer callback");
        JS_FreeValue(r->ctx, ret);

        for (int a = 0; a < argc; a++) JS_FreeValue(r->ctx, argv[a]);
        free(argv);
        JS_FreeValue(r->ctx, fn);
    }
}

static void *vl_pump(void *arg) {
    VlRuntime *r = arg;

    JNIEnv *env = NULL;
    if ((*r->vm)->AttachCurrentThreadAsDaemon(r->vm, &env, NULL) != JNI_OK)
        vl_log(VL_LOG_WARN, "Timer thread could not attach to the VM, bridge calls from timers will fail");

    for (;;) {
        vl_enter(r);
        if (!r->pump_running) {
            vl_leave(r);
            break;
        }
        vl_timers_run_due(r);
        vl_drain_jobs(r);
        int64_t next = -1;
        for (VlTimer *t = r->timers; t; t = t->next)
            if (next < 0 || t->due_ms < next) next = t->due_ms;
        vl_leave(r);

        pthread_mutex_lock(&r->pump_lock);
        if (!r->pump_wake) {
            if (next < 0) {
                pthread_cond_wait(&r->pump_cv, &r->pump_lock);
            } else {
                int64_t delay = next - vl_now_ms();
                if (delay > 0) {
                    struct timespec ts;
                    clock_gettime(CLOCK_MONOTONIC, &ts);
                    ts.tv_sec += delay / 1000;
                    ts.tv_nsec += (delay % 1000) * 1000000;
                    if (ts.tv_nsec >= 1000000000) {
                        ts.tv_sec += 1;
                        ts.tv_nsec -= 1000000000;
                    }
                    pthread_cond_timedwait(&r->pump_cv, &r->pump_lock, &ts);
                }
            }
        }
        r->pump_wake = false;
        pthread_mutex_unlock(&r->pump_lock);
    }

    (*r->vm)->DetachCurrentThread(r->vm);
    return NULL;
}

void vl_pump_wake(VlRuntime *r) {
    pthread_mutex_lock(&r->pump_lock);
    r->pump_wake = true;
    pthread_cond_signal(&r->pump_cv);
    pthread_mutex_unlock(&r->pump_lock);
}

void vl_pump_start(VlRuntime *r) {
    r->pump_running = true;
    if (pthread_create(&r->pump, NULL, vl_pump, r) != 0) {
        r->pump_running = false;
        vl_log(VL_LOG_ERROR, "Could not start the timer thread: %s", strerror(errno));
        return;
    }
    r->pump_started = true;
}

void vl_pump_stop(VlRuntime *r) {
    if (!r->pump_started) return;
    vl_enter(r);
    r->pump_running = false;
    vl_leave(r);
    vl_pump_wake(r);
    pthread_join(r->pump, NULL);
    r->pump_started = false;
}

VlRuntime *vl_from(JSContext *ctx) {
    return JS_GetRuntimeOpaque(JS_GetRuntime(ctx));
}

static JSValue vl_js_logging_hook(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;

    const char *message = argc > 0 ? JS_ToCString(ctx, argv[0]) : NULL;
    int32_t level = 1;
    if (argc > 1) JS_ToInt32(ctx, &level, argv[1]);

    /* React Native's levels are 0 trace, 1 info, 2 warn, 3 error. */
    int mapped = level <= 0 ? VL_LOG_DEBUG : level == 1 ? VL_LOG_INFO : level == 2 ? VL_LOG_WARN : VL_LOG_ERROR;
    vl_log(mapped, "%s", message ? message : "<unprintable>");

    if (message) JS_FreeCString(ctx, message);
    return JS_UNDEFINED;
}

static JSValue vl_js_now(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;
    (void)argc;
    (void)argv;

    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return JS_NewFloat64(ctx, (double)ts.tv_sec * 1000.0 + (double)ts.tv_nsec / 1000000.0);
}

static JSValue vl_js_set_timer(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv, int magic) {
    (void)this_val;
    VlRuntime *r = vl_from(ctx);

    if (argc < 1 || !JS_IsFunction(ctx, argv[0]))
        return JS_ThrowTypeError(ctx, "The first argument must be a function");

    int64_t delay = 0;
    if (argc > 1) JS_ToInt64(ctx, &delay, argv[1]);
    if (delay < 0) delay = 0;

    VlTimer *t = calloc(1, sizeof(VlTimer));
    if (!t) return JS_ThrowOutOfMemory(ctx);

    t->argc = argc > 2 ? argc - 2 : 0;
    if (t->argc > 0) {
        t->argv = malloc(sizeof(JSValue) * (size_t)t->argc);
        if (!t->argv) {
            free(t);
            return JS_ThrowOutOfMemory(ctx);
        }
        for (int i = 0; i < t->argc; i++) t->argv[i] = JS_DupValue(ctx, argv[i + 2]);
    }

    t->id = ++r->next_timer_id;
    t->due_ms = vl_now_ms() + delay;
    t->interval_ms = magic ? (delay > 0 ? delay : 1) : 0;
    t->fn = JS_DupValue(ctx, argv[0]);
    t->next = r->timers;
    r->timers = t;

    vl_pump_wake(r);
    return JS_NewInt64(ctx, t->id);
}

static JSValue vl_js_clear_timer(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;
    VlRuntime *r = vl_from(ctx);

    int64_t id = 0;
    if (argc < 1 || JS_ToInt64(ctx, &id, argv[0]) < 0) return JS_UNDEFINED;

    VlTimer **slot = &r->timers;
    while (*slot && (*slot)->id != id) slot = &(*slot)->next;
    if (*slot) {
        VlTimer *t = *slot;
        *slot = t->next;
        vl_timer_free(r, t);
    }
    return JS_UNDEFINED;
}

static const char kPrelude[] =
    "globalThis.global = globalThis;"
    "globalThis.performance = { now: __valencedNow };"
    "globalThis.queueMicrotask = fn => { Promise.resolve().then(fn) };"
    "globalThis.console = ['trace','info','warn','error'].reduce((c, name, level) => {"
    "  c[name] = (...args) => nativeLoggingHook(args.map(a => {"
    "    try { return typeof a === 'string' ? a : JSON.stringify(a) ?? String(a) } catch { return String(a) }"
    "  }).join(' '), level);"
    "  return c"
    "}, { log: null, debug: null });"
    "console.log = console.debug = console.info;";

static void vl_rejection_tracker(JSContext *ctx, JSValueConst promise, JSValueConst reason, bool is_handled, void *opaque) {
    (void)promise;
    (void)opaque;
    if (is_handled) return;

    const char *message = JS_ToCString(ctx, reason);
    vl_log(VL_LOG_ERROR, "Unhandled promise rejection: %s", message ? message : "<unprintable>");
    if (message) JS_FreeCString(ctx, message);
}

void vl_install_globals(VlRuntime *r) {
    JSContext *ctx = r->ctx;
    JSValue g = JS_GetGlobalObject(ctx);

    JS_SetPropertyStr(ctx, g, "__VALENCED_CLIENT__", JS_NewString(ctx, "phoenix"));
    JS_SetPropertyStr(ctx, g, "nativeLoggingHook", JS_NewCFunction(ctx, vl_js_logging_hook, "nativeLoggingHook", 2));
    JS_SetPropertyStr(ctx, g, "__valencedNow", JS_NewCFunction(ctx, vl_js_now, "__valencedNow", 0));
    JS_SetPropertyStr(ctx, g, "setTimeout", JS_NewCFunctionMagic(ctx, vl_js_set_timer, "setTimeout", 2, JS_CFUNC_generic_magic, 0));
    JS_SetPropertyStr(ctx, g, "setInterval", JS_NewCFunctionMagic(ctx, vl_js_set_timer, "setInterval", 2, JS_CFUNC_generic_magic, 1));
    JS_SetPropertyStr(ctx, g, "clearTimeout", JS_NewCFunction(ctx, vl_js_clear_timer, "clearTimeout", 1));
    JS_SetPropertyStr(ctx, g, "clearInterval", JS_NewCFunction(ctx, vl_js_clear_timer, "clearInterval", 1));

    JS_FreeValue(ctx, g);

    JS_SetHostPromiseRejectionTracker(r->rt, vl_rejection_tracker, NULL);

    vl_install_bridge(r);
    vl_install_gateway(r);

    JSValue ret = JS_Eval(ctx, kPrelude, sizeof(kPrelude) - 1, "valenced-prelude.js", JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(ret)) vl_report_exception(r, "The runtime prelude failed");
    JS_FreeValue(ctx, ret);
}
