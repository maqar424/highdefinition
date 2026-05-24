const API_URL = "https://ejjvnnn1lj.execute-api.eu-central-1.amazonaws.com/gallery";
const MEDIA_BASE_URL = "https://high-definition.net/media/";

async function initGallery() {
    try {
        const response = await fetch(API_URL);
        if (!response.ok) throw new Error(`API Fehler: ${response.status}`);
        const data = await response.json();

        const meta = data.find(item => item.GalleryId && item.GalleryId.startsWith('GALLERY#'));
        const images = data.filter(item => item.GalleryId && item.GalleryId.startsWith('IMAGE#'));

        if (meta) {
            if (meta.Title) document.querySelector('header h1').innerText = meta.Title;
            if (meta.Description) document.querySelector('.description').innerText = meta.Description;
        }

        const imagesHtml = images.map(img => {
            const thumb = (img.ThumbnailUrl || '').replace(/^\//, '');
            const full  = (img.FullSizeUrl  || '').replace(/^\//, '');
            const caption = img.Caption || '';
            return `
                <div class="image-container">
                    <img src="${MEDIA_BASE_URL}${thumb}"
                         onclick="openLightbox('${MEDIA_BASE_URL}${full}')"
                         alt="${caption}">
                    <div class="info-row">
                        <div class="metadata">${caption}</div>
                    </div>
                </div>`;
        }).join('');

        const globe02Wrapper = document.getElementById('globe-wrapper-02');
        globe02Wrapper.insertAdjacentHTML('beforebegin', imagesHtml);

        if (meta && meta.CsvFiles && meta.CsvFiles[0]) {
            const path1 = meta.CsvFiles[0].replace(/"/g, '').replace(/^\//, '');
            renderGlobe('flightGlobe01', `${MEDIA_BASE_URL}${path1}`);
        } else {
            renderGlobe('flightGlobe01', null);
        }

        if (meta && meta.CsvFiles && meta.CsvFiles[1]) {
            const path2 = meta.CsvFiles[1].replace(/"/g, '').replace(/^\//, '');
            renderGlobe('flightGlobe02', `${MEDIA_BASE_URL}${path2}`);
        } else {
            renderGlobe('flightGlobe02', null);
        }

    } catch (error) {
        console.error("Fehler beim Laden der Galerie:", error);
    }
}

// Parst eine einzelne CSV-Zeile und berücksichtigt Felder in Anführungszeichen
function parseCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
            inQuotes = !inQuotes;
        } else if (ch === ',' && !inQuotes) {
            result.push(current.trim());
            current = '';
        } else {
            current += ch;
        }
    }
    result.push(current.trim());
    return result;
}

// Parst FlightRadar24-CSV und gibt Array von [lat, lng]-Punkten zurück
function parseFlightCSV(csvText) {
    const lines = csvText.trim().split('\n');
    if (lines.length < 2) return [];

    const headers = parseCSVLine(lines[0]).map(h => h.replace(/"/g, '').toLowerCase());
    const posIdx = headers.indexOf('position');
    if (posIdx === -1) return [];

    const points = [];
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        const cols = parseCSVLine(line);
        if (cols.length <= posIdx) continue;
        const pos = cols[posIdx].replace(/"/g, '').trim();
        const parts = pos.split(',');
        if (parts.length < 2) continue;
        const lat = parseFloat(parts[0]);
        const lng = parseFloat(parts[1]);
        if (!isNaN(lat) && !isNaN(lng)) {
            points.push([lat, lng]);
        }
    }
    return points;
}

function renderGlobe(containerId, csvUrl) {
    const container = document.getElementById(containerId);

    const world = Globe()(container)
        .globeImageUrl('//unpkg.com/three-globe/example/img/earth-night.jpg')
        .backgroundColor('rgba(0,0,0,0)');

    const resizeObserver = new ResizeObserver(() => {
        world.width(container.offsetWidth);
        world.height(container.offsetHeight);
    });
    resizeObserver.observe(container);

    // Standard-Ansicht: Atlantik (FRA→MIA Route)
    world.pointOfView({ lat: 40, lng: -30, altitude: 2.5 }, 0);

    if (!csvUrl) {
        renderFallbackArc(world);
        return;
    }

    fetch(csvUrl)
        .then(res => {
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.text();
        })
        .then(csvText => {
            const points = parseFlightCSV(csvText);
            if (points.length < 2) {
                console.warn(`${containerId}: Zu wenig Datenpunkte, nutze Fallback`);
                renderFallbackArc(world);
                return;
            }

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
        })
        .catch(err => {
            console.warn(`Globe CSV Fehler (${containerId}):`, err);
            renderFallbackArc(world);
        });
}

function renderFallbackArc(world) {
    world
        .arcsData([{
            startLat: 50.0379, startLng: 8.5622,
            endLat: 25.7959, endLng: -80.2870
        }])
        .arcColor(() => ['rgba(255,255,255,0.4)', '#00eeee'])
        .arcDashLength(0.4)
        .arcDashGap(0.2)
        .arcDashAnimateTime(2000);
}

function openLightbox(url) {
    const lb = document.getElementById('lightbox');
    const lbImg = document.getElementById('lightbox-img');
    lbImg.src = url;
    lb.classList.add('active');
}

document.getElementById('lightbox').onclick = function() {
    this.classList.remove('active');
};

initGallery();
