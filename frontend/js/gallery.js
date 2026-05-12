const API_URL = "DEINE_API_URL_HIER_EINSETZEN"; // Die URL aus deinem Terraform Output
const MEDIA_BASE_URL = "https://high-definition.net/"; // Deine CloudFront Domain

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
            const imgHtml = `
                <div class="image-container" onclick="openLightbox('${MEDIA_BASE_URL}${img.FullSizeUrl}')">
                    <img src="${MEDIA_BASE_URL}${img.ThumbnailUrl}" alt="${img.Caption}">
                    <div class="info-row">
                        <div class="metadata">${img.Caption}</div>
                    </div>
                </div>`;
            galleryGrid.innerHTML += imgHtml;
        });

        // 3. Flug-Daten (Globen) initialisieren
        if (meta && meta.CsvFiles) {
            meta.CsvFiles.forEach((csvPath, index) => {
                const cleanPath = csvPath.replace(/"/g, ''); // Entfernt die extra Anführungszeichen
                const globeId = `flightGlobe0${index + 1}`;
                if (document.getElementById(globeId)) {
                    renderGlobe(globeId, `${MEDIA_BASE_URL}koljagrosse/2026Miami/flights/${cleanPath}`);
                }
            });
        }

    } catch (error) {
        console.error("Fehler beim Laden der Galerie-Daten:", error);
    }
}

function renderGlobe(containerId, csvUrl) {
    // Hier nutzt du deine existierende Globe.gl Logik
    const world = Globe()
      (document.getElementById(containerId))
      .globeImageUrl('//unpkg.com/three-globe/example/img/earth-night.jpg')
      .pointsData([]) // Hier deine CSV-Parsing Logik einbauen
    
    // Tipp: Nutze fetch(csvUrl) um die Daten für den Globus zu laden
}

// Start
initGallery();