/**
 * Left parameter panel: collapsible groups, search filtering, lock buttons.
 */

import { PARAMS, PARAM_GROUPS } from '../state/params.js';
import { state, lockCount, setAutoDerive } from '../state/state.js';
import { buildRow, el } from './widgets.js';
import { on } from '../core/bus.js';

export class ParamPanel {
  constructor(host, opts = {}) {
    this.host = host;
    this.onChange = opts.onChange || (() => {});
    this.sections = new Map();
    this.rows = new Map();
    this.collapsed = new Set(['greenhouse', 'surface']);
    this.filter = '';
    this.build();
    on('state:param', () => this.refresh());
    on('state:meta', () => this.refreshLocks());
    on('scene:apply', () => this.refresh());
  }

  build() {
    this.host.textContent = '';
    for (const group of PARAM_GROUPS) {
      const defs = PARAMS.filter((p) => p.group === group.key && p.key !== 'oceanColor');
      if (!defs.length) continue;

      const body = el('div', { class: 'psec-body' });
      const badge = el('span', { class: 'psec-badge', text: '' });
      const caret = el('span', { class: 'psec-caret', text: '▾' });
      const title = el('span', { class: 'psec-title', text: group.label });
      const head = el('div', { class: 'psec-head' }, [caret, title, badge]);
      const sec = el('div', { class: 'psec' + (this.collapsed.has(group.key) ? ' collapsed' : '') }, [head, body]);

      head.addEventListener('click', () => {
        sec.classList.toggle('collapsed');
        if (sec.classList.contains('collapsed')) this.collapsed.add(group.key);
        else this.collapsed.delete(group.key);
      });

      for (const def of defs) {
        const row = buildRow(def, (extra) => this.onChange(extra, def));
        body.append(row);
        this.rows.set(def.key, row);
      }
      this.sections.set(group.key, { sec, body, badge, defs });
      this.host.append(sec);
    }
    this.refreshLocks();
  }

  setFilter(text) {
    this.filter = (text || '').trim().toLowerCase();
    for (const [key, row] of this.rows) {
      const def = PARAMS.find((p) => p.key === key);
      const hay = `${def.label} ${def.key} ${def.help || ''} ${def.unit || ''}`.toLowerCase();
      row.classList.toggle('hidden-by-search', this.filter.length > 0 && !hay.includes(this.filter));
    }
    for (const [, s] of this.sections) {
      const visible = s.defs.some((d) => !this.rows.get(d.key).classList.contains('hidden-by-search'));
      s.sec.style.display = visible ? '' : 'none';
      if (this.filter) s.sec.classList.remove('collapsed');
    }
  }

  refresh() {
    const counts = new Map();
    for (const [key, row] of this.rows) {
      row._sync?.();
      const def = PARAMS.find((p) => p.key === key);
      const c = counts.get(def.group) || { n: 0, locked: 0 };
      c.n++;
      if (state.locks.has(key)) c.locked++;
      counts.set(def.group, c);
    }
    for (const [key, s] of this.sections) {
      const c = counts.get(key) || { n: 0, locked: 0 };
      s.badge.textContent = c.locked ? `${c.n} 项 · ${c.locked} 锁定` : `${c.n} 项`;
    }
    this.refreshLocks();
  }

  refreshLocks() {
    for (const [key, row] of this.rows) {
      const locked = state.locks.has(key);
      row.classList.toggle('locked', locked);
      const btn = row.querySelector('.lock-btn');
      if (btn) {
        btn.classList.toggle('on', locked);
        btn.textContent = locked ? '🔒' : '🔓';
      }
    }
    if (this.summary) this.summary.textContent = `锁定 ${lockCount()} 项`;
  }

  attachFoot(summaryEl) {
    this.summary = summaryEl;
    this.refreshLocks();
  }
}
