const assert = require('assert');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
require('ts-node/register/transpile-only');
const {DisplayProfiles} = require('../src/server/goog-device/services/DisplayProfiles');
const {calculateDisplaySize, validateViewport} = require('../src/common/DisplayProfile');

class Device {
    constructor(udid, override, densityOverride) {
        this.udid = udid; this.override = override; this.densityOverride = densityOverride;
        this.commands = []; this.failNextResize = false;
    }
    async runShellCommandAdbKit(command) {
        this.commands.push(command);
        await new Promise(resolve => setImmediate(resolve));
        if (command === 'wm size') return 'Physical size: 1344x2992' + (this.override ? `\nOverride size: ${this.override.width}x${this.override.height}` : '');
        if (command === 'wm density') return 'Physical density: 480' + (this.densityOverride ? `\nOverride density: ${this.densityOverride}` : '');
        if (command.startsWith('wm size ')) {
            if (this.failNextResize) { this.failNextResize = false; return 'Error: rejected'; }
            const value = command.slice(8);
            this.override = value === 'reset' ? undefined : {width: +value.split('x')[0], height: +value.split('x')[1]};
            return '';
        }
        if (command.startsWith('wm density ')) {
            const value = command.slice(11);
            this.densityOverride = value === 'reset' ? undefined : +value;
            return '';
        }
        throw new Error(`Unexpected command: ${command}`);
    }
}

(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-display-profile-'));
    try {
        assert.deepStrictEqual(calculateDisplaySize(1344, {width:402,height:639}), {width:1344,height:2080});
        for (const input of [null, {}, {width:639,height:402}, {width:402,height:330}, {width:'402',height:639}, {width:NaN,height:639}]) {
            assert.throws(() => validateViewport(input));
        }
        const service = new DisplayProfiles(dir);
        const device = new Device('emulator-5554');
        let status = await service.adapt(device, {width:402,height:639});
        assert.deepStrictEqual(status.saved, {width:1344,height:2080});
        assert.strictEqual(status.current.density, 480);
        assert.strictEqual(device.commands.some(c => c.startsWith('wm density ')), false);
        const file = path.join(dir, (await fs.readdir(dir))[0]);
        assert.strictEqual((await fs.stat(file)).mode & 0o777, 0o600);
        const persisted = JSON.parse(await fs.readFile(file, 'utf8'));
        assert.strictEqual(persisted.original.override, undefined);
        assert.strictEqual(persisted.original.physical.height, 2992);

        // A new service/device connection restores the durable profile, without
        // issuing another resize if Android already has that override.
        device.override = undefined;
        const restarted = new DisplayProfiles(dir);
        await restarted.reapply(device);
        assert.deepStrictEqual(device.override, status.saved);
        device.commands.length = 0;
        await restarted.reapply(device);
        assert.strictEqual(device.commands.some(c => c.startsWith('wm size ')), false);

        // Multiple viewers cannot interleave display mutations for one device.
        const [first, second] = await Promise.all([
            service.adapt(device, {width:402,height:714}),
            service.adapt(device, {width:390,height:650}),
        ]);
        assert.notDeepStrictEqual(first.saved, second.saved);
        assert.deepStrictEqual((await service.status(device)).saved, second.saved);
        assert.deepStrictEqual(JSON.parse(await fs.readFile(file, 'utf8')).original, persisted.original);

        // Android rejection must leave both the current display and saved
        // default untouched, with an error rather than a false success.
        const before = {...device.override};
        device.failNextResize = true;
        await assert.rejects(service.adapt(device, {width:402,height:639}), /未应用/);
        assert.deepStrictEqual(device.override, before);
        assert.deepStrictEqual((await service.status(device)).saved, second.saved);

        // Failure to persist a new default rolls Android back too.
        const store = service.store.bind(service);
        service.store = async record => { if (record.saved?.height === 2080) throw new Error('disk full'); return store(record); };
        await assert.rejects(service.adapt(device, {width:402,height:639}), /disk full/);
        assert.deepStrictEqual(device.override, before);
        service.store = store;

        status = await service.restore(device);
        assert.strictEqual(status.current.override, undefined);
        assert.strictEqual(status.saved, undefined);
        assert.deepStrictEqual(await fs.readdir(dir), []);

        // Existing overrides (including DPI) are the baseline, not assumptions
        // about the emulator's physical defaults.
        const other = new Device('other/../device', {width:1080,height:2400}, 420);
        await service.adapt(other, {width:402,height:639});
        other.densityOverride = 400;
        status = await service.restore(other);
        assert.deepStrictEqual(status.current.override, {width:1080,height:2400});
        assert.strictEqual(status.current.densityOverride, 420);
        assert.strictEqual((await fs.readdir(dir)).length, 0);
        console.log('Display profiles: geometry, validation, persistence, reconnect, serialization, rollback and original overrides passed.');
    } finally { await fs.rm(dir, {recursive:true, force:true}); }
})().catch(error => { console.error(error); process.exitCode = 1; });
