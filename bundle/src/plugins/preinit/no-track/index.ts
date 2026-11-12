import { withDependencies, withProps } from '@valenced/modules/finders/filters'
import { instead } from '@valenced/patcher'
import {
    isPluginStartedLate,
    registerInternalPlugin,
} from '@valenced/plugins/_'
import { noop } from '@valenced/utils/callback'
import { getCurrentStack } from '@valenced/utils/error'
import { lazyModule } from '@valenced/utils/modules/lazy'
import manifest from './manifest.json'

const fakeSentryCarrier = new Proxy(
    {
        encodePolyfill: () => new Uint8Array(),
        decodePolyfill: () => '',
        version: '',
        _versions: [] as PropertyKey[],
    },
    {
        get: (target, prop) => {
            if (target._versions.includes(prop)) return target
            if (target[prop as keyof typeof target])
                return target[prop as keyof typeof target]
        },
        set: (target, prop, value) => {
            if (prop === 'version') {
                target._versions.push(value)
                return (target.version = value)
            } else return value
        },
    },
)

const getFakeCarrier = () => fakeSentryCarrier

registerInternalPlugin(manifest, {
    preInit({ cleanup, plugin }) {
        if (isPluginStartedLate(plugin)) plugin.requireReload()

        // utils/SentryUtils.native.tsx
        const SentryUtils = lazyModule(
            withProps<{
                profiledRootComponent<T>(x: T): T
                addBreadcrumb(): void
                setTags(): void
                setUser(): void
            }>('profiledRootComponent'),
        )

        // These functions by Discord attempt to call Sentry APIs that set __SENTRY__
        cleanup(
            SentryUtils.instead('profiledRootComponent', args => args[0]),
            SentryUtils.instead('addBreadcrumb', noop),
            SentryUtils.instead('setTags', noop),
            SentryUtils.instead('setUser', noop),
        )

        // modules/errors/native/SentryInitUtils.tsx
        cleanup(lazyModule(withProps('initSentry')).instead('initSentry', noop))

        // Discord uses reactNavigationIntegration to track navigation
        // Discord also uses Profiler to track performance, but we blocked that by patching profiledRootComponent
        // Note that to actually find Sentry, we just need to add 'init' to withProps
        // Source module, Sentry barrels forward to it
        cleanup(
            lazyModule(
                withProps<{
                    reactNavigationIntegration(): {
                        registerNavigationContainer(): void
                    }
                    getReactNavigationIntegration(): unknown
                }>(
                    'reactNavigationIntegration',
                    'getReactNavigationIntegration',
                ),
            ).after('reactNavigationIntegration', integration => {
                // https://docs.sentry.io/platforms/react-native/tracing/instrumentation/react-navigation/
                integration.registerNavigationContainer = noop
                return integration
            }),
        )

        // If we hadn't modified the global
        if (
            Object.getOwnPropertyDescriptor(globalThis, '__SENTRY__')
                ?.configurable
        )
            Object.defineProperty(globalThis, '__SENTRY__', {
                configurable: false,
                get: getFakeCarrier,
                set: () => {
                    if (__DEV__) warnSetSentry(getCurrentStack())
                    return getFakeCarrier()
                },
            })
    },
    init({ cleanup }) {
        // utils/AnalyticsUtils.tsx
        const AnalyticsUtils = lazyModule(
            withProps<{
                trackNetworkAction: () => void
                default: {
                    track: () => void
                    AnalyticsActionHandlers: Record<string, () => void>
                }
            }>('trackNetworkAction'),
        )

        cleanup(
            AnalyticsUtils.prop('default').instead('track', noop),
            AnalyticsUtils.instead('trackNetworkAction', noop),
            AnalyticsUtils.prop('default')
                .prop('AnalyticsActionHandlers')
                .use(handlers => {
                    const unpatches = Object.keys(handlers).map(key =>
                        instead(handlers, key, noop),
                    )
                    return () => {
                        for (const unpatch of unpatches) unpatch()
                    }
                }),
        )
    },
    start({
        cleanup,
        logger,
        unscoped: {
            discord: {
                common: {
                    flux: { DispatcherModuleId },
                },
            },
        },
    }) {
        // modules/app_analytics/useTrackImpression.tsx
        const useTrackImpression = lazyModule(
            withProps<{
                default: () => void
                trackImpression: () => void
            }>('trackImpression'),
        )

        cleanup(
            useTrackImpression.instead('trackImpression', noop),
            useTrackImpression.instead('default', noop),
        )

        // actions/AnalyticsTrackingActionCreators.tsx
        cleanup(
            lazyModule(
                withProps('track').and(
                    withDependencies(
                        withDependencies.partial([DispatcherModuleId]),
                    ),
                ),
            ).use(AnalyticsTrackingActionCreators => {
                logger.info('Patching AnalyticsTrackActionCreators...')
                return instead(AnalyticsTrackingActionCreators, 'track', noop)
            }),
        )

        // ../discord_common/js/packages/http-utils/HTTPUtils.tsx
        cleanup(
            lazyModule(withProps('HTTP', 'post'))
                .prop('HTTP')
                .use(HTTP => {
                    logger.log('Patching HTTPUtils...')

                    // Block analytics requests
                    return instead(HTTP, 'post', (args, original) => {
                        const [{ url }] = args
                        if (url === '/science') return Promise.resolve()

                        return original.apply(this, args)
                    })
                }),
        )
    },
    stop({ plugin }) {
        plugin.requireReload()
    },
})

function warnSetSentry(stack: string) {
    nativeLoggingHook(
        `\u001b[33mNo Track: Attempt to set __SENTRY__\n${stack}\u001b[0m`,
        2,
    )
}
