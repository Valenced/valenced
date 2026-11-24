import { on } from '@valenced/phoenix/gateway'

interface Message {
    id: string
    channel_id: string
    content?: string
}

const MAX_CACHED = 2000
const cache = new Map<string, string>()

function remember(id: string, content: string) {
    cache.delete(id)
    cache.set(id, content)
    if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!)
}

if (__DEV__) {
    on('MESSAGE_CREATE', (message: Message) => {
        if (typeof message.content === 'string')
            remember(message.id, message.content)
    })

    on('MESSAGE_UPDATE', (message: Message) => {
        const old = cache.get(message.id)
        if (typeof message.content !== 'string' || old === undefined) return
        if (old === message.content) return

        remember(message.id, message.content)
        nativeLoggingHook(`Edited ${message.id} in ${message.channel_id}`, 1)
        return {
            ...message,
            content: `${message.content}\n(edited from: ${old})`,
        }
    })

    on('MESSAGE_DELETE', (message: Message) => {
        nativeLoggingHook(
            `Kept deleted ${message.id} in ${message.channel_id}`,
            1,
        )
        return false
    })
}
