const API_URL = "https://ejjvnnn1lj.execute-api.eu-central-1.amazonaws.com/gallery"; 
const MEDIA_BASE_URL = "https://high-definition.net/media/"; // Pfad inklusive /media/

async function initGallery() {
    try {
        const response = await fetch(API_URL);
        const data = await response.json();

        // 1. Metadaten & Bilder trennen
        const meta = data.find(item => item.GalleryId.startsWith('GALLERY#'));
        const images = data.filter(item => item.GalleryId.startsWith('IMAGE#'));
        
        // Header füllen
        if (meta) {
            document.querySelector('header h1').innerText = meta.Title;
            document.querySelector('.description').innerText = meta.Description;
        }

        const galleryGrid = document.getElementById('gallery');
        
        // 2. ERSTER GLOBE (FRA -> MIA)
        // Wir lassen den vorhandenen HTML-Container für Globe 01 stehen
        if (meta && meta.CsvFiles && meta.CsvFiles[0]) {
            const path1 = meta.CsvFiles[0].replace(/"/g, '').replace(/^\//, '');
            renderGlobe('flightGlobe01', `${MEDIA_BASE_URL}${path1}`);
        }

        // 3. ALLE BILDER (Zwischen die Globen schieben)
        // Wir erstellen einen Container für die Bilder, damit sie nicht die Globen verdrängen
        const imagesHtml = images.map(img => {
            const cleanThumb = img.ThumbnailUrl.replace(/^\//, '');
            const cleanFull = img.FullSizeUrl.replace(/^\//, '');
            return `
                <div class="image-container">
                    <img src="${MEDIA_BASE_URL}${cleanThumb}" 
                         onclick="openLightbox('${MEDIA_BASE_URL}${cleanFull}')" 
                         alt="${img.Caption}">
                    <div class="info-row">
                        <div class="metadata">${img.Caption || 'Miami 2026'}</div>
                    </div>
                </div>`;
        }).join('');

        // Wir fügen die Bilder zwischen die beiden Globe-Wrapper ein
        const globe02Wrapper = document.getElementById('globe-wrapper-02');
        globe02Wrapper.insertAdjacentHTML('beforebegin', imagesHtml);

        // 4. ZWEITER GLOBE (MIA -> FRA)
        if (meta && meta.CsvFiles && meta.CsvFiles[1]) {
            const path2 = meta.CsvFiles[1].replace(/"/g, '').replace(/^\//, '');
            renderGlobe('flightGlobe02', `${MEDIA_BASE_URL}${path2}`);
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