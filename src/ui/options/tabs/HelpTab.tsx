/**
 * 帮助
 * ====
 *
 * 把最常见的问题和"这套东西到底怎么运作"写在这里，
 * 用户不用去翻源码或文档目录就能自己排查。
 */

import { Card } from '../../shared/components';

const DOCS = [
  { file: 'docs/01-架构总览.md', title: '架构总览', desc: '整个扩展分成哪几层、每个目录干什么、一次同步的数据怎么流动' },
  { file: 'docs/02-同步原理-三方合并.md', title: '同步原理', desc: '为什么必须要有 base、冲突是怎么判定的、每种情况怎么处理' },
  { file: 'docs/03-数据格式说明.md', title: '数据格式', desc: '云端 JSON 每个字段什么意思、本机存了哪些东西' },
  { file: 'docs/04-代码地图.md', title: '代码地图', desc: '想改某个功能应该打开哪个文件' },
  { file: 'docs/05-界面怎么读.md', title: '界面怎么读', desc: '完全不懂前端框架也能看懂的 Solid 入门' },
  { file: 'docs/06-开发调试指南.md', title: '开发调试', desc: '怎么改代码、怎么看日志、怎么跑测试' },
  { file: 'docs/07-常见问题.md', title: '常见问题', desc: '书签重复、删不掉、同步报错怎么办' },
  { file: 'docs/08-本次重构改了什么.md', title: '重构说明', desc: '旧版本有哪些坑，新版本分别怎么修的' },
];

export function HelpTab() {
  return (
    <>
      <Card title="它是怎么工作的（一分钟版）">
        <ol class="list-decimal space-y-1.5 pl-4 text-sm leading-relaxed text-ink">
          <li>
            你的书签存在自己 GitHub 账号下的一个<strong>私有 Gist</strong> 里（就是一个能存文本文件的云端仓库）。
          </li>
          <li>
            本机每次同步时，会同时拿到三份数据：<strong>云端</strong>、<strong>本机</strong>、
            以及<strong>上次同步时的样子</strong>。靠这三份数据就能判断出"哪边新增了、哪边删除了、哪边修改了"。
          </li>
          <li>把三份数据合并成一份结果，再分别写回浏览器和云端。</li>
          <li>
            只有当两边<strong>改的是同一处</strong>时才会冲突。这时同步会暂停，让你自己选，
            以免误删你的书签。
          </li>
        </ol>
      </Card>

      <Card title="两种授权方式">
        <div class="space-y-3 text-sm">
          <div>
            <p class="font-medium text-ink">方式一：填一个 Token（手动，最省事）</p>
            <p class="mt-1 leading-relaxed text-ink-soft">
              去 GitHub 生成一个只勾了 <code class="rounded bg-surface-raised px-1">gist</code> 的
              Personal Access Token，粘贴到设置页。不用注册任何应用，复制粘贴一次就完事。
              缺点是 Token 是一长串字符，容易复制不全。
            </p>
          </div>
          <div>
            <p class="font-medium text-ink">方式二：用 GitHub 账号授权（不用手抄 Token）</p>
            <p class="mt-1 leading-relaxed text-ink-soft">
              点一下「用 GitHub 授权」，扩展会给你一个 8 位左右的短码，
              你把它填到 GitHub 的授权页面上，回来点确认即可。全程不需要复制长字符串。
            </p>
            <p class="mt-1 leading-relaxed text-ink-soft">
              这种方式需要一个 <strong>OAuth App 的 client_id</strong>。
              client_id 是公开信息、不是密钥，所以可以放心共用。
              如果扩展里没有内置，就需要你自己在 GitHub 上建一个 OAuth App
              （免费、一分钟，设置页里有图文步骤），把 client_id 填进去。
            </p>
            <p class="mt-1 leading-relaxed text-ink-soft">
              两种方式拿到的权限完全一样（都只有 gist），存储方式也一样（加密后存本机）。
            </p>
          </div>
        </div>
      </Card>

      <Card title="常见问题">
        <div class="space-y-4 text-sm">
          <div>
            <p class="font-medium text-ink">同步之后书签变多了（出现重复）</p>
            <p class="mt-1 leading-relaxed text-ink-soft">
              通常发生在「第一次同步」时。新版本会按网址自动和云端配对，一般不会再重复。
              如果已经有重复，去「数据」标签页用「重复书签清理」处理，只保留每组第一条。
            </p>
          </div>

          <div>
            <p class="font-medium text-ink">删掉的书签又回来了</p>
            <p class="mt-1 leading-relaxed text-ink-soft">
              说明另一台设备上还有这条书签，而且它比你这边的删除更晚同步。
              正确做法是：在删除的那台设备上先点一次「立即同步」把删除推上去，再到另一台设备同步。
              如果两边同时改了同一条，会进入冲突界面让你确认。
            </p>
          </div>

          <div>
            <p class="font-medium text-ink">提示「已触发 GitHub 接口次数限制」</p>
            <p class="mt-1 leading-relaxed text-ink-soft">
              GitHub 对接口调用有每小时次数上限。等提示里说的时间过了就会自动恢复。
              平时可以把自动同步间隔调大一些（默认 15 分钟已经很宽裕）。
            </p>
          </div>

          <div>
            <p class="font-medium text-ink">提示「Token 无效或已被撤销」</p>
            <p class="mt-1 leading-relaxed text-ink-soft">
              到设置页重新授权一次。如果你在 GitHub 上删除了旧 Token、取消了应用授权，
              或者改了权限，也会出现这个提示。
            </p>
          </div>

          <div>
            <p class="font-medium text-ink">我不小心点了「用本地覆盖云端」，云端数据没了</p>
            <p class="mt-1 leading-relaxed text-ink-soft">
              去「数据」标签页，点「恢复云端到覆盖前」。覆盖之前会自动备份一份。
            </p>
          </div>

          <div>
            <p class="font-medium text-ink">换了电脑 / 重装了浏览器</p>
            <p class="mt-1 leading-relaxed text-ink-soft">
              在新设备上装好扩展、用同样的方式授权（Token 或 GitHub 授权），
              然后点一次「立即同步」。扩展会自动找到原来那个 Gist 并把书签合并过来。
            </p>
          </div>

          <div>
            <p class="font-medium text-ink">界面颜色太刺眼 / 想要深色</p>
            <p class="mt-1 leading-relaxed text-ink-soft">
              右上角的太阳/月亮图标可以一键切换；在「设置」→「外观」里还能选
              「跟随系统 / 浅色 / 深色」。
            </p>
          </div>

          <div>
            <p class="font-medium text-ink">数据到底存在哪？安全吗？</p>
            <p class="mt-1 leading-relaxed text-ink-soft">
              存在你自己 GitHub 账号下的私有 Gist 里，本项目没有服务器，也不会把书签发到任何第三方。
              凭据加密后存在本机——但请理解，这层加密只能防止别人随手看到明文，
              真正起作用的是"凭据只有 gist 一个权限"。
            </p>
          </div>
        </div>
      </Card>

      <Card title="更多文档" hint="源码里的 docs 目录下有更详细的说明，用 Markdown 写的，普通编辑器就能打开。">
        <div class="space-y-2">
          {DOCS.map((doc) => (
            <div class="rounded-md border border-line px-3 py-2">
              <p class="text-sm font-medium text-ink">{doc.title}</p>
              <p class="text-xs text-ink-soft">{doc.desc}</p>
              <p class="mt-0.5 font-mono text-xs text-ink-faint">{doc.file}</p>
            </div>
          ))}
        </div>
      </Card>

      <Card title="免责声明">
        <p class="text-xs leading-relaxed text-ink-soft">
          本项目按「原样」提供，不附带任何保证。同步操作涉及删除和覆盖，
          建议定期用「数据」标签页导出 JSON 备份。
          GitHub 可能随时调整接口或限制策略，本项目与 GitHub, Inc. 无任何关联。
        </p>
      </Card>
    </>
  );
}
