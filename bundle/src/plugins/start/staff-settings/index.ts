import { ToastActionCreators } from '@valenced/discord/actions'
import { getStore, Stores } from '@valenced/discord/flux'
import { withProps } from '@valenced/modules/finders/filters'
import { instead } from '@valenced/patcher'
import { registerInternalPlugin } from '@valenced/plugins/_'
import { lookupGeneratedIconComponent } from '@valenced/utils/discord'
import { lazyModule } from '@valenced/utils/modules/lazy'
import manifest from './manifest.json'
import type { DiscordModules } from '@valenced/discord/types'

registerInternalPlugin(manifest, {
    start({ cleanup, logger, plugin }) {
        const CircleInformationIcon = lookupGeneratedIconComponent(
            'CircleInformationIcon',
            'CircleInformationIcon-secondary',
            'CircleInformationIcon-primary',
        )

        const showToast = () =>
            ToastActionCreators.open('VALENCED_STAFF_SETTINGS_ACTION', {
                text: 'Navigate out of Settings to apply changes',
                icon: CircleInformationIcon,
            })

        function reset() {
            getStore<{
                initialize(): void
            }>('DeveloperExperimentStore', store => {
                logger.log(
                    'Reinitializing DeveloperExperimentStore to apply changes...',
                )

                const unpatch = instead(
                    Object,
                    'defineProperties',
                    args => args[0],
                )

                store.initialize()
                unpatch()
            })
        }

        cleanup(
            lazyModule(withProps('isStaffEnv')).use(UserStoreUtils => {
                logger.log('Patching UserStoreUtils...')

                const unpatch = instead(
                    UserStoreUtils,
                    'isStaffEnv',
                    ([user]) =>
                        user ===
                        (
                            Stores.UserStore as DiscordModules.Flux.Store<{
                                getCurrentUser(): unknown
                            }>
                        ).getCurrentUser(),
                )

                reset()
                if (plugin.startedLate) showToast()

                return () => {
                    unpatch()
                    reset()
                    showToast()
                }
            }),
        )
    },
})
