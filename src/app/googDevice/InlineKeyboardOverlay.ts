import { ControlMessage } from '../controlMessage/ControlMessage';
import { CommandControlMessage } from '../controlMessage/CommandControlMessage';
import { KeyCodeControlMessage } from '../controlMessage/KeyCodeControlMessage';
import KeyEvent from './android/KeyEvent';
import { KeyInputHandler } from './KeyInputHandler';

/**
 * Input overlay for the active stream. It uses the already-open scrcpy
 * control channel so opening it never steals the Android input focus or
 * waits for a second stream client to finish connecting.
 */
export class InlineKeyboardOverlay {
    private readonly pressedKeys = new Set<number>();
    private root?: HTMLElement;
    private input?: HTMLInputElement;
    private status?: HTMLElement;

    public constructor(
        private readonly send: (message: ControlMessage) => void,
        private readonly anchor?: HTMLElement,
    ) {}

    public open(): void {
        if (this.root) {
            this.input?.focus();
            return;
        }

        const root = document.createElement('div');
        root.className = 'inline-keyboard-overlay';
        root.setAttribute('role', 'dialog');
        root.setAttribute('aria-modal', 'false');
        root.setAttribute('aria-label', 'External keyboard input');

        const card = document.createElement('section');
        card.className = 'inline-keyboard-card';
        const title = document.createElement('h1');
        title.textContent = 'External keyboard';
        const close = document.createElement('button');
        close.className = 'inline-keyboard-close';
        close.type = 'button';
        close.textContent = 'Close';
        close.addEventListener('click', this.close);
        const help = document.createElement('p');
        help.textContent = 'Type or paste here. Keystrokes are sent to the focused field on the cloud phone.';
        const input = document.createElement('input');
        input.className = 'remote-keyboard-input';
        input.type = 'password';
        input.placeholder = 'Click here, then type or paste';
        input.autocomplete = 'off';
        input.autocapitalize = 'off';
        input.spellcheck = false;
        input.setAttribute('aria-label', 'External keyboard input');
        input.addEventListener('keydown', this.onKeyboardEvent);
        input.addEventListener('keyup', this.onKeyboardEvent);
        input.addEventListener('paste', this.onPaste);
        input.addEventListener('input', this.onInput);
        const status = document.createElement('p');
        status.className = 'remote-keyboard-status';
        status.setAttribute('aria-live', 'polite');
        status.textContent = 'Ready. The text is not saved on this page.';

        card.append(title, close, help, input, status);
        root.appendChild(card);
        document.body.appendChild(root);
        this.root = root;
        this.input = input;
        this.status = status;
        window.addEventListener('resize', this.position);
        window.addEventListener('scroll', this.position, true);
        this.position();
        input.focus();
    }

    public release(): void {
        this.releasePressedKeys();
        window.removeEventListener('resize', this.position);
        window.removeEventListener('scroll', this.position, true);
        if (this.root) {
            this.root.remove();
        }
        this.root = undefined;
        this.input = undefined;
        this.status = undefined;
    }

    private close = (): void => {
        this.release();
    };

    private position = (): void => {
        if (!this.root) {
            return;
        }
        const gap = 8;
        const margin = 8;
        const anchor = this.anchor;
        if (!anchor || !anchor.isConnected) {
            this.root.style.left = 'auto';
            this.root.style.top = `${margin}px`;
            this.root.style.right = `${margin}px`;
            return;
        }
        const anchorRect = anchor.getBoundingClientRect();
        const width = this.root.offsetWidth;
        const height = this.root.offsetHeight;
        let left = anchorRect.right + gap;
        if (left + width > window.innerWidth - margin) {
            left = anchorRect.left - width - gap;
        }
        left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));
        let top = anchorRect.top + (anchorRect.height - height) / 2;
        top = Math.max(margin, Math.min(top, window.innerHeight - height - margin));
        this.root.style.left = `${left}px`;
        this.root.style.top = `${top}px`;
        this.root.style.right = 'auto';
    };

    private onKeyboardEvent = (event: KeyboardEvent): void => {
        // macOS sends Meta before the V key. On Android, META is the Home
        // key, so forwarding it would leave Chrome for the launcher before
        // the paste event has a chance to run. Ctrl is likewise a desktop
        // shortcut modifier and is intentionally not sent from this overlay.
        if (
            event.key === 'Meta' ||
            event.key === 'Control' ||
            event.code === 'MetaLeft' ||
            event.code === 'MetaRight' ||
            event.code === 'ControlLeft' ||
            event.code === 'ControlRight'
        ) {
            event.stopPropagation();
            return;
        }
        // The browser emits the shortcut before the paste event. Do not
        // forward it, because Android's clipboard differs from the desktop's.
        // Do not prevent its default action: Safari and some embedded browsers
        // suppress the following paste event when Cmd/Ctrl+V is cancelled.
        if ((event.ctrlKey || event.metaKey) && event.code === 'KeyV') {
            event.stopPropagation();
            return;
        }
        event.preventDefault();
        event.stopPropagation();
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
        const value = (event.clipboardData?.getData('text/plain') || '').replace(/\r\n/g, '\n');
        if (!value) {
            // Let the browser insert the value so the input event below can
            // forward it on engines that hide clipboardData from this event.
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        this.forwardText(value);
    };

    private onInput = (): void => {
        const value = this.input?.value || '';
        if (!value || !this.input) {
            return;
        }
        this.input.value = '';
        this.forwardText(value.replace(/\r\n/g, '\n'));
    };

    public static forwardText(
        send: (message: ControlMessage) => void,
        value: string,
    ): { sent: number; unsupported: number } {
        // Clipboard messages retain all UTF-8 text. The server issues Android's
        // paste key only after the clipboard content has been accepted.
        send(CommandControlMessage.createSetClipboardCommand(value, true));
        return { sent: Array.from(value).length, unsupported: 0 };
    }

    private forwardText(value: string): void {
        const { sent, unsupported } = InlineKeyboardOverlay.forwardText(this.send, value);
        if (unsupported) {
            this.setStatus(`${sent} characters pasted; ${unsupported} unsupported characters were skipped.`, true);
        } else {
            this.setStatus(`${sent} characters pasted.`);
        }
    }

    private releasePressedKeys(): void {
        this.pressedKeys.forEach((keycode) => {
            this.send(new KeyCodeControlMessage(KeyEvent.ACTION_UP, keycode, 0, 0));
        });
        this.pressedKeys.clear();
    }

    private setStatus(message: string, error = false): void {
        if (!this.status) {
            return;
        }
        this.status.textContent = message;
        this.status.classList.toggle('error', error);
    }
}
