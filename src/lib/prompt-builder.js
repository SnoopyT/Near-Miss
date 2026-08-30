// src/lib/prompt-builder.js
// Builds the highly-constrained structured prompt sent to the user's own LLM API.
//
// Each query is split into THREE parallel single-layer requests (core /
// companion / empathy) instead of one mega-request: the model then only
// generates ~1/3 of the output per call, and the calls run concurrently, so
// wall-clock time drops proportionally. The server merges the results.
//
// Reliability-first: every event MUST have a verifiable source URL, and the
// model MUST say "未找到" rather than fabricate.

/**
 * @typedef {Object} QueryInput
 * @property {{lat:number,lng:number,displayName?:string}} point
 * @property {string} placeLabel        human readable place, e.g. "广州市越秀区"
 * @property {ReturnType<typeof buildSpatialScope>} scope
 * @property {{mode:'single'|'range', single?:string, from?:string, to?:string}} time
 * @property {{coreRadiusKm:number, companionRadiusKm:number}} cfg
 * @property {number} cap               max events this layer should return
 */

// Per-layer definitions: Chinese name (correct idioms!), circle rule, and the
// spatial keywords each layer should search with.
const LAYER_DEFS = {
  core: {
    zh: '擦肩而过',
    semantic: '我与危险擦肩而过。',
    circleOf: (cfg) => `距离查询点 ≤ ${cfg.coreRadiusKm} 公里`,
  },
  companion: {
    zh: '一衣带水',
    semantic: '危险曾离我的生活圈很近。',
    circleOf: () => '位于查询点所在城市的相邻地级市（与该市接壤的地级市）',
  },
  empathy: {
    zh: '一箭之遥',
    semantic: '我们共同经历过这场灾难。',
    circleOf: () => '位于查询点同一个省份范围内',
  },
};

function formatTime(time) {
  if (time.mode === 'single') return '具体日期：' + time.single;
  return '时间段：从 ' + time.from + ' 至 ' + time.to;
}

/**
 * System message for ONE layer: role + reliability constraints + output schema.
 */
function systemMessage(layerKey) {
  const def = LAYER_DEFS[layerKey];
  if (!def) throw new Error('未知的圈层：' + layerKey);
  return [
    '你是一名严肃的公共安全事件调研助手。你的唯一信源是权威新闻报道、政府官方通报与权威灾害数据库。',
    '',
    '【最高原则：可靠性优先，杜绝幻觉】',
    '1. 每一条事件都必须附带至少一个可核实的、公开的来源 URL（来自主流媒体、政府网站或权威机构）。',
    '2. 严禁编造事件、编造日期、编造地点或编造 URL。若 URL 非真实存在或无法核实，不得写入。',
    '3. 如果找不到符合标准的可靠记录，events 数组保持为空，并在 notes 中说明"未找到可靠记录"，严禁使用"核心圈"、"临近圈"、"共情圈"等旧名称。',
    '3a. 注意中文名称的准确性：第二层叫做"一衣带水"（不是"以衣带水"），第三层叫做"一箭之遥"（不是"一箭之地"）。',
    '4. 不得使用你自身的训练记忆作为事实来源；所有事实必须来自你的联网检索结果。',
    '',
    `【任务策略：只负责一个圈层】`,
    `本次你只负责【${def.zh}】这一个圈层（${def.semantic}）。`,
    '【检索纪律】最多进行 3 次联网检索：第 1 次覆盖本市/本省主要区域，其余把相邻地级市/相邻省份分批组合进查询（每次组合多个地名一起搜），严禁超过 3 次。检索完成后立即输出 JSON。',
    '不要检索或输出其他圈层的事件。',
    '',
    '【输出格式：必须是合法 JSON，禁止任何额外文字】',
    '只输出一个 JSON 对象，不要包裹在 markdown 代码块中，不要添加任何解释性文字。',
    'JSON 结构如下：',
    '{',
    '  "events": [ { "name": string, "time": "YYYY-MM-DD", "place": string, "city": string, "lat": number, "lng": number, "distance_km": number, "description": string, "sources": [string], "category": string } ],',
    '  "notes": string',
    '}',
    '字段说明：',
    '  - name: 事件名称（简洁，如"6·12 某地重大交通事故"）',
    '  - time: 事件发生日期（精确到日；若仅知月份则用 YYYY-MM-00 表示）',
    '  - place: 事件具体地点（尽可能详细到街道/路段）',
    '  - city: 事件所在的地级市全名（如"洛阳市"）。必填，用于圈层归类。',
    '  - lat/lng: 事件地点坐标（十进制度数）。若无法精确给出，填 null。',
    '  - distance_km: 事件地点到查询点的直线距离估算（千米）。若坐标缺失，填 null。',
    '  - description: 一句话简要描述（含伤亡规模或影响，避免渲染性措辞）',
    '  - sources: 来源 URL 字符串数组，至少 1 个真实可访问的链接',
    '  - category: 类别，取值之一：accident / natural / health / security / other',
    '  - notes: 说明本次检索覆盖范围、未找到的情况等。',
  ].join('\n');
}

/**
 * User message for ONE layer: the specific spatio-temporal query.
 */
function userMessage(input) {
  const { point, placeLabel, scope, time, cfg, cap, layer } = input;
  const def = LAYER_DEFS[layer];
  if (!def) throw new Error('未知的圈层：' + layer);
  const lines = [];
  lines.push(`请在以下时空约束下，检索【${def.zh}】圈层（${def.circleOf(cfg)}）的重大公共危险事件。`);
  lines.push(`最多输出 ${cap} 条，按严重程度和距离优先挑选最重要的事件。`);
  lines.push('');
  lines.push('【时间硬约束】');
  lines.push(formatTime(time));
  lines.push('只检索发生在该日期/该时间段内（或紧邻该时间段 ±7 天）的事件。');
  lines.push('');
  lines.push('【空间硬约束】');
  lines.push('查询点：' + (placeLabel || (point.lat.toFixed(4) + ', ' + point.lng.toFixed(4))));
  lines.push('查询点坐标：' + point.lat.toFixed(5) + ', ' + point.lng.toFixed(5));
  lines.push('圈层定义：' + def.circleOf(cfg) + '。语义："' + def.semantic + '"');
  lines.push('');
  lines.push('【客户端检索词增强（已为你扩展，请充分使用）】');
  const parts = (scope && scope.parts) || {};
  const city = parts.city || '';
  const province = parts.state || parts.province || '';
  const neighborCities = (scope && scope.neighborCities) || [];
  const neighborProvinces = (scope && scope.neighborProvinces) || [];
  if (layer === 'core') {
    const kws = [scope && scope.core, city].filter(Boolean).join('、');
    if (kws) lines.push(`核心检索词：${kws}（配合事件类型词：火灾/爆炸/坍塌/洪涝/地震/暴雨/事故等，逐一组合检索）`);
  } else if (layer === 'companion') {
    lines.push(`检索范围：${city || placeLabel} 的相邻地级市。`);
    if (neighborCities.length) {
      lines.push(`已确认的相邻地级市清单（${neighborCities.length} 个）：${neighborCities.join('、')}。`);
      lines.push('请把这份清单里的每一个市都纳入检索（可以在一次检索里组合多个市名），不得只查其中一两个。');
    } else if (province || city) {
      lines.push(`请先列出${province || '所在省份'}内与 ${city || placeLabel} 接壤的所有地级市名称，然后逐一纳入检索。`);
    }
    lines.push('关键词组合示例：「相邻市名 + 火灾/爆炸/坍塌/洪涝/地震/重大事故 + 年份」。');
  } else if (layer === 'empathy') {
    lines.push(`检索范围：${province || placeLabel} 全省${neighborProvinces.length ? '，并覆盖相邻省份' : ''}。`);
    if (province && !neighborProvinces.length) lines.push(`请覆盖${province}内全部地级市。`);
    if (neighborProvinces.length) lines.push(`相邻省份清单：${neighborProvinces.join('、')}。`);
    lines.push('关键词组合示例：「地级市名/省份名 + 重大事故/自然灾害/公共卫生事件 + 年份」。');
  }
  lines.push('');
  lines.push('请再次确认：每个事件必须有真实可核实的来源 URL；找不到可靠记录时返回空数组并在 notes 中说明（请使用"' + def.zh + '"的中文名称，不要使用"核心圈/临近圈/共情圈"等旧称谓）。');
  lines.push('现在请联网检索并仅输出 JSON。');
  return lines.join('\n');
}

module.exports = { systemMessage, userMessage, LAYER_DEFS };
