#pragma once

#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>

#ifdef __cplusplus
extern "C" {
#endif

NSURL      *getValencedDirectory(void);
void        showErrorAlert(NSString *title, NSString *message, void (^completion)(void));
void        showRecoveryAlert(UIViewController *presenter);
void        RegisterRecoveryBridgeMethods(void);
void        reloadApp(UIViewController *viewController);
BOOL        isHermesBytecode(NSData *data);
NSData     *ValencedEmbeddedSection(const char *name);
dispatch_queue_t fsQueue(void);
BOOL        onFsQueue(void);
void        dispatchSyncFs(void (^block)(void));

NSMutableData *DataOutputBuffer(void);
void DataOutputWriteInt(NSMutableData *data, int value);
void DataOutputWriteBoolean(NSMutableData *data, BOOL value);
void DataOutputWriteUTF(NSMutableData *data, NSString *value);
NSData *DataInputSlice(NSData *data, NSUInteger *offset);
int DataInputReadInt(NSData *data, NSUInteger *offset);
BOOL DataInputReadBoolean(NSData *data, NSUInteger *offset);
NSString *DataInputReadUTF(NSData *data, NSUInteger *offset);

#ifdef __cplusplus
}
#endif
