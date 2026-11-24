#include "valenced.h"

#include <errno.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

#define VL_EXPERIMENT "2026-11-phoenix-app-access"

#if defined(__x86_64__)
static const uint8_t vl_return_true[] = { 0xB0, 0x01, 0xC3 };
#elif defined(__aarch64__)
static const uint8_t vl_return_true[] = { 0x20, 0x00, 0x80, 0x52, 0xC0, 0x03, 0x5F, 0xD6 };
#endif

#if defined(__x86_64__) || defined(__aarch64__)

static size_t vl_keep_function(const VlImage *image, uintptr_t at, uintptr_t *out, size_t found, size_t max) {
    uintptr_t start = vl_image_function_containing(image, at);
    if (!start) return found;

    for (size_t i = 0; i < found; i++) {
        if (out[i] == start) return found;
    }
    if (found < max) out[found++] = start;
    return found;
}

static bool vl_wanted(const uintptr_t *slots, size_t count, uintptr_t target) {
    for (size_t i = 0; i < count; i++) {
        if (slots[i] == target) return true;
    }
    return false;
}

/* x86_64: REX.W lea/mov [rip + disp32]. arm64: adrp, then add or 64-bit ldr on it within 4 instructions. */
static size_t vl_references(const VlImage *image, const uintptr_t *slots, size_t slot_count, uintptr_t *out, size_t max) {
    size_t found = 0;

    for (size_t i = 0; i < image->count; i++) {
        const VlSegment *segment = &image->segments[i];
        if (!segment->exec) continue;

        const uint8_t *code = segment->bytes;
#if defined(__x86_64__)
        for (size_t at = 0; at + 7 < segment->len; at++) {
            uint8_t rex = code[at];
            uint8_t opcode = code[at + 1];
            uint8_t modrm = code[at + 2];
            if ((rex != 0x48 && rex != 0x4C) || (opcode != 0x8B && opcode != 0x8D) || (modrm & 0xC7) != 0x05)
                continue;

            int32_t displacement;
            memcpy(&displacement, code + at + 3, sizeof(displacement));

            uintptr_t target = segment->addr + at + 7 + (uintptr_t)(intptr_t)displacement;
            if (vl_wanted(slots, slot_count, target))
                found = vl_keep_function(image, segment->addr + at, out, found, max);
        }
#else
        size_t total = segment->len / 4;
        for (size_t index = 0; index < total; index++) {
            uint32_t word;
            memcpy(&word, code + index * 4, sizeof(word));
            if ((word & 0x9F000000) != 0x90000000) continue;

            int64_t immediate = ((word >> 29) & 3) | (int64_t)((word >> 5) & 0x7FFFF) << 2;
            if (immediate & (1 << 20)) immediate -= 1 << 21;

            uintptr_t at = segment->addr + index * 4;
            uintptr_t page = (at & ~(uintptr_t)0xFFF) + (uintptr_t)(immediate << 12);
            uint32_t reg = word & 0x1F;

            size_t end = index + 5 < total ? index + 5 : total;
            for (size_t next = index + 1; next < end; next++) {
                uint32_t partner;
                memcpy(&partner, code + next * 4, sizeof(partner));
                if (((partner >> 5) & 0x1F) != reg) continue;

                uintptr_t offset = (partner >> 10) & 0xFFF;
                uintptr_t target;
                if ((partner & 0xFFC00000) == 0x91000000) target = page + offset;
                else if ((partner & 0xFFC00000) == 0xF9400000) target = page + offset * 8;
                else continue;

                if (vl_wanted(slots, slot_count, target))
                    found = vl_keep_function(image, at, out, found, max);
            }
        }
#endif
    }
    return found;
}

#endif

int vl_access_patch(void) {
#if !defined(__x86_64__) && !defined(__aarch64__)
    vl_log(VL_LOG_WARN, "The access gate patch has no code for this ABI");
    return VL_ACCESS_UNSUPPORTED;
#else
    static bool patched = false;
    if (patched) return VL_ACCESS_ALREADY;

    VlImage image;
    if (!vl_image_load(&image, VL_HOST_LIBRARY)) return VL_ACCESS_NOT_LOADED;

    uintptr_t strings[VL_MAX_HITS];
    size_t string_count = 0;
    for (uintptr_t at = 0;
         string_count < VL_MAX_HITS
         && (at = vl_image_find_next(&image, VL_EXPERIMENT, sizeof(VL_EXPERIMENT) - 1, false, at)) != 0;)
        strings[string_count++] = at;

    uintptr_t slots[VL_MAX_HITS];
    size_t slot_count = 0;
    for (size_t i = 0; i < string_count && slot_count < VL_MAX_HITS; i++) {
        uintptr_t found[VL_MAX_HITS];
        size_t count = vl_image_pointers_to(&image, strings[i], found, VL_MAX_HITS);

        for (size_t j = 0; j < count && slot_count < VL_MAX_HITS; j++) {
            uintptr_t length;
            if (vl_image_word(&image, found[j] + sizeof(uintptr_t), &length) && length == sizeof(VL_EXPERIMENT) - 1)
                slots[slot_count++] = found[j];
        }
    }

    if (slot_count == 0) {
        vl_log(VL_LOG_WARN, "No experiment table entry for %s, the access gate is left alone", VL_EXPERIMENT);
        return VL_ACCESS_NO_ANCHOR;
    }

    uintptr_t functions[VL_MAX_HITS];
    size_t count = vl_references(&image, slots, slot_count, functions, VL_MAX_HITS);

    if (count != 1) {
        vl_log(VL_LOG_WARN, "Expected one function referencing %s, found %zu, the access gate is left alone",
               VL_EXPERIMENT, count);
        return VL_ACCESS_NO_ANCHOR;
    }

    const uint8_t *head = vl_image_read(&image, functions[0], sizeof(vl_return_true));
    if (head && memcmp(head, vl_return_true, sizeof(vl_return_true)) == 0) {
        patched = true;
        return VL_ACCESS_ALREADY;
    }

    long size = sysconf(_SC_PAGESIZE);
    if (size <= 0) size = 4096;

    uintptr_t page = functions[0] & ~(uintptr_t)(size - 1);
    size_t span = functions[0] + sizeof(vl_return_true) - page;

    if (mprotect((void *)page, span, PROT_READ | PROT_WRITE | PROT_EXEC) != 0
        && mprotect((void *)page, span, PROT_READ | PROT_WRITE) != 0) {
        vl_log(VL_LOG_ERROR, "Unable to make the access evaluator writable: %s", strerror(errno));
        return VL_ACCESS_WRITE_FAILED;
    }

    memcpy((void *)functions[0], vl_return_true, sizeof(vl_return_true));

    if (mprotect((void *)page, span, PROT_READ | PROT_EXEC) != 0)
        vl_log(VL_LOG_WARN, "Unable to restore the access evaluator page: %s", strerror(errno));

    __builtin___clear_cache((char *)functions[0], (char *)(functions[0] + sizeof(vl_return_true)));

    patched = true;
    vl_log(VL_LOG_INFO, "Patched the Phoenix access evaluator at %p", (void *)functions[0]);
    return VL_ACCESS_PATCHED;
#endif
}
