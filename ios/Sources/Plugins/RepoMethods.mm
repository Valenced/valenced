#import "Plugins/RepoStore.h"
#import "Plugins/SourcesStore.h"
#import "Plugins/RepoIndex.h"
#import "Plugins/PluginLoader.h"
#import "Plugins/PluginManifest.h"
#import "Constants.h"
#import "Bridge.h"
#import "Utils.h"
#import "Logger.h"

NSString * _Nullable RefreshRepo(NSString *url, RepoIndex * _Nullable * _Nullable indexOut);

static NSDictionary *internalRepoJSPayload(void) {
    return @{
        @"url": INTERNAL_REPO_URL,
        @"enabled": @YES,
        @"internal": @YES,
        @"name": @"Valenced",
        @"description": @"Plugins built into Valenced.",
        @"icon": [NSNull null],
    };
}

static NSArray *internalRepoPluginsJSPayload(void) {
    PluginLoader *loader = [PluginLoader sharedLoader];
    NSMutableArray *result = [NSMutableArray array];
    for (PluginRecord *record in loader.listableRecords) {
        if (!record.isInternal || !record.manifest) continue;
        NSString *version = record.manifest.version.stringValue;
        NSMutableDictionary<NSString *, NSDictionary *> *deps = [NSMutableDictionary dictionary];
        for (NSString *depId in record.manifest.dependencies) {
            PluginDependency *dep = record.manifest.dependencies[depId];
            deps[depId] = @{
                @"version": dep.versionRange.stringValue ?: @"*",
                @"optional": @(dep.optional),
            };
        }
        [result addObject:@{
            @"id": record.manifest.id,
            @"name": record.manifest.name,
            @"description": record.manifest.descriptionText,
            @"author": record.manifest.author,
            @"contributors": record.manifest.contributors ?: @[],
            @"icon": record.manifest.icon ?: [NSNull null],
            @"channels": @{REPO_CHANNEL_LATEST: version},
            @"versions": @{version: @{
                @"url": [NSNull null],
                @"sha256": [NSNull null],
                @"size": @0,
                @"dependencies": deps,
            }},
        }];
    }
    return result;
}

static NSDictionary *repoPayload(UserRepo *repo, RepoIndex * _Nullable index) {
    return @{
        @"url": repo.url,
        @"enabled": @(repo.enabled),
        @"internal": @NO,
        @"name": index.name ?: [NSNull null],
        @"description": index.descriptionText ?: [NSNull null],
        @"icon": index.icon ?: [NSNull null],
    };
}

static void emitRepoState(NSString *url, NSString *state, NSString * _Nullable error) {
    NSMutableDictionary *payload = [NSMutableDictionary dictionaryWithDictionary:@{
        @"url": url,
        @"state": state,
    }];
    if (error) payload[@"error"] = error;
    EmitJSEvent(EVENT_REPO_STATE_UPDATE, payload);
}

extern "C" void RegisterRepoMethods(void) {
    bridgeHandlers()[@"valenced.plugins.repos.list"] = ^NSDictionary *(NSArray *args) {
        NSMutableArray *result = [NSMutableArray array];
        [result addObject:internalRepoJSPayload()];
        for (UserRepo *repo in [[RepoStore sharedStore] list]) {
            RepoIndex *index = [[RepoStore sharedStore] cachedIndexForURL:repo.url];
            [result addObject:repoPayload(repo, index)];
        }
        return @{@"result": result};
    };

    bridgeHandlers()[@"valenced.plugins.repos.set"] = ^NSDictionary *(NSArray *args) {
        id config = args.firstObject;
        if (![config isKindOfClass:[NSArray class]]) {
            return @{@"error": @"Expected a config array of { url, enabled }"};
        }

        NSMutableArray<UserRepo *> *entries = [NSMutableArray array];
        for (id entry in config) {
            if (![entry isKindOfClass:[NSDictionary class]]) {
                return @{@"error": @"Expected { url, enabled } objects"};
            }
            NSDictionary *map = entry;
            id url = map[@"url"];
            if (![url isKindOfClass:[NSString class]]) {
                return @{@"error": @"Repository entry is missing 'url'"};
            }
            id enabled = map[@"enabled"];
            [entries addObject:[UserRepo repoWithURL:url
                                             enabled:enabled == nil || ([enabled isKindOfClass:[NSNumber class]] && [enabled boolValue])]];
        }

        NSString *error = [[RepoStore sharedStore] setEntries:entries];
        if (error) return @{@"error": error};
        return @{@"result": [NSNull null]};
    };

    bridgeHandlers()[@"valenced.plugins.repos.refresh"] = ^NSDictionary *(NSArray *args) {
        NSString *url = argString(args, 0, nil);
        if (!url) return @{@"error": @"Expected a repository URL"};
        if ([url isEqualToString:INTERNAL_REPO_URL]) {
            return @{@"error": @"The internal repository cannot be refreshed"};
        }

        emitRepoState(url, @"refreshing", nil);
        RepoIndex *index = nil;
        NSString *error = RefreshRepo(url, &index);
        if (error) {
            emitRepoState(url, @"error", error);
            return @{@"error": error};
        }
        emitRepoState(url, @"ready", nil);

        UserRepo *matched = nil;
        for (UserRepo *repo in [[RepoStore sharedStore] list]) {
            if ([repo.url isEqualToString:url]) { matched = repo; break; }
        }
        return @{@"result": matched ? repoPayload(matched, index) : [NSNull null]};
    };

    bridgeHandlers()[@"valenced.plugins.repos.listPlugins"] = ^NSDictionary *(NSArray *args) {
        NSString *url = argString(args, 0, nil);
        if (!url) return @{@"error": @"Expected a repository URL"};

        if ([url isEqualToString:INTERNAL_REPO_URL]) {
            return @{@"result": internalRepoPluginsJSPayload()};
        }

        BOOL known = NO;
        for (UserRepo *repo in [[RepoStore sharedStore] list]) {
            if ([repo.url isEqualToString:url]) { known = YES; break; }
        }
        if (!known) return @{@"error": [NSString stringWithFormat:@"Unknown repository: '%@'", url]};

        RepoIndex *index = [[RepoStore sharedStore] cachedIndexForURL:url];
        if (!index) {
            return @{@"error": [NSString stringWithFormat:@"No cached index for '%@'; refresh it first", url]};
        }

        NSMutableArray *result = [NSMutableArray array];
        for (NSString *pluginId in index.plugins) {
            RepoPlugin *plugin = index.plugins[pluginId];
            NSMutableDictionary<NSString *, NSDictionary *> *versions = [NSMutableDictionary dictionary];
            for (NSString *versionKey in plugin.versions) {
                RepoVersion *v = plugin.versions[versionKey];
                NSMutableDictionary<NSString *, NSDictionary *> *deps = [NSMutableDictionary dictionary];
                for (NSString *depId in v.dependencies) {
                    NSDictionary *dep = v.dependencies[depId];
                    NSObject *depVersion = dep[@"version"];
                    deps[depId] = @{
                        @"version": [depVersion isKindOfClass:[NSString class]] ? depVersion : @"*",
                        @"optional": dep[@"optional"] ?: @NO,
                    };
                }
                versions[versionKey] = @{
                    @"url": v.url ?: [NSNull null],
                    @"sha256": v.sha256 ?: [NSNull null],
                    @"size": @(v.size),
                    @"dependencies": deps,
                };
            }
            [result addObject:@{
                @"id": pluginId,
                @"name": plugin.name,
                @"description": plugin.descriptionText,
                @"author": plugin.author,
                @"contributors": plugin.contributors ?: @[],
                @"icon": plugin.icon ?: [NSNull null],
                @"channels": plugin.channels ?: @{},
                @"versions": versions,
            }];
        }
        return @{@"result": result};
    };
}
