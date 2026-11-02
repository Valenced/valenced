#pragma once

#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

extern NSString *const VTHThemeBaseDark;
extern NSString *const VTHThemeBaseDarker;
extern NSString *const VTHThemeBaseLight;
extern NSString *const VTHThemeBaseMidnight;

#pragma mark - Model

@interface VTHRawColors : NSObject
@property (nonatomic, readonly) NSDictionary<NSString *, NSString *> *byName;
- (instancetype)initWithByName:(NSDictionary<NSString *, NSString *> *)byName;
@end

@interface VTHSemanticColors : NSObject

@property (nonatomic, readonly) NSDictionary<NSString *, NSDictionary<NSString *, NSString *> *> *byBase;
- (instancetype)initWithByBase:(NSDictionary<NSString *, NSDictionary<NSString *, NSString *> *> *)byBase;

- (nullable NSString *)hexForBase:(NSString *)base name:(NSString *)name;
@end

@interface VTHColorsSelection : NSObject
@property (nonatomic, readonly) NSString *plugin;
@property (nonatomic, readonly) NSString *group;
@property (nonatomic, readonly) NSString *theme;
@property (nonatomic, readonly) VTHSemanticColors *semantic;
@property (nonatomic, readonly) VTHRawColors *raw;
- (instancetype)initWithPlugin:(NSString *)plugin
                         group:(NSString *)group
                         theme:(NSString *)theme
                      semantic:(VTHSemanticColors *)semantic
                           raw:(VTHRawColors *)raw;
- (NSDictionary *)toJson;
@end

@interface VTHFontVariant : NSObject
@property (nonatomic, readonly) NSString *path;
@property (nonatomic, readonly) int weight;
@property (nonatomic, readonly) BOOL italic;
@property (nonatomic, readonly) NSDictionary<NSString *, NSNumber *> *axes;
- (instancetype)initWithPath:(NSString *)path
                      weight:(int)weight
                      italic:(BOOL)italic
                        axes:(NSDictionary<NSString *, NSNumber *> *)axes;
- (NSDictionary *)toJson;
@end

@interface VTHFontSource : NSObject
@property (nonatomic, readonly) NSString *plugin;
@property (nonatomic, readonly) NSString *group;
@property (nonatomic, readonly) NSString *pack;
@property (nonatomic, readonly) NSArray<VTHFontVariant *> *variants;
- (instancetype)initWithPlugin:(NSString *)plugin
                         group:(NSString *)group
                          pack:(NSString *)pack
                      variants:(NSArray<VTHFontVariant *> *)variants;
- (NSDictionary *)toJson;
@end

@interface VTHFontsSelection : NSObject
@property (nonatomic, readonly) NSDictionary<NSString *, VTHFontSource *> *sources;
- (instancetype)initWithSources:(NSDictionary<NSString *, VTHFontSource *> *)sources;
- (NSDictionary *)toJson;
@end

@interface VTHIconsSelection : NSObject
@property (nonatomic, readonly) NSString *plugin;
@property (nonatomic, readonly) NSString *group;
@property (nonatomic, readonly) NSString *pack;
@property (nonatomic, readonly) NSDictionary<NSString *, NSString *> *icons;
@property (nonatomic, readonly) NSDictionary<NSString *, NSString *> *drawables;
- (instancetype)initWithPlugin:(NSString *)plugin
                         group:(NSString *)group
                          pack:(NSString *)pack
                          icons:(NSDictionary<NSString *, NSString *> *)icons
                      drawables:(NSDictionary<NSString *, NSString *> *)drawables;
- (NSDictionary *)toJson;
@end

extern NSString *const VTHSystemEmojiFont;

@interface VTHEmojiSelection : NSObject
@property (nonatomic, readonly) NSString *plugin;
@property (nonatomic, readonly) NSString *group;
@property (nonatomic, readonly) NSString *pack;
@property (nonatomic, readonly, nullable) NSString *images;
@property (nonatomic, readonly, nullable) NSString *font;
- (instancetype)initWithPlugin:(NSString *)plugin
                         group:(NSString *)group
                          pack:(NSString *)pack
                        images:(nullable NSString *)images
                          font:(nullable NSString *)font;
- (NSDictionary *)toJson;
@end

@interface VTHThemesState : NSObject
@property (nonatomic, readonly) int format;
@property (nonatomic, readonly, nullable) VTHColorsSelection *colors;
@property (nonatomic, readonly, nullable) VTHFontsSelection *fonts;
@property (nonatomic, readonly, nullable) VTHIconsSelection *icons;
@property (nonatomic, readonly, nullable) VTHEmojiSelection *emoji;
- (instancetype)initWithFormat:(int)format
                        colors:(nullable VTHColorsSelection *)colors
                         fonts:(nullable VTHFontsSelection *)fonts
                         icons:(nullable VTHIconsSelection *)icons
                         emoji:(nullable VTHEmojiSelection *)emoji;
- (NSDictionary *)toJson;
@end

@interface VTHStateStore : NSObject
@property (nonatomic, readonly) VTHThemesState *state;
+ (instancetype)sharedStore;
- (VTHThemesState *)load;
- (VTHThemesState *)update:(VTHThemesState * (^)(VTHThemesState *state))transform;
@end

#pragma mark - Appliers

@interface VTHColorApplier : NSObject
+ (instancetype)sharedApplier;
- (void)apply:(nullable VTHColorsSelection *)selection;
@end

@interface VTHFontApplier : NSObject
+ (instancetype)sharedApplier;
- (void)apply:(nullable VTHFontsSelection *)selection;
- (void)registerPreviewFamily:(NSString *)name variants:(NSArray<VTHFontVariant *> *)variants;
@end

@interface VTHEmojiApplier : NSObject
+ (instancetype)sharedApplier;
- (void)apply:(nullable VTHEmojiSelection *)selection;
- (nullable NSString *)overridePathForAsset:(NSString *)assetName;
@end

#ifdef __cplusplus
extern "C" {
#endif

void RegisterThemesBridgeMethods(void);

void ThemesApplyAtBoot(void);

#ifdef __cplusplus
}
#endif

NSString *_Nullable VTHOptString(NSDictionary *_Nullable json, NSString *key);
NSString *VTHOptStringOrEmpty(NSDictionary *_Nullable json, NSString *key);
VTHColorsSelection *VTHColorsSelectionOf(NSDictionary *json);
VTHFontVariant *VTHFontVariantOf(NSDictionary *json);
VTHFontsSelection *VTHFontsSelectionOf(NSDictionary *json);
VTHIconsSelection *VTHIconsSelectionOf(NSDictionary *json);
VTHEmojiSelection *VTHEmojiSelectionOf(NSDictionary *json);

NS_ASSUME_NONNULL_END
