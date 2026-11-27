// Favorite drawing tools: ordered tool ids and a floating bar's position, shared by the
// tool menu and every window. Uses the same settings store as the workspace and watchlist.

import { TOOLS } from './drawings.js';
import { store, esc } from './util.js';
import { t } from './i18n.js';

export const FAVORITE_TOOLS_KEY = 'favoriteTools';
export const FAVORITE_POSITION_KEY = 'favoriteToolsPosition';
export const DEFAULT_POSITION = { x: 16, y: 64 };

/** Only drawing tools (not the cursor or actions); keep their saved order, without repeats. */
export function cleanFavorites(value) {
  return [...new Set((Array.isArray(value) ? value : []).filter((id) => (
    typeof id === 'string' && Object.hasOwn(TOOLS, id) && TOOLS[id].points > 0
  )))];
}

export function cleanPosition(value) {
  return value && Number.isFinite(value.x) && Number.isFinite(value.y)
    ? { x: Math.max(0, value.x), y: Math.max(0, value.y) } : { ...DEFAULT_POSITION };
}

/** Position in chart-area pixels. Leave a small margin, including after a window gets smaller. */
export function clampPosition(position, area, bar) {
  const at = cleanPosition(position);
  const axis = (p, space) => {
    const max = Math.max(0, space);
    const margin = Math.min(8, max / 2);
    return Math.min(max - margin, Math.max(margin, p));
  };
  return { x: axis(at.x, area.width - bar.width), y: axis(at.y, area.height - bar.height) };
}

export class FavoriteToolsState {
  constructor({ storage = store, events = globalThis.window } = {}) {
    this.storage = storage;
    this.events = events;
    this.listeners = new Set();
    this.tools = cleanFavorites(storage.get(FAVORITE_TOOLS_KEY, []));
    this.position = cleanPosition(storage.get(FAVORITE_POSITION_KEY, null));
    this.onStorage = (e) => {
      if (e.key === null || e.key === `wickline.${FAVORITE_TOOLS_KEY}`) {
        this.tools = cleanFavorites(storage.get(FAVORITE_TOOLS_KEY, []));
        this.notify('tools');
      }
      if (e.key === null || e.key === `wickline.${FAVORITE_POSITION_KEY}`) {
        this.position = cleanPosition(storage.get(FAVORITE_POSITION_KEY, null));
        this.notify('position');
      }
    };
    events?.addEventListener('storage', this.onStorage);
  }

  has(id) { return this.tools.includes(id); }

  toggle(id) {
    if (!cleanFavorites([id]).length) return;
    // Read the current list too: another window may have edited it since this one last rendered.
    const tools = cleanFavorites(this.storage.get(FAVORITE_TOOLS_KEY, this.tools));
    this.tools = tools.includes(id) ? tools.filter((x) => x !== id) : [...tools, id];
    this.storage.set(FAVORITE_TOOLS_KEY, this.tools);
    this.notify('tools');
  }

  setPosition(position) {
    this.position = cleanPosition(position);
    this.storage.set(FAVORITE_POSITION_KEY, this.position);
    this.notify('position');
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  notify(kind) { for (const fn of this.listeners) fn(kind); }
  destroy() { this.events?.removeEventListener('storage', this.onStorage); this.listeners.clear(); }
}

/** A workspace-level overlay: switching symbols, timeframes or layouts never recreates it. */
export class FavoriteToolsBar {
  constructor(host, { state, icons, titleOf, onSelect }) {
    this.host = host;
    this.state = state;
    this.icons = icons;
    this.titleOf = titleOf;
    this.active = 'cursor';
    this.drag = null;
    this.el = document.createElement('div');
    this.el.id = 'favorite-tools';
    this.el.className = 'favorite-tools';
    this.el.setAttribute('role', 'toolbar');
    this.el.setAttribute('aria-label', t('draw.favorites.title'));
    this.el.innerHTML = `<button type="button" class="favorite-grip" title="${esc(t('draw.favorites.move'))}" aria-label="${esc(t('draw.favorites.move'))}">
      <svg viewBox="0 0 12 24" width="12" height="24" aria-hidden="true" fill="currentColor">${[7, 12, 17].map((y) => `<circle cx="4" cy="${y}" r="1"/><circle cx="8" cy="${y}" r="1"/>`).join('')}</svg>
    </button><div class="favorite-list"></div>`;
    host.append(this.el);
    this.list = this.el.querySelector('.favorite-list');
    this.grip = this.el.querySelector('.favorite-grip');

    // Neither clicking a tool nor dragging/scrolling this overlay may reach a chart beneath it.
    for (const type of ['pointerdown', 'mousedown', 'click', 'dblclick', 'touchstart']) {
      this.el.addEventListener(type, (e) => e.stopPropagation());
    }
    this.el.addEventListener('click', (e) => {
      const button = e.target.closest('[data-tool]');
      if (button) onSelect(button.dataset.tool);
    });
    this.el.addEventListener('wheel', (e) => {
      e.stopPropagation();
      if (this.list.scrollWidth > this.list.clientWidth) {
        e.preventDefault();
        this.list.scrollLeft += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      }
    }, { passive: false });
    // Keep button activation and overflow navigation local; drawing shortcuts still work.
    this.el.addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.key === 'Enter' || (!e.altKey && !e.ctrlKey && !e.metaKey && ['ArrowLeft', 'ArrowRight'].includes(e.key))) e.stopPropagation();
    });
    this.grip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || this.drag) return;
      e.preventDefault();
      this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, start: { ...this.shownPosition }, position: { ...this.shownPosition } };
      this.grip.setPointerCapture(e.pointerId);
      this.el.classList.add('dragging');
    });
    this.grip.addEventListener('pointermove', (e) => {
      if (!this.drag || this.drag.id !== e.pointerId) return;
      e.preventDefault();
      this.drag.position = { x: this.drag.start.x + e.clientX - this.drag.x, y: this.drag.start.y + e.clientY - this.drag.y };
      this.place();
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      this.grip.addEventListener(type, (e) => { if (this.drag?.id === e.pointerId) this.endDrag(); });
    }
    this.onBlur = () => this.endDrag();
    window.addEventListener('blur', this.onBlur);
    // On narrow screens the chart layout itself can scroll vertically; keep the bar in view.
    this.onScroll = () => this.place();
    host.addEventListener('scroll', this.onScroll, { passive: true });
    this.unsubscribe = state.onChange((kind) => { if (kind === 'tools') this.render(); else this.place(); });
    this.observer = new ResizeObserver(() => this.place());
    this.observer.observe(host);
    this.observer.observe(this.el);
    this.render();
  }

  render() {
    if (!this.state.tools.length) this.endDrag();
    this.el.hidden = !this.state.tools.length;
    const focus = this.list.contains(document.activeElement) ? document.activeElement.dataset.tool : null;
    const scroll = this.list.scrollLeft;
    this.list.innerHTML = this.state.tools.map((id) => `<button type="button" data-tool="${id}" title="${esc(this.titleOf(id))}" aria-label="${esc(this.titleOf(id))}">${this.icons[id]}</button>`).join('');
    this.setActive(this.active);
    if (focus) this.list.querySelector(`[data-tool="${focus}"]`)?.focus({ preventScroll: true });
    this.list.scrollLeft = scroll;
    this.place();
  }

  setActive(tool) {
    this.active = tool;
    for (const button of this.list.querySelectorAll('[data-tool]')) {
      const on = button.dataset.tool === tool;
      button.classList.toggle('on', on);
      button.setAttribute('aria-pressed', String(on));
    }
  }

  place() {
    if (this.el.hidden) return;
    const area = { width: this.host.clientWidth, height: this.host.clientHeight };
    const bar = this.el.getBoundingClientRect();
    this.shownPosition = clampPosition(this.drag?.position || this.state.position, area, bar);
    this.el.style.left = `${this.shownPosition.x + this.host.scrollLeft}px`;
    this.el.style.top = `${this.shownPosition.y + this.host.scrollTop}px`;
  }

  endDrag() {
    if (!this.drag) return;
    const id = this.drag.id;
    this.drag = null;
    this.el.classList.remove('dragging');
    if (this.grip.hasPointerCapture(id)) this.grip.releasePointerCapture(id);
    this.state.setPosition(this.shownPosition);
  }

  destroy() {
    this.endDrag();
    this.unsubscribe();
    this.observer.disconnect();
    window.removeEventListener('blur', this.onBlur);
    this.host.removeEventListener('scroll', this.onScroll);
    this.el.remove();
  }
}
