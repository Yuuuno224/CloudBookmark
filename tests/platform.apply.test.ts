import { describe, expect, it } from 'vitest';
import { applySnapshot, type ApplyResult } from '@/platform/apply';
import { readLocalSnapshot, uidMapFromView, type LocalView, type UidMap } from '@/platform/uid-map';
import { repairHierarchy } from '@/core/entries';
import type { DeviceInfo, Entry } from '@/core/types';
import { FakeBrowser } from './fakes/fake-browser';

const device: DeviceInfo = { deviceId: 'dev-a', deviceName: '测试设备' };

/**
 * 读一次本地并立刻保存身份表 —— 和真实代码里的做法一致。
 * 身份表必须保存，否则下次读会给新节点重新生成 uid，"同一条书签"就对不上了。
 */
async function readView(browser: FakeBrowser, uidMap: UidMap = {}): Promise<LocalView> {
  return readLocalSnapshot(await browser.readAll(), uidMap, device);
}

/** 完成一次"读 → 写回"，返回写回后的状态，供下一步继续。 */
async function sync(browser: FakeBrowser, uidMap: UidMap, mutate?: (entries: Entry[], view: LocalView) => Entry[]): Promise<{ view: LocalView; result: ApplyResult }> {
  const view = await readView(browser, uidMap);
  const target = mutate ? mutate(view.snapshot.entries, view) : view.snapshot.entries;
  const result = await applySnapshot(browser, repairHierarchy(target).entries, view);
  return { view, result };
}

/** 把 target 里的某条记录取出来改一改，模拟"合并结果"。 */
function patch(entries: Entry[], uid: string, changes: Partial<Entry>): Entry[] {
  return entries.map((entry) => (entry.uid === uid ? { ...entry, ...changes } : entry));
}

function uidOf(view: LocalView, predicate: (entry: Entry) => boolean): string {
  const found = view.snapshot.entries.find(predicate);
  if (!found) throw new Error('测试数据里找不到目标记录');
  return found.uid;
}

describe('写回浏览器：基本操作', () => {
  it('第一次写回会把身份表建起来，且不改变浏览器内容', async () => {
    const browser = new FakeBrowser();
    browser.addBookmark(browser.barId, 'GitHub', 'https://github.com');

    const { result } = await sync(browser, {});

    expect(browser.titlesOf(browser.barId)).toEqual(['GitHub']);
    expect(Object.keys(result.uidMap)).toHaveLength(3); // 2 个根 + 1 条书签
    expect(result.counts).toEqual({ added: 0, updated: 0, moved: 0, removed: 0 });
  });

  it('目标里多出一条 → 会被创建到正确的文件夹', async () => {
    const browser = new FakeBrowser();
    const devId = browser.addFolder(browser.barId, '开发');
    const first = await sync(browser, {});
    const devUid = uidOf(first.view, (entry) => entry.title === '开发');

    const { result } = await sync(browser, first.result.uidMap, (entries) => [
      ...entries,
      {
        uid: 'new-1',
        parentUid: devUid,
        index: 0,
        kind: 'bookmark',
        title: 'MDN',
        url: 'https://developer.mozilla.org',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      },
    ]);

    expect(browser.titlesOf(devId)).toEqual(['MDN']);
    expect(result.counts.added).toBe(1);
  });

  it('标题和网址会被更新', async () => {
    const browser = new FakeBrowser();
    browser.addBookmark(browser.barId, 'GitHub', 'https://github.com');
    const first = await sync(browser, {});

    const { result } = await sync(browser, first.result.uidMap, (entries, view) =>
      patch(entries, uidOf(view, (entry) => entry.kind === 'bookmark'), {
        title: 'GitHub 首页',
        url: 'https://github.com/dashboard',
      }),
    );

    const node = browser.findByUrl('https://github.com/dashboard')[0]!;
    expect(node.title).toBe('GitHub 首页');
    expect(result.counts.updated).toBe(1);
  });

  it('换文件夹会被移动过去', async () => {
    const browser = new FakeBrowser();
    const dev = browser.addFolder(browser.barId, '开发');
    browser.addBookmark(browser.barId, 'GitHub', 'https://github.com');
    const first = await sync(browser, {});

    await sync(browser, first.result.uidMap, (entries, view) =>
      patch(entries, uidOf(view, (entry) => entry.kind === 'bookmark'), {
        parentUid: uidOf(view, (entry) => entry.title === '开发'),
        index: 0,
      }),
    );

    expect(browser.titlesOf(browser.barId)).toEqual(['开发']);
    expect(browser.titlesOf(dev)).toEqual(['GitHub']);
  });

  it('目标里没有的节点会被删除（文件夹连内容一起删）', async () => {
    const browser = new FakeBrowser();
    const dev = browser.addFolder(browser.barId, '开发');
    browser.addBookmark(dev, 'GitHub', 'https://github.com');
    browser.addBookmark(browser.barId, '保留', 'https://keep.com');
    const first = await sync(browser, {});

    const { result } = await sync(browser, first.result.uidMap, (entries, view) => {
      const devUid = uidOf(view, (entry) => entry.title === '开发');
      const childUid = uidOf(view, (entry) => entry.kind === 'bookmark' && entry.parentUid === devUid);
      return entries.filter((entry) => entry.uid !== devUid && entry.uid !== childUid);
    });

    expect(browser.titlesOf(browser.barId)).toEqual(['保留']);
    expect(browser.countByUrl('https://github.com')).toBe(0);
    expect(result.counts.removed).toBe(2); // 文件夹 + 里面的书签
  });

  it('只删文件夹、却把里面的书签留在目标里 → 书签被救到其他书签下（不丢数据）', async () => {
    const browser = new FakeBrowser();
    const dev = browser.addFolder(browser.barId, '开发');
    browser.addBookmark(dev, 'GitHub', 'https://github.com');
    const first = await sync(browser, {});

    await sync(browser, first.result.uidMap, (entries, view) => {
      const devUid = uidOf(view, (entry) => entry.title === '开发');
      return entries.filter((entry) => entry.uid !== devUid);
    });

    // 文件夹没了，但书签还在（被兜底挂到"其他书签"）
    expect(browser.nodes.has(dev)).toBe(false);
    expect(browser.countByUrl('https://github.com')).toBe(1);
    expect(browser.titlesOf(browser.otherId)).toEqual(['GitHub']);
  });

  it('"先移动再删除"：待在将被删除的文件夹里的书签会被先救出来', async () => {
    const browser = new FakeBrowser();
    const dev = browser.addFolder(browser.barId, '开发');
    browser.addBookmark(dev, 'GitHub', 'https://github.com');
    const first = await sync(browser, {});

    await sync(browser, first.result.uidMap, (entries, view) => {
      const devUid = uidOf(view, (entry) => entry.title === '开发');
      const bookmarkUid = uidOf(view, (entry) => entry.kind === 'bookmark');
      const withoutFolder = entries.filter((entry) => entry.uid !== devUid);
      return patch(withoutFolder, bookmarkUid, { parentUid: 'root:0', index: 0 });
    });

    expect(browser.titlesOf(browser.barId)).toEqual(['GitHub']);
    expect(browser.countByUrl('https://github.com')).toBe(1);
    expect(browser.nodes.has(dev)).toBe(false);
  });

  it('顺序会被调整成目标顺序', async () => {
    const browser = new FakeBrowser();
    browser.addBookmark(browser.barId, 'A', 'https://a.com');
    browser.addBookmark(browser.barId, 'B', 'https://b.com');
    browser.addBookmark(browser.barId, 'C', 'https://c.com');
    const first = await sync(browser, {});

    await sync(browser, first.result.uidMap, (entries, view) => {
      const order = [
        uidOf(view, (entry) => entry.title === 'C'),
        uidOf(view, (entry) => entry.title === 'A'),
        uidOf(view, (entry) => entry.title === 'B'),
      ];
      return entries.map((entry) => {
        const at = order.indexOf(entry.uid);
        return at >= 0 ? { ...entry, index: at } : entry;
      });
    });

    expect(browser.titlesOf(browser.barId)).toEqual(['C', 'A', 'B']);
  });

  it('相同 URL 的两条书签都会被保留（不做静默去重）', async () => {
    const browser = new FakeBrowser();
    browser.addBookmark(browser.barId, 'A', 'https://dup.com');
    browser.addBookmark(browser.barId, 'B', 'https://dup.com');
    const first = await sync(browser, {});

    await sync(browser, first.result.uidMap);

    expect(browser.countByUrl('https://dup.com')).toBe(2);
  });
});

describe('写回浏览器：根目录与替身文件夹', () => {
  function mobileEntries(): Entry[] {
    const iso = '2024-01-01T00:00:00.000Z';
    return [
      { uid: 'root:2', parentUid: '', index: 2, kind: 'folder', title: '移动设备书签', url: null, createdAt: iso, updatedAt: iso },
      { uid: 'm1', parentUid: 'root:2', index: 0, kind: 'bookmark', title: '手机上存的', url: 'https://mobile.com', createdAt: iso, updatedAt: iso },
    ];
  }

  it('远端有一个本地不存在的根目录时，会造一个同名文件夹来放它的内容', async () => {
    const browser = new FakeBrowser();
    const first = await sync(browser, {}, (entries) => [...entries, ...mobileEntries()]);

    expect(browser.titlesOf(browser.otherId)).toEqual(['移动设备书签']);
    const syntheticId = browser.findIdByTitle(browser.otherId, '移动设备书签')!;
    expect(browser.titlesOf(syntheticId)).toEqual(['手机上存的']);
    expect(Object.values(first.result.uidMap).some((record) => record.synthetic)).toBe(true);
    expect(first.result.warnings.some((warning) => warning.code === 'synthetic-root-created')).toBe(true);
  });

  it('替身文件夹第二次同步时会被认出来，不会越建越多', async () => {
    const browser = new FakeBrowser();
    const first = await sync(browser, {}, (entries) => [...entries, ...mobileEntries()]);
    const second = await sync(browser, first.result.uidMap, (entries) => [...entries, ...mobileEntries()]);

    expect(browser.titlesOf(browser.otherId)).toEqual(['移动设备书签']);
    expect(second.result.counts.added).toBe(0);
    expect(second.view.snapshot.entries.some((entry) => entry.uid === 'root:2')).toBe(true);
  });

  it('浏览器后来真的出现了该根目录时，替身会被识别为"被顶替"', async () => {
    const browser = new FakeBrowser();
    const first = await sync(browser, {}, (entries) => [...entries, ...mobileEntries()]);

    // 手工模拟：浏览器多出了第三个真正的根目录
    const realMobile = browser.addFolder(browser.otherId, '移动设备书签');
    const parent = browser.nodes.get(browser.otherId)!;
    parent.children = parent.children.filter((id) => id !== realMobile);
    browser.nodes.get(realMobile)!.parentId = null;
    browser.rootOrder.push(realMobile);

    const view = await readView(browser, first.result.uidMap);
    const roots = view.snapshot.entries.filter((entry) => entry.parentUid === '');
    expect(roots.find((entry) => entry.uid === 'root:2')?.title).toBe('移动设备书签');
    expect(view.warnings.some((warning) => warning.code === 'synthetic-root-superseded')).toBe(true);
  });
});

describe('写回浏览器：身份配对', () => {
  it('renames 会让本地节点认领新身份，而不是新建一条', async () => {
    const browser = new FakeBrowser();
    browser.addBookmark(browser.barId, 'GitHub', 'https://github.com');
    const first = await sync(browser, {});
    const localUid = uidOf(first.view, (entry) => entry.kind === 'bookmark');

    const view = await readView(browser, first.result.uidMap);
    const renames = new Map([[localUid, 'remote-uid-1']]);
    const target = view.snapshot.entries.map((entry) =>
      entry.uid === localUid ? { ...entry, uid: 'remote-uid-1' } : entry,
    );

    const result = await applySnapshot(browser, target, view, { renames });
    expect(browser.countByUrl('https://github.com')).toBe(1);
    expect(Object.values(result.uidMap).some((record) => record.uid === 'remote-uid-1')).toBe(true);
  });
});

describe('身份表', () => {
  it('uidMapFromView 能把绑定关系完整导出，重复读也不会换 uid', async () => {
    const browser = new FakeBrowser();
    browser.addBookmark(browser.barId, 'GitHub', 'https://github.com');
    const view = await readView(browser);
    const map = uidMapFromView(view);

    const again = await readView(browser, map);
    expect(again.snapshot.revision).toBe(view.snapshot.revision);
    expect([...again.uidByBrowserId.values()].sort()).toEqual([...view.uidByBrowserId.values()].sort());
  });

  it('新节点在没有身份表时会拿到新 uid（这正是需要立刻保存的原因）', async () => {
    const browser = new FakeBrowser();
    browser.addBookmark(browser.barId, 'GitHub', 'https://github.com');
    const a = await readView(browser);
    const b = await readView(browser);
    expect(a.snapshot.entries.find((entry) => entry.kind === 'bookmark')!.uid).not.toBe(
      b.snapshot.entries.find((entry) => entry.kind === 'bookmark')!.uid,
    );
  });
});
