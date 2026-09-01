import { ACTION } from '../../../common/Action';
import { ControlMessage } from '../../controlMessage/ControlMessage';
import { CommandControlMessage } from '../../controlMessage/CommandControlMessage';
import { KeyCodeControlMessage } from '../../controlMessage/KeyCodeControlMessage';
import { DisplayCombinedInfo } from '../../client/StreamReceiver';
import KeyEvent from '../android/KeyEvent';
import { KeyInputHandler } from '../KeyInputHandler';
import Util from '../../Util';
import { StreamReceiverScrcpy } from './StreamReceiverScrcpy';

type ParamsRemoteKeyboardScrcpy = {
    udid: string;
    ws?: string;
};

type PastedKey = {
    keycode: number;
    metaState?: number;
};

/**
 * Input-only client for secure dialogs that intentionally hide the video stream.
 * It forwards physical key events directly to the existing scrcpy WebSocket and
 * never reads or retains the contents of the password field.
 */
export class RemoteKeyboardClientScrcpy {
    public static readonly ACTION = ACTION.REMOTE_KEYBOARD;
    private readonly pressedKeys: Set<number> = new Set();
    private readonly streamReceiver: StreamReceiverScrcpy;
    private joinedStream = false;
    private input?: HTMLInputElement;
    private status?: HTMLElement;

    public static start(query: URLSearchParams): RemoteKeyboardClientScrcpy {
        if (query.get('action') !== RemoteKeyboardClientScrcpy.ACTION) {
            throw new Error('Incorrect action');
        }
        return new RemoteKeyboardClientScrcpy({
            udid: Util.parseString(query, 'udid', true),
            ws: Util.parseString(query, 'ws'),
        });
    }

    private constructor(private readonly params: ParamsRemoteKeyboardScrcpy) {
        this.createPage();
        this.streamReceiver = new StreamReceiverScrcpy({
            action: ACTION.STREAM_SCRCPY,
            player: 'remote-keyboard',
            udid: params.udid,
            ws: params.ws,
        });
        this.streamReceiver.on('connected', this.onSocketOpen);
        this.streamReceiver.on('disconnected', this.onSocketClose);
        this.streamReceiver.on('displayInfo', this.onDisplayInfo);
        window.addEventListener('blur', this.releasePressedKeys);
        window.addEventListener('pagehide', this.onPageHide);
    }

    private createPage(): void {
        document.body.replaceChildren();
        document.body.className = 'remote-keyboard';
        document.title = `External keyboard ${this.params.udid}`;

        const card = document.createElement('main');
        card.className = 'remote-keyboard-card';
        const title = document.createElement('h1');
        title.textContent = 'External keyboard';
        const help = document.createElement('p');
        help.textContent =
            'Click the field and type or paste from a physical keyboard. Each key is forwarded immediately; no text is retained on this page.';
        const input = document.createElement('input');
        input.className = 'remote-keyboard-input';
        input.type = 'password';
        input.placeholder = 'Click here, then type';
        input.autocomplete = 'off';
        input.autocapitalize = 'off';
        input.spellcheck = false;
        input.readOnly = true;
        input.setAttribute('aria-label', 'External keyboard input');
        input.addEventListener('keydown', this.onKeyboardEvent);
        input.addEventListener('keyup', this.onKeyboardEvent);
        input.addEventListener('paste', this.onPaste);
        const status = document.createElement('p');
        status.className = 'remote-keyboard-status';
        status.setAttribute('aria-live', 'polite');
        status.textContent = 'Connecting to device…';
        card.append(title, help, input, status);
        document.body.appendChild(card);
        this.input = input;
        this.status = status;
    }

    private onSocketOpen = (): void => {
        this.setStatus('Preparing device input…');
        this.input?.focus();
    };

    private onSocketClose = (): void => {
        this.setStatus('Connection closed. Reopen this page to reconnect.', true);
    };

    private onDisplayInfo = (infoArray: DisplayCombinedInfo[]): void => {
        if (this.joinedStream || !infoArray.length) {
            return;
        }
        const current = infoArray.find((item) => item.videoSettings)?.videoSettings;
        if (!current) {
            this.setStatus('Waiting for the active stream to finish connecting…');
            return;
        }
        this.joinedStream = true;
        this.streamReceiver.sendEvent(CommandControlMessage.createSetVideoSettingsCommand(current));
        this.setStatus('Connected. Click the field and type.');
    };

    private onKeyboardEvent = (event: KeyboardEvent): void => {
        event.preventDefault();
        // The browser emits this shortcut before the paste event. Forwarding
        // it would invoke Android's clipboard and duplicate the pasted text.
        if ((event.ctrlKey || event.metaKey) && event.code === 'KeyV') {
            this.releasePasteModifiers();
            return;
        }
        const message = KeyInputHandler.createControlMessage(event);
        if (!message) {
            this.setStatus('This key is not supported by Android input.', true);
            return;
        }
        if (message.action === KeyEvent.ACTION_DOWN) {
            this.pressedKeys.add(message.keycode);
        } else if (message.action === KeyEvent.ACTION_UP) {
            this.pressedKeys.delete(message.keycode);
        }
        this.send(message);
    };

    private onPaste = (event: ClipboardEvent): void => {
        event.preventDefault();
        const value = (event.clipboardData?.getData('text/plain') || '').replace(/\r\n/g, '\n');
        if (!value) {
            this.setStatus('Nothing to paste.');
            return;
        }
        let sent = 0;
        let unsupported = 0;
        for (const char of value) {
            const key = this.getPastedKey(char);
            if (!key) {
                unsupported++;
                continue;
            }
            const metaState = key.metaState || 0;
            this.send(new KeyCodeControlMessage(KeyEvent.ACTION_DOWN, key.keycode, 0, metaState));
            this.send(new KeyCodeControlMessage(KeyEvent.ACTION_UP, key.keycode, 0, metaState));
            sent++;
        }
        if (unsupported) {
            this.setStatus(`${sent} characters pasted; ${unsupported} unsupported characters were skipped.`, true);
        } else {
            this.setStatus(`${sent} characters pasted. No text was saved on this page.`);
        }
    };

    private getPastedKey(char: string): PastedKey | undefined {
        if (char >= 'a' && char <= 'z') {
            return { keycode: KeyEvent.KEYCODE_A + char.charCodeAt(0) - 'a'.charCodeAt(0) };
        }
        if (char >= 'A' && char <= 'Z') {
            return {
                keycode: KeyEvent.KEYCODE_A + char.charCodeAt(0) - 'A'.charCodeAt(0),
                metaState: KeyEvent.META_SHIFT_ON,
            };
        }
        if (char >= '0' && char <= '9') {
            return { keycode: KeyEvent.KEYCODE_0 + char.charCodeAt(0) - '0'.charCodeAt(0) };
        }
        const direct: Record<string, number> = {
            ' ': KeyEvent.KEYCODE_SPACE,
            '\n': KeyEvent.KEYCODE_ENTER,
            '\r': KeyEvent.KEYCODE_ENTER,
            '\t': KeyEvent.KEYCODE_TAB,
            '-': KeyEvent.KEYCODE_MINUS,
            '=': KeyEvent.KEYCODE_EQUALS,
            '[': KeyEvent.KEYCODE_LEFT_BRACKET,
            ']': KeyEvent.KEYCODE_RIGHT_BRACKET,
            '\\': KeyEvent.KEYCODE_BACKSLASH,
            ';': KeyEvent.KEYCODE_SEMICOLON,
            "'": KeyEvent.KEYCODE_APOSTROPHE,
            ',': KeyEvent.KEYCODE_COMMA,
            '.': KeyEvent.KEYCODE_PERIOD,
            '/': KeyEvent.KEYCODE_SLASH,
            '`': KeyEvent.KEYCODE_GRAVE,
        };
        if (typeof direct[char] === 'number') {
            return { keycode: direct[char] };
        }
        const shifted: Record<string, number> = {
            '!': KeyEvent.KEYCODE_1,
            '@': KeyEvent.KEYCODE_2,
            '#': KeyEvent.KEYCODE_3,
            $: KeyEvent.KEYCODE_4,
            '%': KeyEvent.KEYCODE_5,
            '^': KeyEvent.KEYCODE_6,
            '&': KeyEvent.KEYCODE_7,
            '*': KeyEvent.KEYCODE_8,
            '(': KeyEvent.KEYCODE_9,
            ')': KeyEvent.KEYCODE_0,
            _: KeyEvent.KEYCODE_MINUS,
            '+': KeyEvent.KEYCODE_EQUALS,
            '{': KeyEvent.KEYCODE_LEFT_BRACKET,
            '}': KeyEvent.KEYCODE_RIGHT_BRACKET,
            '|': KeyEvent.KEYCODE_BACKSLASH,
            ':': KeyEvent.KEYCODE_SEMICOLON,
            '"': KeyEvent.KEYCODE_APOSTROPHE,
            '<': KeyEvent.KEYCODE_COMMA,
            '>': KeyEvent.KEYCODE_PERIOD,
            '?': KeyEvent.KEYCODE_SLASH,
            '~': KeyEvent.KEYCODE_GRAVE,
        };
        if (typeof shifted[char] === 'number') {
            return { keycode: shifted[char], metaState: KeyEvent.META_SHIFT_ON };
        }
        return;
    }

    private releasePasteModifiers(): void {
        const modifierKeyCodes = [
            KeyEvent.KEYCODE_CTRL_LEFT,
            KeyEvent.KEYCODE_CTRL_RIGHT,
            KeyEvent.KEYCODE_META_LEFT,
            KeyEvent.KEYCODE_META_RIGHT,
        ];
        modifierKeyCodes.forEach((keycode) => {
            if (this.pressedKeys.delete(keycode)) {
                this.send(new KeyCodeControlMessage(KeyEvent.ACTION_UP, keycode, 0, 0));
            }
        });
    }

    private onPageHide = (): void => {
        this.releasePressedKeys();
        this.streamReceiver.stop();
    };

    private releasePressedKeys = (): void => {
        this.pressedKeys.forEach((keycode) => {
            this.send(new KeyCodeControlMessage(KeyEvent.ACTION_UP, keycode, 0, 0));
        });
        this.pressedKeys.clear();
    };

    private send(event: ControlMessage): void {
        this.streamReceiver.sendEvent(event);
    }

    private setStatus(message: string, error = false): void {
        if (!this.status) {
            return;
        }
        this.status.textContent = message;
        this.status.classList.toggle('error', error);
    }
}
