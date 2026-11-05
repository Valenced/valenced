#import "Plugins/RepoIndex.h"

#import "Constants.h"
#import "Logger.h"
#import "ValencedCoreBridge.h"

@implementation RepoVersion
@end

@implementation RepoPlugin
@end

@implementation RepoIndex
@end

RepoIndex * _Nullable ParseRepoIndex(NSString *text, NSString *repoUrl) {
    char *parseError = NULL;
    char *normalized = ValencedCore_RepoIndexParse(text.UTF8String, repoUrl.UTF8String, &parseError);
    if (!normalized) {
        ValencedLog(@"Repository '%@': %@", repoUrl, ValencedCore_ConsumeError(parseError));
        return nil;
    }

    NSData *data = [ValencedCore_ConsumeString(normalized) dataUsingEncoding:NSUTF8StringEncoding];
    NSDictionary *raw = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
    if (![raw isKindOfClass:[NSDictionary class]]) {
        ValencedLog(@"Repository '%@': invalid normalized index", repoUrl);
        return nil;
    }

    RepoIndex *index = [[RepoIndex alloc] init];
    index.format = [raw[@"format"] isKindOfClass:[NSNumber class]] ? [raw[@"format"] integerValue] : REPO_INDEX_FORMAT;
    index.name = [raw[@"name"] isKindOfClass:[NSString class]] ? raw[@"name"] : @"";
    index.descriptionText = [raw[@"description"] isKindOfClass:[NSString class]] ? raw[@"description"] : @"";
    index.icon = [raw[@"icon"] isKindOfClass:[NSString class]] ? raw[@"icon"] : nil;

    NSMutableDictionary<NSString *, RepoPlugin *> *plugins = [NSMutableDictionary dictionary];
    NSDictionary *rawPlugins = [raw[@"plugins"] isKindOfClass:[NSDictionary class]] ? raw[@"plugins"] : nil;

    for (NSString *pluginId in rawPlugins) {
        NSDictionary *rawPlugin = rawPlugins[pluginId];
        if (![rawPlugin isKindOfClass:[NSDictionary class]]) continue;

        RepoPlugin *plugin = [[RepoPlugin alloc] init];
        plugin.name = [rawPlugin[@"name"] isKindOfClass:[NSString class]] ? rawPlugin[@"name"] : @"";
        plugin.descriptionText = [rawPlugin[@"description"] isKindOfClass:[NSString class]] ? rawPlugin[@"description"] : @"";
        plugin.author = [rawPlugin[@"author"] isKindOfClass:[NSString class]] ? rawPlugin[@"author"] : @"";

        NSMutableArray<NSString *> *contributors = [NSMutableArray array];
        NSArray *rawContributors =
            [rawPlugin[@"contributors"] isKindOfClass:[NSArray class]] ? rawPlugin[@"contributors"] : nil;
        for (id contributor in rawContributors) {
            if ([contributor isKindOfClass:[NSString class]]) [contributors addObject:contributor];
        }
        plugin.contributors = contributors;

        plugin.icon = [rawPlugin[@"icon"] isKindOfClass:[NSString class]] ? rawPlugin[@"icon"] : nil;

        NSMutableDictionary<NSString *, RepoVersion *> *versions = [NSMutableDictionary dictionary];
        NSDictionary *rawVersions = [rawPlugin[@"versions"] isKindOfClass:[NSDictionary class]] ? rawPlugin[@"versions"] : nil;
        for (NSString *versionKey in rawVersions) {
            NSDictionary *rawVersion = rawVersions[versionKey];
            if (![rawVersion isKindOfClass:[NSDictionary class]]) continue;

            RepoVersion *version = [[RepoVersion alloc] init];
            version.url = [rawVersion[@"url"] isKindOfClass:[NSString class]] ? rawVersion[@"url"] : nil;
            version.sha256 = [rawVersion[@"sha256"] isKindOfClass:[NSString class]] ? rawVersion[@"sha256"] : nil;
            version.size = [rawVersion[@"size"] isKindOfClass:[NSNumber class]] ? [rawVersion[@"size"] longLongValue] : 0;

            NSMutableDictionary<NSString *, NSDictionary *> *deps = [NSMutableDictionary dictionary];
            NSDictionary *rawDeps = [rawVersion[@"dependencies"] isKindOfClass:[NSDictionary class]] ? rawVersion[@"dependencies"] : nil;
            for (NSString *depId in rawDeps) {
                NSDictionary *rawDep = rawDeps[depId];
                if (![rawDep isKindOfClass:[NSDictionary class]]) continue;
                id depVersion = rawDep[@"version"];
                NSNumber *depOptional = [rawDep[@"optional"] isKindOfClass:[NSNumber class]] ? rawDep[@"optional"] : nil;
                deps[depId] = @{
                    @"version": [depVersion isKindOfClass:[NSString class]] ? depVersion : [NSNull null],
                    @"optional": @(depOptional.boolValue),
                };
            }
            version.dependencies = deps;

            versions[versionKey] = version;
        }

        NSMutableDictionary<NSString *, NSString *> *channels = [NSMutableDictionary dictionary];
        NSDictionary *rawChannels = [rawPlugin[@"channels"] isKindOfClass:[NSDictionary class]] ? rawPlugin[@"channels"] : nil;
        for (NSString *channel in rawChannels) {
            NSString *target = rawChannels[channel];
            if ([target isKindOfClass:[NSString class]]) channels[channel] = target;
        }

        plugin.channels = channels;
        plugin.versions = versions;
        plugins[pluginId] = plugin;
    }

    index.plugins = plugins;
    return index;
}
