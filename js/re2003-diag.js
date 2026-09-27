/* kiosk diagnostics — report the on-device GL driver and the app's own live
   FPS/perf to the local server's /__diag sink. No-op outside the kiosk origin. */
(() => {
  const K = location.protocol === 'http:' && location.port === '8123';
  if (!K) return;
  const send = (s) => { try { fetch('/__diag', { method: 'POST', body: String(s).slice(0, 2000) }); } catch (e) {} };

  const origLog = console.log;
  console.log = (...a) => {
    const s = a.map(x => typeof x === 'string' ? x : (x && x.toString ? x.toString() : String(x))).join(' ');
    if (/\[perf\]/.test(s)) send('PERF ' + s);
    return origLog.apply(console, a);
  };

  try { if (window.Driving && Driving.perf) Driving.perf(true); }
  catch (e) { send('perf-enable err ' + e.message); }

  try {
    const cv = document.createElement('canvas');
    const gl = cv.getContext('webgl') || cv.getContext('experimental-webgl');
    if (gl) {
      const di = gl.getExtension('WEBGL_debug_renderer_info');
      if (di) send('GL ' + gl.getParameter(di.UNMASKED_VENDOR_WEBGL) + ' | ' + gl.getParameter(di.UNMASKED_RENDERER_WEBGL));
      else send('GL ' + gl.getParameter(gl.VERSION));
    } else send('GL none');
  } catch (e) { send('GL err ' + e.message); }

  const gid = (id) => document.getElementById(id);
  /* wrap rAF to meter the app's own frame-callback duration — if each callback
     is ~1000ms the lag is in the page, not WebKit's scheduler */
  const _cb = { sum: 0, n: 0, last: performance.now() };
  const _origRAF = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => _origRAF((t) => {
    const t0 = performance.now();
    let r;
    try { r = cb(t); } catch (e) { r = undefined; }
    const d = performance.now() - t0;
    _cb.sum += d; _cb.n++;
    if (performance.now() - _cb.last >= 2000) {
      const dur = (_cb.sum / _cb.n).toFixed(1);
      const fps = (_cb.n * 1000 / (performance.now() - _cb.last)).toFixed(1);
      _cb.sum = 0; _cb.n = 0; _cb.last = performance.now();
      send('CB dur=' + dur + 'ms fps=' + fps);
    }
    return r;
  });
  setInterval(() => {
    const fps = gid('viewer-fps') ? gid('viewer-fps').textContent : '';
    const cnv = document.querySelector('canvas');
    const csz = cnv ? cnv.width + 'x' + cnv.height + '(css ' + cnv.clientWidth + 'x' + cnv.clientHeight + ')' : 'none';
    const sc = document.querySelector('canvas') ? Math.round(document.querySelector('canvas').width / Math.max(1, document.querySelector('canvas').clientWidth)) : '?';
    const logline = gid('vp-log') ? String(gid('vp-log').textContent).split('\n').filter(Boolean).slice(-1)[0] : '';
    send('STATE dpr=' + window.devicePixelRatio + ' fps=' + fps + ' scale=' + sc + ' canvas=' + csz + ' | ' + logline);
  }, 3000);

  /* WebGL per-call profiler — catches pathological per-draw-call sync or a slow
     texture/buffer path inside the page's own render. Each wrapped method times
     every call; sub-2ms calls are ignored; the worst per-call ms in each window
     and the total spend are reported. Prototype patching covers the live context. */
  const wg2 = (typeof WebGL2RenderingContext !== 'undefined') ? WebGL2RenderingContext.prototype : null;
  const wg1 = (typeof WebGLRenderingContext !== 'undefined') ? WebGLRenderingContext.prototype : null;
  const toTime = ['drawElements', 'drawArrays', 'texImage2D', 'texImage3D', 'texSubImage2D', 'bufferData',
                  'bufferSubData', 'readPixels', 'generateMipmap', 'clear', 'clearColor', 'uniform4fv',
                  'uniformMatrix4fv', 'createProgram', 'linkProgram', 'viewport', 'scissor', 'flush', 'finish',
                  'getUniformLocation', 'getShaderInfoLog', 'getProgramInfoLog',
                  'bindTexture', 'useProgram', 'bindVertexArray', 'vertexAttribPointer', 'framebufferTexture2D',
                  'blendFunc', 'depthMask', 'colorMask', 'enable', 'disable', 'activeTexture',
                  'disableVertexAttribArray', 'bindBuffer', 'bindFramebuffer', 'bindRenderbuffer'];
  const slow = {};
  const install = (proto) => {
    if (!proto) return;
    for (const n of toTime) {
      const orig = proto[n];
      if (typeof orig !== 'function') continue;
      proto[n] = function (...a) {
        const t0 = performance.now();
        let r;
        try { r = orig.apply(this, a); } catch (e) { throw e; }
        const d = performance.now() - t0;
        if (d > 2) (slow[n] = slow[n] || []).push(d);
        return r;
      };
    }
  };
  const glctx = { gl: null };
  try {
    const origGC = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (...a) {
      const c = origGC.apply(this, a);
      if (!glctx.gl && c && typeof c.drawElements === 'function') glctx.gl = c;
      return c;
    };
  } catch (e) {}
  install(wg1);
  install(wg2);
  setInterval(() => {
    for (const n of Object.keys(slow)) {
      const arr = slow[n];
      const tot = arr.reduce((x, y) => x + y, 0);
      const cnt = arr.length;
      const mx = Math.max.apply(null, arr);
      arr.length = 0;
      send('GL ' + n + ' n=' + cnt + ' tot=' + tot.toFixed(0) + 'ms avg=' + (tot / cnt).toFixed(1) + ' max=' + mx.toFixed(0));
    }
    const cv = document.querySelector('canvas');
    const gl = glctx.gl || (cv && (cv.getContext('webgl') || cv.getContext('webgl2')));
    if (gl) {
      const kv = (p) => { try { return gl.getParameter(p); } catch (e) { return 'err'; } };
      send('GLINFO maxTex=' + kv(0x0D33) + ' maxRBO=' + kv(0x84E8) +
           ' maxUnits=' + kv(gl.MAX_TEXTURE_IMAGE_UNITS) + ' maxVerts=' + kv(gl.MAX_VERTEX_ATTRIBS) +
           ' halfFloat=' + !!gl.getExtension('WEBGL_color_buffer_float') +
           (gl.getExtension('OES_texture_half_float') ? '+hf' : '') +
           (gl.getExtension('EXT_color_buffer_half_float') ? '+cbhf' : '') +
           (gl.getExtension('EXT_color_buffer_float') ? '+cbf' : '') +
           (gl.getExtension('OES_texture_float_linear') ? '+tfl' : ''));
    }
  }, 3500);
})();