import { registerInternalManifest } from '@valenced/plugins/_'
import type { InternalPluginManifest } from '@valenced/plugins/_'

const manifests = import.meta.glob<InternalPluginManifest>(
    [
        './preinit/*/manifest.json',
        './init/*/manifest.json',
        './start/*/manifest.json',
    ],
    {
        eager: true,
        import: 'default',
    },
)

for (const manifest of Object.values(manifests)) {
    if (manifest.build?.devOnly && !__DEV__) continue
    registerInternalManifest(manifest)
}
