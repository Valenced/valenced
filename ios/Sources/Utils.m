#import "Utils.h"
#import "Constants.h"
#import "Bridge.h"
#import "Logger.h"
#import <objc/message.h>
#import <dlfcn.h>
#import <sys/utsname.h>

NSURL *getValencedDirectory(void) {
    NSFileManager *fm = [NSFileManager defaultManager];
    NSURL *docs = [[fm URLsForDirectory:NSDocumentDirectory inDomains:NSUserDomainMask] lastObject];
    NSURL *valenced = [docs URLByAppendingPathComponent:@"valenced"];
    if (![fm fileExistsAtPath:valenced.path]) {
        [fm createDirectoryAtURL:valenced withIntermediateDirectories:YES attributes:nil error:nil];
    }
    return valenced;
}

void showErrorAlert(NSString *title, NSString *message, void (^completion)(void)) {
    dispatch_async(dispatch_get_main_queue(), ^{
        UIAlertController *alert =
            [UIAlertController alertControllerWithTitle:title
                                                message:message
                                         preferredStyle:UIAlertControllerStyleAlert];

        UIAlertAction *okAction = [UIAlertAction actionWithTitle:@"OK"
                                                           style:UIAlertActionStyleDefault
                                                         handler:^(UIAlertAction *action) {
                                                             if (completion) {
                                                                 completion();
                                                             }
                                                         }];

        [alert addAction:okAction];

        UIWindow *window = nil;
        NSArray *windows = [[UIApplication sharedApplication] windows];
        for (UIWindow *w in windows) {
            if (w.isKeyWindow) {
                window = w;
                break;
            }
        }

        [window.rootViewController presentViewController:alert animated:YES completion:nil];
    });
}

void reloadApp(UIViewController *viewController) {
    dispatch_async(dispatch_get_main_queue(), ^{
        void (^finish)(void) = ^{
            UIApplication *app = [UIApplication sharedApplication];
            ((void (*)(id, SEL))objc_msgSend)(app, @selector(suspend));
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 0.5 * NSEC_PER_SEC),
                           dispatch_get_main_queue(), ^{ exit(0); });
        };

        if (viewController) {
            [viewController dismissViewControllerAnimated:NO completion:finish];
        } else {
            finish();
        }
    });
}

BOOL isHermesBytecode(NSData *data) {
    if (!data || data.length < 4) {
        return NO;
    }
    const uint8_t *bytes = (const uint8_t *) data.bytes;

    // hbc 98 :P
    if (bytes[0] == 0xC6 && bytes[1] == 0x1F && bytes[2] == 0xBC && bytes[3] == 0x03) {
        return YES;
    }

    // probably JS
    if (bytes[0] > 0x7F) {
        for (int i = 0; i < 4 && i < (int)data.length; i++) {
            if (bytes[i] == 0x00) return YES;
        }
    }
    return NO;
}

static UIViewController *topPresentableViewController(UIViewController *start) {
    UIViewController *host = start;
    if (!host) {
        for (UIWindow *w in [UIApplication sharedApplication].windows) {
            if (w.isKeyWindow) {
                host = w.rootViewController;
                break;
            }
        }
    }
    while (host.presentedViewController && !host.presentedViewController.isBeingDismissed) {
        host = host.presentedViewController;
    }
    return host;
}

static void presentRecoveryAlert(UIViewController *presenter) {
    UIAlertController *alert =
        [UIAlertController alertControllerWithTitle:@"Valenced Recovery Options"
                                            message:nil
                                     preferredStyle:UIAlertControllerStyleActionSheet];

    [alert addAction:[UIAlertAction actionWithTitle:@"Reload" style:UIAlertActionStyleDefault handler:^(UIAlertAction *action) {
        reloadApp(presenter);
    }]];

    [alert addAction:[UIAlertAction actionWithTitle:@"Enter Recovery Mode" style:UIAlertActionStyleDefault handler:^(UIAlertAction *action) {

        BridgeHandler getConstants = bridgeHandlers()[@"valenced.plugins.getConstants"];
        BridgeHandler setSlot = bridgeHandlers()[@"valenced.plugins.states.setActiveSlot"];

        NSString *errorMessage = nil;
        NSString *slot = nil;

        if (!getConstants || !setSlot) {
            errorMessage = @"Plugin system handlers not found";
        } else {
            NSDictionary *constantsResponse = getConstants(@[]);
            NSDictionary *constants = constantsResponse[@"result"];
            if ([constants isKindOfClass:[NSDictionary class]]) {
                slot = constants[@"defaultsOnlySlot"];
            }

            if (![slot isKindOfClass:[NSString class]] || slot.length == 0) {
                errorMessage = constantsResponse[@"error"] ?: @"Could not read defaultsOnlySlot";
            } else {
                NSDictionary *setResponse = setSlot(@[slot, @YES]);
                if (setResponse[@"error"]) errorMessage = setResponse[@"error"];
            }
        }

        if (errorMessage) {
            showErrorAlert(@"Valenced Recovery",
                           [NSString stringWithFormat:@"Failed to enter recovery mode: %@", errorMessage],
                           nil);
            return;
        }

        reloadApp(presenter);
    }]];

#ifdef DEBUG
    [alert addAction:[UIAlertAction actionWithTitle:@"Delete Downloaded Bundle" style:UIAlertActionStyleDefault handler:^(UIAlertAction *action) {

        NSURL *bundleFile = [[getValencedDirectory() URLByAppendingPathComponent:CACHE_DIR]
                             URLByAppendingPathComponent:MAIN_SCRIPT_FILE];
        [[NSFileManager defaultManager] removeItemAtURL:bundleFile error:nil];
        reloadApp(presenter);
    }]];

    [alert addAction:[UIAlertAction actionWithTitle:@"Reset Loader Config" style:UIAlertActionStyleDefault handler:^(UIAlertAction *action) {

        NSURL *configFile = [getValencedDirectory() URLByAppendingPathComponent:CONFIG_PATH];
        [[NSFileManager defaultManager] removeItemAtURL:configFile error:nil];
        reloadApp(presenter);
    }]];
#endif

    [alert addAction:[UIAlertAction actionWithTitle:@"Cancel" style:UIAlertActionStyleCancel handler:nil]];

    UIViewController *host = topPresentableViewController(presenter);
    if (!host || !host.view) return;

    UIPopoverPresentationController *popover = alert.popoverPresentationController;
    if (popover) {
        popover.sourceView = host.view;
        popover.sourceRect = CGRectMake(CGRectGetMidX(host.view.bounds),
                                        CGRectGetMidY(host.view.bounds), 0, 0);
        popover.permittedArrowDirections = 0;
    }

    [host presentViewController:alert animated:YES completion:nil];
}

void showRecoveryAlert(UIViewController *presenter) {
    dispatch_async(dispatch_get_main_queue(), ^{
        UIViewController *host = topPresentableViewController(presenter);

        if ([host isKindOfClass:[UIAlertController class]] && host.presentingViewController) {
            [host.presentingViewController dismissViewControllerAnimated:YES
                                                              completion:^{
                                                                  presentRecoveryAlert(presenter);
                                                              }];
            return;
        }

        UIViewController *dismissing = host.presentedViewController;
        if (dismissing.isBeingDismissed) {
            id<UIViewControllerTransitionCoordinator> coordinator = dismissing.transitionCoordinator;
            if (coordinator) {
                [coordinator animateAlongsideTransition:nil
                                             completion:^(id<UIViewControllerTransitionCoordinatorContext> context) {
                                                 presentRecoveryAlert(presenter);
                                             }];
                return;
            }
        }

        presentRecoveryAlert(presenter);
    });
}

void RegisterRecoveryBridgeMethods(void) {
    bridgeHandlers()[@"valenced.showRecoveryAlert"] = ^NSDictionary *(NSArray *args) {
        showRecoveryAlert(nil);
        return @{@"result": [NSNull null]};
    };

    bridgeHandlers()[@"valenced.alertError"] = ^NSDictionary *(NSArray *args) {
        if (![args.firstObject isKindOfClass:[NSString class]]) return @{@"error": @"Expected a string error argument"};
        if (args.count < 2 || ![args[1] isKindOfClass:[NSString class]]) return @{@"error": @"Expected a string version argument"};
        NSString *errorString = args[0];
        NSString *version = args[1];

        NSString *discordVersion = [[NSBundle mainBundle] objectForInfoDictionaryKey:@"CFBundleShortVersionString"] ?: @"";
        NSString *deviceModel = [UIDevice currentDevice].model;

        NSString *message = [NSString stringWithFormat:
                             @"Valenced: %@\nDiscord: %@\nDevice: %@\n\n\n%@",
                             version, discordVersion, deviceModel, errorString];

        dispatch_async(dispatch_get_main_queue(), ^{
            UIAlertController *alert = [UIAlertController alertControllerWithTitle:@"Valenced Error"
                                                                           message:message
                                                                    preferredStyle:UIAlertControllerStyleAlert];

            [alert addAction:[UIAlertAction actionWithTitle:@"OK" style:UIAlertActionStyleDefault handler:nil]];
            [alert addAction:[UIAlertAction actionWithTitle:@"Copy" style:UIAlertActionStyleDefault handler:^(UIAlertAction *action) {
                [UIPasteboard generalPasteboard].string = errorString;
            }]];
            [alert addAction:[UIAlertAction actionWithTitle:@"Recovery" style:UIAlertActionStyleDestructive handler:^(UIAlertAction *action) {
                showRecoveryAlert(nil);
            }]];

            UIViewController *host = nil;
            for (UIWindow *w in [UIApplication sharedApplication].windows) {
                if (w.isKeyWindow) { host = w.rootViewController; break; }
            }
            while (host.presentedViewController) host = host.presentedViewController;
            [host presentViewController:alert animated:YES completion:nil];
        });
        return @{@"result": [NSNull null]};
    };
}

static const char *const kFsQueueKey = "app.valenced.fsQueue.ctx";

dispatch_queue_t fsQueue(void) {
    static dispatch_queue_t queue;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        queue = dispatch_queue_create("app.valenced.fsQueue", DISPATCH_QUEUE_SERIAL);
        dispatch_queue_set_specific(queue, (void *)kFsQueueKey, (__bridge void *)queue, NULL);
    });
    return queue;
}

BOOL onFsQueue(void) {
    return dispatch_get_specific((void *)kFsQueueKey) != NULL;
}

void dispatchSyncFs(void (^block)(void)) {
    if (onFsQueue()) {
        block();
        return;
    }
    dispatch_sync(fsQueue(), block);
}

NSMutableData *DataOutputBuffer(void) {
    return [NSMutableData data];
}

void DataOutputWriteInt(NSMutableData *data, int value) {
    uint8_t bytes[4] = {
        (uint8_t)((value >> 24) & 0xFF),
        (uint8_t)((value >> 16) & 0xFF),
        (uint8_t)((value >> 8) & 0xFF),
        (uint8_t)(value & 0xFF),
    };
    [data appendBytes:bytes length:4];
}

void DataOutputWriteBoolean(NSMutableData *data, BOOL value) {
    uint8_t b = value ? 1 : 0;
    [data appendBytes:&b length:1];
}

void DataOutputWriteUTF(NSMutableData *data, NSString *value) {
    NSMutableData *encoded = [NSMutableData data];
    NSData *raw = [value dataUsingEncoding:NSUTF8StringEncoding];
    const uint8_t *bytes = raw.bytes;
    for (NSUInteger i = 0; i < raw.length; i++) {
        if (bytes[i] != 0) {
            [encoded appendBytes:bytes + i length:1];
        } else {
            const uint8_t c080[2] = {0xC0, 0x80};
            [encoded appendBytes:c080 length:2];
        }
    }
    uint8_t lenBytes[2] = { (uint8_t)((encoded.length >> 8) & 0xFF), (uint8_t)(encoded.length & 0xFF) };
    [data appendBytes:lenBytes length:2];
    [data appendData:encoded];
}

NSData *DataInputSlice(NSData *data, NSUInteger *offset) {
    return [data subdataWithRange:NSMakeRange(*offset, data.length - *offset)];
}

int DataInputReadInt(NSData *data, NSUInteger *offset) {
    if (data.length < *offset + 4) return 0;
    const uint8_t *bytes = (const uint8_t *)data.bytes + *offset;
    *offset += 4;
    return (int)(((uint32_t)bytes[0] << 24) | ((uint32_t)bytes[1] << 16) | ((uint32_t)bytes[2] << 8) | (uint32_t)bytes[3]);
}

BOOL DataInputReadBoolean(NSData *data, NSUInteger *offset) {
    if (data.length < *offset + 1) return NO;
    const uint8_t *bytes = (const uint8_t *)data.bytes + *offset;
    *offset += 1;
    return bytes[0] != 0;
}

NSString *DataInputReadUTF(NSData *data, NSUInteger *offset) {
    if (data.length < *offset + 2) return @"";
    const uint8_t *lenBytes = (const uint8_t *)data.bytes + *offset;
    NSUInteger length = ((NSUInteger)lenBytes[0] << 8) | lenBytes[1];
    *offset += 2;
    if (data.length < *offset + length) return @"";
    NSData *encoded = [data subdataWithRange:NSMakeRange(*offset, length)];
    *offset += length;
    NSMutableData *std = [NSMutableData dataWithData:encoded];
    NSUInteger i = 0;
    while (i + 1 < std.length) {
        if (((const uint8_t *)std.bytes)[i] == 0xC0 && ((const uint8_t *)std.bytes)[i + 1] == 0x80) {
            uint8_t nul = 0;
            NSRange range = NSMakeRange(i, 2);
            [std replaceBytesInRange:range withBytes:&nul length:1];
            i += 1;
        } else {
            i += 1;
        }
    }
    return [[NSString alloc] initWithData:std encoding:NSUTF8StringEncoding] ?: @"";
}
