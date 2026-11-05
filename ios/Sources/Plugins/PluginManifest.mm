#import "Plugins/PluginManifest.h"

#import "ValencedCoreBridge.h"

@implementation PluginDependency

+ (instancetype)dependencyWithVersionRange:(PluginVersionRange *)versionRange optional:(BOOL)optional {
    PluginDependency *d = [[PluginDependency alloc] init];
    d->_versionRange = versionRange;
    d->_optional = optional;
    return d;
}

- (id)copyWithZone:(NSZone *)zone {
    return [PluginDependency dependencyWithVersionRange:self.versionRange optional:self.optional];
}

@end

@implementation PluginManifest

+ (instancetype)manifestWithId:(NSString *)id
                            name:(NSString *)name
                     description:(NSString *)descriptionText
                            author:(NSString *)author
                      contributors:(NSArray<NSString *> *)contributors
                            icon:(nullable NSString *)icon
                    dependencies:(NSDictionary<NSString *, PluginDependency *> *)dependencies
                         version:(PluginVersion *)version {
    PluginManifest *m = [[PluginManifest alloc] init];
    m->_id = [id copy];
    m->_name = [name copy];
    m->_descriptionText = [descriptionText copy];
    m->_author = [author copy];
    m->_contributors = [contributors copy];
    m->_icon = [icon copy];
    m->_dependencies = [dependencies copy];
    m->_version = version;
    return m;
}

+ (nullable PluginManifest *)manifestFromDictionary:(NSDictionary *)dict error:(NSString * _Nullable * _Nullable)error {
    if (![dict isKindOfClass:[NSDictionary class]]) {
        if (error) *error = @"Manifest is not a dictionary";
        return nil;
    }

    NSData *jsonData = [NSJSONSerialization dataWithJSONObject:dict options:0 error:nil];
    if (!jsonData) {
        if (error) *error = @"Manifest is not JSON-serializable";
        return nil;
    }
    NSString *json = [[NSString alloc] initWithData:jsonData encoding:NSUTF8StringEncoding];

    char *parseError = NULL;
    char *normalized = ValencedCore_ManifestParse(json.UTF8String, &parseError);
    if (!normalized) {
        if (error) *error = ValencedCore_ConsumeError(parseError);
        return nil;
    }

    NSData *normalizedData = [ValencedCore_ConsumeString(normalized) dataUsingEncoding:NSUTF8StringEncoding];
    NSDictionary *parsed = normalizedData ? [NSJSONSerialization JSONObjectWithData:normalizedData options:0 error:nil] : nil;
    if (![parsed isKindOfClass:[NSDictionary class]]) {
        if (error) *error = @"Normalized manifest is not a dictionary";
        return nil;
    }

    NSMutableDictionary<NSString *, PluginDependency *> *dependencies = [NSMutableDictionary dictionary];
    NSDictionary *rawDeps = parsed[@"dependencies"];
    if ([rawDeps isKindOfClass:[NSDictionary class]]) {
        for (NSString *depId in rawDeps) {
            NSDictionary *dep = rawDeps[depId];
            if (![dep isKindOfClass:[NSDictionary class]]) continue;

            PluginVersionRange *range = [PluginVersionRange anyVersionRange];
            id versionValue = dep[@"version"];
            if ([versionValue isKindOfClass:[NSString class]]) {
                NSString *rangeError = nil;
                range = [PluginVersionRange versionRangeFromString:versionValue error:&rangeError];
                if (!range) {
                    if (error) *error = rangeError;
                    return nil;
                }
            }
            BOOL optional = [dep[@"optional"] isKindOfClass:[NSNumber class]] ? [dep[@"optional"] boolValue] : NO;
            dependencies[depId] = [PluginDependency dependencyWithVersionRange:range optional:optional];
        }
    }

    NSString *versionError = nil;
    PluginVersion *version = [PluginVersion versionFromString:parsed[@"version"] error:&versionError];
    if (!version) {
        if (error) *error = versionError;
        return nil;
    }

    NSString *distScript = nil;
    NSDictionary *dist = parsed[@"dist"];
    if ([dist isKindOfClass:[NSDictionary class]]) {
        id script = dist[@"script"];
        if ([script isKindOfClass:[NSString class]] && ((NSString *) script).length > 0) distScript = script;
    }

    NSMutableArray<NSString *> *contributors = [NSMutableArray array];
    NSArray *rawContributors =
        [parsed[@"contributors"] isKindOfClass:[NSArray class]] ? parsed[@"contributors"] : nil;
    for (id contributor in rawContributors) {
        if ([contributor isKindOfClass:[NSString class]]) [contributors addObject:contributor];
    }

    NSString *icon = [parsed[@"icon"] isKindOfClass:[NSString class]] ? parsed[@"icon"] : nil;
    PluginManifest *manifest = [PluginManifest manifestWithId:parsed[@"id"]
                                                         name:parsed[@"name"]
                                                  description:parsed[@"description"] ?: @""
                                                         author:parsed[@"author"] ?: @""
                                                   contributors:contributors
                                                         icon:icon
                                                 dependencies:dependencies
                                                      version:version];
    manifest->_distScript = [distScript copy];
    return manifest;
}

- (NSDictionary *)toDictionary {
    NSMutableDictionary<NSString *, id> *deps = [NSMutableDictionary dictionary];
    for (NSString *depId in self.dependencies) {
        PluginDependency *dep = self.dependencies[depId];
        deps[depId] = @{
            @"version": dep.versionRange.stringValue,
            @"optional": @(dep.optional),
        };
    }

    NSMutableDictionary<NSString *, id> *dict = [NSMutableDictionary dictionaryWithDictionary:@{
        @"format": @(1),
        @"id": self.id,
        @"name": self.name,
        @"description": self.descriptionText,
        @"author": self.author,
        @"contributors": self.contributors ?: @[],
        @"version": self.version.stringValue,
        @"dependencies": deps,
    }];
    if (self.icon) dict[@"icon"] = self.icon;
    return dict;
}

- (id)copyWithZone:(NSZone *)zone {
    PluginManifest *m = [[PluginManifest alloc] init];
    m->_id = [self.id copy];
    m->_name = [self.name copy];
    m->_descriptionText = [self.descriptionText copy];
    m->_author = [self.author copy];
    m->_contributors = [self.contributors copy];
    m->_icon = [self.icon copy];
    m->_dependencies = [self.dependencies copy];
    m->_version = self.version;
    m->_distScript = [self.distScript copy];
    return m;
}

@end
