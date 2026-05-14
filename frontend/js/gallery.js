const API_URL = "https://ejjvnnn1lj.execute-api.eu-central-1.amazonaws.com/gallery"; 
const MEDIA_BASE_URL = "https://high-definition.net/media/"; // Pfad inklusive /media/

async function initGallery() {
    try {
        const response = await fetch(API_URL);
        const data = await response.json();

        // 1. Galerie-Metadaten finden
        const meta = data.find(item => item.GalleryId.startsWith('GALLERY#'));
        if (meta) {
            document.querySelector('header h1').innerText = meta.Title;
            document.querySelector('.description').innerText = meta.Description;
        }

        // 2. Bilder laden
        const images = data.filter(item => item.GalleryId.startsWith('IMAGE#'));
        const galleryGrid = document.getElementById('gallery');

        images.forEach(img => {
            // Wir entfernen eventuelle führende Slashes von den URLs aus der DB
            const cleanThumb = img.ThumbnailUrl.replace(/^\//, '');
            const cleanFull = img.FullSizeUrl.replace(/^\//, '');

            const imgHtml = `
                <div class="image-container">
                    <img src="${MEDIA_BASE_URL}${cleanThumb}" 
                         onclick="openLightbox('${MEDIA_BASE_URL}${cleanFull}')" 
                         alt="${img.Caption}">
                    <div class="info-row">
                        <div class="metadata">${img.Caption || 'Miami 2026'}</div>
                    </div>
                </div>`;
            galleryGrid.innerHTML += imgHtml;
        });

        // 3. Flug-Daten (Globen) initialisieren
        if (meta && meta.CsvFiles) {
            meta.CsvFiles.forEach((csvPath, index) => {
                const cleanPath = csvPath.replace(/"/g, '').replace(/^\//, ''); 
                const globeId = `flightGlobe0${index + 1}`;
                if (document.getElementById(globeId)) {
                    // Pfad: /media/ + restlicher Pfad aus DB
                    renderGlobe(globeId, `${MEDIA_BASE_URL}${cleanPath}`);
                }
            });
        }

    } catch (error) {
        console.error("Fehler beim Laden der Galerie-Daten:", error);
    }
}

function renderGlobe(containerId, csvUrl) {
    const container = document.getElementById(containerId);
    
    // Globus initialisieren
    const world = Globe()(container)
        .globeImageUrl('//unpkg.com/three-globe/example/img/earth-night.jpg')
        .arcColor(() => '#00eeee')
        .arcDashLength(0.4)
        .arcDashGap(0.2)
        .arcDashAnimateTime(2000)
        .backgroundColor('rgba(0,0,0,0)'); // Transparentes Schwarz

    // Daten laden und Pfade zeichnen
    fetch(csvUrl)
        .then(res => res.text())
        .then(csvText => {
            // Einfaches Parsing für Start/Ende (FRA - MIA Logik)
            // Hier müsstest du ggf. deine Koordinaten-Logik verfeinern
            const arcsData = [{
                startLat: 50.0379, startLng: 8.5622, // FRA
                endLat: 25.7959, endLng: -80.2870,   // MIA
                color: ['#ffffff', '#00eeee']
            }];
            
            world.arcsData(arcsData);
            
            // Auto-Resize
            const resizeObserver = new ResizeObserver(() => {
                world.width(container.offsetWidth);
                world.height(container.offsetHeight);
            });
            resizeObserver.observe(container);
        });
}

// Lightbox Funktionen
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