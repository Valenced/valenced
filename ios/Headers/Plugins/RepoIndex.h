#pragma once

#import <Foundation/Foundation.h>
#import "PluginVersion.h"

NS_ASSUME_NONNULL_BEGIN

@interface RepoVersion : NSObject
@property (nonatomic, copy) NSString *url;
@property (nonatomic, copy) NSString *sha256;
@property (nonatomic, assign) long long size;
@property (nonatomic, copy) NSDictionary<NSString *, NSDictionary *> *dependencies;
@end

@interface RepoPlugin : NSObject
@property (nonatomic, copy) NSString *name;
@property (nonatomic, copy) NSString *descriptionText;
@property (nonatomic, copy) NSString *author;
@property (nonatomic, copy) NSArray<NSString *> *contributors;
@property (nonatomic, copy, nullable) NSString *icon;
@property (nonatomic, copy) NSDictionary<NSString *, NSString *> *channels;
@property (nonatomic, copy) NSDictionary<NSString *, RepoVersion *> *versions;
@end

@interface RepoIndex : NSObject
@property (nonatomic, assign) NSInteger format;
@property (nonatomic, copy) NSString *name;
@property (nonatomic, copy) NSString *descriptionText;
@property (nonatomic, copy, nullable) NSString *icon;
@property (nonatomic, copy) NSDictionary<NSString *, RepoPlugin *> *plugins;
@end

RepoIndex * _Nullable ParseRepoIndex(NSString *text, NSString *repoUrl);

BOOL RequireValidPluginIdPublic(NSString *pluginId);

NS_ASSUME_NONNULL_END
