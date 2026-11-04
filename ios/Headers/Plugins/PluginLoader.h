#pragma once

#import <Foundation/Foundation.h>
#import "Plugin.h"
#import "PluginStates.h"

NS_ASSUME_NONNULL_BEGIN

typedef NS_ENUM(NSInteger, PluginErrorCode) {
    PluginErrorManifestInvalid,
    PluginErrorDependencyMissing,
    PluginErrorDependencyUnsatisfied,
    PluginErrorDependencyFailed,
    PluginErrorDependencyCycle,
    PluginErrorLoadFailed,
    PluginErrorPluginError,
    PluginErrorInstallInvalidZip,
    PluginErrorInstallVerifyFailed,
    PluginErrorInstallMismatch,
    PluginErrorInstallFailed
};

NSString *PluginErrorCodeString(PluginErrorCode code);

@interface PluginErrorInfo : NSObject

@property (nonatomic, copy) NSString *code;
@property (nonatomic, copy) NSString *message;
@property (nonatomic, copy, nullable) NSString *stack;

+ (instancetype)errorWithCode:(PluginErrorCode)code message:(NSString *)message stack:(nullable NSString *)stack;
+ (instancetype)errorWithString:(NSString *)code message:(NSString *)message stack:(nullable NSString *)stack;
- (NSDictionary *)toDictionary;

@end

@interface PluginRecord : NSObject

@property (nonatomic, strong, nullable) PluginManifest *manifest;
@property (nonatomic, assign) NSInteger flags;
@property (nonatomic, copy, nullable) NSString *sourceRepo;
@property (nonatomic, copy, nullable) NSString *sourceChannel;
@property (nonatomic, assign) BOOL hasSource;
@property (nonatomic, copy, nullable) NSString *defaultSourceRepo;
@property (nonatomic, copy, nullable) NSString *defaultSourceChannel;
@property (nonatomic, strong, nullable) PluginErrorInfo *errorInfo;
@property (nonatomic, copy, nullable) NSArray<PluginErrorInfo *> *errors;
@property (nonatomic, copy, nullable) NSString *bundlePath;
@property (nonatomic, copy) NSArray<NSString *> *unsatisfiedOptionalDependencies;
@property (nonatomic, assign) BOOL isInternal;
@property (nonatomic, assign) BOOL isEssential;
@property (nonatomic, assign) BOOL isEnabledByDefault;
@property (nonatomic, assign) BOOL isApi;
@property (nonatomic, copy, nullable) NSString *scriptContent;

+ (instancetype)recordWithManifest:(nullable PluginManifest *)manifest;

- (BOOL)isEnabled;
- (BOOL)isPendingReload;
- (BOOL)wasStartedLate;
- (BOOL)isSessionSkip;
- (NSDictionary *)toJSPayloadWithScript:(BOOL)includeScript;

@end

@interface InternalPluginFactory : NSObject

@property (nonatomic, strong) id<Plugin> (^builder)(void);
@property (nonatomic, strong) PluginManifest *manifest;
@property (nonatomic, assign) BOOL internalFlag;
@property (nonatomic, assign) BOOL essentialFlag;
@property (nonatomic, assign) BOOL enabledByDefaultFlag;
@property (nonatomic, assign) BOOL apiFlag;

+ (instancetype)factoryWithManifest:(PluginManifest *)manifest
                              flags:(NSArray<NSString *> *)flags
                         startBlock:(id<Plugin> (^)(void))startBlock;

@end

@interface PluginLoader : NSObject

+ (instancetype)sharedLoader;

@property (nonatomic, copy, readonly) NSDictionary<NSString *, PluginRecord *> *records;

- (NSArray<PluginRecord *> *)listableRecords;

- (void)loadPlugins;
- (NSURL *)pluginsDirectory;
- (NSURL *)pluginStorageRoot;
- (NSURL *)storageDirectoryForPlugin:(NSString *)pluginId;

- (BOOL)isReservedPluginId:(NSString *)pluginId;

- (BOOL)isValidPluginId:(NSString *)pluginId;

- (void)addPluginFlags:(PluginFlag)flags forPlugin:(NSString *)pluginId;

- (BOOL)setEnabled:(NSString *)pluginId enabled:(BOOL)enabled requiredByUser:(BOOL)requiredByUser;
- (void)enablePlugin:(NSString *)pluginId requiredByUser:(BOOL)requiredByUser;
- (BOOL)disablePlugin:(NSString *)pluginId;
- (void)stopPlugin:(NSString *)pluginId;
- (void)stopNativePlugin:(NSString *)pluginId;

- (NSArray<NSDictionary *> *)dependencyProblemsForPlugin:(NSString *)pluginId;
- (void)clearPersistedState:(NSString *)pluginId;
- (void)uninstall:(NSString *)pluginId;
- (BOOL)isEssentialPlugin:(NSString *)pluginId;
- (void)addRecord:(PluginRecord *)record;
- (BOOL)startNative:(NSString *)pluginId;
- (void)presentFilePickerForInstall;

- (nullable PluginRecord *)readExternalPluginDir:(NSURL *)dir
                                   knownVersions:(NSDictionary<NSString *, PluginVersion *> *)knownVersions
                                           error:(NSString * _Nullable * _Nullable)error;

- (nullable PluginRecord *)extractPluginZipAtPath:(NSString *)zipPath
                                             root:(NSURL *)root
                                          tmpName:(NSString *)tmpName
                                            error:(PluginErrorInfo * _Nullable * _Nullable)error;

- (nullable NSURL *)applyStagedDirectory:(NSURL *)stagedDir forPluginId:(NSString *)pluginId;

- (void)setPendingUpdate:(NSString *)pluginId version:(NSString *)version;
- (nullable NSString *)pendingUpdateForPlugin:(NSString *)pluginId;

- (NSDictionary<NSString *, PluginVersion *> *)installedVersions;
- (NSDictionary<NSString *, NSDictionary<NSString *, PluginVersionRange *> *> *)installedDependencies;

- (void)registerLoaderMethods;

@end

NS_ASSUME_NONNULL_END
