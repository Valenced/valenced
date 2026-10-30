import { describe, expect, test } from 'vitest'
import {
    formatPluginContributor,
    getPluginContributorName,
    parsePluginContributor,
} from './utils'

const Id1 = '123456789012345678'
const Id2 = '876543210987654321'

describe('parsePluginContributor', () => {
    test('parses a name only', () => {
        expect(parsePluginContributor('  Valenced  ')).toEqual({
            name: 'Valenced',
            ids: [],
            links: [],
        })
    })

    test('parses IDs and links', () => {
        expect(
            parsePluginContributor(
                `Jane Doe <${Id1}> <${Id2}> (https://example.com/jane "Website") (mailto:jane@example.com)`,
            ),
        ).toEqual({
            name: 'Jane Doe',
            ids: [Id1, Id2],
            links: [
                { url: 'https://example.com/jane', label: 'Website' },
                { url: 'mailto:jane@example.com', label: undefined },
            ],
        })
    })

    test('allows entries without whitespace between them', () => {
        expect(
            parsePluginContributor(`Jane<${Id1}>(http://example.com)`),
        ).toEqual({
            name: 'Jane',
            ids: [Id1],
            links: [{ url: 'http://example.com', label: undefined }],
        })
    })

    test.each([
        ['an empty name', `<${Id1}>`],
        ['an ID after a link', `Jane (https://example.com) <${Id1}>`],
        ['a short ID', 'Jane <1234>'],
        ['a non-numeric ID', 'Jane <jane@example.com>'],
        ['an unsupported scheme', 'Jane (javascript:alert(1))'],
        ['a link without a scheme', 'Jane (example.com)'],
        ['a parenthesized name', 'Jane (Doe)'],
        ['an empty link label', 'Jane (https://example.com "")'],
        ['an unquoted link label', 'Jane (https://example.com Website)'],
        ['trailing text', `Jane <${Id1}> extra`],
        ['an unclosed entry', `Jane <${Id1}`],
    ])('rejects %s', (_, input) => {
        expect(parsePluginContributor(input)).toBeNull()
    })
})

describe('getPluginContributorName', () => {
    test('returns the parsed name', () => {
        expect(getPluginContributorName(`Jane <${Id1}>`)).toBe('Jane')
    })

    test('returns the raw string when unparseable', () => {
        expect(getPluginContributorName('Jane (Doe)')).toBe('Jane (Doe)')
    })
})

describe('formatPluginContributor', () => {
    test('passes strings through', () => {
        expect(formatPluginContributor(`Jane <${Id1}>`)).toBe(`Jane <${Id1}>`)
    })

    test('formats objects into a parseable string', () => {
        const formatted = formatPluginContributor({
            name: 'Jane Doe',
            ids: [Id1, Id2],
            links: [
                { url: 'https://example.com/jane', title: 'Website' },
                { url: 'mailto:jane@example.com' },
            ],
        })

        expect(formatted).toBe(
            `Jane Doe <${Id1}> <${Id2}> (https://example.com/jane "Website") (mailto:jane@example.com)`,
        )
        expect(parsePluginContributor(formatted)).toEqual({
            name: 'Jane Doe',
            ids: [Id1, Id2],
            links: [
                { url: 'https://example.com/jane', label: 'Website' },
                { url: 'mailto:jane@example.com', label: undefined },
            ],
        })
    })

    test('formats a name only', () => {
        expect(formatPluginContributor({ name: 'Valenced' })).toBe('Valenced')
    })
})
