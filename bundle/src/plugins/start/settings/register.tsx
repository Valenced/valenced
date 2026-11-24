import {
    registerSettingsItems,
    registerSettingsSection,
} from '@valenced/discord/modules/settings'
import { Setting } from './constants'
import HermesVersionSetting from './definitions/HermesVersionSetting'
import LoaderVersionSetting from './definitions/LoaderVersionSetting'
import ReactNativeVersionSetting from './definitions/ReactNativeVersionSetting'
import ReactVersionSetting from './definitions/ReactVersionSetting'
import ReloadSetting from './definitions/ReloadSetting'
import ValencedClientSetting from './definitions/ValencedClientSetting'
import ValencedDeveloperModeSetting from './definitions/ValencedDeveloperModeSetting'
import ValencedDiscordSetting from './definitions/ValencedDiscordSetting'
import ValencedFrameworkSetting from './definitions/ValencedFrameworkSetting'
import ValencedLicenseSetting from './definitions/ValencedLicenseSetting'
import ValencedSetting from './definitions/ValencedSetting'
import ValencedSourceRepositorySetting from './definitions/ValencedSourceRepositorySetting'
import ValencedSwitchClientSetting from './definitions/ValencedSwitchClientSetting'
import ValencedVersionSetting from './definitions/ValencedVersionSetting'

registerSettingsItems({
    [Setting.Valenced]: ValencedSetting,
    [Setting.ValencedSourceRepository]: ValencedSourceRepositorySetting,
    [Setting.ValencedLicense]: ValencedLicenseSetting,
    [Setting.ValencedDiscord]: ValencedDiscordSetting,
    [Setting.Reload]: ReloadSetting,
    [Setting.ValencedDeveloperMode]: ValencedDeveloperModeSetting,
    [Setting.ValencedVersion]: ValencedVersionSetting,
    [Setting.ReactVersion]: ReactVersionSetting,
    [Setting.ReactNativeVersion]: ReactNativeVersionSetting,
    [Setting.HermesVersion]: HermesVersionSetting,
    [Setting.LoaderVersion]: LoaderVersionSetting,
    [Setting.ValencedClient]: ValencedClientSetting,
    [Setting.ValencedFramework]: ValencedFrameworkSetting,
    [Setting.ValencedSwitchClient]: ValencedSwitchClientSetting,
})

registerSettingsSection('VALENCED', {
    label: 'Valenced',
    settings: [Setting.Valenced],
})
