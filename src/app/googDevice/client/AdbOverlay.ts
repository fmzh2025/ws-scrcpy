interface AdbOverlayStatus {
    enabled: boolean;
    udid: string;
    host: string;
    port: number;
    targetHost: string;
    targetPort: number;
    connectCommand: string;
    shellCommand: string;
}

interface AdbCommandResult {
    success: boolean;
    stdout?: string;
    stderr?: string;
    code?: number;
    output?: string;
    status?: AdbOverlayStatus;
}

export class AdbOverlay {
    private root?: HTMLElement;
    private statusBadge?: HTMLElement;
    private connectionInfo?: HTMLElement;
    private connectCommand?: HTMLElement;
    private shellCommand?: HTMLElement;
    private commandInput?: HTMLTextAreaElement;
    private executeButton?: HTMLButtonElement;
    private output?: HTMLElement;
    private status?: AdbOverlayStatus;

    public constructor(private readonly udid: string, private readonly anchor?: HTMLElement) {}

    public open(): void {
        if (this.root) {
            this.commandInput?.focus();
            return;
        }
        const root = document.createElement('div');
        root.className = 'adb-overlay';
        root.setAttribute('role', 'dialog');
        root.setAttribute('aria-modal', 'false');
        root.setAttribute('aria-label', 'ADB access');

        const card = document.createElement('section');
        card.className = 'adb-card';
        const header = document.createElement('div');
        header.className = 'adb-header';
        const title = document.createElement('h1');
        title.textContent = 'ADB access';
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'adb-close';
        close.textContent = 'Close';
        close.addEventListener('click', this.close);
        header.append(title, close);

        const device = document.createElement('p');
        device.className = 'adb-device';
        device.textContent = `Device: ${this.udid}`;
        const statusLine = document.createElement('div');
        statusLine.className = 'adb-status-line';
        const label = document.createElement('span');
        label.textContent = 'ADB TCP access';
        const badge = (this.statusBadge = document.createElement('strong'));
        badge.className = 'adb-status off';
        badge.textContent = 'OFF';
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'adb-action';
        toggle.textContent = 'Enable';
        toggle.addEventListener('click', () => void this.toggle(toggle));
        statusLine.append(label, badge, toggle);

        const info = (this.connectionInfo = document.createElement('div'));
        info.className = 'adb-connection-info';
        info.textContent = 'Loading connection information…';

        const commands = document.createElement('div');
        commands.className = 'adb-command-list';
        const connect = (this.connectCommand = document.createElement('code'));
        const shell = (this.shellCommand = document.createElement('code'));
        const connectCopy = this.createCopyButton(connect);
        const shellCopy = this.createCopyButton(shell);
        commands.append(this.wrapCommand('Connect', connect, connectCopy), this.wrapCommand('Shell', shell, shellCopy));

        const help = document.createElement('p');
        help.className = 'adb-help';
        help.textContent =
            'Paste an adb command below. It runs on the ws-scrcpy host and targets this emulator by default. A new external computer may need to approve the RSA authorization dialog once.';
        const input = (this.commandInput = document.createElement('textarea'));
        input.className = 'adb-command-input';
        input.rows = 3;
        input.placeholder = 'adb shell getprop ro.build.version.release';
        input.autocomplete = 'off';
        input.autocapitalize = 'off';
        input.spellcheck = false;
        input.setAttribute('aria-label', 'ADB command');
        const actions = document.createElement('div');
        actions.className = 'adb-actions';
        const execute = (this.executeButton = document.createElement('button'));
        execute.type = 'button';
        execute.className = 'adb-action adb-execute';
        execute.textContent = 'Execute';
        execute.disabled = true;
        execute.addEventListener('click', () => void this.execute());
        actions.appendChild(execute);
        const output = (this.output = document.createElement('pre'));
        output.className = 'adb-output';
        output.textContent = 'No command executed.';

        card.append(header, device, statusLine, info, commands, help, input, actions, output);
        root.appendChild(card);
        document.body.appendChild(root);
        this.root = root;
        window.addEventListener('resize', this.position);
        window.addEventListener('scroll', this.position, true);
        this.position();
        void this.refresh();
    }

    public release(): void {
        window.removeEventListener('resize', this.position);
        window.removeEventListener('scroll', this.position, true);
        this.root?.remove();
        this.root = undefined;
        this.statusBadge = undefined;
        this.connectionInfo = undefined;
        this.connectCommand = undefined;
        this.shellCommand = undefined;
        this.commandInput = undefined;
        this.executeButton = undefined;
        this.output = undefined;
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

    private async refresh(): Promise<void> {
        try {
            const response = await fetch(this.endpoint(`status?udid=${encodeURIComponent(this.udid)}`));
            const result = (await response.json().catch(() => ({}))) as AdbCommandResult;
            if (!response.ok || !result.status) {
                throw new Error(result.output || `Unable to read ADB status (${response.status})`);
            }
            this.applyStatus(result.status);
        } catch (error: unknown) {
            this.setOutput(error instanceof Error ? error.message : 'Unable to read ADB status', true);
        }
    }

    private async toggle(button: HTMLButtonElement): Promise<void> {
        const enabled = !this.status?.enabled;
        button.disabled = true;
        try {
            const response = await fetch(this.endpoint('toggle'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ udid: this.udid, enabled }),
            });
            const result = (await response.json().catch(() => ({}))) as AdbCommandResult;
            if (!response.ok || !result.status) {
                throw new Error(result.output || `Unable to change ADB status (${response.status})`);
            }
            this.applyStatus(result.status);
            this.setOutput(enabled ? 'ADB TCP access enabled.' : 'ADB TCP access disabled.');
        } catch (error: unknown) {
            this.setOutput(error instanceof Error ? error.message : 'Unable to change ADB status', true);
        } finally {
            button.disabled = false;
        }
    }

    private async execute(): Promise<void> {
        const command = this.commandInput?.value.trim();
        if (!command || !this.status?.enabled || !this.executeButton) {
            return;
        }
        this.executeButton.disabled = true;
        this.setOutput('Executing…');
        try {
            const response = await fetch(this.endpoint('command'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ udid: this.udid, command }),
            });
            const result = (await response.json().catch(() => ({}))) as AdbCommandResult;
            const output = [result.stdout, result.stderr].filter((value) => !!value).join('\n');
            const code = typeof result.code === 'number' ? `Exit code: ${result.code}` : '';
            this.setOutput([output || '(no output)', code].filter((value) => !!value).join('\n'), !result.success);
        } catch (error: unknown) {
            this.setOutput(error instanceof Error ? error.message : 'ADB command failed', true);
        } finally {
            this.executeButton.disabled = !this.status?.enabled;
        }
    }

    private applyStatus(status: AdbOverlayStatus): void {
        this.status = status;
        if (this.statusBadge) {
            this.statusBadge.textContent = status.enabled ? 'ON' : 'OFF';
            this.statusBadge.classList.toggle('on', status.enabled);
            this.statusBadge.classList.toggle('off', !status.enabled);
        }
        const toggle = this.root?.querySelector<HTMLButtonElement>('.adb-status-line .adb-action');
        if (toggle) {
            toggle.textContent = status.enabled ? 'Disable' : 'Enable';
        }
        if (this.connectionInfo) {
            this.connectionInfo.textContent = `${status.host}:${status.port} → ${status.targetHost}:${status.targetPort}`;
        }
        if (this.connectCommand) {
            this.connectCommand.textContent = status.connectCommand;
        }
        if (this.shellCommand) {
            this.shellCommand.textContent = status.shellCommand;
        }
        if (this.executeButton) {
            this.executeButton.disabled = !status.enabled;
        }
    }

    private createCopyButton(source: HTMLElement): HTMLButtonElement {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'adb-copy';
        button.textContent = 'Copy';
        button.addEventListener('click', () => void this.copy(source.textContent || '', button));
        return button;
    }

    private wrapCommand(label: string, command: HTMLElement, copy: HTMLButtonElement): HTMLElement {
        const row = document.createElement('div');
        row.className = 'adb-command-row';
        const name = document.createElement('span');
        name.textContent = label;
        row.append(name, command, copy);
        return row;
    }

    private async copy(value: string, button: HTMLButtonElement): Promise<void> {
        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(value);
            } else {
                const input = document.createElement('textarea');
                input.value = value;
                input.style.position = 'fixed';
                input.style.opacity = '0';
                document.body.appendChild(input);
                input.select();
                document.execCommand('copy');
                input.remove();
            }
            const old = button.textContent;
            button.textContent = 'Copied';
            window.setTimeout(() => {
                button.textContent = old;
            }, 1200);
        } catch (error: unknown) {
            this.setOutput(error instanceof Error ? error.message : 'Copy failed', true);
        }
    }

    private setOutput(message: string, error = false): void {
        if (!this.output) {
            return;
        }
        this.output.textContent = message;
        this.output.classList.toggle('error', error);
    }

    private endpoint(path: string): string {
        const pathname = window.location.pathname.endsWith('/')
            ? window.location.pathname
            : `${window.location.pathname}/`;
        return new URL(`${pathname}api/adb/${path}`, window.location.origin).toString();
    }
}
