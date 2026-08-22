/**
 * 离线 lockfile 来源规则回归：既要阻断 Git/远程 tarball，也不能被弃用公告中的文档 URL 误伤。
 *
 * @requirement CFG-005
 * @requirement CFG-011
 */
import { findForbiddenLockfileSources } from './offline-lockfile-policy';

const forbidden = ['git+', 'github:', 'gitlab:', 'bitbucket:', 'http://', 'https://'];

describe('[CFG-005][CFG-011] offline lockfile source policy', () => {
  it('说明性 deprecated URL 不属于依赖来源', () => {
    expect(
      findForbiddenLockfileSources(
        '    deprecated: See https://eslint.org/version-support for options.',
        forbidden,
      ),
    ).toEqual([]);
  });

  it.each([
    '        specifier: git+https://github.com/example/repository.git',
    '        version: github:example/repository#commit',
    '    resolution: {tarball: https://downloads.example.invalid/package.tgz}',
    "  'https://downloads.example.invalid/package.tgz':",
  ])('真实远程来源被阻断：%s', (line) => {
    expect(findForbiddenLockfileSources(line, forbidden)).toEqual([line]);
  });
});
