#ifndef VALENCED_PHOENIX_H
#define VALENCED_PHOENIX_H

#include <jni.h>
#include <pthread.h>
#include <quickjs.h>
#include <stdbool.h>
#include <stdint.h>

#define VL_LOG_DEBUG 0
#define VL_LOG_INFO 1
#define VL_LOG_WARN 2
#define VL_LOG_ERROR 3

typedef struct VlTimer VlTimer;

typedef struct VlRuntime {
    JSRuntime *rt;
    JSContext *ctx;

    JavaVM *vm;
    jobject host;
    jmethodID call_sync;
    jmethodID call_async;

    /* Recursive: a sync bridge handler can call back into JS on the same thread. */
    pthread_mutex_t lock;
    int depth;

    pthread_t pump;
    pthread_mutex_t pump_lock;
    pthread_cond_t pump_cv;
    bool pump_started;
    bool pump_running;
    bool pump_wake;

    VlTimer *timers;
    int64_t next_timer_id;

    /* callId -> { resolve, reject } for the async bridge seam. */
    JSValue pending;
    int64_t next_call_id;
} VlRuntime;

void vl_log(int level, const char *fmt, ...);
int64_t vl_now_ms(void);

/* Takes the runtime lock and, at depth 0, re-points QuickJS at the calling thread's stack. */
void vl_enter(VlRuntime *r);
void vl_leave(VlRuntime *r);

void vl_drain_jobs(VlRuntime *r);
void vl_report_exception(VlRuntime *r, const char *where);

void vl_install_globals(VlRuntime *r);
void vl_pump_start(VlRuntime *r);
void vl_pump_stop(VlRuntime *r);
void vl_pump_wake(VlRuntime *r);
void vl_timers_free(VlRuntime *r);

void vl_install_bridge(VlRuntime *r);
void vl_bridge_resolve(VlRuntime *r, int64_t call_id, const char *result_json);

/* Returns NULL on failure. Sets *attached when the caller must call vl_detach. */
JNIEnv *vl_env(VlRuntime *r, bool *attached);
void vl_detach(VlRuntime *r, bool attached);

/*
 * Frame verdicts travel as a tagged byte array: first byte 0 for a `false` return, 2 for `true`,
 * 1 to replace the payload with the remaining bytes. NULL passes the frame through. A non-NULL
 * [target] is passed to the handler before the frame. A negative [length] forwards the whole array.
 */
jbyteArray vl_frame_bytes(VlRuntime *r, JNIEnv *env, const char *handler, const int64_t *target, jbyteArray in, int32_t length);

#define VL_MAX_SEGMENTS 8

typedef struct {
    uintptr_t addr;
    const uint8_t *bytes;
    size_t len;
    bool exec;
} VlSegment;

/* A library mapped in this process, at the addresses its own code sees. */
typedef struct {
    VlSegment segments[VL_MAX_SEGMENTS];
    size_t count;
    uintptr_t eh_frame_hdr;
} VlImage;

bool vl_image_load(VlImage *image, const char *name);
const uint8_t *vl_image_read(const VlImage *image, uintptr_t addr, size_t len);
bool vl_image_word(const VlImage *image, uintptr_t addr, uintptr_t *out);
/* Lowest address above `after` holding `needle`, or 0. Lazy, so a caller that stops at the first
   useful hit does not fault in the rest of a 100 MB library. */
uintptr_t vl_image_find_next(const VlImage *image, const void *needle, size_t len, bool data_only, uintptr_t after);
size_t vl_image_pointers_to(const VlImage *image, uintptr_t target, uintptr_t *out, size_t max);

/* Start of the last `.eh_frame_hdr` entry at or below `addr`, or 0 when the table is missing. */
uintptr_t vl_image_function_containing(const VlImage *image, uintptr_t addr);

#define VL_ACCESS_PATCHED 0
#define VL_ACCESS_ALREADY 1
#define VL_ACCESS_NOT_LOADED 2
#define VL_ACCESS_NO_ANCHOR 3
#define VL_ACCESS_UNSUPPORTED 4
#define VL_ACCESS_WRITE_FAILED 5

int vl_access_patch(void);

#define VL_GATEWAY_HOOKED 0
#define VL_GATEWAY_ALREADY 1
#define VL_GATEWAY_NOT_LOADED 2
#define VL_GATEWAY_NO_ANCHOR 3
#define VL_GATEWAY_WRITE_FAILED 4

void vl_install_gateway(VlRuntime *r);
int vl_gateway_hook(VlRuntime *r);

#endif
