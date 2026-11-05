#pragma once

#import <Foundation/Foundation.h>
#import "PluginVersion.h"

NS_ASSUME_NONNULL_BEGIN

@interface PluginDependency : NSObject <NSCopying>

@property (nonatomic, strong) PluginVersionRange *versionRange;
@property (nonatomic, assign) BOOL optional;

+ (instancetype)dependencyWithVersionRange:(PluginVersionRange *)versionRange optional:(BOOL)optional;

@end

@interface PluginManifest : NSObject <NSCopying>

@property (nonatomic, copy) NSString *id;
@property (nonatomic, copy) NSString *name;
@property (nonatomic, copy) NSString *descriptionText;
@property (nonatomic, copy) NSString *author;
@property (nonatomic, copy) NSArray<NSString *> *contributors;
@property (nonatomic, copy, nullable) NSString *icon;
@property (nonatomic, copy) NSDictionary<NSString *, PluginDependency *> *dependencies;
@property (nonatomic, strong) PluginVersion *version;
@property (nonatomic, copy, nullable) NSString *distScript;

+ (instancetype)manifestWithId:(NSString *)id
                          name:(NSString *)name
                   description:(NSString *)descriptionText
                          author:(NSString *)author
                    contributors:(NSArray<NSString *> *)contributors
                          icon:(nullable NSString *)icon
                  dependencies:(NSDictionary<NSString *, PluginDependency *> *)dependencies
                       version:(PluginVersion *)version;

+ (nullable PluginManifest *)manifestFromDictionary:(NSDictionary *)dict error:(NSString * _Nullable * _Nullable)error;

- (NSDictionary *)toDictionary;

@end

NS_ASSUME_NONNULL_END
