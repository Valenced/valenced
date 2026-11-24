import TableRowAssetIcon from '@valenced/components/TableRowAssetIcon'
import { Setting } from '../constants'
import { CopyableSetting, getClientInfo } from './shared'
import type { SettingsItem } from '@valenced/discord/modules/settings'

const ValencedFrameworkSetting: SettingsItem = CopyableSetting(
    {
        parent: Setting.Valenced,
        IconComponent: () => <TableRowAssetIcon name="WrenchIcon" />,
        useTitle: () => 'Framework',
    },
    () => getClientInfo().framework,
)

export default ValencedFrameworkSetting
