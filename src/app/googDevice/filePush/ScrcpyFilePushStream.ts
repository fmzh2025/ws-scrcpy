import { FilePushStream } from './FilePushStream';
import { StreamReceiverScrcpy } from '../client/StreamReceiverScrcpy';
import DeviceMessage from '../DeviceMessage';
import { CommandControlMessage, FilePushState } from '../../controlMessage/CommandControlMessage';

export class ScrcpyFilePushStream extends FilePushStream {
    constructor(private readonly streamReceiver: StreamReceiverScrcpy) {
        super();
        streamReceiver.on('deviceMessage', this.onDeviceMessage);
    }
    public hasConnection(): boolean {
        return this.streamReceiver.hasConnection();
    }

    public isAllowedFile(): boolean {
        // Every dropped file is kept in the device Download directory after
        // transfer. APKs are installed by the server-side finalization step.
        return true;
    }

    public sendEventAppend({ id, chunk }: { id: number; chunk: Uint8Array }): void {
        const appendParams = { id, chunk, state: FilePushState.APPEND };
        this.streamReceiver.sendEvent(CommandControlMessage.createPushFileCommand(appendParams));
    }

    public sendEventFinish({ id }: { id: number }): void {
        const finishParams = { id, state: FilePushState.FINISH };
        this.streamReceiver.sendEvent(CommandControlMessage.createPushFileCommand(finishParams));
    }

    public sendEventNew({ id }: { id: number }): void {
        const newParams = { id, state: FilePushState.NEW };
        this.streamReceiver.sendEvent(CommandControlMessage.createPushFileCommand(newParams));
    }

    public sendEventStart({ id, fileName, fileSize }: { id: number; fileName: string; fileSize: number }): void {
        const startParams = { id, fileName, fileSize, state: FilePushState.START };
        this.streamReceiver.sendEvent(CommandControlMessage.createPushFileCommand(startParams));
    }

    public release(): void {
        this.streamReceiver.off('deviceMessage', this.onDeviceMessage);
    }

    onDeviceMessage = (ev: DeviceMessage): void => {
        if (ev.type !== DeviceMessage.TYPE_PUSH_RESPONSE) {
            return;
        }
        const stats = ev.getPushStats();
        this.emit('response', stats);
    };
}
