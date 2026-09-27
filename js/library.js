/* Game-folder loader + sidebar toggle.
   The user points "Open Game Folder" at their NR2003 install and webkitdirectory
   hands us every file at once. We find the series/ and tracks/ subtrees, bucket
   the files by folder, and fill the Car / Track dropdowns. The car dropdown
   loads immediately on change; the track loads via the Load button. */
(() => {
  const $ = (id) => document.getElementById(id);

  /* ---------- sidebar toggle (button + Blender's N key) ---------- */
  const togglePanel = () => document.body.classList.toggle('panel-collapsed');
  const toggleBtn = $('panel-toggle');
  if (toggleBtn) toggleBtn.addEventListener('click', togglePanel);
  document.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() === 'n' &&
        !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) togglePanel();
  });

  /* ---------- state ---------- */
  const MAX_CAR_PAINTS = 256;       /* safety ceiling only — comfortably covers full carsets; raise if a mod ever exceeds it */
  const carFolders = new Map();     /* folder name -> File[] */
  const trackFolders = new Map();   /* folder name -> File[] */
  let busy = false;

  function log(msg) {
    const el = $('vp-log');
    if (!el) return;
    el.textContent += msg + '\n';
    el.scrollTop = el.scrollHeight;
  }

  const isJunk = (name) => {
    const b = (name || '').split('/').pop().toLowerCase();
    return b.startsWith('.') || b === 'thumbs.db';
  };

  /* group files by the folder directly under a `dir` path segment
     (…/series/<car>/… collects into map[<car>]) */
  function bucketByFolder(files, dir, map) {
    map.clear();
    for (const f of files) {
      if (isJunk(f.name)) continue;
      const parts = (f.webkitRelativePath || f.name).split('/');
      const di = parts.findIndex(p => p.toLowerCase() === dir);
      if (di < 0 || parts.length <= di + 2) continue;   /* need <dir>/<folder>/<file…> */
      const folder = parts[di + 1];
      if (!map.has(folder)) map.set(folder, []);
      map.get(folder).push(f);
    }
  }

  /* Dropdowns stay visible at all times — they just start empty (only the
     placeholder option) until a game folder is picked and fills them. */
  function fillSelect(sel, names, placeholder) {
    if (!sel) return;
    const opts = [`<option value="" disabled selected hidden>${placeholder}</option>`];
    for (const n of names) opts.push(`<option value="${n.replace(/"/g, '&quot;')}">${n}</option>`);
    sel.innerHTML = opts.join('');
  }

  async function withBusy(fn) {
    if (busy) return;
    busy = true;
    for (const id of ['game-folder', 'lib-car', 'lib-track', 'lib-load']) {
      const el = $(id); if (el) el.disabled = true;
    }
    try { await fn(); }
    catch (err) { console.error(err); log('ERROR: ' + err.message); }
    finally {
      busy = false;
      for (const id of ['game-folder', 'lib-car', 'lib-track', 'lib-load']) {
        const el = $(id); if (el) el.disabled = false;
      }
    }
  }

  /* .car paints are optional paint schemes — keep every other file, cap paints */
  function capPaints(files) {
    const paints = files.filter(f => /\.car$/i.test(f.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    const rest = files.filter(f => !/\.car$/i.test(f.name));
    return rest.concat(paints.slice(0, MAX_CAR_PAINTS));
  }

  /* ---------- controls ---------- */
  const gameInput = $('game-folder');
  if (gameInput) gameInput.addEventListener('change', (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    if (!files.length) return;

    bucketByFolder(files, 'series', carFolders);
    bucketByFolder(files, 'tracks', trackFolders);
    const cars = [...carFolders.keys()].sort((a, b) => a.localeCompare(b));
    const tracks = [...trackFolders.keys()].sort((a, b) => a.localeCompare(b));

    fillSelect($('lib-car'), cars, 'Series…');
    fillSelect($('lib-track'), tracks, 'Track…');

    if (!cars.length && !tracks.length) {
      log('No series/ or tracks/ folders found in that directory.');
      alert('No "series" or "tracks" folder was found there.\n' +
        'Pick your NR2003 game folder — the one that contains series/ and tracks/.');
      return;
    }
    log(`Game folder loaded: ${cars.length} series, ${tracks.length} tracks.`);
  });

  const carSel = $('lib-car');
  if (carSel) carSel.addEventListener('change', (e) => {
    const files = carFolders.get(e.target.value);
    if (files) withBusy(() => Viewer.openFolder(capPaints(files), e.target.value, { keepTrack: true }));
  });

  async function loadSelected() {
    const carName = $('lib-car')?.value;
    const trackName = $('lib-track')?.value;
    if (!carName) {
      alert('Pick a series (car) first.');
      return;
    }
    if (!trackName) {
      alert('Pick a track first.');
      return;
    }
    const carFiles = carFolders.get(carName);
    const trackFiles = trackFolders.get(trackName);
    if (!carFiles || !trackFiles) return;
    await Viewer.openFolder(capPaints(carFiles), carName);
    await Viewer.openTrackFolder(trackFiles, trackName);
  }

  async function restoreContext(ctx) {
    if (!ctx?.series || !ctx?.track) return false;
    if (!carFolders.has(ctx.series) || !trackFolders.has(ctx.track)) return false;
    const trackSel = $('lib-track');
    if (carSel) carSel.value = ctx.series;
    if (trackSel) trackSel.value = ctx.track;
    await withBusy(loadSelected);
    return true;
  }

  const loadBtn = $('lib-load');
  if (loadBtn) loadBtn.addEventListener('click', () => withBusy(loadSelected));

  /* ---------- kiosk (on-device server) mode ----------
     The RG35XXH build has no file picker: the app is served from
     http://127.0.0.1:8123 and the HTML5 server at /api/list + /gamedata
     enumerates the NR2003 install. ServerFile mirrors the File surface the
     viewer actually uses (.name, ._relPath, .size, arrayBuffer(), text());
     bucketByFolder-style grouping is done server-side, so carFolders /
     trackFolders get filled by folder name exactly like a real pick. */
  const IS_KIOSK = location.protocol === 'http:' && location.port === '8123';

  class ServerFile {
    constructor(name, rel, url, size) {
      this.name = name;
      this._relPath = rel;      /* logical path for the viewer's loose-file logic */
      this._url = url;          /* server-relative path for the actual fetch */
      this.size = size || 0;
    }
    async _get() {
      const enc = this._url.split('/').map(encodeURIComponent).join('/');
      const r = await fetch('/gamedata/' + enc);
      if (!r.ok) throw new Error('GET ' + this._url + ' -> ' + r.status);
      return r;
    }
    async arrayBuffer() { return (await this._get()).arrayBuffer(); }
    async text() { return (await this._get()).text(); }
  }

  async function kioskList(p) {
    const r = await fetch('/api/list?p=' + encodeURIComponent(p));
    if (!r.ok) throw new Error('list ' + p + ' -> ' + r.status);
    return r.json();
  }

  function kioskFolder(dir) {
    /* returns a promise resolving to map folderName -> ServerFile[] */
    return (async () => {
      const map = new Map();
      for (const item of await kioskList(dir)) {
        if (!item.dir) continue;
        const files = (await kioskList(dir + '/' + item.name))
          .filter(f => !isJunk(f.name))
          .map(f => new ServerFile(f.name, 'root/' + dir + '/' + item.name + '/' + f.name, dir + '/' + item.name + '/' + f.name, f.size));
        map.set(item.name, files);
      }
      return map;
    })();
  }

  async function populateFromServer() {
    const [carsMap, tracksMap] = await Promise.all([kioskFolder('series'), kioskFolder('tracks')]);
    carFolders.clear();
    for (const [k, v] of carsMap) carFolders.set(k, v);
    trackFolders.clear();
    for (const [k, v] of tracksMap) trackFolders.set(k, v);

    const cars = [...carFolders.keys()].sort((a, b) => a.localeCompare(b));
    const tracks = [...trackFolders.keys()].sort((a, b) => a.localeCompare(b));
    fillSelect($('lib-car'), cars, 'Series…');
    fillSelect($('lib-track'), tracks, 'Track…');
    log(`Server game folder: ${cars.length} series, ${tracks.length} tracks.`);
    if (!cars.length && !tracks.length) return;

    let saved = null;
    try { saved = JSON.parse(localStorage.getItem('re2003-server-last') || 'null'); } catch (e) {}
    const carName = (saved && carFolders.has(saved.car)) ? saved.car : (cars[0] || '');
    const kioskPick = (names, map) => {
      for (const n of names) {
        const lo = (map.get(n) || []).map(f => f.name.toLowerCase());
        const hasIni = lo.some(x => x === 'track.ini');
        const hasArch = lo.some(x => /\.dat$/.test(x)) || lo.some(x => /\.ptf$/.test(x));
        if (hasIni && hasArch) return n;
      }
      return names[0] || '';
    };
    const trackName = (saved && trackFolders.has(saved.track)) ? saved.track : kioskPick(tracks, trackFolders);
    if (carSel) carSel.value = carName;
    if ($('lib-track')) $('lib-track').value = trackName;
    try { localStorage.setItem('re2003-server-last', JSON.stringify({ car: carName, track: trackName })); } catch (e) {}
    await loadSelected();
  }

  if (IS_KIOSK) {
    document.addEventListener('DOMContentLoaded', () => withBusy(populateFromServer));
  }

  window.Library = { loadSelected, restoreContext };
})();
