import { onDispatch } from '@valenced/phoenix'
import { decodeUtf8 } from '@valenced/phoenix/bytes'
import { dispatch, on } from '@valenced/phoenix/gateway'
import { request } from '@valenced/phoenix/http'
import { registerInternalPhoenixPlugin } from '@valenced/phoenix/plugins'
import { splitDispatch } from '@valenced/phoenix/ui'
import manifest from '../../start/staff-settings/manifest.json'

interface User {
    id: string
    flags: number
}

const STAFF = 1
const SOCKET_MESSAGE = 0x17a
const READY = '{"t":"READY",'

registerInternalPhoenixPlugin(manifest.id, {
    start({ cleanup, logger }) {
        let me: User | undefined
        let stopped = false

        const fetchMe = async () =>
            JSON.parse(
                decodeUtf8(
                    (
                        await request({
                            url: 'https://discord.com/api/v9/users/@me',
                        })
                    ).body,
                ),
            ) as User

        const apply = (user: User) =>
            dispatch('USER_UPDATE', user).catch(error =>
                logger.warn(`Unable to update the current user: ${error}`),
            )

        // Cleanups run in reverse, so this one runs after the listeners are gone
        cleanup(async () => {
            stopped = true
            if (me) await apply(await fetchMe())
        })

        cleanup(
            on<User>('USER_UPDATE', user => {
                if (user.id !== me?.id) return
                me = user
                return { ...user, flags: user.flags | STAFF }
            }),
            // READY is applied outside the gateway handlers and resets the flags
            onDispatch((_, bytes) => {
                if (!me || bytes[0] !== 4 || bytes[1] !== 0) return
                for (const frame of splitDispatch(bytes)) {
                    const view = new DataView(
                        frame.buffer,
                        frame.byteOffset,
                        frame.length,
                    )
                    if (
                        frame.length < 16 ||
                        view.getUint32(4, true) !== SOCKET_MESSAGE
                    )
                        continue

                    const body = 16 + view.getUint32(12, true)
                    if (
                        decodeUtf8(
                            frame.subarray(body, body + READY.length),
                        ) === READY
                    )
                        apply({ ...me, flags: me.flags | STAFF })
                }
            }),
        )

        fetchMe().then(
            user => {
                if (stopped) return
                me = user
                apply({ ...user, flags: user.flags | STAFF })
            },
            error => logger.warn(`Unable to get the current user: ${error}`),
        )
    },
})
