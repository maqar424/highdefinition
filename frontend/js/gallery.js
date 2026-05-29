const API_URL        = "https://ejjvnnn1lj.execute-api.eu-central-1.amazonaws.com/gallery";
const MEDIA_BASE_URL = "https://high-definition.net/media/";

// ---------------------------------------------------------------------------
// Legacy-Modus (2026Miami – hardcodierte Globe-Wrapper in HTML)
// ---------------------------------------------------------------------------

async function initGallery() {
    try {
        // Derive userId / galleryId from the URL so only this gallery's items
        // are returned (e.g. /koljagrosse/2026Miami/index.html).
        const parts     = window.location.pathname
            .replace(/\/index\.html$/, '')
            .split('/').filter(Boolean);   // ['koljagrosse', '2026Miami']
        const userId    = parts[0] || 'koljagrosse';
        const galleryId = parts[1] || null;
        const query     = galleryId
            ? `?userId=${encodeURIComponent(userId)}&galleryId=${encodeURIComponent(galleryId)}`
            : `?userId=${encodeURIComponent(userId)}`;

        const response = await fetch(API_URL + query);
        if (!response.ok) throw new Error(`API Fehler: ${response.status}`);
        const data = await response.json();

        const meta   = data.find(item => item.GalleryId && item.GalleryId.startsWith('GALLERY#'));
        const images = data.filter(item => item.GalleryId && item.GalleryId.startsWith('IMAGE#'));

        if (meta && (meta.Title || meta.Description)) {
            const header = document.createElement('header');
            if (meta.Title) {
                const h1 = document.createElement('h1');
                h1.innerText = meta.Title;
                header.appendChild(h1);
            }
            if (meta.Description) {
                const desc = document.createElement('div');
                desc.className = 'description';
                desc.innerText = meta.Description;
                header.appendChild(desc);
            }
            document.querySelector('main.gallery-grid').before(header);
        }

        const imagesHtml = images.map(img => {
            const thumb    = (img.ThumbnailUrl || '').replace(/^\//, '');
            const full     = (img.FullSizeUrl  || '').replace(/^\//, '');
            const alt      = img.Caption || '';
            const aperture = img.Aperture     || '—';
            const shutter  = img.ShutterSpeed || '—';
            const iso      = img.ISO          ? `ISO ${img.ISO}` : '—';
            const caption  = img.Caption      || '';
            return `
                <div class="image-container">
                    <img src="${MEDIA_BASE_URL}${thumb}"
                         onclick="openLightbox('${MEDIA_BASE_URL}${full}')"
                         alt="${alt}">
                    <div class="info-row">
                        <div class="metadata">${aperture} · ${shutter} · ${iso}</div>
                    </div>
                    ${caption ? `<div class="image-description">${caption}</div>` : ''}
                </div>`;
        }).join('');

        document.getElementById('globe-wrapper-02').insertAdjacentHTML('beforebegin', imagesHtml);

        alignCaptionsToImages();
        window.addEventListener('resize', alignCaptionsToImages);

        const csv1 = meta?.CsvFiles?.[0] ? `${MEDIA_BASE_URL}${meta.CsvFiles[0].replace(/^\//, '')}` : null;
        const csv2 = meta?.CsvFiles?.[1] ? `${MEDIA_BASE_URL}${meta.CsvFiles[1].replace(/^\//, '')}` : null;
        renderGlobe('flightGlobe01', 'flightInfo01', csv1);
        renderGlobe('flightGlobe02', 'flightInfo02', csv2);

    } catch (err) {
        console.error("Fehler beim Laden der Galerie:", err);
    }
}

// ---------------------------------------------------------------------------
// Caption-Ausrichtung
// ---------------------------------------------------------------------------

function alignCaptionsToImages() {
    document.querySelectorAll('.image-container img').forEach(img => {
        const apply = () => {
            const w = img.clientWidth;
            if (!w) return;
            img.closest('.image-container')
               .querySelectorAll('.info-row, .image-description')
               .forEach(el => el.style.width = w + 'px');
        };
        if (img.complete && img.naturalWidth > 0) apply();
        else img.addEventListener('load', apply, { once: true });
    });
}

// ---------------------------------------------------------------------------
// CSV-Parser
// ---------------------------------------------------------------------------

function parseCSVLine(line) {
    const result = [];
    let cur = '', inQ = false;
    for (const ch of line) {
        if (ch === '"')              inQ = !inQ;
        else if (ch === ',' && !inQ) { result.push(cur.trim()); cur = ''; }
        else                          cur += ch;
    }
    result.push(cur.trim());
    return result;
}

function parseFlightCSV(csvText) {
    const lines = csvText.trim().split('\n');
    if (lines.length < 2) return { points: [], rows: [] };

    const hdrs = parseCSVLine(lines[0]).map(h => h.replace(/"/g, '').toLowerCase());
    const idx  = name => hdrs.indexOf(name);
    const posI = idx('position'), tsI = idx('timestamp'), utcI = idx('utc');
    const csI  = idx('callsign'), altI = idx('altitude'), spdI = idx('speed');

    const points = [], rows = [];
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        const c = parseCSVLine(line);
        const posParts = (c[posI] || '').replace(/"/g, '').split(',');
        const lat = parseFloat(posParts[0]), lng = parseFloat(posParts[1]);
        if (isNaN(lat) || isNaN(lng)) continue;
        points.push([lat, lng]);
        rows.push({
            timestamp: parseInt(c[tsI])  || 0,
            utc:       (c[utcI] || '').replace(/"/g, '').trim(),
            callsign:  (c[csI]  || '').replace(/"/g, '').trim(),
            altitude:  parseInt(c[altI]) || 0,
            speed:     parseInt(c[spdI]) || 0,
            lat, lng
        });
    }
    return { points, rows };
}

// ---------------------------------------------------------------------------
// Flugstatistik
// ---------------------------------------------------------------------------

function pathLengthKm(points) {
    let km = 0;
    for (let i = 1; i < points.length; i++)
        km += haversineKm(points[i-1][0], points[i-1][1], points[i][0], points[i][1]);
    return Math.max(km, 1);   // avoid division-by-zero for degenerate paths
}

function haversineKm(lat1, lon1, lat2, lon2) {
    const R    = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a    = Math.sin(dLat / 2) ** 2
               + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
               * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.asin(Math.sqrt(a));
}

function computeFlightStats(rows) {
    const first = rows[0], last = rows[rows.length - 1];

    // Use only airborne rows for duration so taxi time is excluded.
    // 100 ft is a safe threshold — FlightRadar24 reports 0 on the ground.
    const AIRBORNE_FT = 100;
    const airRows  = rows.filter(r => r.altitude > AIRBORNE_FT);
    const takeoff  = airRows.length ? airRows[0]                  : first;
    const landing  = airRows.length ? airRows[airRows.length - 1] : last;

    const durationSec = landing.timestamp - takeoff.timestamp;
    const hours = Math.floor(durationSec / 3600);
    const mins  = Math.floor((durationSec % 3600) / 60);
    const maxAlt   = Math.max(...rows.map(r => r.altitude));
    const maxSpeed = Math.max(...rows.map(r => r.speed));
    let totalKm = 0;
    for (let i = 1; i < rows.length; i++)
        totalKm += haversineKm(rows[i-1].lat, rows[i-1].lng, rows[i].lat, rows[i].lng);
    const parseDate = utc => {
        const [y, m, d] = (utc.split('T')[0] || '').split('-');
        const mo = ['Jan.','Feb.','Mrz.','Apr.','Mai','Jun.','Jul.','Aug.','Sep.','Okt.','Nov.','Dez.'];
        return `${parseInt(d)}. ${mo[parseInt(m) - 1]} ${y}`;
    };
    return {
        callsign:    first.callsign,
        date:        parseDate(first.utc),
        hours, mins,
        totalKm:     Math.round(totalKm),
        totalNm:     Math.round(totalKm / 1.852),
        maxAltFt:    maxAlt,
        maxAltKm:    (maxAlt * 0.3048 / 1000).toFixed(1),
        maxSpeedKts: maxSpeed,
        maxSpeedKmh: Math.round(maxSpeed * 1.852)
    };
}

function renderFlightInfo(infoId, stats, routeLabel = '') {
    const el = document.getElementById(infoId);
    if (!el) return;
    const fmt = n => n.toLocaleString('de-DE');
    el.innerHTML = `
        <div class="fi-stat">
            <span class="fi-label">Flug</span>
            <span class="fi-callsign">${stats.callsign}</span>
        </div>
        ${routeLabel ? `
        <div class="fi-stat">
            <span class="fi-label">Route</span>
            <span class="fi-value">${routeLabel}</span>
        </div>` : ''}
        <div class="fi-stat">
            <span class="fi-label">Datum</span>
            <span class="fi-value">${stats.date}</span>
        </div>
        <div class="fi-stat">
            <span class="fi-label">Flugzeit</span>
            <span class="fi-value">${stats.hours}h ${String(stats.mins).padStart(2,'0')}min</span>
        </div>
        <div class="fi-divider"></div>
        <div class="fi-stat">
            <span class="fi-label">Strecke</span>
            <span class="fi-value">${fmt(stats.totalKm)} km
                <span class="fi-sub">(${fmt(stats.totalNm)} NM)</span>
            </span>
        </div>
        <div class="fi-stat">
            <span class="fi-label">Max. Höhe</span>
            <span class="fi-value">${fmt(stats.maxAltFt)} ft
                <span class="fi-sub">(${stats.maxAltKm} km)</span>
            </span>
        </div>
        <div class="fi-stat">
            <span class="fi-label">Max. Speed</span>
            <span class="fi-value">${stats.maxSpeedKts} kts
                <span class="fi-sub">(${fmt(stats.maxSpeedKmh)} km/h)</span>
            </span>
        </div>`;
}

// ---------------------------------------------------------------------------
// Globe-Rendering
// ---------------------------------------------------------------------------

// Per-leg path colours (cyan → gold → lavender …)
const PATH_COLOURS = [
    ['rgba(255,255,255,0.4)', 'rgba(0,238,238,1)'],
    ['rgba(255,255,255,0.4)', 'rgba(255,200,50,1)'],
    ['rgba(255,255,255,0.4)', 'rgba(180,140,255,1)'],
];

// renderGlobe accepts a single URL string *or* an array of URLs.
// All tracks are drawn on the same globe; info panel shows merged stats.
// routeLabel (optional) is shown in the info panel between callsign and date.
function renderGlobe(globeId, infoId, csvUrlOrUrls, routeLabel = '') {
    const container = document.getElementById(globeId);
    if (!container) {
        console.warn('renderGlobe: element not found:', globeId);
        return;
    }

    const world = Globe()(container)
        .globeImageUrl('https://unpkg.com/three-globe@2.45.2/example/img/earth-blue-marble.jpg')
        .backgroundImageUrl('https://unpkg.com/three-globe/example/img/night-sky.png');

    // Apply size after layout is computed, keep in sync via ResizeObserver.
    const applySize = () => {
        const w = container.offsetWidth;
        const h = container.offsetHeight;
        if (w > 0 && h > 0) { world.width(w).height(h); }
    };
    requestAnimationFrame(() => {
        applySize();
        new ResizeObserver(applySize).observe(container);
    });

    world.pointOfView({ lat: 40, lng: -30, altitude: 2.5 }, 0);

    // Normalise to an array of non-falsy URL strings
    const urls = Array.isArray(csvUrlOrUrls)
        ? csvUrlOrUrls.filter(Boolean)
        : (csvUrlOrUrls ? [csvUrlOrUrls] : []);

    if (!urls.length) { renderFallbackArc(world); renderFlightInfoError(infoId); return; }

    Promise.all(
        urls.map(url =>
            fetch(url)
                .then(res => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.text(); })
        )
    )
    .then(csvTexts => {
        const parsed = csvTexts
            .map(parseFlightCSV)
            .filter(p => p.points.length >= 2);

        if (!parsed.length) { renderFallbackArc(world); renderFlightInfoError(infoId); return; }

        // Draw every leg as a separate path with a distinct colour.
        // Dash size and animation speed are normalised to physical km so all
        // legs look the same regardless of route length.
        const TARGET_DASH_KM = 200;   // visual dash ≈ this many km of route
        const TARGET_GAP_KM  = 150;
        const MS_PER_KM      = 3.0;   // animation cycle time proportional to route length

        const pathData = parsed.map((p, i) => ({
            pts:     p.points,
            i,
            totalKm: pathLengthKm(p.points)
        }));

        world
            .pathsData(pathData)
            .pathPoints(d => d.pts)
            .pathPointLat(p => p[0])
            .pathPointLng(p => p[1])
            .pathColor(d => PATH_COLOURS[d.i % PATH_COLOURS.length])
            .pathStroke(1.5)
            .pathDashLength(d => Math.min(0.15, Math.max(0.02, TARGET_DASH_KM / d.totalKm)))
            .pathDashGap(d     => Math.min(0.10, Math.max(0.015, TARGET_GAP_KM  / d.totalKm)))
            .pathDashAnimateTime(d => Math.round(d.totalKm * MS_PER_KM));

        // Centre the view on the midpoint of all combined points
        const allPts = parsed.flatMap(p => p.points);
        const mid    = allPts[Math.floor(allPts.length / 2)];
        world.pointOfView({ lat: mid[0], lng: mid[1], altitude: 2.5 }, 2000);

        // Build flight-info panel
        const statsList = parsed
            .filter(p => p.rows.length >= 2)
            .map(p => computeFlightStats(p.rows));

        if (statsList.length === 1) {
            renderFlightInfo(infoId, statsList[0], routeLabel);
        } else if (statsList.length > 1) {
            renderMultiFlightInfo(infoId, statsList, routeLabel);
        }
    })
    .catch(err => {
        console.warn(`Globe Fehler (${globeId}):`, err);
        renderFallbackArc(world);
        renderFlightInfoError(infoId);
    });
}

// Merged info panel for multi-leg flights.
// Callsign, date, duration, altitude and speed are shown per leg,
// deduplicated when all legs share the same value.
// Distance is always shown as the total for the whole trip.
function renderMultiFlightInfo(infoId, statsList, routeLabel = '') {
    const el = document.getElementById(infoId);
    if (!el) return;
    const fmt  = n  => n.toLocaleString('de-DE');

    // Helper: map each leg, deduplicate if all equal, otherwise join with " / "
    const perLeg = fn => {
        const vals = statsList.map(fn);
        const unique = [...new Set(vals)];
        return unique.join(' / ');
    };

    // Per-leg duration (shown separately when legs differ)
    const durationStr = perLeg(s =>
        `${s.hours}h ${String(s.mins).padStart(2,'0')}min`
    );

    // Total distance (sum – most useful as a single trip number)
    const totalKm = statsList.reduce((a, s) => a + s.totalKm, 0);
    const totalNm = Math.round(totalKm / 1.852);

    // Per-leg max altitude
    const altFtStr = perLeg(s => `${fmt(s.maxAltFt)} ft`);
    const altKmStr = perLeg(s => s.maxAltKm);          // already a string "xx.x"

    // Per-leg max speed
    const spdKtsStr = perLeg(s => `${s.maxSpeedKts} kts`);
    const spdKmhStr = perLeg(s => fmt(s.maxSpeedKmh));

    el.innerHTML = `
        <div class="fi-stat">
            <span class="fi-label">Flug</span>
            <span class="fi-callsign">${perLeg(s => s.callsign)}</span>
        </div>
        ${routeLabel ? `
        <div class="fi-stat">
            <span class="fi-label">Route</span>
            <span class="fi-value">${routeLabel}</span>
        </div>` : ''}
        <div class="fi-stat">
            <span class="fi-label">Datum</span>
            <span class="fi-value">${perLeg(s => s.date)}</span>
        </div>
        <div class="fi-stat">
            <span class="fi-label">Flugzeit</span>
            <span class="fi-value">${durationStr}</span>
        </div>
        <div class="fi-divider"></div>
        <div class="fi-stat">
            <span class="fi-label">Strecke</span>
            <span class="fi-value">${fmt(Math.round(totalKm))} km
                <span class="fi-sub">(${fmt(totalNm)} NM)</span>
            </span>
        </div>
        <div class="fi-stat">
            <span class="fi-label">Max. Höhe</span>
            <span class="fi-value">${altFtStr}
                <span class="fi-sub">(${altKmStr} km)</span>
            </span>
        </div>
        <div class="fi-stat">
            <span class="fi-label">Max. Speed</span>
            <span class="fi-value">${spdKtsStr}
                <span class="fi-sub">(${spdKmhStr} km/h)</span>
            </span>
        </div>`;
}

function renderFallbackArc(world) {
    world
        .arcsData([{ startLat: 50.0379, startLng: 8.5622, endLat: 25.7959, endLng: -80.2870 }])
        .arcColor(() => ['rgba(255,255,255,0.4)', '#00eeee'])
        .arcDashLength(0.4).arcDashGap(0.2).arcDashAnimateTime(2000);
}

function renderFlightInfoError(infoId) {
    const el = document.getElementById(infoId);
    if (el) el.innerHTML = '<div class="fi-loading">Keine Flugdaten</div>';
}

// ---------------------------------------------------------------------------
// Lightbox
// ---------------------------------------------------------------------------

function openLightbox(url) {
    document.getElementById('lightbox-img').src = url;
    document.getElementById('lightbox').classList.add('active');
}

document.getElementById('lightbox').onclick = function () {
    this.classList.remove('active');
};

// ---------------------------------------------------------------------------
// Dynamisches Rendering für neue Galerien (HD_USER + HD_GALLERY in HTML gesetzt)
// ---------------------------------------------------------------------------

async function initGalleryDynamic(userId, galleryId) {
    try {
        const url      = `${API_URL}?userId=${encodeURIComponent(userId)}&galleryId=${encodeURIComponent(galleryId)}`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`API Fehler: ${response.status}`);
        const data = await response.json();

        const meta = data.find(item => item.GalleryId && item.GalleryId.startsWith('GALLERY#'));

        // Bilder + Flüge nach SortOrder sortieren (undefined → 50 als Mittelwert)
        const elements = data
            .filter(item => item.GalleryId &&
                (item.GalleryId.startsWith('IMAGE#') || item.GalleryId.startsWith('FLIGHT#')))
            .sort((a, b) => {
                const sa = (a.SortOrder !== undefined && a.SortOrder !== null) ? Number(a.SortOrder) : 50;
                const sb = (b.SortOrder !== undefined && b.SortOrder !== null) ? Number(b.SortOrder) : 50;
                return sa - sb;
            });

        // Header aus DynamoDB einfügen (kein Flash, weil <main> leer startet)
        if (meta && (meta.Title || meta.Description)) {
            const header = document.createElement('header');
            if (meta.Title) {
                const h1 = document.createElement('h1');
                h1.innerText = meta.Title;
                header.appendChild(h1);
            }
            if (meta.Description) {
                const desc = document.createElement('div');
                desc.className = 'description';
                desc.innerText = meta.Description;
                header.appendChild(desc);
            }
            document.querySelector('main.gallery-grid').before(header);
        }

        const main = document.getElementById('gallery');
        let globeIndex = 1;

        for (const item of elements) {
            if (item.GalleryId.startsWith('IMAGE#')) {
                main.appendChild(_buildImageEl(item));
            } else if (item.GalleryId.startsWith('FLIGHT#')) {
                // CsvUrls = array of legs (new); CsvUrl = single leg (backward compat)
                const csvUrls = Array.isArray(item.CsvUrls) && item.CsvUrls.length
                    ? item.CsvUrls
                    : (item.CsvUrl ? [item.CsvUrl] : []);
                const gBase    = `flightGlobe${globeIndex}`;
                const iBase    = `flightInfo${globeIndex}`;
                main.appendChild(_buildFlightEl(item, gBase, iBase));
                // All legs on one globe — pass the full URL array
                const fullUrls = csvUrls.map(u => `${MEDIA_BASE_URL}${u}`);
                try {
                    renderGlobe(gBase, iBase, fullUrls.length ? fullUrls : null, item.Label || '');
                } catch (e) {
                    console.warn(`Globe init failed (${gBase}):`, e);
                }
                globeIndex++;
            }
        }

        alignCaptionsToImages();
        window.addEventListener('resize', alignCaptionsToImages);

    } catch (err) {
        console.error("Fehler beim Laden der Galerie:", err);
    }
}

function _buildImageEl(img) {
    const thumb    = (img.ThumbnailUrl || '').replace(/^\//, '');
    const full     = (img.FullSizeUrl  || '').replace(/^\//, '');
    const aperture = img.Aperture     || '—';
    const shutter  = img.ShutterSpeed || '—';
    const iso      = img.ISO          ? `ISO ${img.ISO}` : '—';
    const caption  = img.Caption      || '';

    const div = document.createElement('div');
    div.className = 'image-container';
    div.innerHTML = `
        <img src="${MEDIA_BASE_URL}${thumb}"
             onclick="openLightbox('${MEDIA_BASE_URL}${full}')"
             alt="${caption}">
        <div class="info-row">
            <div class="metadata">${aperture} · ${shutter} · ${iso}</div>
        </div>
        ${caption ? `<div class="image-description">${caption}</div>` : ''}`;
    return div;
}

function _buildFlightEl(flight, baseGlobeId, baseInfoId) {
    const label   = flight.Label || '';
    const div     = document.createElement('div');
    div.className = 'image-container';
    div.innerHTML = `
        <div class="flight-card">
            <div class="flight-info" id="${baseInfoId}">
                <div class="fi-loading">Lade Flugdaten …</div>
            </div>
            <div class="globe-container">
                <div id="${baseGlobeId}" class="flight-div"></div>
            </div>
        </div>
        <div class="info-row">
            <div class="metadata">${label}</div>
        </div>`;
    return div;
}

// ---------------------------------------------------------------------------
// Einstiegspunkt: dynamisch (neue Galerien) oder legacy (2026Miami)
// ---------------------------------------------------------------------------

if (typeof HD_USER !== 'undefined' && typeof HD_GALLERY !== 'undefined') {
    initGalleryDynamic(HD_USER, HD_GALLERY);
} else {
    initGallery();
}
