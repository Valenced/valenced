#include "valenced.h"

#include <link.h>
#include <string.h>

typedef struct {
    const char *name;
    VlImage *image;
    bool found;
} VlImageSearch;

static int vl_image_visit(struct dl_phdr_info *info, size_t size, void *data) {
    (void)size;

    VlImageSearch *search = data;
    const char *path = info->dlpi_name;
    if (!path || !*path) return 0;

    const char *slash = strrchr(path, '/');
    if (strcmp(slash ? slash + 1 : path, search->name) != 0) return 0;

    VlImage *image = search->image;
    for (int i = 0; i < info->dlpi_phnum; i++) {
        const ElfW(Phdr) *header = &info->dlpi_phdr[i];
        uintptr_t addr = (uintptr_t)info->dlpi_addr + (uintptr_t)header->p_vaddr;

        if (header->p_type == PT_GNU_EH_FRAME) {
            image->eh_frame_hdr = addr;
        } else if (header->p_type == PT_LOAD && (header->p_flags & PF_R) && image->count < VL_MAX_SEGMENTS) {
            VlSegment *segment = &image->segments[image->count++];
            segment->addr = addr;
            segment->bytes = (const uint8_t *)addr;
            segment->len = (size_t)header->p_memsz;
            segment->exec = (header->p_flags & PF_X) != 0;
        }
    }

    search->found = true;
    return 1;
}

bool vl_image_load(VlImage *image, const char *name) {
    memset(image, 0, sizeof(*image));

    VlImageSearch search = { name, image, false };
    dl_iterate_phdr(vl_image_visit, &search);
    return search.found && image->count > 0;
}

const uint8_t *vl_image_read(const VlImage *image, uintptr_t addr, size_t len) {
    for (size_t i = 0; i < image->count; i++) {
        const VlSegment *segment = &image->segments[i];
        if (addr < segment->addr) continue;

        size_t offset = addr - segment->addr;
        if (offset > segment->len || len > segment->len - offset) continue;
        return segment->bytes + offset;
    }
    return NULL;
}

bool vl_image_word(const VlImage *image, uintptr_t addr, uintptr_t *out) {
    const uint8_t *at = vl_image_read(image, addr, sizeof(uintptr_t));
    if (!at) return false;

    memcpy(out, at, sizeof(uintptr_t));
    return true;
}

uintptr_t vl_image_find_next(const VlImage *image, const void *needle, size_t len, bool data_only, uintptr_t after) {
    for (size_t i = 0; i < image->count; i++) {
        const VlSegment *segment = &image->segments[i];
        if (data_only && segment->exec) continue;

        size_t start = 0;
        if (after >= segment->addr) {
            if (after + 1 >= segment->addr + segment->len) continue;
            start = after + 1 - segment->addr;
        }
        if (segment->len - start < len) continue;

        const uint8_t *hit = memmem(segment->bytes + start, segment->len - start, needle, len);
        if (hit) return segment->addr + (size_t)(hit - segment->bytes);
    }
    return 0;
}

size_t vl_image_pointers_to(const VlImage *image, uintptr_t target, uintptr_t *out, size_t max) {
    size_t found = 0;
    uintptr_t at = 0;

    while (found < max && (at = vl_image_find_next(image, &target, sizeof(target), true, at)) != 0) {
        if (at % sizeof(uintptr_t) == 0) out[found++] = at;
    }
    return found;
}

static bool vl_eh_frame_start(const VlImage *image, uintptr_t hdr, size_t index, uintptr_t *out) {
    const uint8_t *at = vl_image_read(image, hdr + 12 + index * 8, 4);
    if (!at) return false;

    int32_t relative;
    memcpy(&relative, at, sizeof(relative));
    *out = hdr + (uintptr_t)(intptr_t)relative;
    return true;
}

uintptr_t vl_image_function_containing(const VlImage *image, uintptr_t addr) {
    uintptr_t hdr = image->eh_frame_hdr;
    if (!hdr) return 0;

    const uint8_t *head = vl_image_read(image, hdr, 12);
    if (!head || head[0] != 1 || head[2] != 0x03 || head[3] != 0x3B) return 0;
    if ((head[1] & 0x0F) != 0x03 && (head[1] & 0x0F) != 0x0B) return 0;

    int32_t count;
    memcpy(&count, head + 8, sizeof(count));
    if (count <= 0) return 0;

    size_t low = 0;
    size_t high = (size_t)count;
    while (low < high) {
        size_t mid = low + (high - low) / 2;
        uintptr_t start;
        if (!vl_eh_frame_start(image, hdr, mid, &start)) return 0;
        if (start <= addr) low = mid + 1;
        else high = mid;
    }

    uintptr_t start;
    if (low == 0 || !vl_eh_frame_start(image, hdr, low - 1, &start)) return 0;
    return start;
}
