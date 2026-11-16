// tools/models-preview.mjs
// 预览模型在选择器与卡片中的显示文本。
import { FALLBACK_QWENWORK_MODELS, toPiModel, catalogForCard, formatRate } from '../lib/models.js';

const BASE = 'http://127.0.0.1:1/v1/chat/completions';

console.log('=== 模型选择器显示（pi-ai 描述符的 name 字段）===');
for (const info of FALLBACK_QWENWORK_MODELS) {
  const pi = toPiModel(info, BASE);
  console.log(`  ${pi.id.padEnd(22)} → ${pi.name}`);
}

console.log('\n=== 设置卡片显示 ===');
for (const card of catalogForCard()) {
  console.log(`  ${card.id.padEnd(22)} | ${card.name.padEnd(22)} | ${card.description}`);
}

console.log('\n=== formatRate 边界 ===');
for (const r of [0, 0.1, 1, 1.1, 2.5, NaN, undefined]) {
  console.log(`  ${String(r).padEnd(10)} → ${JSON.stringify(formatRate(r))}`);
}

console.log('\n=== 关键断言 ===');
// ⚠️ 按 id 查找而不是按下标取：静态目录的顺序会变（深 seek-flash 现在是第一项），
// 写死下标会让断言在目录调整后误报。
const byId = (id) => {
  const info = FALLBACK_QWENWORK_MODELS.find((m) => m.id === id);
  if (info === undefined) throw new Error(`静态目录里找不到模型 ${id}`);
  return info;
};
const defaultModel = FALLBACK_QWENWORK_MODELS.find((m) => m.isDefault === true)
  ?? FALLBACK_QWENWORK_MODELS[0];
const cheapest = [...FALLBACK_QWENWORK_MODELS].sort((a, b) => a.billingRate - b.billingRate)[0];
const defaultPi = toPiModel(defaultModel, BASE);
let fail = 0;
const check = (label, cond) => {
  console.log(`  ${cond ? '✅' : '❌'} ${label}`);
  if (!cond) fail++;
};
check(
  `默认模型(${defaultModel.id})的选择器名含倍率 x${defaultModel.billingRate.toFixed(2)}`,
  defaultPi.name.includes(`x${defaultModel.billingRate.toFixed(2)}`),
);
check(
  `最低倍率模型(${cheapest.id})的选择器名含倍率 x${cheapest.billingRate.toFixed(2)}`,
  toPiModel(cheapest, BASE).name.includes(`x${cheapest.billingRate.toFixed(2)}`),
);
check('有默认标记的模型，其选择器名含"默认"', defaultPi.name.includes('默认'));
check('name 用 · 分隔', defaultPi.name.includes(' · '));
check(`id 未被污染（仍为 ${defaultModel.id}）`, defaultPi.id === defaultModel.id);
const firstCard = catalogForCard({ models: [defaultModel] })[0];
check('卡片名保持短名（不含倍率）', firstCard.name === (defaultModel.shortName ?? defaultModel.id));
byId(defaultModel.id); // 存在性自检

process.exit(fail > 0 ? 1 : 0);
