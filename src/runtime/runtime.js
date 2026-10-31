/*
 * htmlreel browser runtime.
 *
 * Makes an HTML/CSS page deterministic and seekable: nothing animates on wall-clock time, every
 * frame is produced by Reel.seek(t). The renderer calls seek(t) for each frame and captures it;
 * preview mode drives seek(t) from an <audio> element (or a clock).
 *
 * Contract for compositions:
 *   CSS variables on :root   --t (seconds), --p (0..1 progress), --level (0..1 loudness), --beat (0..1 pulse)
 *   #reel-captions           filled with .reel-line[data-start][data-duration] > .reel-word
 *                            (created with a default style when captions exist and the page has none)
 *   .reel-line classes       is-active | is-past | is-future | is-next, plus --lp (0..1 line progress) and --dur
 *   .reel-word classes       is-spoken, plus --wi (word index)
 *   [data-start][data-duration]  any element: hidden outside its time window; its CSS animations start at data-start
 *   Reel.onFrame(fn)         per-frame hook fn(t, Reel) for canvas / JS-driven motion (window.render works too)
 *   Reel.rand(seed)          seeded PRNG; Reel.levelAt(t); Reel.beatAt(t); Reel.captions; Reel.data; Reel.duration
 */
(function () {
  'use strict';
  var cfg = window.__REEL__ || {};
  var Reel = (window.Reel = window.Reel || {});
  var levels = cfg.levels || [];
  var lfps = cfg.levelsFps || 30;
  var duration = Math.max(0.04, cfg.duration || 10);
  var frameHooks = [];

  Reel.duration = duration;
  Reel.width = cfg.width || 0;
  Reel.height = cfg.height || 0;
  Reel.fps = cfg.fps || 30;
  Reel.captions = cfg.captions || [];
  Reel.data = cfg.data || {};
  Reel.mode = cfg.mode || 'render';
  Reel.t = 0;

  function clamp(v, a, b) {
    return v < a ? a : v > b ? b : v;
  }
  Reel.clamp = clamp;

  Reel.onFrame = function (fn) {
    if (typeof fn === 'function') frameHooks.push(fn);
  };

  Reel.levelAt = function (t) {
    if (!levels.length) return 0;
    var i = t * lfps;
    var i0 = Math.floor(i);
    var a = levels[clamp(i0, 0, levels.length - 1)] || 0;
    var b = levels[clamp(i0 + 1, 0, levels.length - 1)] || a;
    return a + (b - a) * (i - i0);
  };

  // A transient pulse: how far the current level rises above its recent average.
  Reel.beatAt = function (t) {
    var now = Reel.levelAt(t);
    var avg = 0;
    for (var k = 1; k <= 8; k++) avg += Reel.levelAt(Math.max(0, t - k * 0.06));
    avg /= 8;
    return clamp((now - avg) * 4, 0, 1);
  };

  // mulberry32 seeded PRNG: Reel.rand(seed) returns a function () => [0,1)
  Reel.rand = function (seed) {
    var a = seed >>> 0 || 1;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  Reel.activeCaption = function (t) {
    for (var i = 0; i < Reel.captions.length; i++) {
      var c = Reel.captions[i];
      if (t >= c.start && t < c.end) return c;
    }
    return null;
  };

  // ---- Determinism guards -------------------------------------------------------------
  var guard = document.createElement('style');
  guard.textContent =
    '*,*::before,*::after{transition:none!important;caret-color:transparent!important}' +
    '.reel-hidden{visibility:hidden!important}' +
    // Words keep their spacing even when a composition lays lines out with flexbox.
    '.reel-word{display:inline-block;margin:0 .14em}' +
    '#reel-captions.reel-default{position:absolute;left:7%;right:7%;bottom:9%;height:20vmin;text-align:center;z-index:50;' +
    'font:800 5.2vmin/1.2 system-ui,-apple-system,"Segoe UI","Noto Sans","Noto Sans Devanagari",sans-serif;color:#fff}' +
    // Vertical video (Reels, Shorts, TikTok): stay above the app's bottom UI.
    '@media (max-aspect-ratio:4/5){#reel-captions.reel-default{bottom:26%;font-size:7.2vmin}}' +
    '#reel-captions.reel-default .reel-line{position:absolute;inset:0;display:flex;flex-wrap:wrap;align-items:center;justify-content:center;' +
    'align-content:center;opacity:0;text-shadow:0 .4vmin 2.4vmin rgba(0,0,0,.65)}' +
    '#reel-captions.reel-default .reel-line.is-active{opacity:1;animation:reelIn .45s cubic-bezier(.2,.8,.2,1) both}' +
    '#reel-captions.reel-default .reel-word{opacity:.5}' +
    '#reel-captions.reel-default .reel-word.is-spoken{opacity:1}' +
    '@keyframes reelIn{from{opacity:0;transform:translateY(2vmin) scale(.96)}to{opacity:1;transform:none}}';
  (document.head || document.documentElement).appendChild(guard);

  // Freeze wall-clock sources so careless code can't drift between frames or workers.
  var realNow =
    window.performance && performance.now
      ? performance.now.bind(performance)
      : function () {
          return new Date().getTime();
        };
  var fixedNow = 1700000000000;
  Date.now = function () {
    return fixedNow + Reel.t * 1000;
  };
  if (window.performance) {
    try {
      window.performance.now = function () {
        return Reel.t * 1000;
      };
    } catch (e) {}
  }
  Math.random = Reel.rand(1337);

  // ---- Captions -----------------------------------------------------------------------
  var lines = [];
  var clips = [];
  var clipOffset = new WeakMap();

  function buildCaptions() {
    var host = document.getElementById('reel-captions');
    if (!host) {
      if (cfg.captionsLayer === false || !Reel.captions.length) return;
      host = document.createElement('div');
      host.id = 'reel-captions';
      host.className = 'reel-default';
      document.body.appendChild(host);
    }
    host.innerHTML = '';
    lines = [];
    Reel.captions.forEach(function (c, i) {
      var el = document.createElement('div');
      var dur = Math.max(0.2, c.end - c.start);
      el.className = 'reel-line is-future';
      el.setAttribute('data-reel-line', '');
      el.dataset.index = String(i);
      el.dataset.lstart = String(c.start);
      el.style.setProperty('--dur', dur.toFixed(3) + 's');
      el.style.setProperty('--li', String(i));
      var words = String(c.text).split(/\s+/).filter(Boolean);
      words.forEach(function (w, j) {
        var s = document.createElement('span');
        s.className = 'reel-word';
        s.style.setProperty('--wi', String(j));
        s.textContent = w;
        el.appendChild(s);
        if (j < words.length - 1) el.appendChild(document.createTextNode(' '));
      });
      el.style.setProperty('--wn', String(words.length));
      host.appendChild(el);
      lines.push({ el: el, start: c.start, end: c.start + dur, words: el.querySelectorAll('.reel-word'), state: '' });
    });
  }

  function collectClips() {
    clips = [];
    var nodes = document.querySelectorAll('[data-start][data-duration]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var start = parseFloat(el.dataset.start) || 0;
      clips.push({ el: el, start: start, end: start + (parseFloat(el.dataset.duration) || 0) });
    }
  }

  function animationOffset(target) {
    if (!target || !target.closest) return 0;
    if (clipOffset.has(target)) return clipOffset.get(target);
    var off = 0;
    var line = target.closest('[data-reel-line]');
    if (line) off = parseFloat(line.dataset.lstart) || 0;
    else {
      var clip = target.closest('[data-start]');
      if (clip) off = parseFloat(clip.dataset.start) || 0;
    }
    clipOffset.set(target, off);
    return off;
  }

  function setState(line, state, isNext) {
    var full = state + (isNext ? ' is-next' : '');
    if (line.state === full) return;
    line.state = full;
    var cl = line.el.classList;
    cl.toggle('is-active', state === 'is-active');
    cl.toggle('is-past', state === 'is-past');
    cl.toggle('is-future', state === 'is-future');
    cl.toggle('is-next', isNext);
  }

  // ---- Seek ---------------------------------------------------------------------------
  Reel.seek = function (t) {
    t = clamp(+t || 0, 0, duration);
    Reel.t = t;
    var root = document.documentElement.style;
    root.setProperty('--t', t.toFixed(4));
    root.setProperty('--p', (t / duration).toFixed(5));
    root.setProperty('--level', Reel.levelAt(t).toFixed(4));
    root.setProperty('--beat', Reel.beatAt(t).toFixed(4));

    var activeIdx = -1;
    var nextIdx = -1;
    for (var i = 0; i < lines.length; i++) {
      var L = lines[i];
      if (t >= L.start && t < L.end) activeIdx = i;
      else if (t < L.start && nextIdx === -1) nextIdx = i;
    }
    for (var j = 0; j < lines.length; j++) {
      var line = lines[j];
      var st = j === activeIdx ? 'is-active' : t < line.start ? 'is-future' : 'is-past';
      setState(line, st, j === nextIdx);
      if (st === 'is-active') {
        var lp = clamp((t - line.start) / (line.end - line.start), 0, 1);
        line.el.style.setProperty('--lp', lp.toFixed(4));
        var n = line.words.length;
        for (var w = 0; w < n; w++) line.words[w].classList.toggle('is-spoken', lp >= (w + 0.35) / n);
      }
    }

    for (var c = 0; c < clips.length; c++) {
      var clip = clips[c];
      clip.el.classList.toggle('reel-hidden', t < clip.start || t >= clip.end);
    }

    // getAnimations() flushes style, so animations started by the class changes above are included.
    var anims = document.getAnimations ? document.getAnimations() : [];
    for (var a = 0; a < anims.length; a++) {
      var anim = anims[a];
      var target = anim.effect && anim.effect.target;
      try {
        anim.pause();
        anim.currentTime = Math.max(0, (t - animationOffset(target)) * 1000);
      } catch (e) {}
    }

    var svgs = document.querySelectorAll('svg');
    for (var s = 0; s < svgs.length; s++) {
      var svg = svgs[s];
      if (!svg.ownerSVGElement && svg.pauseAnimations) {
        try {
          svg.pauseAnimations();
          svg.setCurrentTime(t);
        } catch (e) {}
      }
    }

    var hooks = typeof window.render === 'function' ? frameHooks.concat([window.render]) : frameHooks;
    for (var h = 0; h < hooks.length; h++) {
      // Same sequence every frame: careless Math.random() use gives stable shapes instead of
      // flicker, and frames rendered by different workers match.
      Math.random = Reel.rand(1337);
      try {
        hooks[h](t, Reel);
      } catch (e) {
        if (!Reel.__frameErrorLogged) {
          Reel.__frameErrorLogged = true;
          console.error('htmlreel: frame hook threw: ' + (e && e.message));
        }
      }
    }
  };

  // ---- Boot ---------------------------------------------------------------------------
  function waitImages() {
    var imgs = Array.prototype.slice.call(document.images || []);
    return Promise.all(
      imgs.map(function (img) {
        if (img.complete) return null;
        return new Promise(function (r) {
          img.addEventListener('load', r, { once: true });
          img.addEventListener('error', r, { once: true });
        });
      })
    );
  }

  function boot() {
    try {
      buildCaptions();
      collectClips();
    } catch (e) {
      console.error('htmlreel: boot error ' + (e && e.message));
    }
    var fonts = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
    var timeout = new Promise(function (r) {
      setTimeout(r, 8000);
    });
    Promise.race([Promise.all([fonts, waitImages()]), timeout]).then(function () {
      Reel.seek(cfg.startAt || 0);
      window.__REEL_READY__ = true;
      if (Reel.mode === 'preview') startPreview();
    });
  }

  // ---- Preview player (browser only) --------------------------------------------------
  // Without an audio track a wall clock stands in for the <audio> element.
  function silentClock() {
    var base = 0;
    var startedAt = 0;
    var clock = {
      paused: true,
      onplay: null,
      onpause: null,
      play: function () {
        if (!clock.paused) return;
        if (base >= duration) base = 0;
        startedAt = realNow();
        clock.paused = false;
        if (clock.onplay) clock.onplay();
      },
      pause: function () {
        if (clock.paused) return;
        base = clock.currentTime;
        clock.paused = true;
        if (clock.onpause) clock.onpause();
      },
    };
    Object.defineProperty(clock, 'currentTime', {
      get: function () {
        if (clock.paused) return base;
        var t = base + (realNow() - startedAt) / 1000;
        if (t >= duration) {
          base = duration;
          clock.pause();
          return duration;
        }
        return t;
      },
      set: function (v) {
        base = clamp(+v || 0, 0, duration);
        startedAt = realNow();
      },
    });
    return clock;
  }

  function startPreview() {
    var audio = cfg.audioUrl ? new Audio(cfg.audioUrl) : silentClock();
    audio.preload = 'auto';
    var bar = document.createElement('div');
    bar.setAttribute(
      'style',
      'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;display:flex;align-items:center;gap:12px;' +
        'padding:10px 14px;background:linear-gradient(transparent,rgba(0,0,0,.75));font:600 13px system-ui;color:#fff;visibility:visible!important'
    );
    var btn = document.createElement('button');
    btn.textContent = '▶';
    btn.setAttribute('style', 'width:36px;height:36px;border-radius:50%;border:0;background:#fff;color:#000;font-size:14px;cursor:pointer');
    var range = document.createElement('input');
    range.type = 'range';
    range.min = '0';
    range.max = String(duration);
    range.step = '0.01';
    range.value = '0';
    range.setAttribute('style', 'flex:1;accent-color:#f59e0b');
    var label = document.createElement('span');
    function fmt(s) {
      s = Math.max(0, s | 0);
      return ((s / 60) | 0) + ':' + ('0' + (s % 60)).slice(-2);
    }
    label.textContent = '0:00 / ' + fmt(duration);
    bar.appendChild(btn);
    bar.appendChild(range);
    bar.appendChild(label);
    document.body.appendChild(bar);

    var scrubbing = false;
    btn.onclick = function () {
      if (audio.paused) audio.play();
      else audio.pause();
    };
    audio.onplay = function () {
      btn.textContent = '❚❚';
    };
    audio.onpause = function () {
      btn.textContent = '▶';
    };
    range.oninput = function () {
      scrubbing = true;
      Reel.seek(+range.value);
    };
    range.onchange = function () {
      audio.currentTime = +range.value;
      scrubbing = false;
    };
    document.addEventListener('keydown', function (e) {
      if (e.code === 'Space') {
        e.preventDefault();
        btn.onclick();
      }
    });
    (function loop() {
      if (!scrubbing) {
        var t = audio.currentTime || 0;
        Reel.seek(t);
        range.value = String(t);
      }
      label.textContent = fmt(Reel.t) + ' / ' + fmt(duration);
      requestAnimationFrame(loop);
    })();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
