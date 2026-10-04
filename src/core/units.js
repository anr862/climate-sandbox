/** Unit conversion helpers. Internal storage is SI-ish metric (K, m, ppm, W/m²). */

export const UNIT_SYSTEMS = {
  metric: { key: 'metric', label: '公制 °C', temp: '°C', len: 'm', lenBig: 'km', mass: 'kg' },
  kelvin: { key: 'kelvin', label: '开尔文 K', temp: 'K', len: 'm', lenBig: 'km', mass: 'kg' },
  imperial: { key: 'imperial', label: '英制 °F', temp: '°F', len: 'ft', lenBig: 'mi', mass: 'lb' },
};

export function tempFromK(k, sysKey) {
  if (sysKey === 'kelvin') return k;
  if (sysKey === 'imperial') return k * 9 / 5 - 459.67;
  return k - 273.15;
}

export function tempToK(v, sysKey) {
  if (sysKey === 'kelvin') return v;
  if (sysKey === 'imperial') return (v + 459.67) * 5 / 9;
  return v + 273.15;
}

export function tempUnit(sysKey) { return UNIT_SYSTEMS[sysKey]?.temp || '°C'; }

/** Delta of temperature (no offset — Kelvin and Celsius deltas are identical). */
export function tempDeltaFromK(dk, sysKey) {
  return sysKey === 'imperial' ? dk * 9 / 5 : dk;
}

export function lengthFromM(m, sysKey) {
  return sysKey === 'imperial' ? m * 3.28084 : m;
}
export function lengthToM(v, sysKey) {
  return sysKey === 'imperial' ? v / 3.28084 : v;
}
export function lengthUnit(sysKey) { return sysKey === 'imperial' ? 'ft' : 'm'; }

export function fmt(v, dec = 2) {
  if (v === null || v === undefined || !isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e6) return (v / 1e6).toFixed(dec) + 'M';
  if (a >= 1e4) return (v / 1e3).toFixed(dec) + 'k';
  return v.toFixed(dec);
}

export function fmtInt(v) {
  if (!isFinite(v)) return '—';
  return Math.round(v).toLocaleString('en-US');
}

export function fmtPressure(atm) {
  return `${atm.toFixed(3)} atm / ${(atm * 1013.25).toFixed(0)} hPa`;
}

export function fmtTime(months) {
  const y = Math.floor(months / 12);
  const m = Math.floor(months % 12) + 1;
  return `Y${y} M${String(m).padStart(2, '0')}`;
}

export function fmtDuration(months) {
  const y = months / 12;
  if (y >= 1000) return `${(y / 1000).toFixed(2)} kyr`;
  if (y >= 1) return `${y.toFixed(y < 10 ? 2 : 1)} yr`;
  return `${months.toFixed(1)} mo`;
}
