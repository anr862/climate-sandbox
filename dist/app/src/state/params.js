/**
 * Parameter registry — a single declarative source of truth that drives
 * (a) the left parameter panel widgets, (b) the creation wizard, (c) undo/lock,
 * (d) the physics model and (e) scene (de)serialisation.
 */

export const PARAM_GROUPS = [
  { key: 'star', label: '恒星与辐照', note: '当前仅单恒星模型' },
  { key: 'orbit', label: '轨道与自转' },
  { key: 'atmos', label: '大气成分' },
  { key: 'hydro', label: '海洋与冰盖' },
  { key: 'albedo', label: '反照率' },
  { key: 'terrain', label: '地形' },
  { key: 'greenhouse', label: '温室效应' },
  { key: 'circulation', label: '洋流与大气环流' },
  { key: 'surface', label: '地表与渲染' },
  { key: 'meteor', label: '陨石' },
  { key: 'time', label: '时间与模拟' },
];

/**
 * kind: slider | number | toggle | select | action | readonly
 * auto: key of the auto-derivation rule (see state.js) — only applied while
 *       "auto derive" is enabled and the parameter is not locked.
 */
export const PARAMS = [
  /* ---------------- star ---------------- */
  {
    key: 'irradiance', group: 'star', label: '太阳辐照度', short: '辐照',
    kind: 'slider', min: 100, max: 4000, step: 1, dec: 0,
    unit: 'W/m²', def: 1361,
    help: '行星轨道处的恒星总辐照度（TSI）。地球当前值 1361 W/m²。',
  },
  {
    key: 'starCount', group: 'star', label: '恒星数量', kind: 'select', def: 1,
    options: [{ v: 1, t: '单恒星（当前支持）' }, { v: 2, t: '双恒星（预留接口）' }, { v: 3, t: '三星系统（预留接口）' }],
    help: '多恒星求解器接口已预留（src/physics/stars.js），当前版本以主星参数运行。',
  },
  {
    key: 'starTemp', group: 'star', label: '恒星有效温度', kind: 'slider',
    min: 2400, max: 12000, step: 50, dec: 0, unit: 'K', def: 5772,
    help: '影响光谱能量分布，进而影响行星反照率与光化学；当前以权重修正方式参与。',
  },

  /* ---------------- orbit ---------------- */
  {
    key: 'axialTilt', group: 'orbit', label: '黄赤交角', short: '倾角',
    kind: 'slider', min: 0, max: 90, step: 0.01, dec: 2, unit: '°', def: 23.44,
    help: '决定季节性强度。0° 无季节，90° 极端极昼极夜。',
  },
  {
    key: 'rotationSpeed', group: 'orbit', label: '自转速度', short: '自转',
    kind: 'slider', min: 0.02, max: 8, step: 0.01, dec: 2, unit: '×地球', def: 1,
    help: '相对地球自转速率。越快昼夜温差越小，越慢昼夜温差越大。',
  },
  {
    key: 'orbitalSpeed', group: 'orbit', label: '公转速度', short: '公转',
    kind: 'slider', min: 0.1, max: 6, step: 0.01, dec: 2, unit: '×地球', def: 1,
    help: '相对地球公转速率，即“一年”的长短。',
  },
  {
    key: 'eccentricity', group: 'orbit', label: '轨道偏心率', kind: 'slider',
    min: 0, max: 0.6, step: 0.001, dec: 3, unit: '', def: 0.0167,
    help: '高偏心率会带来显著的年际辐照变化。',
  },
  {
    key: 'perihelion', group: 'orbit', label: '近日点位置', kind: 'slider',
    min: 0, max: 360, step: 1, dec: 0, unit: '°', def: 102,
    help: '近日点相对春分的黄经位置，决定季节与距离的相位关系。',
  },

  /* ---------------- atmosphere ---------------- */
  {
    key: 'pressure', group: 'atmos', label: '大气压', kind: 'slider',
    min: 0.001, max: 200, step: 0.001, dec: 3, unit: 'atm', def: 1, auto: 'pressure',
    help: '地表气压。影响温室增温、大气热容量与散射。',
  },
  {
    key: 'o2', group: 'atmos', label: '氧浓度占比', short: 'O₂',
    kind: 'slider', min: 0, max: 60, step: 0.01, dec: 2, unit: '%vol', def: 20.95, auto: 'dryGas',
    tone: 'good', help: '自由氧体积占比。>25% 会显著提高火灾风险。',
  },
  {
    key: 'n2', group: 'atmos', label: '氮浓度占比', short: 'N₂',
    kind: 'slider', min: 0, max: 100, step: 0.01, dec: 2, unit: '%vol', def: 78.08, auto: 'dryGas',
    help: '惰性主成分。它不直接参与温室效应，但决定总压分配。',
  },
  {
    key: 'co2', group: 'atmos', label: '二氧化碳浓度', short: 'CO₂',
    kind: 'slider', min: 1, max: 40000, step: 1, dec: 0, unit: 'ppm', def: 420, auto: 'co2',
    help: '对数强迫：对 280 ppm 基准，ΔF ≈ 5.35·ln(C/280) W/m²。',
  },
  {
    key: 'ch4', group: 'atmos', label: '甲烷浓度', short: 'CH₄',
    kind: 'slider', min: 0, max: 5000, step: 1, dec: 1, unit: 'ppb', def: 1920,
    help: '强效温室气体，也计入毒性/危险气体指数。',
  },
  {
    key: 'n2o', group: 'atmos', label: '氧化亚氮浓度', short: 'N₂O',
    kind: 'slider', min: 0, max: 3000, step: 1, dec: 1, unit: 'ppb', def: 332,
    help: '工业与生物来源的温室气体。',
  },
  {
    key: 'otherGas', group: 'atmos', label: '其它气体 / 惰性填充', short: '其它',
    kind: 'slider', min: 0, max: 50, step: 0.01, dec: 2, unit: '%vol', def: 0.93, auto: 'dryGas',
    help: '氩、氖等。干空气四组分之和应接近 100%。',
  },
  {
    key: 'humidity', group: 'atmos', label: '基准相对湿度', short: '湿度',
    kind: 'slider', min: 0, max: 100, step: 1, dec: 0, unit: '%', def: 68, auto: 'humidity',
    tone: 'hydro', help: '全球平均地表相对湿度，决定水汽温室项与降水总量。',
  },
  {
    key: 'cloud', group: 'atmos', label: '云量覆盖率', short: '云量',
    kind: 'slider', min: 0, max: 100, step: 1, dec: 0, unit: '%', def: 62, auto: 'cloud',
    tone: 'neutral', help: '云同时增反照率（降温）与增温室（升温），此处按净降温处理。',
  },

  /* ---------------- hydrosphere / cryosphere ---------------- */
  {
    key: 'waterInventory', group: 'hydro', label: '总水量', short: '水量',
    kind: 'slider', min: 0, max: 6, step: 0.01, dec: 2, unit: '×地球', def: 1,
    help: '全球水总量，决定海平面随冰盖消长的响应幅度。',
  },
  {
    key: 'oceanFraction', group: 'hydro', label: '海洋面积占比', short: '海洋',
    kind: 'slider', min: 0, max: 100, step: 0.1, dec: 1, unit: '%', def: 70.8, auto: 'ocean',
    help: '由海底地形与海平面自动推导，也可手动设定（会反向调整海平面）。',
  },
  {
    key: 'iceFlow', group: 'hydro', label: '冰盖形成速率', short: '成冰',
    kind: 'slider', min: 0, max: 4, step: 0.01, dec: 2, unit: '×', def: 1,
    help: '冰盖厚度向平衡态松弛的速率。',
  },
  {
    key: 'iceAlbedo', group: 'albedo', label: '海冰反照率', short: '海冰α',
    kind: 'slider', min: 0.2, max: 0.9, step: 0.01, dec: 2, unit: '', def: 0.56,
    help: '冰—反照率正反馈的关键系数。观测值 0.5–0.7（裸冰偏低、积雪覆盖偏高）；取值越高气候越容易进入"雪球"分支。',
  },
  {
    key: 'snowAlbedo', group: 'albedo', label: '雪 / 陆冰反照率', short: '雪α',
    kind: 'slider', min: 0.3, max: 0.95, step: 0.01, dec: 2, unit: '', def: 0.76,
    help: '观测值 0.7–0.85（陈雪偏低、新雪偏高）。',
  },
  {
    key: 'oceanAlbedo', group: 'albedo', label: '开阔水面反照率', short: '水α',
    kind: 'slider', min: 0.02, max: 0.3, step: 0.005, dec: 3, unit: '', def: 0.06,
  },

  /* ---------------- terrain ---------------- */
  {
    key: 'terrainScale', group: 'terrain', label: '地形高低起伏', short: '起伏',
    kind: 'slider', min: 0.05, max: 3, step: 0.01, dec: 2, unit: '×', def: 1,
    help: '对生成的高度场做整体缩放；会改变海陆分布与气候。',
  },
  {
    key: 'seaLevel', group: 'terrain', label: '海平面高度', short: '海面',
    kind: 'slider', min: -3000, max: 3000, step: 10, dec: 0, unit: 'm', def: 0,
    help: '人为抬升/降低海平面。实际海平面 = 基准 + 冰盖消长 + 本偏移。',
  },
  {
    key: 'plateCount', group: 'terrain', label: '板块数量', short: '板块',
    kind: 'slider', min: 3, max: 40, step: 1, dec: 0, unit: '', def: 14,
  },
  {
    key: 'fragmentation', group: 'terrain', label: '板块破碎程度', short: '破碎',
    kind: 'slider', min: 0, max: 100, step: 1, dec: 0, unit: '', def: 45,
    help: '低值=完整大陆，高值=群岛与海峡密布。',
  },
  {
    key: 'relief', group: 'terrain', label: '大陆高度起伏', short: '地势',
    kind: 'slider', min: 0, max: 100, step: 1, dec: 0, unit: '', def: 55,
  },
  {
    key: 'seaFloorRelief', group: 'terrain', label: '海底地形起伏', short: '海底',
    kind: 'slider', min: 0, max: 100, step: 1, dec: 0, unit: '', def: 50,
  },
  {
    key: 'seed', group: 'terrain', label: '地形随机种子', kind: 'number',
    min: 1, max: 999999999, step: 1, dec: 0, unit: '', def: 20240,
  },

  /* ---------------- circulation ---------------- */
  {
    key: 'transport', group: 'circulation', label: '经向热量输运总强度', short: '输运',
    kind: 'slider', min: 0, max: 3, step: 0.01, dec: 2, unit: '×', def: 1,
    help: '赤道—极地热输送的总强度（大洋环流 + 大气环流合计）。减弱会导致极地更冷、赤道更热。',
  },
  {
    key: 'oceanCirculation', group: 'circulation', label: '洋流强度', short: '洋流',
    kind: 'slider', min: 0, max: 3, step: 0.01, dec: 2, unit: '×', def: 1,
    help: '风生环流与温盐环流。西边界流（湾流/黑潮）窄而暖，东边界流宽而冷并伴随上升流；' +
      '上升流会让同纬度西岸比东岸干旱得多。',
  },
  {
    key: 'atmosphericCirculation', group: 'circulation', label: '大气环流强度', short: '环流',
    kind: 'slider', min: 0, max: 3, step: 0.01, dec: 2, unit: '×', def: 1,
    help: '三圈环流（信风 / 西风 / 极地东风）强度。影响热量输运、风场与降水辐合带（赤道辐合带、极锋）。',
  },
  {
    key: 'windMoisture', group: 'circulation', label: '水汽平流强度', short: '平流',
    kind: 'slider', min: 0, max: 3, step: 0.01, dec: 2, unit: '×', def: 1,
    help: '盛行风把水汽带到下风方向的程度：决定山脉迎风坡/背风坡与大陆西岸/内陆的干湿差异。',
  },

  /* ---------------- surface ---------------- */
  {
    key: 'bareAlbedo', group: 'albedo', label: '裸岩反照率', short: '岩α',
    kind: 'slider', min: 0.05, max: 0.5, step: 0.01, dec: 2, unit: '', def: 0.17,
  },
  {
    key: 'vegAlbedo', group: 'albedo', label: '植被反照率', short: '植α',
    kind: 'slider', min: 0.05, max: 0.4, step: 0.01, dec: 2, unit: '', def: 0.14,
  },
  {
    key: 'desertAlbedo', group: 'albedo', label: '沙漠反照率', short: '沙α',
    kind: 'slider', min: 0.1, max: 0.6, step: 0.01, dec: 2, unit: '', def: 0.30,
  },
  {
    key: 'planeRadiusKm', group: 'surface', label: '星球半径', short: '半径',
    kind: 'slider', min: 500, max: 40000, step: 10, dec: 0, unit: 'km', def: 6371,
    help: '只影响显示与重力推导，不改变行星几何（扁平模型）。',
  },
  {
    key: 'gravity', group: 'surface', label: '重力加速度', short: '重力',
    kind: 'slider', min: 0.5, max: 40, step: 0.01, dec: 2, unit: 'm/s²', def: 9.807,
    auto: 'gravity', help: '影响大气标高、对流与尘埃沉降。',
  },
  {
    key: 'axHabitabilityTemp', group: 'surface', label: '宜居最适温度', short: '最适温',
    kind: 'slider', min: 250, max: 320, step: 0.5, dec: 1, unit: 'K', def: 288,
    help: '宜居度评分的中心温度。',
  },
  {
    key: 'precipFactor', group: 'surface', label: '降水效率', short: '降水',
    kind: 'slider', min: 0.2, max: 3, step: 0.01, dec: 2, unit: '×', def: 1,
  },

  /* ---------------- greenhouse strength ---------------- */
  {
    key: 'ghgCO2', group: 'greenhouse', label: 'CO₂ 强迫强度', kind: 'slider',
    min: 0, max: 3, step: 0.01, dec: 2, unit: '×', def: 1, auto: 'co2',
    help: '用于“假设 CO₂ 不敏感”等反事实实验。',
  },
  {
    key: 'ghgH2O', group: 'greenhouse', label: '水汽强迫强度', kind: 'slider',
    min: 0, max: 3, step: 0.01, dec: 2, unit: '×', def: 1,
  },
  {
    key: 'ghgCH4', group: 'greenhouse', label: 'CH₄ 强迫强度', kind: 'slider',
    min: 0, max: 3, step: 0.01, dec: 2, unit: '×', def: 1,
  },
  {
    key: 'ghgN2O', group: 'greenhouse', label: 'N₂O 强迫强度', kind: 'slider',
    min: 0, max: 3, step: 0.01, dec: 2, unit: '×', def: 1,
  },
  {
    key: 'aerosolLoad', group: 'greenhouse', label: '气溶胶 / 尘埃负载', short: '尘埃',
    kind: 'slider', min: 0, max: 1.5, step: 0.01, dec: 2, unit: '', def: 0.12,
    tone: 'warn', help: '散射阳光造成降温，同时提高大气浊度图层。',
  },

  /* ---------------- thermodynamics ---------------- */
  {
    key: 'landHeatCapacity', group: 'surface', label: '陆地热容量', kind: 'slider',
    min: 0.05, max: 6, step: 0.01, dec: 2, unit: '相对', def: 1.2,
    help: '有效热惯量。越小=季节与昼夜温差越大。',
  },
  {
    key: 'oceanHeatCapacity', group: 'surface', label: '海洋混合层热容量', kind: 'slider',
    min: 0.5, max: 60, step: 0.1, dec: 1, unit: '相对', def: 12,
    help: '越大=海洋升温越滞后、季节振幅越小。',
  },
  {
    key: 'iceTempScale', group: 'hydro', label: '成冰温度响应', kind: 'slider',
    min: 0.05, max: 1.5, step: 0.01, dec: 2, unit: 'K⁻¹', def: 0.42,
  },

  /* ---------------- meteor ---------------- */
  {
    key: 'meteorEnabled', group: 'meteor', label: '启用陨石轰击', kind: 'toggle', def: false,
    help: '勾选后，在设定的时间点触发撞击：尘埃进入平流层遮蔽阳光（撞击冬天），' +
      '撞击点接收一次火球热脉冲。尘埃按 ~2.2 年 e 折时间衰减。',
  },
  {
    key: 'meteorMonth', group: 'meteor', label: '轰击起始时间', kind: 'number',
    min: 0, max: 2000000, step: 1, dec: 0, unit: '月', def: 240,
    help: '自模拟起点起的第几个月开始轰击（240 = 第 20 年）。',
  },
  {
    key: 'meteorEndMonth', group: 'meteor', label: '轰击结束时间', kind: 'number',
    min: 0, max: 2000000, step: 1, dec: 0, unit: '月', def: 240,
    help: '数量大于 1 时，各颗陨石按时间均匀落在「起始 → 结束」这个区间内（带轻微随机抖动），' +
      '用来模拟持续一段时间的轰击。等于起始时间时全部同时撞击。数量为 1 时本项无效。',
  },
  {
    key: 'meteorMass', group: 'meteor', label: '陨石重量', kind: 'number',
    min: 1e9, max: 1e24, step: 1e9, dec: 0, unit: 'kg', def: 1e15,
    help: '单颗平均质量。1e12 kg 级为区域性事件，1e15 kg 级造成全球性撞击冬天，' +
      '1e18 kg 级接近希克苏鲁伯事件。',
  },
  {
    key: 'meteorCount', group: 'meteor', label: '陨石数量', kind: 'slider',
    min: 1, max: 500, step: 1, dec: 0, unit: '颗', def: 1,
    help: '每颗陨石随机落在星球上的不同位置（按面积均匀分布，极区不会被漏掉），' +
      '重量按下方方差抽样；2 颗以上时按「结束时间」分散在一段时间内。',
  },
  {
    key: 'meteorMassSigma', group: 'meteor', label: '重量相对方差', kind: 'slider',
    min: 0, max: 1, step: 0.01, dec: 2, unit: 'σ', def: 0.35,
    help: '各颗陨石质量的相对标准差（对数正态分布）：0 = 全部等重，1 = 相差数倍。',
  },

  /* ---------------- time ---------------- */
  {
    key: 'stepMonths', group: 'time', label: '模拟步长', kind: 'select', def: 1,
    options: [{ v: 1, t: '1 个月（最小）' }, { v: 3, t: '3 个月' }, { v: 6, t: '6 个月' }, { v: 12, t: '1 年' }],
    help: '内部积分采用子步细分，步长只影响采样与推进粒度。',
  },
  {
    key: 'totalMonths', group: 'time', label: '模拟总时长', kind: 'number', def: 1200, min: -1, max: 2000000, step: 1, dec: 0, unit: '月',
    help: '设为 -1 表示不限时长，持续推演。',
  },
  {
    key: 'autoStop', group: 'time', label: '达到总时长后自动暂停', kind: 'toggle', def: true,
  },

  /* ---------------- render (basemap) ---------------- */
  { key: 'oceanColor', group: 'surface', label: '海洋基础色', kind: 'action', def: '#2c4a66' },
  { key: 'tempTint', group: 'surface', label: '地表温度着色强度', kind: 'slider', min: 0, max: 1, step: 0.01, dec: 2, def: 0.35 },
  { key: 'cloudVisual', group: 'surface', label: '云层显示', kind: 'slider', min: 0, max: 1, step: 0.01, dec: 2, def: 0.8 },
  { key: 'nightLights', group: 'surface', label: '夜间灯光（文明）', kind: 'slider', min: 0, max: 1, step: 0.01, dec: 2, def: 0.5 },
];

export const PARAM_MAP = Object.fromEntries(PARAMS.map((p) => [p.key, p]));

export function defaults() {
  const out = {};
  for (const p of PARAMS) out[p.key] = p.def;
  return out;
}

export function paramDef(key) { return PARAM_MAP[key]; }

/** Clamp a value to its declared domain, coercing types. */
export function coerce(key, value) {
  const p = PARAM_MAP[key];
  if (!p) return value;
  if (p.kind === 'toggle') return !!value;
  if (p.kind === 'select') {
    const allowed = p.options.map((o) => o.v);
    return allowed.includes(value) ? value : p.def;
  }
  if (p.kind === 'action') return value;
  const n = Number(value);
  if (!isFinite(n)) return p.def;
  if (p.min !== undefined) return Math.min(p.max, Math.max(p.min, n));
  return n;
}
