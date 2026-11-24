import { Design } from '@valenced/discord/design'
import { useSetting } from '@valenced/plugins/_/react'
import { useEffect, useState } from 'react'
import type {
    PluginApi,
    PluginSettingDefinition,
} from '@valenced/plugins/types'

const {
    Stack,
    TableRadioGroup,
    TableRadioRow,
    TableRow,
    TableRowGroup,
    TableSwitchRow,
    TextInput,
} = Design

export default function GeneratedPluginSettings({
    api,
}: {
    api: PluginApi<any>
}) {
    const settings = api.plugin.manifest.settings ?? []
    if (!settings.length) return null

    const groups = new Map<string | undefined, PluginSettingDefinition[]>()
    for (const setting of settings) {
        const group = groups.get(setting.section) ?? []
        group.push(setting)
        groups.set(setting.section, group)
    }

    return (
        <Stack spacing={16}>
            {[...groups].map(([section, fields]) => (
                <TableRowGroup key={section ?? 'default'} title={section}>
                    {fields.map(setting => (
                        <SettingField
                            key={setting.key}
                            api={api}
                            setting={setting}
                        />
                    ))}
                </TableRowGroup>
            ))}
        </Stack>
    )
}

function SettingField({
    api,
    setting,
}: {
    api: PluginApi<any>
    setting: PluginSettingDefinition
}) {
    const [value, setValue] = useSetting(api.settings, setting.key)
    const save = (next: string | number | boolean) => setValue(next)

    if (setting.type === 'switch')
        return (
            <TableSwitchRow
                label={setting.label}
                subLabel={setting.description}
                value={value as boolean}
                onValueChange={next => save(next).catch(api.plugin.reportError)}
            />
        )

    if (setting.type === 'select')
        return (
            <TableRadioGroup
                title={setting.label}
                value={value as string}
                onChange={next =>
                    save(String(next)).catch(api.plugin.reportError)
                }
            >
                {setting.options?.map(option => (
                    <TableRadioRow
                        key={option.value}
                        label={option.label}
                        value={option.value}
                    />
                ))}
            </TableRadioGroup>
        )

    return (
        <TextSettingField
            setting={setting}
            value={value as string | number}
            save={save}
        />
    )
}

function TextSettingField({
    setting,
    value,
    save,
}: {
    setting: PluginSettingDefinition
    value: string | number
    save: (value: string | number) => Promise<void>
}) {
    const [draft, setDraft] = useState(String(value))
    useEffect(() => setDraft(String(value)), [value])

    return (
        <TableRow
            label={setting.label}
            subLabel={setting.description}
            trailing={
                <TextInput
                    value={draft}
                    onChange={setDraft}
                    onBlur={() => {
                        if (setting.type === 'number') {
                            const number = Number(draft)
                            if (!Number.isFinite(number)) {
                                setDraft(String(value))
                                return
                            }
                            save(number).catch(() => setDraft(String(value)))
                        } else save(draft).catch(() => setDraft(String(value)))
                    }}
                    placeholder={setting.type === 'text' ? '' : undefined}
                    style={{ minWidth: 100 }}
                />
            }
        />
    )
}
