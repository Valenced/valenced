#include "valenced.h"

#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

#define VL_HOST_LIBRARY "liblibdiscord_wasm_host.so"
#define VL_GATEWAY_GLOBAL "__valencedPhoenixGateway"
#define VL_GATEWAY_SEED "MESSAGE_CREATE"
#define VL_GATEWAY_DOMAIN_SEED "READY_SUPPLEMENTAL"
#define VL_GATEWAY_STRIDE (3 * sizeof(uintptr_t))
#define VL_NAME_MAX 64
#define VL_MAX_EVENTS 384
#define VL_MAX_LISTENED 64
#define VL_MAX_HITS 8

typedef struct {
    const uint8_t *ptr;
    size_t len;
} VlRawStr;

/* Phoenix's gateway event. `rest` is opaque and passes through unchanged. */
typedef struct {
    VlRawStr name;
    VlRawStr data;
    uint64_t rest[4];
} VlGatewayEvent;

/* A 32-byte Rust Result, returned through x8 on arm64 and a hidden pointer on x86_64. */
typedef struct {
    uint64_t words[4];
} VlHandlerResult;

typedef VlHandlerResult (*VlHandlerFn)(void *store, const VlGatewayEvent *event, void *ctx);

typedef struct {
    char name[VL_NAME_MAX + 1];
    size_t name_len;
    uintptr_t handler_slot;
    VlHandlerFn original;
} VlGatewayEntry;

static VlGatewayEntry vl_entries[VL_MAX_EVENTS];
static size_t vl_entry_count;
static char vl_listened[VL_MAX_LISTENED][VL_NAME_MAX + 1];
static size_t vl_listened_count;
static VlRuntime *vl_gateway_runtime;

/* Set while this thread runs a listener, so an event JS causes goes straight to Phoenix. */
static __thread bool vl_in_js;

static VlGatewayEntry *vl_lookup(const char *name, size_t len) {
    for (size_t i = 0; i < vl_entry_count; i++) {
        if (vl_entries[i].name_len == len && memcmp(vl_entries[i].name, name, len) == 0)
            return &vl_entries[i];
    }
    return NULL;
}

static bool vl_is_listened(const char *name) {
    for (size_t i = 0; i < vl_listened_count; i++) {
        if (strcmp(vl_listened[i], name) == 0) return true;
    }
    return false;
}

static bool vl_read_entry(const VlImage *image, uintptr_t base, VlGatewayEntry *out) {
    uintptr_t name_ptr, name_len, handler;
    if (!vl_image_word(image, base, &name_ptr)) return false;
    if (!vl_image_word(image, base + sizeof(uintptr_t), &name_len)) return false;
    if (!vl_image_word(image, base + 2 * sizeof(uintptr_t), &handler)) return false;
    if (name_len < 1 || name_len > VL_NAME_MAX) return false;
    if (vl_image_function_containing(image, handler) != handler) return false;

    const uint8_t *name = vl_image_read(image, name_ptr, name_len);
    if (!name) return false;

    for (size_t i = 0; i < name_len; i++) {
        uint8_t byte = name[i];
        if (!((byte >= 'A' && byte <= 'Z') || (byte >= '0' && byte <= '9') || byte == '_')) return false;
    }

    memcpy(out->name, name, name_len);
    out->name[name_len] = 0;
    out->name_len = name_len;
    out->handler_slot = base + 2 * sizeof(uintptr_t);
    out->original = (VlHandlerFn)handler;
    return true;
}

/*
 * Walks the `{name ptr, name len, handler}` table holding `seed` out in both directions, until an
 * entry stops looking like one. Events already collected are left alone, so the domain reducer
 * table only adds what the main registry does not have.
 */
static void vl_walk(const VlImage *image, const char *seed) {
    size_t len = strlen(seed);

    uintptr_t start = 0;
    size_t found = 0;
    for (uintptr_t string = 0; !found && (string = vl_image_find_next(image, seed, len, false, string)) != 0;) {
        uintptr_t slots[VL_MAX_HITS];
        size_t count = vl_image_pointers_to(image, string, slots, VL_MAX_HITS);

        for (size_t j = 0; j < count; j++) {
            uintptr_t name_len;
            VlGatewayEntry probe;
            if (!vl_image_word(image, slots[j] + sizeof(uintptr_t), &name_len) || name_len != len) continue;
            if (!vl_read_entry(image, slots[j], &probe)) continue;
            start = slots[j];
            found++;
        }
    }

    if (found != 1) {
        vl_log(found ? VL_LOG_WARN : VL_LOG_DEBUG, "Expected one gateway table holding %s, found %zu", seed, found);
        return;
    }

    VlGatewayEntry entry;
    while (start >= VL_GATEWAY_STRIDE && vl_read_entry(image, start - VL_GATEWAY_STRIDE, &entry))
        start -= VL_GATEWAY_STRIDE;

    for (uintptr_t base = start; vl_entry_count < VL_MAX_EVENTS; base += VL_GATEWAY_STRIDE) {
        if (!vl_read_entry(image, base, &entry)) break;
        if (!vl_lookup(entry.name, entry.name_len)) vl_entries[vl_entry_count++] = entry;
    }
}

/*
 * Points a handler slot at `value`. The registry sits in `PT_GNU_RELRO`, so the page is read-only
 * by the time Phoenix dispatches and has to be opened for the write.
 */
static bool vl_write_slot(uintptr_t slot, uintptr_t value) {
    long size = sysconf(_SC_PAGESIZE);
    if (size <= 0) size = 4096;

    uintptr_t page = slot & ~(uintptr_t)(size - 1);
    size_t span = slot + sizeof(uintptr_t) - page;

    if (mprotect((void *)page, span, PROT_READ | PROT_WRITE) != 0) {
        vl_log(VL_LOG_ERROR, "Unable to make a gateway registry entry writable: %s", strerror(errno));
        return false;
    }

    __atomic_store_n((uintptr_t *)slot, value, __ATOMIC_RELEASE);

    if (mprotect((void *)page, span, PROT_READ) != 0)
        vl_log(VL_LOG_WARN, "Unable to restore a gateway registry page: %s", strerror(errno));
    return true;
}

/* Returns 0 to keep the event, 1 to drop it, 2 when *out holds a replacement to free. */
static int vl_gateway_js(VlRuntime *r, const VlGatewayEntry *entry, const VlRawStr *data, char **out, size_t *out_len) {
    JSContext *ctx = r->ctx;
    int verdict = 0;

    vl_enter(r);

    JSValue g = JS_GetGlobalObject(ctx);
    JSValue gateway = JS_GetPropertyStr(ctx, g, VL_GATEWAY_GLOBAL);
    JS_FreeValue(ctx, g);

    JSValue fn = JS_IsObject(gateway) ? JS_GetPropertyStr(ctx, gateway, "onEvent") : JS_UNDEFINED;
    JS_FreeValue(ctx, gateway);

    if (!JS_IsFunction(ctx, fn)) {
        JS_FreeValue(ctx, fn);
        vl_leave(r);
        return 0;
    }

    JSValue argv[2];
    argv[0] = JS_NewStringLen(ctx, entry->name, entry->name_len);
    argv[1] = JS_NewStringLen(ctx, (const char *)data->ptr, data->len);

    vl_in_js = true;
    JSValue ret = JS_Call(ctx, fn, JS_UNDEFINED, 2, (JSValueConst *)argv);
    vl_in_js = false;

    JS_FreeValue(ctx, argv[0]);
    JS_FreeValue(ctx, argv[1]);
    JS_FreeValue(ctx, fn);

    if (JS_IsException(ret)) {
        vl_report_exception(r, "A Phoenix gateway listener failed");
    } else if (JS_IsBool(ret) && !JS_ToBool(ctx, ret)) {
        verdict = 1;
    } else if (JS_IsString(ret)) {
        size_t len = 0;
        const char *text = JS_ToCStringLen(ctx, &len, ret);
        char *copy = text ? malloc(len) : NULL;
        if (copy) {
            memcpy(copy, text, len);
            *out = copy;
            *out_len = len;
            verdict = 2;
        }
        if (text) JS_FreeCString(ctx, text);
    }

    JS_FreeValue(ctx, ret);
    vl_drain_jobs(r);
    vl_leave(r);
    vl_pump_wake(r);
    return verdict;
}

static VlHandlerResult vl_gateway_detour(void *store, const VlGatewayEvent *event, void *ctx) {
    static const VlHandlerResult ok = { { UINT64_MAX, 0, 0, 0 } };

    VlGatewayEntry *entry = event && event->name.ptr
        ? vl_lookup((const char *)event->name.ptr, event->name.len)
        : NULL;

    if (!entry) {
        vl_log(VL_LOG_ERROR, "A gateway event arrived without a registry entry, dropped");
        return ok;
    }

    VlRuntime *r = vl_gateway_runtime;
    if (!r || vl_in_js || !event->data.ptr || !vl_is_listened(entry->name))
        return entry->original(store, event, ctx);

    char *replacement = NULL;
    size_t replacement_len = 0;
    int verdict = vl_gateway_js(r, entry, &event->data, &replacement, &replacement_len);

    if (verdict == 1) return ok;
    if (verdict == 0) return entry->original(store, event, ctx);

    VlGatewayEvent replaced = *event;
    replaced.data.ptr = (const uint8_t *)replacement;
    replaced.data.len = replacement_len;

    VlHandlerResult result = entry->original(store, &replaced, ctx);
    free(replacement);
    return result;
}

static JSValue vl_js_listen(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;

    if (argc < 1) return JS_FALSE;

    size_t len = 0;
    const char *name = JS_ToCStringLen(ctx, &len, argv[0]);
    if (!name) return JS_FALSE;

    bool enabled = argc < 2 || JS_ToBool(ctx, argv[1]);
    bool ok = !enabled;

    size_t at = VL_MAX_LISTENED;
    size_t free_slot = VL_MAX_LISTENED;
    for (size_t i = 0; i < vl_listened_count; i++) {
        if (strcmp(vl_listened[i], name) == 0) at = i;
        else if (!vl_listened[i][0] && free_slot == VL_MAX_LISTENED) free_slot = i;
    }

    if (!enabled) {
        /* Cleared in place. The detour reads this table without a lock, so entries never move. */
        if (at < VL_MAX_LISTENED) vl_listened[at][0] = 0;
    } else if (at < VL_MAX_LISTENED) {
        ok = true;
    } else if (free_slot < VL_MAX_LISTENED && len <= VL_NAME_MAX) {
        memcpy(vl_listened[free_slot], name, len + 1);
        ok = true;
    } else if (vl_listened_count < VL_MAX_LISTENED && len <= VL_NAME_MAX) {
        memcpy(vl_listened[vl_listened_count], name, len + 1);
        __atomic_store_n(&vl_listened_count, vl_listened_count + 1, __ATOMIC_RELEASE);
        ok = true;
    }

    if (ok && enabled && vl_entry_count && !vl_lookup(name, len))
        vl_log(VL_LOG_WARN, "No gateway event named %s, nothing will arrive", name);

    JS_FreeCString(ctx, name);
    return ok ? JS_TRUE : JS_FALSE;
}

void vl_install_gateway(VlRuntime *r) {
    JSContext *ctx = r->ctx;
    JSValue g = JS_GetGlobalObject(ctx);

    JSValue symbol = JS_GetPropertyStr(ctx, g, "Symbol");
    JSValue symbol_for = JS_GetPropertyStr(ctx, symbol, "for");

    JSValue name = JS_NewString(ctx, "valenced.phoenix.gateway.listen");
    JSValue key = JS_Call(ctx, symbol_for, symbol, 1, (JSValueConst *)&name);
    JS_FreeValue(ctx, name);

    if (JS_IsException(key)) {
        vl_report_exception(r, "Symbol.for failed while installing the gateway seam");
    } else {
        JSAtom atom = JS_ValueToAtom(ctx, key);
        JS_SetProperty(ctx, g, atom, JS_NewCFunction(ctx, vl_js_listen, "listen", 2));
        JS_FreeAtom(ctx, atom);
    }

    JS_FreeValue(ctx, key);
    JS_FreeValue(ctx, symbol_for);
    JS_FreeValue(ctx, symbol);
    JS_FreeValue(ctx, g);
}

int vl_gateway_hook(VlRuntime *r) {
    if (vl_entry_count) return VL_GATEWAY_ALREADY;

    VlImage image;
    if (!vl_image_load(&image, VL_HOST_LIBRARY)) return VL_GATEWAY_NOT_LOADED;

    vl_walk(&image, VL_GATEWAY_SEED);
    if (!vl_entry_count) return VL_GATEWAY_NO_ANCHOR;

    size_t main_count = vl_entry_count;
    vl_walk(&image, VL_GATEWAY_DOMAIN_SEED);

    vl_gateway_runtime = r;

    for (size_t i = 0; i < vl_entry_count; i++) {
        if (!vl_write_slot(vl_entries[i].handler_slot, (uintptr_t)vl_gateway_detour))
            return VL_GATEWAY_WRITE_FAILED;
    }

    vl_log(VL_LOG_INFO, "Hooked %zu gateway events and %zu domain reducers",
           main_count, vl_entry_count - main_count);
    return VL_GATEWAY_HOOKED;
}
