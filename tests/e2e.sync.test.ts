import { beforeEach, describe, expect, it } from 'vitest';
import { SyncService, type SyncStore } from '@/features/sync/service';
import { applyResolutions } from '@/core/resolve';
import { DEFAULT_SETTINGS } from '@/features/settings';
import type { DeviceInfo, Settings, SyncLogEntry, SyncState } from '@/core/types';
import { FakeBrowser } from './fakes/fake-browser';
import { FakeRemote, MemoryStore } from './fakes/fake-remote';

/**
 * 端到端仿真：两台设备 + 一个共享的"Gist"。
 *
 * 这里没有 chrome.*，也没有网络，全部跑在内存里，
 * 但走的代码路径和真实环境**完全一样**（同一个 SyncService）。
 */

interface Device {
  name: string;
  browser: FakeBrowser;
  store: MemoryStore;
  service: SyncService;
  state: Partial<SyncState>;
  logs: SyncLogEntry[];
}

let remote: FakeRemote;
const settings: Settings = { ...DEFAULT_SETTINGS, conflictPolicy: 'ask' };

function makeDevice(name: string, id: string): Device {
  const browser = new FakeBrowser();
  const store = new MemoryStore();
  const device: DeviceInfo = { deviceId: id, deviceName: name };
  const holder: Device = {
    name,
    browser,
    store,
    state: {},
    logs: [],
    service: null as unknown as SyncService,
  };
  holder.service = new SyncService({
    adapter: browser,
    remote,
    store: store as SyncStore,
    device,
    settings: async () => settings,
    hooks: {
      onState: (patch) => {
        holder.state = { ...holder.state, ...patch };
      },
      onLog: (entry) => {
        holder.logs.push(entry);
      },
    },
  });
  return holder;
}

beforeEach(() => {
  remote = new FakeRemote({ deviceId: 'seed', deviceName: 'seed' });
});

describe('端到端：首次同步', () => {
  it('A 上传后，B 首次同步不会把同一本书签变成两份', async () => {
    const a = makeDevice('设备A', 'dev-a');
    const b = makeDevice('设备B', 'dev-b');
    a.browser.addBookmark(a.browser.barId, 'GitHub', 'https://github.com');
    b.browser.addBookmark(b.browser.barId, 'GitHub', 'https://github.com');

    await a.service.run('merge');
    expect(remote.titles()).toEqual(['GitHub']);

    const outcome = await b.service.run('merge');
    expect(outcome.ok).toBe(true);
    expect(b.browser.countByUrl('https://github.com')).toBe(1);
    expect(remote.titles()).toEqual(['GitHub']);
  });

  it('两端各有不同的书签 → 合并后两边都有', async () => {
    const a = makeDevice('设备A', 'dev-a');
    const b = makeDevice('设备B', 'dev-b');
    a.browser.addBookmark(a.browser.barId, 'A 的书签', 'https://a.com');
    b.browser.addBookmark(b.browser.barId, 'B 的书签', 'https://b.com');

    await a.service.run('merge');
    await b.service.run('merge');
    await a.service.run('merge');

    expect(a.browser.countByUrl('https://b.com')).toBe(1);
    expect(b.browser.countByUrl('https://a.com')).toBe(1);
    expect(remote.titles()).toEqual(['A 的书签', 'B 的书签']);
  });

  it('文件夹层级和顺序都能对上', async () => {
    const a = makeDevice('设备A', 'dev-a');
    const b = makeDevice('设备B', 'dev-b');
    const dev = a.browser.addFolder(a.browser.barId, '开发');
    a.browser.addBookmark(dev, 'GitHub', 'https://github.com');
    a.browser.addBookmark(dev, 'MDN', 'https://developer.mozilla.org');

    await a.service.run('merge');
    await b.service.run('merge');

    const devId = b.browser.findIdByTitle(b.browser.barId, '开发');
    expect(devId).toBeTruthy();
    expect(b.browser.titlesOf(devId!)).toEqual(['GitHub', 'MDN']);
  });
});

describe('端到端：改动传播', () => {
  async function pair(): Promise<[Device, Device]> {
    const a = makeDevice('设备A', 'dev-a');
    const b = makeDevice('设备B', 'dev-b');
    a.browser.addBookmark(a.browser.barId, 'GitHub', 'https://github.com');
    await a.service.run('merge');
    await b.service.run('merge');
    return [a, b];
  }

  it('A 新增 → B 同步后也有', async () => {
    const [a, b] = await pair();
    a.browser.addBookmark(a.browser.barId, '新站点', 'https://new.com');

    await a.service.run('merge');
    await b.service.run('merge');

    expect(b.browser.countByUrl('https://new.com')).toBe(1);
  });

  it('A 删除 → B 同步后也没了（删除会真正传播）', async () => {
    const [a, b] = await pair();
    const id = a.browser.findByUrl('https://github.com')[0]!.id;
    await a.browser.remove(id);

    await a.service.run('merge');
    expect(remote.titles()).toEqual([]);

    await b.service.run('merge');
    expect(b.browser.countByUrl('https://github.com')).toBe(0);
  });

  it('A 改标题 → B 同步后标题同步', async () => {
    const [a, b] = await pair();
    const node = a.browser.findByUrl('https://github.com')[0]!;
    await a.browser.update(node.id, { title: 'GitHub 首页' });

    await a.service.run('merge');
    await b.service.run('merge');

    expect(b.browser.findByUrl('https://github.com')[0]!.title).toBe('GitHub 首页');
  });

  it('A 把书签移到别的文件夹 → B 也移动', async () => {
    const [a, b] = await pair();
    const dev = a.browser.addFolder(a.browser.barId, '开发');
    const node = a.browser.findByUrl('https://github.com')[0]!;
    await a.browser.move(node.id, { parentId: dev, index: 0 });

    await a.service.run('merge');
    await b.service.run('merge');

    const devId = b.browser.findIdByTitle(b.browser.barId, '开发');
    expect(b.browser.titlesOf(devId!)).toEqual(['GitHub']);
  });

  it('A 调整顺序 → B 顺序跟着变', async () => {
    const [a, b] = await pair();
    a.browser.addBookmark(a.browser.barId, '第二个', 'https://second.com');
    await a.service.run('merge');
    await b.service.run('merge');

    // A 把第二条移到最前面
    const second = a.browser.findByUrl('https://second.com')[0]!;
    await a.browser.move(second.id, { parentId: a.browser.barId, index: 0 });
    await a.service.run('merge');
    await b.service.run('merge');

    expect(b.browser.titlesOf(b.browser.barId)).toEqual(['第二个', 'GitHub']);
  });

  it('没有改动时不会重复上传（省接口次数）', async () => {
    const [, b] = await pair();
    const before = remote.writes;
    await b.service.run('merge');
    expect(remote.writes).toBe(before);
  });
});

describe('端到端：冲突', () => {
  it('两边改了同一条的标题 → 同步暂停，本地不被动过', async () => {
    const a = makeDevice('设备A', 'dev-a');
    const b = makeDevice('设备B', 'dev-b');
    a.browser.addBookmark(a.browser.barId, 'GitHub', 'https://github.com');
    await a.service.run('merge');
    await b.service.run('merge');

    // A 先改并上传
    await a.browser.update(a.browser.findByUrl('https://github.com')[0]!.id, { title: 'A 版标题' });
    await a.service.run('merge');

    // B 也改成不一样的内容
    await b.browser.update(b.browser.findByUrl('https://github.com')[0]!.id, { title: 'B 版标题' });
    const outcome = await b.service.run('merge');

    expect(outcome.conflictCount).toBe(1);
    expect(b.state.status).toBe('conflict');
    expect(b.store.pending).not.toBeNull();
    // 冲突未解决前，本地保持原样
    expect(b.browser.findByUrl('https://github.com')[0]!.title).toBe('B 版标题');
  });

  it('用户选择"保留本地" → 本地不变，远端被覆盖成本地版本', async () => {
    const a = makeDevice('设备A', 'dev-a');
    const b = makeDevice('设备B', 'dev-b');
    a.browser.addBookmark(a.browser.barId, 'GitHub', 'https://github.com');
    await a.service.run('merge');
    await b.service.run('merge');
    await a.browser.update(a.browser.findByUrl('https://github.com')[0]!.id, { title: 'A 版标题' });
    await a.service.run('merge');
    await b.browser.update(b.browser.findByUrl('https://github.com')[0]!.id, { title: 'B 版标题' });
    await b.service.run('merge');

    const pending = b.store.pending!;
    const resolutions = Object.fromEntries(pending.conflicts.map((c) => [c.id, 'local' as const]));
    await b.service.resolveConflicts(resolutions);

    expect(b.browser.findByUrl('https://github.com')[0]!.title).toBe('B 版标题');
    expect(remote.titles()).toEqual(['B 版标题']);
    expect(b.store.pending).toBeNull();
    expect(b.state.status).toBe('idle');
  });

  it('用户选择"使用远端" → 本地被远端版本覆盖', async () => {
    const a = makeDevice('设备A', 'dev-a');
    const b = makeDevice('设备B', 'dev-b');
    a.browser.addBookmark(a.browser.barId, 'GitHub', 'https://github.com');
    await a.service.run('merge');
    await b.service.run('merge');
    await a.browser.update(a.browser.findByUrl('https://github.com')[0]!.id, { title: 'A 版标题' });
    await a.service.run('merge');
    await b.browser.update(b.browser.findByUrl('https://github.com')[0]!.id, { title: 'B 版标题' });
    await b.service.run('merge');

    const pending = b.store.pending!;
    const resolutions = Object.fromEntries(pending.conflicts.map((c) => [c.id, 'remote' as const]));
    await b.service.resolveConflicts(resolutions);

    expect(b.browser.findByUrl('https://github.com')[0]!.title).toBe('A 版标题');
  });

  it('"两者都留" → 生成一份副本，两条都在', async () => {
    const a = makeDevice('设备A', 'dev-a');
    const b = makeDevice('设备B', 'dev-b');
    a.browser.addBookmark(a.browser.barId, 'GitHub', 'https://github.com');
    await a.service.run('merge');
    await b.service.run('merge');
    await a.browser.update(a.browser.findByUrl('https://github.com')[0]!.id, { title: 'A 版标题' });
    await a.service.run('merge');
    await b.browser.update(b.browser.findByUrl('https://github.com')[0]!.id, { title: 'B 版标题' });
    await b.service.run('merge');

    const pending = b.store.pending!;
    const resolutions = Object.fromEntries(pending.conflicts.map((c) => [c.id, 'both' as const]));
    await b.service.resolveConflicts(resolutions);

    expect(b.browser.countByUrl('https://github.com')).toBe(2);
  });

  it('等待处理期间本地又变了 → 拒绝应用，避免覆盖新改动', async () => {
    const a = makeDevice('设备A', 'dev-a');
    const b = makeDevice('设备B', 'dev-b');
    a.browser.addBookmark(a.browser.barId, 'GitHub', 'https://github.com');
    await a.service.run('merge');
    await b.service.run('merge');
    await a.browser.update(a.browser.findByUrl('https://github.com')[0]!.id, { title: 'A 版标题' });
    await a.service.run('merge');
    await b.browser.update(b.browser.findByUrl('https://github.com')[0]!.id, { title: 'B 版标题' });
    await b.service.run('merge');

    // 用户在冲突界面还没点，就又加了一本书签
    b.browser.addBookmark(b.browser.barId, '新加的', 'https://later.com');

    const pending = b.store.pending!;
    const resolutions = Object.fromEntries(pending.conflicts.map((c) => [c.id, 'local' as const]));
    await expect(b.service.resolveConflicts(resolutions)).rejects.toThrow(/变化了/);
    // 新加的书签没有被覆盖掉
    expect(b.browser.countByUrl('https://later.com')).toBe(1);
  });

  it('删除 vs 修改：默认保留被修改的那一份', async () => {
    const a = makeDevice('设备A', 'dev-a');
    const b = makeDevice('设备B', 'dev-b');
    a.browser.addBookmark(a.browser.barId, 'GitHub', 'https://github.com');
    await a.service.run('merge');
    await b.service.run('merge');

    // A 删除并上传
    await a.browser.remove(a.browser.findByUrl('https://github.com')[0]!.id);
    await a.service.run('merge');
    // B 改成别的标题
    await b.browser.update(b.browser.findByUrl('https://github.com')[0]!.id, { title: '我改过了' });

    const outcome = await b.service.run('merge');
    expect(outcome.conflictCount).toBe(1);
    expect(b.store.pending!.conflicts[0]!.kind).toBe('delete-modify');
    // 合并结果默认保住"被修改的那一份"，不会静默删掉
    expect(b.store.pending!.merged.some((entry) => entry.title === '我改过了')).toBe(true);
  });

  it('冲突策略设成"本地优先"时不会暂停，直接采用本地', async () => {
    const preferLocal: Settings = { ...DEFAULT_SETTINGS, conflictPolicy: 'prefer-local' };
    const a = makeDevice('设备A', 'dev-a');
    const b = makeDevice('设备B', 'dev-b');
    a.browser.addBookmark(a.browser.barId, 'GitHub', 'https://github.com');
    await a.service.run('merge');
    await b.service.run('merge');
    await a.browser.update(a.browser.findByUrl('https://github.com')[0]!.id, { title: 'A 版标题' });
    await a.service.run('merge');
    await b.browser.update(b.browser.findByUrl('https://github.com')[0]!.id, { title: 'B 版标题' });

    // 临时把设置换成 prefer-local
    const original = { ...settings };
    Object.assign(settings, preferLocal);
    try {
      const outcome = await b.service.run('merge');
      expect(outcome.conflictCount).toBe(1); // 仍然记录了冲突
      expect(b.store.pending).toBeNull(); // 但不暂停
      expect(b.browser.findByUrl('https://github.com')[0]!.title).toBe('B 版标题');
    } finally {
      Object.assign(settings, original);
    }
  });
});

describe('端到端：危险操作的保护', () => {
  it('远端有未合并的新内容时，上传会先要求确认', async () => {
    const a = makeDevice('设备A', 'dev-a');
    const b = makeDevice('设备B', 'dev-b');
    a.browser.addBookmark(a.browser.barId, 'GitHub', 'https://github.com');
    await a.service.run('merge');
    await b.service.run('merge');

    // A 又加了一条，B 还不知道
    a.browser.addBookmark(a.browser.barId, 'A 的新书签', 'https://a-new.com');
    await a.service.run('merge');

    const warning = await b.service.run('push');
    expect(warning.needsConfirm).toBe('overwrite-remote');
    expect(remote.titles()).toContain('A 的新书签');

    // 用户确认之后才真的覆盖
    const forced = await b.service.run('push', true);
    expect(forced.needsConfirm).toBeNull();
    expect(remote.titles()).not.toContain('A 的新书签');
  });

  it('本地有未同步的改动时，下载会先要求确认', async () => {
    const a = makeDevice('设备A', 'dev-a');
    const b = makeDevice('设备B', 'dev-b');
    a.browser.addBookmark(a.browser.barId, 'GitHub', 'https://github.com');
    await a.service.run('merge');
    await b.service.run('merge');

    b.browser.addBookmark(b.browser.barId, 'B 本地新加的', 'https://b-local.com');

    const warning = await b.service.run('pull');
    expect(warning.needsConfirm).toBe('overwrite-local');
    expect(b.browser.countByUrl('https://b-local.com')).toBe(1);

    await b.service.run('pull', true);
    expect(b.browser.countByUrl('https://b-local.com')).toBe(0);
    expect(b.browser.countByUrl('https://github.com')).toBe(1);
  });

  it('覆盖前会留下备份，可以回滚', async () => {
    const a = makeDevice('设备A', 'dev-a');
    a.browser.addBookmark(a.browser.barId, '要保住的', 'https://keep.com');
    await a.service.run('merge');
    await a.service.run('pull', true); // 强制用远端覆盖本地

    expect(a.store.backups.local).toBeTruthy();
    const counts = await a.service.rollback('local');
    expect(counts.removed).toBeGreaterThanOrEqual(0);
    expect(a.browser.countByUrl('https://keep.com')).toBe(1);
  });

  it('同一时间只能跑一个同步', async () => {
    const a = makeDevice('设备A', 'dev-a');
    a.browser.addBookmark(a.browser.barId, 'GitHub', 'https://github.com');
    const first = a.service.run('merge');
    await expect(a.service.run('merge')).rejects.toThrow(/还没有结束/);
    await first;
  });

  it('接口出错时状态会被标成错误，并记进历史', async () => {
    const a = makeDevice('设备A', 'dev-a');
    a.browser.addBookmark(a.browser.barId, 'GitHub', 'https://github.com');
    remote.failNextWith = new Error('网络炸了');

    await expect(a.service.run('merge')).rejects.toThrow('网络炸了');
    expect(a.state.status).toBe('error');
    expect(a.state.lastError).toBe('网络炸了');
    expect(a.logs.at(-1)?.ok).toBe(false);
  });
});

describe('端到端：本地数据管理', () => {
  it('能找出重复书签并清理', async () => {
    const a = makeDevice('设备A', 'dev-a');
    a.browser.addBookmark(a.browser.barId, 'A', 'https://dup.com/');
    a.browser.addBookmark(a.browser.otherId, 'B', 'https://dup.com');

    const duplicates = await a.service.listDuplicates();
    expect(duplicates).toHaveLength(1);

    const removed = await a.service.removeDuplicates(duplicates[0]!.uids.slice(1));
    expect(removed).toBe(1);
    expect(a.browser.countByUrl('https://dup.com/') + a.browser.countByUrl('https://dup.com')).toBe(1);
  });

  it('导出再导入不会丢失结构', async () => {
    const a = makeDevice('设备A', 'dev-a');
    const dev = a.browser.addFolder(a.browser.barId, '开发');
    a.browser.addBookmark(dev, 'GitHub', 'https://github.com');

    const exported = await a.service.exportSnapshot();
    expect(exported.filename).toMatch(/^cloudbookmark-.*\.json$/);

    const b = makeDevice('设备B', 'dev-b');
    await b.service.importSnapshot(exported.json, 'replace');

    const devId = b.browser.findIdByTitle(b.browser.barId, '开发');
    expect(devId).toBeTruthy();
    expect(b.browser.titlesOf(devId!)).toEqual(['GitHub']);
  });
});

describe('端到端：多设备来回', () => {
  it('三轮交替同步后三台设备内容一致', async () => {
    const a = makeDevice('设备A', 'dev-a');
    const b = makeDevice('设备B', 'dev-b');
    const c = makeDevice('设备C', 'dev-c');

    a.browser.addBookmark(a.browser.barId, '一号', 'https://one.com');
    await a.service.run('merge');

    b.browser.addBookmark(b.browser.otherId, '二号', 'https://two.com');
    await b.service.run('merge');

    c.browser.addBookmark(c.browser.barId, '三号', 'https://three.com');
    await c.service.run('merge');

    for (const device of [a, b, c, a, b, c]) {
      await device.service.run('merge');
    }

    for (const device of [a, b, c]) {
      expect(device.browser.countByUrl('https://one.com')).toBe(1);
      expect(device.browser.countByUrl('https://two.com')).toBe(1);
      expect(device.browser.countByUrl('https://three.com')).toBe(1);
    }
    expect(remote.titles()).toEqual(['一号', '三号', '二号']);
  });

  it('冲突解决后其他设备也能拿到结果', async () => {
    const a = makeDevice('设备A', 'dev-a');
    const b = makeDevice('设备B', 'dev-b');
    a.browser.addBookmark(a.browser.barId, 'GitHub', 'https://github.com');
    await a.service.run('merge');
    await b.service.run('merge');

    await a.browser.update(a.browser.findByUrl('https://github.com')[0]!.id, { title: 'A 版' });
    await a.service.run('merge');
    await b.browser.update(b.browser.findByUrl('https://github.com')[0]!.id, { title: 'B 版' });
    await b.service.run('merge');

    const pending = b.store.pending!;
    await b.service.resolveConflicts(
      Object.fromEntries(pending.conflicts.map((conflict) => [conflict.id, 'local' as const])),
    );
    await a.service.run('merge');

    expect(a.browser.findByUrl('https://github.com')[0]!.title).toBe('B 版');
  });
});

describe('冲突解析工具', () => {
  it('applyResolutions 对空冲突表是安全的', () => {
    expect(applyResolutions([], [], {}).entries).toEqual([]);
  });
});
