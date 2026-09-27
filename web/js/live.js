// Live view: layouts, pages, drag-to-reorder, quality selection and the large "focus" view.
import { LAYOUTS, layoutIds, layoutIcon, slotsOf } from './layouts.js';
import { Tile } from './tile.js';
import { bookmarkDialog, esc, icon, toast, openPopover } from './ui.js';
import { WCPlayer } from './wcplayer.js';
import { api } from './api.js';
import { enhancePanelHTML, wireEnhancePanel, summarizeEnhParams } from './enhancePanel.js';

// The recorder's channel-zero overview stream (Settings > Connection) — a synthetic "camera" that isn't a
// real entry in settings.channels (mirrors app/settings.py's channel_zero_channel), so it never touches
// Arrange order, the Channels tab, or channel counts anywhere else. `channel` is a harmless placeholder,
// same reasoning as the backend's: tile.js/player.js build the go2rtc stream name from `id` alone
// ("chan0_sub"/"chan0_main"), never from `channel`.
const CHAN0_ID = 'chan0';
const CHAN0_CAM = { id: CHAN0_ID, channel: 0, name: 'Channel 0', enabled: true, aspect: 'auto' };
const isChan0 = (cam) => cam?.id === CHAN0_ID;

export class LiveView {
  /** @param ctx { settings(): current settings, saveDisplay(display): Promise, go(hash) } */
  constructor(root, ctx) {
    this.root = root;
    this.ctx = ctx;
    this.page = 0;
    this.edit = false;
    this.rotating = true;
    this.tiles = [];
    this.focus = null;         // { tile, id }
    this.menuOpen = false;
    this.pendingFocusId = null;
    this.zoomMem = {};          // grid zoom per camera, kept while paging/re-laying out
    this.fitOverride = null;   // null = follow Settings > Display > Fit; 'contain'/'cover' = this-session-only override, never saved (see fitMode())
    // Read once at construction (Settings tears down and rebuilds LiveView on any route change — see
    // main.js route() — so a fresh read here already picks up a toggle flipped from within Settings).
    this.tvMode = !!ctx.tvMode?.();
    this.tvQualityPref = ctx.tvQuality?.() || 'sub';
    this.tvIndex = 0;   // currently-selected tile in TV mode's own arrow-key grid navigation
    // TV mode's default view, when channel-zero is available, is that single stream full screen rather
    // than the camera grid — session-only (not persisted): a "Grid" toggle in the subbar can switch back
    // without that choice following you to the next visit.
    this.tvSingleView = this.tvMode && this.channelZeroOn;
    // Set once by Settings right before ctx.go('#/live') (see settings.js's TV-mode confirm flow) —
    // consumed here so a plain reload/return to Live never re-triggers an unrequested full-screen jump.
    this._autoFs = !!ctx.consumeTvFullscreen?.();
    this.onKey = (e) => this.key(e);
    document.addEventListener('keydown', this.onKey);
    this.onFs = () => this.syncFullscreen();
    document.addEventListener('fullscreenchange', this.onFs);
    this.onDoc = (e) => { if (this.menuOpen && !e.target.closest('.menu-wrap')) { this.menuOpen = false; this.renderBar(); } };
    document.addEventListener('click', this.onDoc);
    this.rotTimer = setInterval(() => this.rotate(), 1000);
    this.rotSince = Date.now();
    this.evTimer = setInterval(() => this.pollEvents(), 4000);
    this.pollEvents();
    this.build();
  }

  get s() { return this.ctx.settings(); }
  get d() { return this.s.display; }
  get channelZeroOn() { return !!this.s.connection.channel_zero; }
  fitMode() { return this.fitOverride || this.d.fit; }
  toggleFit() {
    this.fitOverride = this.fitMode() === 'cover' ? 'contain' : 'cover';
    // Just the class — NOT renderWall(), which starts from disposeTiles() and would tear down and
    // reconnect every single camera stream (found directly: every tile went back to "Connecting…") for
    // what should be a purely cosmetic, instant change. Live view's tiles don't need touching at all here.
    this.wall?.classList.toggle('fill', this.fitMode() === 'cover');
    this.renderBar();
    this.focus?.el.classList.toggle('fill', this.fitMode() === 'cover'); // focus is a separate overlay, not inside .wall — kept in sync here too
  }
  cams() {
    const by = Object.fromEntries(this.s.channels.filter((c) => c.enabled).map((c) => [c.id, c]));
    const real = this.d.order.map((id) => by[id]).filter(Boolean);
    // Always first, regardless of the configured camera order — it's the recorder's own overview of
    // everything else in this list, not one more camera slotted in wherever Arrange left it.
    return this.channelZeroOn ? [CHAN0_CAM, ...real] : real;
  }
  slots() { return slotsOf(this.d.layout); }
  pages() { return Math.max(1, Math.ceil(this.cams().length / this.slots())); }

  // ---------------------------------------------------------------- structure
  build() {
    this.disposeTiles();
    const s = this.s;
    if (!s.connection.host) {
      this.root.innerHTML = `<main class="liveview"><div class="center-card"><div class="cc-icon">${icon('plug')}</div>
        <h2>Connect your recorder</h2><p>Enter the IP address and login of your DVR or camera to see the live video.</p>
        <a class="btn primary" href="#/settings/connection">Open settings</a></div></main>`;
      return;
    }
    if (!this.cams().length) {
      this.root.innerHTML = `<main class="liveview"><div class="center-card"><div class="cc-icon">${icon('video')}</div>
        <h2>No cameras yet</h2><p>Add or enable channels to start watching.</p><a class="btn primary" href="#/settings/channels">Manage channels</a></div></main>`;
      return;
    }
    this.root.innerHTML = `<main class="liveview"><div class="subbar"></div><div class="wall"></div>
      <div class="tv-fs-controls">
        <button class="tv-fs-btn" data-a="pgprev" title="Previous page" aria-label="Previous page">${icon('left')}</button>
        <span class="tv-fs-page"></span>
        <button class="tv-fs-btn" data-a="pgnext" title="Next page" aria-label="Next page">${icon('right')}</button>
        <button class="tv-fs-btn" data-a="wallfs" title="Exit full screen (F)" aria-label="Exit full screen">${icon('fullscreen')}</button>
      </div></main>`;
    this.live = this.root.querySelector('.liveview');
    this.bar = this.root.querySelector('.subbar');
    this.wall = this.root.querySelector('.wall');
    this.wall.addEventListener('focusin', (e) => this._tvFocusIn(e));
    this.live.querySelector('[data-a=wallfs]').addEventListener('click', () => this.toggleFullscreen(this.live));
    this.live.querySelector('[data-a=pgprev]').addEventListener('click', () => this.goPage(this.page - 1));
    this.live.querySelector('[data-a=pgnext]').addEventListener('click', () => this.goPage(this.page + 1));
    this._bindWallFsAutoHide();
    this.page = Math.min(this.page, this.pages() - 1);
    this.renderBar();
    this.renderWall();
    if (this.pendingFocusId) this.route(this.pendingFocusId);
  }

  // TV mode + full screen on the grid itself (not a single camera's own focus view, which already has
  // _bindFocusAutoHide): the subbar disappears entirely (CSS, gated to html.tv-mode .liveview:fullscreen)
  // so the wall of cameras is the only thing on screen, and this floating cluster — page prev/next (when
  // there's more than one page), a page indicator, and exit — is what's left to control it. Hidden until
  // you move the mouse or touch the screen, same idle cycle as _bindFocusAutoHide. A no-op everywhere else:
  // outside that exact fullscreen+TV-mode state the cluster stays display:none regardless of .show.
  _bindWallFsAutoHide() {
    const el = this.live.querySelector('.tv-fs-controls');
    let hideTimer;
    const hide = () => el.classList.remove('show');
    const show = () => {
      el.classList.add('show');
      clearTimeout(hideTimer);
      hideTimer = setTimeout(hide, 2600);
    };
    this.live.addEventListener('mousemove', show);
    this.live.addEventListener('mouseenter', show);
    this.live.addEventListener('touchstart', show, { passive: true });
    show();
  }

  /** Keeps the floating fullscreen page controls in sync with the real pager — called from renderBar(),
   * which already recomputes pages()/this.page on every layout, camera, or page change. */
  _syncFsControls() {
    const el = this.live?.querySelector('.tv-fs-controls');
    if (!el) return;
    const single = this.tvMode && this.channelZeroOn && this.tvSingleView;
    const pages = this.pages(), multi = !single && pages > 1;
    el.querySelector('[data-a=pgprev]').hidden = !multi;
    el.querySelector('[data-a=pgnext]').hidden = !multi;
    el.querySelector('.tv-fs-page').textContent = multi ? `${this.page + 1}/${pages}` : '';
  }

  renderBar() {
    if (!this.bar) return;
    const d = this.d, pages = this.pages(), q = this.effQuality();
    // TV mode's channel-zero single view replaces the grid entirely — no layout/order/Arrange to offer,
    // just the one stream — so those controls give way to a single toggle back to the grid.
    const single = this.tvMode && this.channelZeroOn && this.tvSingleView;
    const canToggleView = this.tvMode && this.channelZeroOn;
    const seg = (v, label, tip) => `<button data-q="${v}" aria-pressed="${q === v}" title="${tip}">${label}</button>`;
    this.bar.innerHTML = `
      ${single ? '' : `<div class="menu-wrap">
        <button class="btn" data-a="layout" aria-haspopup="true" aria-expanded="${this.menuOpen}">${layoutIcon(d.layout, 22)} ${LAYOUTS[d.layout].label} ${icon('down')}</button>
        ${this.menuOpen ? `<div class="menu" style="left:0;right:auto;min-width:250px"><div class="lay">${layoutIds.map((id) =>
          `<button data-l="${id}" aria-pressed="${d.layout === id}">${layoutIcon(id, 40)}<span>${LAYOUTS[id].label}</span></button>`).join('')}</div></div>` : ''}
      </div>`}
      <div class="seg" role="group" aria-label="Video quality">
        ${seg('auto', 'Auto', 'HD for large tiles and the large view, SD for small tiles')}${seg('sub', 'SD', 'Always use the lighter sub-stream')}${seg('main', 'HD', 'Always use the full quality main stream')}
      </div>
      <button class="btn" data-a="fit" aria-pressed="${this.fitMode() === 'cover'}"
        title="${this.fitMode() === 'cover' ? 'Filling tiles (cropped to fill, nothing letterboxed) — tap to letterbox instead. This session only, not saved.' : 'Letterboxed to fit — tap to fill tiles instead (crops the picture). This session only, not saved.'}">
        ${icon('crop')} ${this.fitMode() === 'cover' ? 'Fill' : 'Fit'}
      </button>
      ${canToggleView
        ? `<button class="btn" data-a="tvview" title="${single ? 'Switch to the camera grid' : "Back to the recorder's Channel 0 overview"}">${icon(single ? 'live' : 'monitor')} ${single ? 'Grid' : 'Channel 0'}</button>`
        : `<button class="btn" data-a="edit" aria-pressed="${this.edit}" title="Drag tiles to change their order (E)">${icon('move')} Arrange</button>`}
      ${!single && d.rotate_seconds > 0 && pages > 1 ? `<button class="btn" data-a="rotate" aria-pressed="${this.rotating}" title="Auto-rotate pages every ${d.rotate_seconds}s">${icon(this.rotating ? 'pause' : 'play')} Rotate</button>` : ''}
      <span class="spacer"></span>
      ${!single && pages > 1 ? `<div class="pager"><button class="btn icon ghost" data-a="prev" aria-label="Previous page">${icon('left')}</button>
        <div class="dots">${Array.from({ length: pages }, (_, i) => `<button data-p="${i}" aria-label="Page ${i + 1}" aria-current="${i === this.page}"></button>`).join('')}</div>
        <span>${this.page + 1} / ${pages}</span><button class="btn icon ghost" data-a="next" aria-label="Next page">${icon('right')}</button></div>` : ''}
      <span class="pill" title="Cameras currently showing live video"><span class="dot ${this.liveCount === this.tiles.length && this.tiles.length ? 'live' : 'wait'}"></span><span class="livecount">${this.liveCount ?? 0}/${this.tiles.length} live</span></span>
      <button class="btn icon" data-a="wallfs" title="Full screen" aria-label="Full screen">${icon('fullscreen')}</button>`;
    this.bar.querySelector('[data-a=layout]')?.addEventListener('click', (e) => { e.stopPropagation(); this.menuOpen = !this.menuOpen; this.renderBar(); });
    this.bar.querySelectorAll('[data-l]').forEach((b) => b.addEventListener('click', () => this.setDisplay({ layout: b.dataset.l }, true)));
    this.bar.querySelectorAll('[data-q]').forEach((b) => b.addEventListener('click', () => {
      // TV mode: this control still works, it just writes to the local TV-only preference (see
      // effQuality()) instead of the setting every other device shares — flipping a TV to HD shouldn't
      // change what a phone on the same server defaults to next time it opens.
      if (this.tvMode) { this.tvQualityPref = b.dataset.q; this.ctx.setTvQuality?.(b.dataset.q); this.renderBar(); this.renderWall(); }
      else this.setDisplay({ quality: b.dataset.q }, true);
    }));
    this.bar.querySelector('[data-a=fit]').addEventListener('click', () => this.toggleFit());
    this.bar.querySelector('[data-a=edit]')?.addEventListener('click', () => this.toggleEdit());
    this.bar.querySelector('[data-a=tvview]')?.addEventListener('click', () => { this.tvSingleView = !this.tvSingleView; this.renderBar(); this.renderWall(); });
    this.bar.querySelector('[data-a=rotate]')?.addEventListener('click', () => { this.rotating = !this.rotating; this.rotSince = Date.now(); this.renderBar(); });
    this.bar.querySelector('[data-a=prev]')?.addEventListener('click', () => this.goPage(this.page - 1));
    this.bar.querySelector('[data-a=next]')?.addEventListener('click', () => this.goPage(this.page + 1));
    this.bar.querySelectorAll('[data-p]').forEach((b) => b.addEventListener('click', () => this.goPage(+b.dataset.p)));
    this.bar.querySelector('[data-a=wallfs]').addEventListener('click', () => this.toggleFullscreen(this.live));
    this._syncFsControls();
  }

  // TV mode's own Auto/SD/HD choice in place of the synced Settings one (see main.js's tvQuality) — same
  // "auto" rule either way (HD only for the one big/large tile, SD for the rest), just pointed at whichever
  // preference is active. Defaults to SD (a full wall of simultaneous HD decodes is what was actually
  // lagging on the Tizen browser this was built for) but a TV browser with room for it can switch to HD
  // from the same quality control every other client uses.
  effQuality() { return this.tvMode ? this.tvQualityPref : this.d.quality; }
  qualityFor(cell) {
    const q = this.effQuality();
    return q === 'main' ? 'main' : q === 'sub' ? 'sub' : cell.big ? 'main' : 'sub';
  }

  renderWall() {
    if (!this.wall) return;
    if (this.tvMode && this.channelZeroOn && this.tvSingleView) { this._renderTvSingleView(); return; }
    this.disposeTiles();
    const layout = LAYOUTS[this.d.layout], slots = layout.cells.length, cams = this.cams();
    const w = this.wall;
    w.className = 'wall' + (this.edit ? ' editing' : '') + (this.fitMode() === 'cover' ? ' fill' : '');
    w.style.gridTemplateColumns = `repeat(${layout.cols}, minmax(0, 1fr))`;
    w.style.gridTemplateRows = `repeat(${layout.rows}, minmax(0, 1fr))`;
    w.style.setProperty('--fit', this.d.fit);
    w.innerHTML = '';
    layout.cells.forEach((cell, i) => {
      const cam = cams[this.page * slots + i];
      let el;
      if (cam) {
        // Channel-zero isn't a real DVR channel with its own recording/event timeline, so instant replay
        // and bookmarking (both keyed to a real channel number server-side) don't apply to it — omitted
        // rather than wired up to fail.
        const chan0 = isChan0(cam);
        const t = new Tile(cam, {
          kind: this.qualityFor(cell), display: this.d, chrome: true, tv: this.tvMode,
          zoomInit: this.zoomMem[cam.id],
          onZoom: (id, st) => { if (st.s > 1.001) this.zoomMem[id] = st; else delete this.zoomMem[id]; },
          onFocus: () => this.ctx.go(`#/live/${cam.id}`),
          onUpdate: () => this.countLive(),
          onHevcFallback: () => toast('This browser could not play H.265, so HD now uses a converted H.264 stream.', 'ok', 7000),
          onKindFail: (tile, kind) => toast(`${cam.name || 'Camera'}: the ${kind === 'main' ? 'HD' : 'SD'} stream could not be started. Keeping the current stream.`, 'bad', 6000),
          onReplay: chan0 ? null : () => this.openReplay(cam),
          onBookmark: chan0 ? null : () => this.bookmarkNow(cam),
        });
        t.cellIndex = i;
        this.tiles.push(t);
        el = t.el;
        this.bindDrag(el, cam.id);
      } else {
        el = document.createElement('div');
        el.className = 'tile empty';
        el.textContent = 'Empty';
      }
      el.style.gridColumn = `${cell.c} / span ${cell.w}`;
      el.style.gridRow = `${cell.r} / span ${cell.h}`;
      w.append(el);
    });
    this.liveCount = 0;
    if (this.tvMode) {
      this.tvIndex = Math.max(0, Math.min(this.tiles.length - 1, this.tvIndex));
      this.tiles[this.tvIndex]?.el.querySelector('.hit')?.focus({ preventScroll: true });
    }
  }

  /** TV mode's default view when channel-zero is on: just that one stream, filling the wall — no grid,
   * no per-camera actions that don't apply to it (see the chan0 comment above), no Arrange. The subbar's
   * "Grid" button (renderBar) switches back to the normal TV-mode camera grid. */
  _renderTvSingleView() {
    this.disposeTiles();
    const w = this.wall;
    w.className = 'wall tv-single' + (this.fitMode() === 'cover' ? ' fill' : '');
    w.style.gridTemplateColumns = '1fr';
    w.style.gridTemplateRows = '1fr';
    w.style.setProperty('--fit', this.d.fit);
    w.innerHTML = '';
    const kind = this.effQuality() === 'main' ? 'main' : 'sub';
    const t = new Tile(CHAN0_CAM, {
      kind, display: this.d, chrome: true, tv: this.tvMode,
      onZoom: () => {},
      onFocus: null,
      onUpdate: () => this.countLive(),
      onHevcFallback: () => toast('This browser could not play H.265, so HD now uses a converted H.264 stream.', 'ok', 7000),
      onKindFail: () => toast('The stream could not be started. Keeping the current one.', 'bad', 6000),
      onReplay: null,
      onBookmark: null,
    });
    this.tiles.push(t);
    t.el.style.gridColumn = '1 / span 1';
    t.el.style.gridRow = '1 / span 1';
    w.append(t.el);
    this.liveCount = 0;
    if (this._autoFs) {
      this._autoFs = false;
      // Only ever fires once, right after the confirm-dialog flow in settings.js (ctx.armTvFullscreen) —
      // that click is real user activation, but the settings save it waited on eats into how long the
      // browser considers that activation still "fresh"; if it's expired by the time we get here,
      // requestFullscreen rejects quietly and the floating fullscreen button (subbar) still works normally.
      this.live.requestFullscreen?.().catch(() => {});
    }
  }

  countLive() {
    const n = this.tiles.filter((t) => t.state === 'live').length;
    if (n === this.liveCount) return;
    this.liveCount = n;
    const pill = this.bar?.querySelector('.livecount');
    if (pill) {
      pill.textContent = `${n}/${this.tiles.length} live`;
      pill.previousElementSibling.className = `dot ${n === this.tiles.length ? 'live' : 'wait'}`;
    }
  }

  disposeTiles() { this.tiles.forEach((t) => t.dispose()); this.tiles = []; }

  // ---------------------------------------------------------------- actions
  async setDisplay(patch, rebuild) {
    const next = { ...this.d, ...patch };
    this.menuOpen = false;
    try {
      const saved = await this.ctx.saveDisplay(next);
      Object.assign(this.s.display, saved);
    } catch (e) { toast(e.message, 'bad'); return; }
    if ('layout' in patch) this.page = 0;
    this.page = Math.min(this.page, this.pages() - 1);
    this.renderBar();
    if (rebuild) this.renderWall();
  }

  goPage(p) {
    const n = this.pages();
    this.page = ((p % n) + n) % n;
    this.rotSince = Date.now();
    this.renderBar();
    this.renderWall();
  }

  toggleEdit(force) {
    this.edit = force ?? !this.edit;
    this.wall?.classList.toggle('editing', this.edit);
    this.tiles.forEach((t) => { t.el.draggable = this.edit; });
    this.renderBar();
    if (this.edit) toast('Drag a camera onto another one to change the order.', 'ok', 3500);
  }

  rotate() {
    const sec = this.d.rotate_seconds;
    if (!sec || !this.rotating || this.edit || this.focus || this.pages() < 2 || document.hidden) return;
    if (Date.now() - this.rotSince >= sec * 1000) this.goPage(this.page + 1);
  }

  bindDrag(el, id) {
    el.draggable = this.edit;
    el.addEventListener('dragstart', (e) => { if (!this.edit) return; this.dragId = id; el.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', id); });
    el.addEventListener('dragend', () => { el.classList.remove('dragging'); this.wall.querySelectorAll('.over').forEach((x) => x.classList.remove('over')); });
    el.addEventListener('dragover', (e) => { if (this.edit && this.dragId && this.dragId !== id) { e.preventDefault(); el.classList.add('over'); } });
    el.addEventListener('dragleave', () => el.classList.remove('over'));
    el.addEventListener('drop', (e) => { e.preventDefault(); el.classList.remove('over'); if (this.edit && this.dragId && this.dragId !== id) this.reorder(this.dragId, id); this.dragId = null; });
  }

  async reorder(fromId, toId) {
    const order = [...this.d.order];
    const from = order.indexOf(fromId), to = order.indexOf(toId);
    if (from < 0 || to < 0) return;
    order.splice(to, 0, order.splice(from, 1)[0]);
    try {
      const saved = await this.ctx.saveDisplay({ ...this.d, order });
      Object.assign(this.s.display, saved);
    } catch (e) { toast(e.message, 'bad'); return; }
    this.renderWall();
    if (this.edit) this.tiles.forEach((t) => { t.el.draggable = true; });
  }

  // ---------------------------------------------------------------- focus (large view)
  route(id) {
    this.pendingFocusId = id || null;
    if (!this.wall) return;
    if (!id) { if (this.focus) this.closeFocus(); return; }
    if (this.focus?.id === id) return;
    const cam = this.cams().find((c) => c.id === id);
    if (!cam) { this.ctx.go('#/live'); return; }
    this.openFocus(cam);
  }

  openFocus(cam) {
    // Swapping cameras while focused (nav arrows, or ArrowLeft/Right) goes through close-then-reopen — if
    // that's happening while fullscreen, remember it: the element about to close is what's actually
    // fullscreened, and the browser exits fullscreen on its own the instant it's removed from the DOM
    // (standard behaviour, not something this code controls), so without re-requesting it on the new
    // element below, every camera swap silently dropped out of fullscreen (found directly, not assumed).
    const wasFullscreen = this.focus && document.fullscreenElement === this.focus.el;
    this.closeFocus(true);
    this.toggleEdit(false);
    const cams = this.cams();
    const idx = cams.findIndex((c) => c.id === cam.id);
    const kind = this.effQuality() === 'sub' ? 'sub' : 'main';

    // Seamless upgrade: reuse the tile already running in the grid (same player, same connection) instead
    // of disposing it and opening a fresh one — no reconnect, no black frame, and the grid's other tiles
    // (and this one, once we hand it back) keep playing behind the overlay. If the camera isn't on the
    // current page (e.g. a direct link), there's no running tile to reuse — fall back to a fresh one.
    const fromGrid = this.tiles.find((t) => t.cam.id === cam.id) || null;
    const tile = fromGrid || new Tile(cam, { kind, display: this.d, chrome: false,
      onHevcFallback: () => toast('This browser could not play H.265, so HD now uses a converted H.264 stream.', 'ok', 7000),
      onKindFail: (t, k) => toast(`The ${k === 'main' ? 'HD' : 'SD'} stream could not be started.`, 'bad', 6000) });
    tile.opts.onUpdate = (t) => this.paintFocus(t);
    // The focus bar is its own header, not the grid tile's own chrome (which is hidden while in focus —
    // see .tile.in-focus's own CSS comment), so the "filters active" pill needs its own copy kept in sync.
    tile.opts.onFxChange = (active) => { const t = this.focus?.el.querySelector('.tag.fx'); if (t) t.hidden = !active; };
    if (fromGrid) {
      tile.el.remove();               // detach from the wall; the tile/player object itself stays alive
      tile.el.classList.add('in-focus');
    }

    const f = document.createElement('div');
    f.className = 'focus' + (this.fitMode() === 'cover' ? ' fill' : '');
    f.innerHTML = `<div class="focus-bar">
        <button class="btn" data-a="close">${icon('left')} Back</button>
        <h2>${esc(cam.name || 'Camera ' + cam.channel)}</h2><span class="tag fx" ${summarizeEnhParams(tile.enhParams).active ? '' : 'hidden'} title="Live filters active">${icon('wand')}</span><span class="pill stat"></span><span class="spacer"></span>
        <div class="seg" role="group" aria-label="Video quality"><button data-k="sub">SD</button><button data-k="main">HD</button></div>
        <div class="zoomctl" role="group" aria-label="Zoom"><button class="btn icon" data-a="zout" title="Zoom out (-)" aria-label="Zoom out">${icon('minus')}</button>
          <button class="btn pct" data-a="zreset" title="Reset zoom (0)">100%</button><button class="btn icon" data-a="zin" title="Zoom in (+)" aria-label="Zoom in">${icon('plus')}</button></div>
        <button class="btn icon" data-a="snap" title="Save snapshot" aria-label="Save snapshot">${icon('camera')}</button>
        <button class="btn icon" data-a="replay" title="Instant replay (last 10s)" aria-label="Instant replay">${icon('rewind')}</button>
        <button class="btn icon" data-a="bookmark" title="Bookmark this moment" aria-label="Bookmark this moment">${icon('flag')}</button>
        <div class="menu-wrap enh-wrap"><button class="btn icon" data-a="enhance" title="Live enhancement" aria-label="Live enhancement" aria-haspopup="true">${icon('wand')}</button></div>
        <button class="btn icon" data-a="fit" aria-pressed="${this.fitMode() === 'cover'}"
          title="${this.fitMode() === 'cover' ? 'Filling (cropped) — tap to letterbox instead. This session only.' : 'Letterboxed to fit — tap to fill instead (crops). This session only.'}"
          aria-label="Toggle fit or fill">${icon('crop')}</button>
        <button class="btn icon" data-a="fs" title="Full screen (F)" aria-label="Full screen">${icon('fullscreen')}</button>
        <button class="btn icon ghost" data-a="x" title="Close (Esc)" aria-label="Close">${icon('close')}</button>
      </div><div class="stage-host" style="position:relative;flex:1;min-height:0"></div>
      ${cams.length > 1 ? `<button class="nav-arrow prev" aria-label="Previous camera">${icon('left')}</button><button class="nav-arrow next" aria-label="Next camera">${icon('right')}</button>` : ''}`;
    tile.el.style.cssText = 'position:absolute;inset:0;border:0;border-radius:0';
    f.querySelector('.stage-host').append(tile.el);
    const hit = document.createElement('div');
    hit.className = 'hitzone';
    f.querySelector('.stage-host').append(hit);
    tile.enableZoom(hit, { dbl: true });   // single click does nothing (never pauses); double click/tap toggles zoom
    this.live.append(f);
    this.focus = { tile, id: cam.id, el: f, idx, fromGrid: !!fromGrid };
    // Carry fullscreen across the swap (see the wasFullscreen comment above) — the old element's removal
    // above already dropped the browser out of fullscreen, so this is a fresh request, not a toggle.
    if (wasFullscreen) f.requestFullscreen?.().catch(() => {});
    f.querySelector('[data-a=close]').addEventListener('click', () => this.ctx.go('#/live'));
    f.querySelector('[data-a=x]').addEventListener('click', () => this.ctx.go('#/live'));
    f.querySelector('[data-a=snap]').addEventListener('click', () => { if (!tile.snapshot()) toast('No picture to save yet.', 'bad'); });
    f.querySelector('[data-a=replay]').addEventListener('click', () => this.openReplay(cam));
    f.querySelector('[data-a=bookmark]').addEventListener('click', () => this.bookmarkNow(cam));
    f.querySelector('[data-a=fs]').addEventListener('click', () => this.toggleFullscreen(f));
    f.querySelector('[data-a=fit]').addEventListener('click', () => {
      this.toggleFit();
      const btn = f.querySelector('[data-a=fit]');
      const on = this.fitMode() === 'cover';
      btn.setAttribute('aria-pressed', String(on));
      btn.title = on ? 'Filling (cropped) — tap to letterbox instead. This session only.' : 'Letterboxed to fit — tap to fill instead (crops). This session only.';
    });
    f.querySelector('[data-a=enhance]').addEventListener('click', () => this._toggleFocusEnhanceMenu(tile));
    f.querySelector('[data-a=zin]').addEventListener('click', () => tile.zoom.zoomBy(1.6));
    f.querySelector('[data-a=zout]').addEventListener('click', () => tile.zoom.zoomBy(1 / 1.6));
    f.querySelector('[data-a=zreset]').addEventListener('click', () => tile.zoom.reset());
    f.querySelectorAll('[data-k]').forEach((b) => b.addEventListener('click', () => tile.setKind(b.dataset.k)));
    f.querySelector('.prev')?.addEventListener('click', () => this.stepFocus(-1));
    f.querySelector('.next')?.addEventListener('click', () => this.stepFocus(1));
    if (tile.kind !== kind) tile.setKind(kind);   // upgrade in place (gapless swap already built into Tile)
    this.paintFocus(tile);
    this._bindFocusAutoHide(f);
  }

  // Same show-on-activity/hide-while-idle cycle Playback's topline/controls use, not a :hover reveal — see
  // .focus:fullscreen's own CSS comment for why. A harmless no-op in windowed mode (nothing there reads the
  // .show class the CSS only applies under .focus:fullscreen). Listeners live on `f` itself, so they're
  // discarded along with it on close/swap — no separate teardown needed.
  _bindFocusAutoHide(f) {
    const bar = f.querySelector('.focus-bar');
    const arrows = f.querySelectorAll('.nav-arrow');
    let hideTimer;
    const hide = () => { bar.classList.remove('show'); arrows.forEach((a) => a.classList.remove('show')); };
    const show = () => {
      bar.classList.add('show');
      arrows.forEach((a) => a.classList.add('show'));
      clearTimeout(hideTimer);
      hideTimer = setTimeout(hide, 2600);
    };
    f.addEventListener('mousemove', show);
    f.addEventListener('mouseenter', show);
    f.addEventListener('touchstart', show, { passive: true });
    show();
  }

  paintFocus(tile) {
    const f = this.focus?.el;
    if (!f || this.focus.tile !== tile) return;
    f.querySelectorAll('[data-k]').forEach((b) => b.setAttribute('aria-pressed', String(tile.kind === b.dataset.k)));
    const z = tile.zoom;
    if (z) {
      f.querySelector('.pct').textContent = `${z.percent}%`;
      f.querySelector('[data-a=zin]').disabled = z.atMax;
      f.querySelector('[data-a=zout]').disabled = !z.zoomed;
      f.querySelector('[data-a=zreset]').disabled = !z.zoomed;
    }
    const pill = f.querySelector('.stat');
    const pending = tile.pend ? ` · loading ${tile.pend.kind === 'main' ? 'HD' : 'SD'}…` : '';
    pill.textContent = (tile.summary() || (tile.state === 'live' ? 'live' : 'connecting…')) + pending;
  }

  stepFocus(dir) {
    const cams = this.cams();
    if (cams.length < 2 || !this.focus) return;
    const i = (cams.findIndex((c) => c.id === this.focus.id) + dir + cams.length) % cams.length;
    this.ctx.go(`#/live/${cams[i].id}`);
  }

  closeFocus(silent) {
    if (!this.focus) return;
    // silent: this is openFocus() swapping to a different camera, not a genuine close — the caller decides
    // whether to carry fullscreen over to the new element (see openFocus's wasFullscreen), not this exit.
    if (!silent && document.fullscreenElement === this.focus.el) document.exitFullscreen?.();
    const { tile, fromGrid } = this.focus;
    if (fromGrid && this.tiles.includes(tile)) {
      // hand the still-running tile back to its grid cell — no reconnect, no black frame
      tile.zoom?.reset(false);
      tile.el.classList.remove('in-focus');
      tile.el.style.cssText = '';
      tile.opts.onUpdate = () => this.countLive();
      tile.enableZoom(tile.el.querySelector('.hit'), { dbl: false });   // back to grid rules: click opens focus, no dbl-click zoom
      const cell = LAYOUTS[this.d.layout].cells[tile.cellIndex];
      if (cell) { tile.el.style.gridColumn = `${cell.c} / span ${cell.w}`; tile.el.style.gridRow = `${cell.r} / span ${cell.h}`; }
      const wantKind = this.qualityFor(cell || {});
      if (tile.kind !== wantKind) tile.setKind(wantKind);
      this.wall.append(tile.el);
    } else {
      tile.dispose();
    }
    this.focus.el.remove();
    this.focus = null;
    if (!silent && !fromGrid) this.renderWall();   // the borrowed-tile case needs no rebuild — everything else kept running
  }

  // ---------------------------------------------------------------- live event badges
  // Polls the same unified event index the timeline/playback UI reads (fed live by the DVR's
  // alertStream subscriber — see app/events.py AlertStreamSubscriber) for anything active or that
  // just ended, and paints small badges onto each grid tile for its channel.
  async pollEvents() {
    try {
      const since = new Date(Date.now() - 20000).toISOString();
      const r = await fetch(`/api/timeline/events?start_utc=${encodeURIComponent(since)}&limit=200`);
      if (!r.ok) return;
      const rows = await r.json();
      const byChannel = new Map();
      for (const row of rows) {
        if (!byChannel.has(row.channel)) byChannel.set(row.channel, new Set());
        byChannel.get(row.channel).add(row.kind);
      }
      for (const t of this.tiles) t.setBadges(byChannel.get(t.cam.channel));
    } catch { /* transient network hiccup — next poll retries */ }
  }

  // ---------------------------------------------------------------- bookmarks (spec section 9/11.6)
  async bookmarkNow(cam) {
    const r = await bookmarkDialog({ subtitle: `${cam.name || 'Camera ' + cam.channel} · right now` });
    if (!r) return;
    try {
      await api.createBookmark({ channels: [cam.id], time_utc: new Date().toISOString(), ...r });
      toast('Bookmark saved.', 'ok');
    } catch (e) {
      toast(e.message || 'Could not save the bookmark', 'bad');
    }
  }

  // ---------------------------------------------------------------- L0 live enhancement (focus bar)
  // The focus view's control bar lives outside the Tile's own element (unlike the grid tile's built-in
  // popover), so it gets its own small menu here rather than reusing Tile._toggleEnhanceMenu — both just
  // end up driving the same tile.enhParams. This is also what fullscreen shows (wall fullscreen keeps the
  // grid's own per-tile hover controls; opening a tile in focus — including fullscreen focus — used to have
  // no enhancement control at all, found by checking, not assumed working from the grid case.
  _toggleFocusEnhanceMenu(tile) {
    const btn = this.focus?.el.querySelector('[data-a=enhance]');
    if (!btn) return;
    const menu = openPopover(btn, enhancePanelHTML({}), { className: 'enh-menu enh2-panel' });
    if (!menu) return;
    wireEnhancePanel(menu, {
      getParams: () => tile.enhParams,
      onPreset: (name) => tile.applyEnhancePreset(name),
      onParam: (key, value) => tile.applyEnhParam(key, value),
    });
  }

  // ---------------------------------------------------------------- instant replay
  // A dedicated small overlay that opens a real playback session (WCPlayer over /api/playback/ws)
  // starting ~10s in the past and playing forward at 1x, rather than a client-side ring buffer — this
  // reuses the already-verified DVR playback path instead of new plumbing. Counts against the DVR's
  // 4-session playback cap like any other playback stream; released the moment it's closed.
  openReplay(cam, seconds = 10) {
    this.closeReplay();
    const r = document.createElement('div');
    r.className = 'replay-overlay';
    r.innerHTML = `<div class="replay-bar">
        ${icon('rewind')} <span>Instant replay · ${esc(cam.name || 'Camera ' + cam.channel)}</span>
        <span class="pill stat">starting…</span><span class="spacer"></span>
        <button class="btn primary" data-a="live">${icon('play')} Back to live</button>
        <button class="btn icon ghost" data-a="x" title="Close (Esc)" aria-label="Close">${icon('close')}</button>
      </div><div class="replay-stage"><canvas></canvas></div>`;
    this.live.append(r);
    const canvas = r.querySelector('canvas');
    const pill = r.querySelector('.stat');
    const player = new WCPlayer(canvas, {
      onState: (s) => { pill.textContent = s === 'playing' ? 'replaying' : s === 'queued' ? 'waiting for a recorder session…' : s; },
      onError: (msg) => { pill.textContent = 'error'; toast(`Instant replay: ${msg}`, 'bad', 6000); },
    });
    if (!player.supported) { toast('This browser does not support instant replay (WebCodecs unavailable).', 'bad'); r.remove(); return; }
    const startIso = new Date(Date.now() - seconds * 1000).toISOString();
    player.connect(cam.id, startIso, '1');
    this.replay = { el: r, player, cam };
    r.querySelector('[data-a=live]').addEventListener('click', () => this.closeReplay());
    r.querySelector('[data-a=x]').addEventListener('click', () => this.closeReplay());
  }

  closeReplay() {
    if (!this.replay) return;
    this.replay.player.destroy();
    this.replay.el.remove();
    this.replay = null;
  }

  /** Called by main.js when the tab/installed app regains visibility (see Tile.resume's own comment for
   * why this is needed at all — a backgrounded iOS home-screen app's network connections die well before
   * anything else does). Every live tile gets kicked, including whichever one is open in the large view. */
  resume() {
    this.tiles.forEach((t) => t.resume());
    this.focus?.tile.resume();
  }

  // ---------------------------------------------------------------- fullscreen & keys
  toggleFullscreen(el) {
    if (document.fullscreenElement) document.exitFullscreen();
    else el?.requestFullscreen?.().catch(() => toast('Full screen is not available here.', 'bad'));
  }
  syncFullscreen() {}

  key(e) {
    if (!this.wall || e.target?.closest?.('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (document.getElementById('modal-root').firstChild) return;
    const k = e.key;
    if (this.replay) { if (k === 'Escape') this.closeReplay(); return; }
    if (this.focus) {
      if (k === 'Escape' && !document.fullscreenElement) { if (this.focus.tile.zoom?.zoomed) this.focus.tile.zoom.reset(); else this.ctx.go('#/live'); }
      else if (k === '+' || k === '=') this.focus.tile.zoom?.zoomBy(1.6);
      else if (k === '-' || k === '_') this.focus.tile.zoom?.zoomBy(1 / 1.6);
      else if (k === '0') this.focus.tile.zoom?.reset();
      else if (k === 'ArrowLeft') this.stepFocus(-1);
      else if (k === 'ArrowRight') this.stepFocus(1);
      else if (k === 'f' || k === 'F') this.toggleFullscreen(this.focus.el);
      else if (k === 's' || k === 'S') this.focus.tile.snapshot();
      else if (k === 'h' || k === 'H') this.focus.tile.setKind(this.focus.tile.kind === 'main' ? 'sub' : 'main');
      else if (k === 'b' || k === 'B') this.bookmarkNow(this.focus.tile.cam);
      return;
    }
    // TV mode: arrow keys move a selection cursor between tiles instead of paging — a D-pad's arrow keys
    // don't move focus between elements on their own (that's a Tab-key thing on every browser tested,
    // Tizen's Chromium-based one included — there's no built-in "spatial navigation" to lean on), so this
    // drives it by hand rather than assuming the browser does it. Enter/Space then opens the selected tile
    // via the real keydown handler already on its .hit element (tile.js, under the same flag).
    if (this.tvMode && (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'ArrowUp' || k === 'ArrowDown')) {
      e.preventDefault();
      const cols = LAYOUTS[this.d.layout].cols || 1;
      this._tvMove(k === 'ArrowLeft' ? -1 : k === 'ArrowRight' ? 1 : k === 'ArrowUp' ? -cols : cols);
      return;
    }
    if (k === 'Escape') { if (this.edit) this.toggleEdit(false); }
    else if (k === 'ArrowLeft') this.goPage(this.page - 1);
    else if (k === 'ArrowRight') this.goPage(this.page + 1);
    else if (k === 'e' || k === 'E') this.toggleEdit();
    else if (k === 'f' || k === 'F') this.toggleFullscreen(this.live);
    else if (/^[1-9]$/.test(k)) { const t = this.tiles[+k - 1]; if (t) this.ctx.go(`#/live/${t.cam.id}`); }
  }

  // ---------------------------------------------------------------- TV mode grid navigation
  /** Moves the TV-mode selection cursor by `delta` tiles (±1 for left/right, ±cols for up/down) and gives
   * that tile's hit-target real keyboard focus — works identically on a real TV remote and a laptop
   * keyboard, since nothing here depends on the browser's own focus-traversal order. */
  _tvMove(delta) {
    if (!this.tiles.length) return;
    this.tvIndex = Math.max(0, Math.min(this.tiles.length - 1, this.tvIndex + delta));
    this.tiles[this.tvIndex]?.el.querySelector('.hit')?.focus({ preventScroll: true });
  }

  /** Keeps tvIndex in sync when a tile is focused by some other means (mouse click, Tab) — so arrow-key
   * navigation picks up from wherever focus actually is, not a stale cursor position. */
  _tvFocusIn(e) {
    const hit = e.target.closest?.('.hit');
    if (!hit) return;
    const i = this.tiles.findIndex((t) => t.el.contains(hit));
    if (i >= 0) this.tvIndex = i;
  }

  destroy() {
    this.disposeTiles();
    this.focus?.tile.dispose();
    this.focus = null;
    this.closeReplay();
    document.removeEventListener('keydown', this.onKey);
    document.removeEventListener('fullscreenchange', this.onFs);
    document.removeEventListener('click', this.onDoc);
    clearInterval(this.rotTimer);
    clearInterval(this.evTimer);
    if (document.fullscreenElement) document.exitFullscreen?.();
    this.root.innerHTML = '';
  }
}
