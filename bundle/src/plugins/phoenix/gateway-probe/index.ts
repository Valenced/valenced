import { on } from '@valenced/phoenix/gateway'

if (__DEV__)
    on('MESSAGE_CREATE', (message: { id: string; channel_id: string }) => {
        nativeLoggingHook(
            `MESSAGE_CREATE ${message.id} in ${message.channel_id}`,
            1,
        )
    })
