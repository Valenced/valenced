/**
 * Marks filters made by `namespaceOnly` and `withDefaultExport`, so `runFilter` doesn't run them against the `default` export at all.
 * Copies of a filter (eg. from `scope()`) keep it, along with the key.
 */
export const NamespaceOnlyMark = Symbol('valenced.namespaceOnly')

export interface MaybeNamespaceOnly {
    [NamespaceOnlyMark]?: true
}
