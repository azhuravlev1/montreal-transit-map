(function () {
  'use strict';

  const TRANSIT = window.TRANSIT || [];
  const DEV = (window.REM_DEV && window.REM_DEV.stations) || [];
  const canHover = window.matchMedia('(hover: hover)').matches;
  const clamp = (lo, hi, v) => Math.max(lo, Math.min(hi, v));
  let currentIndex = null;

  // ---- Design spec -------------------------------------------------------

  const KIND = {
    metro: {
      opacity: 0.55, ring: 1.6,
      width: (z) => clamp(2, 7, (z - 9) * 0.9),
      radius: (z) => clamp(1.6, 5, (z - 10) * 0.75),
    },
    rail: {
      opacity: 0.4, ring: 1.2,
      width: (z) => clamp(1, 3.2, (z - 9) * 0.4),
      radius: (z) => clamp(1.2, 3.6, (z - 10) * 0.5),
    },
  };

  // ---- Card colour system ------------------------------------------------

  const USES = {
    residential:   { label: 'Residential',   color: '#EE6A59' },
    office:        { label: 'Office',        color: '#5466D6' },
    retail:        { label: 'Retail',        color: '#D6457A' },
    hotel:         { label: 'Hotel',         color: '#8A4FBF' },
    institutional: { label: 'Institutional', color: '#1F9AAE' },
    park:          { label: 'Parks',         color: '#3FA36B' },
    entertainment: { label: 'Entertainment', color: '#F08A24' },
    industrial:    { label: 'Industrial',    color: '#8C7B6B' },
    civic:         { label: 'Public realm',  color: '#5F8FB4' },
  };
  const NO_DEV_COLOR = '#B9C7A6';

  const STATUSES = [
    { key: 'proposed',           label: 'Proposed' },
    { key: 'approved',           label: 'Approved' },
    { key: 'under_construction', label: 'Building' },
    { key: 'completed',          label: 'Completed' },
  ];
  const STATUS_LABEL = {
    proposed: 'Proposed', approved: 'Approved', under_construction: 'Under construction',
    completed: 'Completed', cancelled: 'Cancelled',
  };

  const ACTIVITY = { high: 3, medium: 2, low: 1 };

  // ---- Helpers -----------------------------------------------------------

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
  const safeUrl = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null);
  const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; } };
  const fmtInt = (n) => Number(n).toLocaleString('en-CA');

  function fmtDate(iso) {
    if (!iso) return null;
    const d = new Date(iso + 'T12:00:00');
    if (isNaN(d)) return esc(iso);
    return d.toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function useWeights(st) {
    const w = {};
    for (const p of st.projects || []) {
      if (p.status === 'cancelled') continue;
      const uses = (p.uses || []).filter((u) => USES[u]);
      for (const u of uses) w[u] = (w[u] || 0) + 1 / uses.length;
    }
    return Object.entries(w).sort((a, b) => b[1] - a[1]);
  }

  function mixGradient(weights) {
    if (!weights.length) return NO_DEV_COLOR;
    const total = weights.reduce((s, [, v]) => s + v, 0);
    let acc = 0;
    const stops = weights.map(([u, v]) => {
      const from = (acc / total) * 360;
      acc += v;
      const to = (acc / total) * 360;
      return `${USES[u].color} ${from.toFixed(1)}deg ${to.toFixed(1)}deg`;
    });
    return `conic-gradient(${stops.join(', ')})`;
  }

  function mixLinear(weights) {
    if (!weights.length) return NO_DEV_COLOR;
    const total = weights.reduce((s, [, v]) => s + v, 0);
    let acc = 0;
    const stops = weights.map(([u, v]) => {
      const from = (acc / total) * 100;
      acc += v;
      return `${USES[u].color} ${from.toFixed(1)}% ${((acc / total) * 100).toFixed(1)}%`;
    });
    return `linear-gradient(180deg, ${stops.join(', ')})`;
  }

  function statColor(label) {
    const l = label.toLowerCase();
    if (/home|unit|dwelling|housing|resident|condo|apartment|logement/.test(l)) return USES.residential.color;
    if (/office|job|employ|worker/.test(l)) return USES.office.color;
    if (/retail|shop|commerc|store/.test(l)) return USES.retail.color;
    if (/park|green|tree|hectare/.test(l)) return USES.park.color;
    if (/hotel|room/.test(l)) return USES.hotel.color;
    if (/student|campus|school|universit|hospital/.test(l)) return USES.institutional.color;
    if (/\$|invest|cost|billion|million/.test(l)) return '#2F7D6D';
    return '#56627A';
  }

  // ---- Map ---------------------------------------------------------------

  const map = L.map('map', { zoomControl: true, minZoom: 9, maxZoom: 18, zoomSnap: 0.5 });


  map.createPane('transit').style.zIndex = 410;
  map.createPane('stations').style.zIndex = 430;
  map.createPane('markers').style.zIndex = 640;
  const lineRenderer = L.canvas({ pane: 'transit' });
  const stationRenderer = L.canvas({ pane: 'stations' });

  const bounds = L.latLngBounds([]);
  TRANSIT.forEach((l) => l.segments.forEach((seg) => seg.forEach(([lon, lat]) => bounds.extend([lat, lon]))));
  const narrow = window.matchMedia('(max-width: 720px)').matches;
  if (narrow) {
    const core = L.latLngBounds([]);
    TRANSIT.filter((l) => l.id !== 'rem').forEach((l) => l.segments.forEach((seg) => seg.forEach(([lon, lat]) => core.extend([lat, lon]))));
    map.fitBounds(core, { padding: [10, 10] });
  } else {
    map.fitBounds(bounds, { padding: [20, 20] });
  }

  try {
    L.maplibreGL({ style: 'https://tiles.openfreemap.org/styles/positron' }).addTo(map);
  } catch (err) {
    console.error('Basemap unavailable (WebGL?)', err);
  }

  const ordered = [...TRANSIT].sort((a, b) => (a.kind === 'rail' ? 0 : 1) - (b.kind === 'rail' ? 0 : 1));
  const lineLayers = [];
  const stationLayers = [];

  for (const line of ordered) {
    const k = KIND[line.kind] || KIND.metro;
    const z = map.getZoom();
    lineLayers.push({
      kind: line.kind,
      layer: L.polyline(line.segments.map((seg) => seg.map(([lon, lat]) => [lat, lon])), {
        renderer: lineRenderer, pane: 'transit', interactive: false,
        color: line.color, opacity: k.opacity, weight: k.width(z),
        lineCap: 'round', lineJoin: 'round',
      }).addTo(map),
    });
  }

  for (const line of ordered) {
    const k = KIND[line.kind] || KIND.metro;
    for (const st of line.stations) {
      const m = L.circleMarker([st.lat, st.lon], {
        renderer: stationRenderer, pane: 'stations', interactive: canHover,
        radius: k.radius(map.getZoom()), color: line.color, weight: k.ring, opacity: 0.85,
        fillColor: '#fff', fillOpacity: 1,
      }).addTo(map);
      if (canHover) {
        m.bindTooltip(tipHtml(st.name, line.color), {
          className: 'stn-tip', direction: 'top', offset: [0, -6], opacity: 1,
        });
      }
      stationLayers.push({ kind: line.kind, layer: m });
    }
  }

  function tipHtml(name, color) {
    return `<span class="chip" style="background:${color}"></span>${esc(name)}`;
  }

  // ---- REM development rings (interactive markers) -----------------------

  const remLine = TRANSIT.find((l) => l.id === 'rem');
  const remColor = remLine ? remLine.color : '#84BD00';
  const devMarkers = [];

  DEV.forEach((st, i) => {
    if (st.lat == null || st.lon == null) return;
    st.index = i;
    st.weights = useWeights(st);
    st.gradient = mixGradient(st.weights);
    st.dominant = st.weights.length ? USES[st.weights[0][0]].color : NO_DEV_COLOR;
    const marker = L.marker([st.lat, st.lon], {
      pane: 'markers', icon: ringIcon(st, map.getZoom()), keyboard: true,
      title: canHover ? '' : st.station, riseOnHover: true,
    }).addTo(map);
    if (canHover) {
      marker.bindTooltip(tipHtml(st.station, remColor) + '<span class="tip-hint">Tap for development</span>', {
        className: 'stn-tip', direction: 'top', offset: [0, -10], opacity: 1,
      });
    }
    marker.on('click', () => openStation(i, true));
    devMarkers.push({ st, marker });
  });

  function ringIcon(st, z) {
    const level = ACTIVITY[st.activity] || 1;
    const dot = KIND.metro.radius(z) * 2;
    const d = Math.round(dot + (6 + level * 3) * clamp(0.55, 1, (z - 8) / 5));
    const t = level + 1;
    const hit = Math.max(d, 30);
    const active = currentIndex === st.index ? ' is-active' : '';
    const future = !st.opened && st.opening ? ' is-future' : '';
    return L.divIcon({
      className: 'dev-ring-wrap' + active + future,
      iconSize: [hit, hit],
      html: `<span class="dev-ring" style="--d:${d}px;--t:${t}px;--mix:${st.gradient}"></span>`,
    });
  }

  function refreshRings() {
    const z = map.getZoom();
    devMarkers.forEach(({ st, marker }) => marker.setIcon(ringIcon(st, z)));
  }

  map.on('zoomend', () => {
    const z = map.getZoom();
    lineLayers.forEach(({ kind, layer }) => layer.setStyle({ weight: (KIND[kind] || KIND.metro).width(z) }));
    stationLayers.forEach(({ kind, layer }) => layer.setRadius((KIND[kind] || KIND.metro).radius(z)));
    refreshRings();
  });

  // ---- Legend ------------------------------------------------------------

  (function buildLegend() {
    const el = document.getElementById('legend');
    const metro = TRANSIT.filter((l) => l.kind !== 'rail');
    const rail = TRANSIT.filter((l) => l.kind === 'rail');
    const chips = metro.map((l) => `<span class="bar" style="background:${l.color}"></span>`).join('');
    let html = `<button class="legend-toggle" aria-expanded="false">${chips}<span class="legend-toggle-label">Legend</span></button>`;
    html += '<div class="legend-full"><div class="legend-lines">';
    html += metro.map((l) => `<div class="legend-row"><span class="bar" style="background:${l.color}"></span>${esc(l.name)}</div>`).join('');
    if (rail.length) {
      const stops = rail.map((l, i) => `${l.color} ${(i / rail.length) * 100}% ${((i + 1) / rail.length) * 100}%`).join(',');
      html += `<div class="legend-row"><span class="bar thin" style="background:linear-gradient(90deg,${stops})"></span>Commuter rail</div>`;
    }
    html += '</div>';
    if (devMarkers.length) {
      const sample = mixGradient([['residential', 3], ['office', 1.5], ['retail', 1.2], ['park', 0.8], ['institutional', 0.6]]);
      html += `<div class="legend-dev"><span class="dev-ring sample" style="--d:16px;--t:3px;--mix:${sample}"></span>`
        + '<span>REM rings show each station\'s development mix — tap one.</span></div>';
    }
    html += '<div class="legend-dl">Download: <a href="output/Montreal-Metro-REM-Earth.kmz">Google Earth</a> · <a href="output/Montreal-Metro-REM-MyMaps.kml">My Maps</a></div></div>';
    el.innerHTML = html;
    const toggle = el.querySelector('.legend-toggle');
    toggle.addEventListener('click', () => {
      const open = el.classList.toggle('expanded');
      toggle.setAttribute('aria-expanded', String(open));
    });
    L.DomEvent.disableClickPropagation(el);
  })();

  // ---- Station card ------------------------------------------------------

  const panel = document.getElementById('panel');
  const isSheet = () => window.matchMedia('(max-width: 720px)').matches;

  function openStation(i, fly) {
    const st = DEV[i];
    if (!st) return;
    currentIndex = i;
    panel.innerHTML = cardHtml(st);
    panel.style.setProperty('--accent', st.dominant);
    panel.classList.add('open');
    panel.setAttribute('aria-hidden', 'false');
    panel.scrollTop = 0;
    const body = panel.querySelector('.panel-body');
    if (body) body.scrollTop = 0;
    refreshRings();
    if (history.replaceState) history.replaceState(null, '', '#' + st.id);
    if (fly) focusStation(st);
  }

  function closePanel() {
    if (currentIndex == null) return;
    currentIndex = null;
    panel.classList.remove('open');
    panel.setAttribute('aria-hidden', 'true');
    refreshRings();
    if (history.replaceState) history.replaceState(null, '', location.pathname + location.search);
  }

  function step(delta) {
    if (currentIndex == null) return;
    const n = DEV.length;
    openStation((currentIndex + delta + n) % n, true);
  }

  function focusStation(st) {
    const z = Math.max(map.getZoom(), 14);
    const pt = map.project([st.lat, st.lon], z);
    if (isSheet()) pt.y += panel.offsetHeight / 2;
    else pt.x += panel.offsetWidth / 2;
    map.flyTo(map.unproject(pt, z), z, { duration: 0.7 });
  }

  function cardHtml(st) {
    const n = DEV.length;
    const prev = DEV[(st.index - 1 + n) % n];
    const next = DEV[(st.index + 1) % n];
    const level = ACTIVITY[st.activity] || 1;
    const opened = st.opened ? `Opened ${fmtDate(st.opened)}` : (st.opening ? esc(st.opening) : 'Opening date TBA');

    let h = `<header class="panel-head" style="--mixlin:${mixLinear(st.weights)}">
      <span class="head-stripe"></span>
      <button class="close" aria-label="Close">×</button>
      <div class="eyebrow"><span class="rem-badge">REM</span><span class="eyebrow-text">${esc(st.area || st.branch || '')}</span></div>
      <h2>${esc(st.station)}</h2>
      <div class="head-meta">
        <span>${opened}</span>
        <span class="activity act-${level}" title="Development activity">
          <i></i><i></i><i></i>${['', 'Quiet', 'Growing', 'Booming'][level]}
        </span>
      </div>
    </header>
    <div class="panel-body">`;

    if (st.summary) h += `<p class="summary">${esc(st.summary)}</p>`;

    if (st.stats && st.stats.length) {
      h += '<div class="stats">' + st.stats.map((s) => {
        const src = safeUrl(s.source_url);
        return `<div class="stat" style="--c:${statColor(s.label + ' ' + s.value)}">
          <div class="stat-v">${esc(s.value)}</div>
          <div class="stat-l">${esc(s.label)}</div>
          ${src ? `<a class="stat-src" href="${esc(src)}" target="_blank" rel="noopener">${esc(hostOf(src))} ↗</a>` : ''}
        </div>`;
      }).join('') + '</div>';
    }

    const projects = st.projects || [];
    if (st.weights.length) {
      const total = st.weights.reduce((s, [, v]) => s + v, 0);
      h += '<section><h3>Development mix</h3><div class="mixbar">'
        + st.weights.map(([u, v]) => `<span style="flex:${v};background:${USES[u].color}" title="${USES[u].label}"></span>`).join('')
        + '</div><div class="mix-legend">'
        + st.weights.map(([u, v]) => `<span><i style="background:${USES[u].color}"></i>${USES[u].label} <b>${Math.round((v / total) * 100)}%</b></span>`).join('')
        + '</div></section>';
    }

    if (projects.length) {
      const counts = {};
      projects.forEach((p) => { counts[p.status] = (counts[p.status] || 0) + 1; });
      h += '<section><h3>Pipeline</h3><div class="pipeline">'
        + STATUSES.map((s) => `<div class="pipe st-${s.key}${counts[s.key] ? '' : ' empty'}">
            <b>${counts[s.key] || 0}</b><span>${s.label}</span></div>`).join('')
        + '</div>'
        + (counts.cancelled ? `<div class="pipe-note">${counts.cancelled} cancelled</div>` : '')
        + '</section>';

      h += '<section><h3>Projects</h3>' + projects.map(projectHtml).join('') + '</section>';
    } else {
      h += '<section class="quiet"><h3>Projects</h3><p>No major projects announced around this station yet.</p></section>';
    }

    const plans = (st.plans || []).filter((p) => safeUrl(p.url));
    if (plans.length) {
      h += '<section><h3>Planning documents</h3><ul class="plans">'
        + plans.map((p) => `<li><a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.name)} ↗</a>${p.by ? `<span>${esc(p.by)}</span>` : ''}</li>`).join('')
        + '</ul></section>';
    }

    h += '<p class="notes">Compiled from public sources, Nov 2026. Statuses change — follow the links for the latest.</p>';
    h += '</div>';

    h += `<nav class="panel-nav">
      <button class="nav-prev" aria-label="Previous station"><span>←</span>${esc(prev.station)}</button>
      <span class="nav-count">${st.index + 1} / ${n}</span>
      <button class="nav-next" aria-label="Next station">${esc(next.station)}<span>→</span></button>
    </nav>`;
    return h;
  }

  function projectHtml(p) {
    const uses = (p.uses || []).filter((u) => USES[u]);
    const stripe = uses.length
      ? `linear-gradient(180deg, ${uses.map((u, i) => `${USES[u].color} ${(i / uses.length) * 100}% ${((i + 1) / uses.length) * 100}%`).join(', ')})`
      : NO_DEV_COLOR;
    const main = uses.length ? USES[uses[0]].color : '#56627A';
    const meta = [
      p.units ? `<span><b>${fmtInt(p.units)}</b> homes</span>` : '',
      p.floor_area ? `<span>${esc(p.floor_area)}</span>` : '',
      p.height ? `<span>${esc(p.height)}</span>` : '',
      p.timeline ? `<span>${esc(p.timeline)}</span>` : '',
      p.cost ? `<span>${esc(p.cost)}</span>` : '',
    ].filter(Boolean).join('');
    const renders = safeUrl(p.renders_url);
    const source = safeUrl(p.source_url);
    return `<article class="project${p.status === 'cancelled' ? ' is-cancelled' : ''}" style="--stripe:${stripe};--main:${main}">
      <div class="project-top">
        <h4>${esc(p.name)}</h4>
        <span class="status st-${esc(p.status)}">${esc(STATUS_LABEL[p.status] || p.status)}</span>
      </div>
      ${p.developer ? `<div class="dev">${esc(p.developer)}</div>` : ''}
      ${uses.length ? `<div class="uses">${uses.map((u) => `<span style="--u:${USES[u].color}">${USES[u].label}</span>`).join('')}</div>` : ''}
      ${meta ? `<div class="meta">${meta}</div>` : ''}
      ${p.description ? `<p>${esc(p.description)}</p>` : ''}
      <div class="links">
        ${renders ? `<a class="btn-renders" href="${esc(renders)}" target="_blank" rel="noopener">View renders ↗</a>` : ''}
        ${source && source !== renders ? `<a class="btn-source" href="${esc(source)}" target="_blank" rel="noopener">${esc(hostOf(source))} ↗</a>` : ''}
      </div>
    </article>`;
  }

  panel.addEventListener('click', (e) => {
    if (e.target.closest('.close')) closePanel();
    else if (e.target.closest('.nav-prev')) step(-1);
    else if (e.target.closest('.nav-next')) step(1);
  });
  L.DomEvent.disableClickPropagation(panel);
  L.DomEvent.disableScrollPropagation(panel);

  map.on('click', closePanel);
  document.addEventListener('keydown', (e) => {
    if (currentIndex == null) return;
    if (e.key === 'Escape') closePanel();
    else if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === 'ArrowRight') step(1);
  });

  const initial = DEV.findIndex((s) => '#' + s.id === location.hash);
  if (initial >= 0) setTimeout(() => openStation(initial, true), 300);
})();
