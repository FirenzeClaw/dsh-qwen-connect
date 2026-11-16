/**
 * 动态模型目录的单元测试。
 *
 * 覆盖三类真实风险：
 *   1. 字段映射错位——上游字段名与插件内部形状不同名（key/price_factor/is_vl…），
 *      映射错了模型会显示成错误的倍率或错误的视觉能力。
 *   2. 白名单失效——用户要求只保留一个模型，过滤漏了会让 13 个模型全冒出来。
 *   3. 空列表——目录拉取失败时若返回空，模型选择器会一片空白，用户连原来的
 *      对话能力都失去。这是最不能接受的降级方向。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_ALLOWED_MODEL_IDS,
  extractCatalogModels,
  fetchUpstreamModels,
  filterModels,
  normalizeCatalogEntry,
  resolveModelCatalog,
} from '../../lib/model-catalog.js';
import { FALLBACK_QWENWORK_MODELS } from '../../lib/models.js';

/** 上游真实响应的最小片段（字段名照抄实测值）。 */
const REAL_ENTRY = {
  key: 'deepseek-flash',
  display_name: 'DeepSeek-V4.1-Flash',
  is_vl: true,
  is_reasoning: true,
  price_factor: 0.1,
  enable: true,
  is_new: true,
  max_input_tokens: 1000000,
  context_config: {
    '1M': { token_count: 1000000, is_default: true },
    '200K': { token_count: 200000 },
    '400K': { token_count: 400000 },
  },
  i18n: { display_name: { zh: 'DeepSeek-V4.1-Flash' } },
};

test('normalizeCatalogEntry 把上游字段映射成内部形状', () => {
  const m = normalizeCatalogEntry(REAL_ENTRY);
  assert.equal(m.id, 'deepseek-flash');
  assert.equal(m.shortName, 'DeepSeek-V4.1-Flash');
  assert.equal(m.billingRate, 0.1);
  assert.equal(m.supportsImages, true);
  assert.equal(m.contextWindow, 1000000);
  assert.equal(m.isNew, true);
  // context_config 的 token_count 必须升序，供 UI 列可选上下文窗口
  assert.deepEqual(m.availableContextWindows, [200000, 400000, 1000000]);
});

test('normalizeCatalogEntry：enable=false 的模型不接入', () => {
  assert.equal(normalizeCatalogEntry({ ...REAL_ENTRY, enable: false }), null);
});

test('normalizeCatalogEntry：缺 key 的条目返回 null 而不是抛错', () => {
  assert.equal(normalizeCatalogEntry({ display_name: 'x' }), null);
  assert.equal(normalizeCatalogEntry(null), null);
  assert.equal(normalizeCatalogEntry('not-an-object'), null);
});

test('normalizeCatalogEntry：i18n 名称优先于顶层 display_name', () => {
  const m = normalizeCatalogEntry({
    ...REAL_ENTRY,
    display_name: 'Top Level Name',
    i18n: { display_name: { zh: '中文名' } },
  });
  assert.equal(m.shortName, '中文名');
});

test('normalizeCatalogEntry：缺失价格/上下文时给出安全默认值', () => {
  const m = normalizeCatalogEntry({ key: 'x', i18n: { display_name: { zh: 'X' } } });
  assert.equal(m.billingRate, 1, '缺 price_factor 时按 1 倍率，不显示免费');
  assert.ok(m.contextWindow > 0);
  assert.equal(m.supportsImages, false, '缺 is_vl 时不得声称支持图片');
});

test('extractCatalogModels 只读 qwork 分组并去重', () => {
  const models = extractCatalogModels({
    qwork: [REAL_ENTRY, { ...REAL_ENTRY, key: 'pro', display_name: '高级' }, REAL_ENTRY],
    chat: [{ key: 'should-be-ignored' }],
    byok_teams: [{ key: 'also-ignored' }],
  });
  assert.deepEqual(models.map((m) => m.id), ['deepseek-flash', 'pro'], '重复项必须去掉');
});

test('extractCatalogModels：qwork 缺失或非数组时返回空而不抛错', () => {
  assert.deepEqual(extractCatalogModels({}), []);
  assert.deepEqual(extractCatalogModels(null), []);
  assert.deepEqual(extractCatalogModels({ qwork: 'not-array' }), []);
});

test('默认白名单只放行 deepseek-flash', () => {
  assert.deepEqual([...DEFAULT_ALLOWED_MODEL_IDS], ['deepseek-flash']);
});

test('filterModels：默认用内置白名单', () => {
  const upstream = [
    { id: 'deepseek-flash' },
    { id: 'kimi-k3.1-pro' },
    { id: 'glm-5.3' },
  ];
  assert.deepEqual(filterModels(upstream, undefined).map((m) => m.id), ['deepseek-flash']);
  assert.deepEqual(filterModels(upstream, null).map((m) => m.id), ['deepseek-flash']);
});

test('filterModels：显式空数组表示不限制', () => {
  const upstream = [{ id: 'a' }, { id: 'b' }];
  assert.equal(filterModels(upstream, []).length, 2);
});

test('filterModels：非数组输入返回空数组', () => {
  assert.deepEqual(filterModels(undefined, undefined), []);
});

test('resolveModelCatalog：显式给 models 时直接过滤，不碰网络', async () => {
  const r = await resolveModelCatalog({
    models: [{ id: 'deepseek-flash' }, { id: 'other' }],
    // 若实现错误地去拉网络，这个抛错的 signer 会让测试失败
    signer: { signRequest: () => { throw new Error('不该被调用'); } },
  });
  assert.equal(r.source, 'override');
  assert.deepEqual(r.models.map((m) => m.id), ['deepseek-flash']);
});

test('resolveModelCatalog：上游成功后按白名单过滤', async () => {
  const r = await resolveModelCatalog({
    fetchImpl: async () => ({ ok: true, json: async () => ({ qwork: [REAL_ENTRY, { ...REAL_ENTRY, key: 'kimi-k3.1-pro' }] }) }),
    signer: { signRequest: async () => ({ headers: {} }) },
  });
  assert.equal(r.source, 'upstream');
  assert.deepEqual(r.models.map((m) => m.id), ['deepseek-flash']);
});

test('resolveModelCatalog：上游失败时回退静态目录，绝不返回空', async () => {
  const r = await resolveModelCatalog({
    fetchImpl: async () => { throw new Error('网络不可用'); },
    signer: { signRequest: async () => ({ headers: {} }) },
    logger: {},
  });
  assert.equal(r.source, 'fallback');
  assert.ok(r.models.length > 0, '拉取失败也必须给出可用模型');
});

test('resolveModelCatalog：未提供 signer 时走静态目录', async () => {
  const r = await resolveModelCatalog({ logger: {} });
  assert.equal(r.source, 'fallback');
  assert.ok(r.models.length > 0);
});

test('resolveModelCatalog：白名单与静态目录无交集时回退为不过滤', async () => {
  // 上游把模型改名 / 白名单配错的情形：宁可多给一个可用模型，也不要空列表
  const r = await resolveModelCatalog({ allowed: ['does-not-exist'], logger: {} });
  assert.equal(r.source, 'fallback-unfiltered');
  assert.equal(r.models.length, FALLBACK_QWENWORK_MODELS.length);
  assert.ok(r.models.length > 0);
});

test('resolveModelCatalog：上游有模型但白名单全未命中时降级到静态目录', async () => {
  const r = await resolveModelCatalog({
    fetchImpl: async () => ({ ok: true, json: async () => ({ qwork: [{ ...REAL_ENTRY, key: 'only-other-model' }] }) }),
    signer: { signRequest: async () => ({ headers: {} }) },
    logger: {},
  });
  // 上游没有一个命中白名单，兜底到静态目录（静态里也没有别的模型，
  // 但关键断言是「不返回空」）
  assert.ok(r.models.length > 0, '白名单未命中也不得返回空列表');
  assert.notEqual(r.source, 'upstream');
});

test('fetchUpstreamModels：非 2xx 抛错（由上层决定降级）', async () => {
  await assert.rejects(
    () => fetchUpstreamModels({
      fetchImpl: async () => ({ ok: false, status: 403 }),
      signer: { signRequest: async () => ({ headers: {} }) },
    }),
    /403/,
  );
});

test('fetchUpstreamModels：请求路径与 GET 方法正确', async () => {
  let seenUrl = '';
  let seenMethod = '';
  await fetchUpstreamModels({
    endpoint: 'https://example.test',
    fetchImpl: async (url, init) => {
      seenUrl = url;
      seenMethod = init.method;
      return { ok: true, json: async () => ({ qwork: [] }) };
    },
    signer: { signRequest: async () => ({ headers: { 'x-test': '1' } }) },
  });
  assert.equal(seenUrl, 'https://example.test/api/v2/model/list');
  assert.equal(seenMethod, 'GET');
});
