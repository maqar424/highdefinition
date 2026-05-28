const API_URL        = "https://ejjvnnn1lj.execute-api.eu-central-1.amazonaws.com/gallery";
const MEDIA_BASE_URL = "https://high-definition.net/media/";

// ---------------------------------------------------------------------------
// Legacy-Modus (2026Miami – hardcodierte Globe-Wrapper in HTML)
// ---------------------------------------------------------------------------

async function initGallery() {
    try {
        const response = await fetch(API_URL);
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
    const durationSec = last.timestamp - first.timestamp;
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

function renderFlightInfo(infoId, stats) {
    const el = document.getElementById(infoId);
    if (!el) return;
    const fmt = n => n.toLocaleString('de-DE');
    el.innerHTML = `
        <div class="fi-stat">
            <span class="fi-label">Flug</span>
            <span class="fi-callsign">${stats.callsign}</span>
        </div>
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

function renderGlobe(globeId, infoId, csvUrl) {
    const container = document.getElementById(globeId);
    const world = Globe()(container)
        .globeImageUrl('//unpkg.com/three-globe/example/img/earth-night.jpg')
        .backgroundColor('rgba(0,0,0,0)');

    new ResizeObserver(() => {
        world.width(container.offsetWidth);
        world.height(container.offsetHeight);
    }).observe(container);

    world.pointOfView({ lat: 40, lng: -30, altitude: 2.5 }, 0);

    if (!csvUrl) { renderFallbackArc(world); renderFlightInfoError(infoId); return; }

    fetch(csvUrl)
        .then(res => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.text(); })
        .then(csvText => {
            const { points, rows } = parseFlightCSV(csvText);
            if (points.length < 2) { renderFallbackArc(world); renderFlightInfoError(infoId); return; }
            world
                .pathsData([{ pts: points }])
                .pathPoints(d => d.pts)
                .pathPointLat(p => p[0])
                .pathPointLng(p => p[1])
                .pathColor(() => ['rgba(255,255,255,0.4)', 'rgba(0,238,238,1)'])
                .pathStroke(1.5)
                .pathDashLength(0.05)
                .pathDashGap(0.03)
                .pathDashAnimateTime(8000);
            const mid = points[Math.floor(points.length / 2)];
            world.pointOfView({ lat: mid[0], lng: mid[1], altitude: 2.5 }, 2000);
            if (rows.length >= 2) renderFlightInfo(infoId, computeFlightStats(rows));
        })
        .catch(err => {
            console.warn(`Globe Fehler (${globeId}):`, err);
            renderFallbackArc(world);
            renderFlightInfoError(infoId);
        });
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
                // Unterstützt CsvUrls (Array, mehrere Legs) und CsvUrl (einzeln, backward compat)
                const csvUrls = Array.isArray(item.CsvUrls) && item.CsvUrls.length
                    ? item.CsvUrls
                    : (item.CsvUrl ? [item.CsvUrl] : []);
                const gBase = `flightGlobe${globeIndex}`;
                const iBase = `flightInfo${globeIndex}`;
                main.appendChild(_buildFlightEl(item, gBase, iBase, csvUrls));
                const legs = csvUrls.length ? csvUrls : [null];
                legs.forEach((url, li) => {
                    const sfx     = legs.length > 1 ? `_${li}` : '';
                    const fullUrl = url ? `${MEDIA_BASE_URL}${url}` : null;
                    renderGlobe(`${gBase}${sfx}`, `${iBase}${sfx}`, fullUrl);
                });
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

function _buildFlightEl(flight, baseGlobeId, baseInfoId, csvUrls = []) {
    const label   = flight.Label || '';
    const div     = document.createElement('div');
    div.className = 'image-container';
    const legs    = csvUrls.length > 1 ? csvUrls.map((_, i) => i) : [0];
    const multi   = legs.length > 1;

    const segmentsHtml = legs.map(i => {
        const sfx = multi ? `_${i}` : '';
        return multi
            ? `<div class="flight-segment">
                   <div class="flight-info" id="${baseInfoId}${sfx}">
                       <div class="fi-loading">Lade Flugdaten …</div>
                   </div>
                   <div class="globe-container">
                       <div id="${baseGlobeId}${sfx}" class="flight-div"></div>
                   </div>
               </div>`
            : `<div class="flight-info" id="${baseInfoId}">
                   <div class="fi-loading">Lade Flugdaten …</div>
               </div>
               <div class="globe-container">
                   <div id="${baseGlobeId}" class="flight-div"></div>
               </div>`;
    }).join('');

    div.innerHTML = `
        <div class="flight-card${multi ? ' multi-leg' : ''}">
            ${segmentsHtml}
        </div>
        <div class="info-row">
            <div class="metadata">${label}</div>
            <div class="download-btn" style="cursor:default; background:#333; color:white;">3D Log</div>
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
