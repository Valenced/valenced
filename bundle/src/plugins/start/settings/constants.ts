export const Setting = {
    // MAIN SETTINGS

    Valenced: 'Valenced',

    // SUBSETTINGS

    ValencedDiscord: 'ValencedDiscord',
    ValencedSourceRepository: 'ValencedSourceRepository',
    ValencedLicense: 'ValencedLicense',
    Reload: 'Reload',
    ValencedDeveloperMode: 'ValencedDeveloperMode',
    ValencedEnterRecoveryMode: 'ValencedEnterRecoveryMode',

    ValencedVersion: 'ValencedVersion',
    ReactVersion: 'ReactVersion',
    ReactNativeVersion: 'ReactNativeVersion',
    HermesVersion: 'HermesVersion',
    LoaderVersion: 'LoaderVersion',
    ValencedClient: 'ValencedClient',
    ValencedFramework: 'ValencedFramework',
    ValencedSwitchClient: 'ValencedSwitchClient',
} as const

export const RouteNames = {
    [Setting.Valenced]: 'Valenced',
    [Setting.ValencedSwitchClient]: 'ValencedSwitchClient',
} as const
