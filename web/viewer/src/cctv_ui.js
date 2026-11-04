// 가상 CCTV 화면 조각(DOM). 칸의 위치와 크기는 CSS 격자가 정하고, 장면은 그 칸의 영역에 그린다(scene.setCctv).
import { CCTV_LIMITS, orderCameras, pageOf, zoneAlarmed } from './cctv.js';

const $ = (id) => document.getElementById(id);

export class CctvPanel {
  // handlers: { onTiles(list|null) } list = [{ el, def }]
  constructor(handlers, tier = 'mid') {
    this.h = handlers;
    this.limit = CCTV_LIMITS[tier] ?? CCTV_LIMITS.mid;
    this.cams = [];
    this.page = 0;
    this.zoom = null;
    this.sets = { rows: new Set(), cracs: new Set(), any: false };
    this.isOpen = false;
    $('cctv-prev').addEventListener('click', () => this.go(-1));
    $('cctv-next').addEventListener('click', () => this.go(1));
    $('cctv-close').addEventListener('click', () => this.close());
  }

  open(cams, sets, tier = 'mid') {
    const lim = CCTV_LIMITS[tier] ?? CCTV_LIMITS.mid;
    this.limit = { ...lim, tiles: window.innerWidth <= 700 ? Math.min(lim.tiles, 2) : lim.tiles }; // 좁은 화면은 2칸까지
    this.sets = sets;
    this.cams = orderCameras(cams, sets); // 알람 구역을 앞으로
    this.page = 0;
    this.zoom = null;
    this.isOpen = true;
    $('cctv').hidden = false;
    this.render();
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    $('cctv').hidden = true;
    $('cctv-grid').replaceChildren();
    this.h.onTiles(null);
    this.h.onClosed?.();
  }

  go(d) {
    this.zoom = null;
    this.page += d;
    this.render();
  }

  shown() {
    if (this.zoom) return this.cams.filter((c) => c.id === this.zoom);
    return pageOf(this.cams, this.limit.tiles, this.page);
  }

  render() {
    const grid = $('cctv-grid');
    const list = this.shown();
    grid.dataset.n = String(list.length);
    const pages = Math.ceil(this.cams.length / this.limit.tiles);
    const p = ((this.page % pages) + pages) % pages;
    $('cctv-page').textContent = this.zoom ? '크게 보기 (다시 누르면 돌아감)' : `${p + 1} / ${pages}`;
    $('cctv-prev').disabled = $('cctv-next').disabled = !!this.zoom || pages < 2;
    const tiles = list.map((def) => {
      const el = document.createElement('div');
      el.className = 'cctv-tile';
      el.tabIndex = 0;
      el.setAttribute('role', 'button');
      el.setAttribute('aria-label', `${def.name} 카메라. 누르면 크게 보거나 원래대로 돌아간다`);
      el.dataset.id = def.id;
      const name = document.createElement('span');
      name.className = 'cctv-name';
      name.textContent = def.name;
      const tag = document.createElement('span');
      tag.className = 'cctv-tag';
      tag.textContent = '● 가상 CCTV';
      const time = document.createElement('span');
      time.className = 'cctv-time';
      const alarm = document.createElement('span');
      alarm.className = 'cctv-alarm';
      alarm.textContent = '알람';
      el.append(name, tag, time, alarm);
      const toggle = () => {
        this.zoom = this.zoom ? null : def.id;
        this.render();
      };
      el.addEventListener('click', toggle);
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggle();
        }
      });
      return { el, def };
    });
    grid.replaceChildren(...tiles.map((t) => t.el));
    this.tiles = tiles;
    this.setAlarms(this.sets);
    this.h.onTiles(tiles);
  }

  setAlarms(sets) {
    this.sets = sets;
    for (const t of this.tiles ?? []) {
      const hot = zoneAlarmed(t.def, sets);
      t.el.classList.toggle('alarm', hot);
      t.el.querySelector('.cctv-alarm').hidden = !hot;
    }
  }

  setTime(text) {
    if (text === this._time) return;
    this._time = text;
    for (const t of this.tiles ?? []) t.el.querySelector('.cctv-time').textContent = text;
  }
}
