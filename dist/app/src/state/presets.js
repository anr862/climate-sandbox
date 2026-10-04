/**
 * Preset worlds. Values are overrides on top of params.defaults().
 * `terrain` overrides drive the procedural generator (see world.js).
 *
 * To keep the roster honest: every preset was chosen so its radiative
 * equilibrium lands in the regime its name promises (see physics/climate.js).
 */

export const PRESETS = [
  {
    id: 'earth', label: '地球 · Earth (2024)',
    blurb: '默认基准：1361 W/m²、420 ppm CO₂、21% O₂、70.8% 海洋。',
    seed: 20240,
    terrain: { plateCount: 14, fragmentation: 45, relief: 55, seaFloorRelief: 50, oceanTarget: 0.708 },
  },
  {
    id: 'earth-preindustrial', label: '前工业地球 · 1750',
    blurb: 'CO₂ 280 ppm、CH₄ 730 ppb，用于观察增温距平。',
    seed: 20241,
    params: { co2: 280, ch4: 730, n2o: 270, aerosolLoad: 0.08 },
    terrain: { plateCount: 14, fragmentation: 45, relief: 55, seaFloorRelief: 50, oceanTarget: 0.708 },
  },
  {
    id: 'earth-2xco2', label: '地球 · CO₂ 加倍 (840 ppm)',
    blurb: '平衡态气候敏感度实验，典型结果 +3 ~ +4 K。',
    seed: 20242,
    params: { co2: 840 },
    terrain: { plateCount: 14, fragmentation: 45, relief: 55, seaFloorRelief: 50, oceanTarget: 0.708 },
  },
  {
    id: 'snowball', label: '雪球地球 · Snowball',
    blurb: '全球冰封的失控冰室态：低辐照、低 CO₂、高反照率。',
    seed: 7712,
    // 1120 W/m² = 82 % of Earth's insolation. The cold branch is a *stable* fixed
    // point, so the forcing has to push the planet across the bifurcation rather
    // than merely cool it: measured on this preset the cliff sits between 1120 and
    // 1180 W/m² (279 K / 9 % ice -> 225 K / 80 % ice), and 1180 no longer freezes
    // the planet now that the transport conserves heat and the albedos are physical.
    params: { irradiance: 1120, co2: 90, humidity: 12, cloud: 30, aerosolLoad: 0.3, landHeatCapacity: 0.2 },
    terrain: { plateCount: 12, fragmentation: 35, relief: 50, seaFloorRelief: 45, oceanTarget: 0.72 },
  },
  {
    id: 'hothouse', label: '温室地球 · Hothouse',
    blurb: '高辐照 + 高 CO₂ 的无冰温室态，海平面高、极地温暖。',
    seed: 3390,
    params: { irradiance: 1440, co2: 4000, ch4: 4000, humidity: 85, cloud: 70, oceanFraction: 78 },
    terrain: { plateCount: 16, fragmentation: 55, relief: 45, seaFloorRelief: 40, oceanTarget: 0.78 },
  },
  {
    id: 'mars', label: '火星 · Mars-like',
    blurb: '低重力、稀薄 CO₂ 大气、无液态海洋（低压下不成海）。',
    seed: 9182,
    params: {
      irradiance: 586, planeRadiusKm: 3390, gravity: 3.721, pressure: 0.006,
      co2: 40000, ch4: 0.4, n2o: 0, o2: 0.13, n2: 2.6, otherGas: 1.9,
      humidity: 3, cloud: 2, waterInventory: 0.02, oceanFraction: 0, axialTilt: 25.19,
      rotationSpeed: 0.9747, orbitalSpeed: 0.531, eccentricity: 0.0934, aerosolLoad: 0.45,
      iceAlbedo: 0.55, snowAlbedo: 0.7, oceanColor: '#3a2f28', tempTint: 0.55,
    },
    terrain: { plateCount: 8, fragmentation: 30, relief: 75, seaFloorRelief: 70, oceanTarget: 0.001 },
  },
  {
    id: 'venus', label: '金星 · Venus-like',
    blurb: '巨厚 CO₂ 大气，表面足以熔化铅的失控温室。',
    seed: 4404,
    params: {
      irradiance: 2611, planeRadiusKm: 6052, gravity: 8.87, pressure: 92,
      co2: 40000, ch4: 0, n2o: 0, o2: 0, n2: 3.5, otherGas: 0.5,
      humidity: 0, cloud: 95, waterInventory: 0, oceanFraction: 0, axialTilt: 177.4,
      rotationSpeed: 0.02, orbitalSpeed: 1.626, eccentricity: 0.0068, aerosolLoad: 1.2,
      oceanColor: '#4a3a2a', tempTint: 0.2, nightLights: 0,
    },
    terrain: { plateCount: 6, fragmentation: 20, relief: 40, seaFloorRelief: 30, oceanTarget: 0.001 },
  },
  {
    id: 'titan', label: '泰坦型 · Titan-like',
    blurb: '寒冷、厚氮大气、甲烷循环与有机尘埃，无自由氧。',
    seed: 6201,
    params: {
      irradiance: 14.8, planeRadiusKm: 2575, gravity: 1.352, pressure: 1.45,
      co2: 20, ch4: 5000, n2o: 0, o2: 0, n2: 94.2, otherGas: 5.6,
      humidity: 40, cloud: 55, waterInventory: 0.05, oceanFraction: 4,
      axialTilt: 26.7, rotationSpeed: 0.06, orbitalSpeed: 0.339, aerosolLoad: 1.1,
      iceAlbedo: 0.7, snowAlbedo: 0.82, oceanColor: '#3c3a28', tempTint: 0.5, nightLights: 0,
    },
    terrain: { plateCount: 10, fragmentation: 50, relief: 30, seaFloorRelief: 25, oceanTarget: 0.04 },
  },
  {
    id: 'desert', label: '干旱超级大陆 · Arid Supercontinent',
    blurb: '海洋仅 12%，内陆极端干旱，昼夜温差巨大。',
    seed: 8123,
    params: {
      co2: 700, humidity: 30, cloud: 25, waterInventory: 0.35, oceanFraction: 12,
      landHeatCapacity: 0.15, aerosolLoad: 0.35, fragmentation: 12, plateCount: 5,
    },
    terrain: { plateCount: 5, fragmentation: 12, relief: 70, seaFloorRelief: 60, oceanTarget: 0.12 },
  },
  {
    id: 'archipelago', label: '群岛世界 · Archipelago',
    blurb: '破碎板块形成的万岛之海，海洋性气候主导。',
    seed: 5150,
    // cloud stays at its original 70. A previous attempt to re-tune it to 64 was made
    // while the calibration was running against the wrong world — the check scripts
    // fed defaults().humidity (68) into the cloud rule instead of the humidity the
    // app's applyAutoRules derives (78), so they modelled cloud cover 60.96 while the
    // app ran 68.2. With CLOUD_ALBEDO_MAX now reproducing the observed cloud radiative
    // effect, no compensating tweak is needed here.
    params: { oceanFraction: 88, humidity: 78, cloud: 70 },
    terrain: { plateCount: 30, fragmentation: 92, relief: 55, seaFloorRelief: 60, oceanTarget: 0.88 },
  },
  {
    id: 'eyeball', label: '潮汐锁定 · Eyeball',
    blurb: '自转极慢的潮汐锁定行星：昼半球海洋、夜半球冰盖。',
    seed: 3301,
    params: {
      irradiance: 1050, co2: 1500, rotationSpeed: 0.02, axialTilt: 0,
      humidity: 70, cloud: 60, oceanFraction: 62, landHeatCapacity: 0.25, oceanHeatCapacity: 9,
    },
    terrain: { plateCount: 12, fragmentation: 40, relief: 50, seaFloorRelief: 45, oceanTarget: 0.62 },
  },
  {
    id: 'ice-moon', label: '冰卫星 · Ice Moon',
    blurb: '数十亿年的冰壳世界，全球平均 ~230 K，生命窗口在冰下海洋。',
    seed: 2718,
    params: {
      irradiance: 50, planeRadiusKm: 1560, gravity: 1.31, pressure: 0.01, co2: 100,
      ch4: 50, n2o: 0, o2: 1, n2: 96, otherGas: 2.9, humidity: 5, cloud: 5,
      waterInventory: 2.5, oceanFraction: 100, iceAlbedo: 0.7, snowAlbedo: 0.85,
      axialTilt: 0.03, rotationSpeed: 1, orbitalSpeed: 1.77, aerosolLoad: 0.05,
      oceanColor: '#33475c', tempTint: 0.5, nightLights: 0,
    },
    terrain: { plateCount: 20, fragmentation: 60, relief: 25, seaFloorRelief: 20, oceanTarget: 1 },
  },
  {
    id: 'alto', label: '高重力海洋行星 · Alto',
    blurb: '2.4 g、半径 1.7 R⊕、全球暖海；云量高、风暴强。',
    seed: 1010,
    params: {
      irradiance: 1520, planeRadiusKm: 10800, gravity: 23.5, pressure: 2.6, co2: 900,
      o2: 26, n2: 71, humidity: 88, cloud: 80, oceanFraction: 94, waterInventory: 2.2,
      oceanHeatCapacity: 9, landHeatCapacity: 0.5, aerosolLoad: 0.25,
    },
    terrain: { plateCount: 10, fragmentation: 30, relief: 30, seaFloorRelief: 35, oceanTarget: 0.94 },
  },
];

export const PRESET_MAP = Object.fromEntries(PRESETS.map((p) => [p.id, p]));
