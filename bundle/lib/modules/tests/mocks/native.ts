// Stands in for `@valenced/modules/native`, recording every call
export const nativeCalls: [name: string, args: unknown[]][] = []

export function callNativeMethodSync(name: string, args: unknown[]) {
    nativeCalls.push([name, args])
    // Saved module cache, so blacklist restores run like on device
    if (name === 'valenced.caches.modules.read')
        return { blacklist: [], finds: {}, version: 3 }
    return null
}

export async function callNativeMethod(name: string, args: unknown[]) {
    nativeCalls.push([name, args])
    return null
}
