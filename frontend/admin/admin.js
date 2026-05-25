// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const ADMIN_API    = "https://ejjvnnn1lj.execute-api.eu-central-1.amazonaws.com";
const MEDIA_BASE   = "https://high-definition.net/media/";
const DEFAULT_USER = "koljagrosse";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let state = {
    token:       null,
    userId:      DEFAULT_USER,
    gallerySlug: null,
    galleryTitle: null,
    elements:    [],   // { type:'image'|'flight', galleryId, label, thumbUrl, fullUrl, csvUrl }
    thumbnailGalleryId: null,  // GalleryId des gewählten Galerie-Thumbnails
    sortCounter: 1,
};

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

async function doLogin() {
    const pw  = document.getElementById('pw-input').value;
    const err = document.getElementById('login-error');
    err.textContent = '';
    if (!pw) return;

    const btn = document.querySelector('#step-login .btn-primary');
    btn.disabled = true;
    btn.textContent = '…';

    try {
        const res  = await apiPost('/admin/login', { password: pw }, false);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Fehler');
        state.token = data.token;
        localStorage.setItem('hd_admin_token', data.token);
        showLoggedIn();
    } catch (e) {
        err.textContent = e.message;
    } finally {
        btn.disabled = false;
        btn.textContent = 'Anmelden';
    }
}

function showLoggedIn() {
    show('admin-header');
    hide('step-login');
    show('step-create');
    document.getElementById('pw-input').value = '';
}

function logout() {
    localStorage.removeItem('hd_admin_token');
    state.token = null;
    hide('admin-header');
    hide('step-create');
    hide('step-elements');
    hide('step-done');
    show('step-login');
    document.getElementById('pw-input').value = '';
}

// ---------------------------------------------------------------------------
// Slug helpers
// ---------------------------------------------------------------------------

function slugify(text) {
    return text
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .trim()
        .replace(/[\s-]+/g, '-');
}

function updateSlugPreview() {
    const title = document.getElementById('gallery-title').value;
    const preview = document.getElementById('slug-preview');
    if (title.trim()) {
        preview.textContent = `URL: /${state.userId}/${slugify(title)}/`;
    } else {
        preview.textContent = '';
    }
}

// ---------------------------------------------------------------------------
// Schritt 1: Galerie erstellen
// ---------------------------------------------------------------------------

async function createGallery() {
    const title = document.getElementById('gallery-title').value.trim();
    const desc  = document.getElementById('gallery-desc').value.trim();
    const err   = document.getElementById('create-error');
    const btn   = document.getElementById('create-btn');
    err.textContent = '';

    if (!title) { err.textContent = 'Bitte einen Namen eingeben.'; return; }

    btn.disabled = true;
    btn.textContent = 'Erstelle …';

    try {
        const res  = await apiPost('/admin/gallery', { userId: state.userId, title, description: desc });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Fehler');

        state.gallerySlug  = data.slug;
        state.galleryTitle = title;

        hide('step-create');
        show('step-elements');
        document.getElementById('elements-heading').textContent = `Elemente für „${title}"`;

    } catch (e) {
        err.textContent = e.message;
    } finally {
        btn.disabled = false;
        btn.textContent = 'Galerie erstellen';
    }
}

// ---------------------------------------------------------------------------
// Schritt 2: Foto hochladen
// ---------------------------------------------------------------------------

function onPhotoSelected() {
    const file = document.getElementById('photo-file').files[0];
    if (!file) return;
    const preview = document.getElementById('photo-preview');
    const wrap    = document.getElementById('photo-preview-wrap');
    preview.src = URL.createObjectURL(file);
    show('photo-preview-wrap');
}

async function uploadPhoto() {
    const fileInput = document.getElementById('photo-file');
    const caption   = document.getElementById('photo-caption').value.trim();
    const err       = document.getElementById('photo-error');
    const btn       = document.getElementById('photo-upload-btn');
    err.textContent = '';

    const file = fileInput.files[0];
    if (!file) { err.textContent = 'Bitte eine Datei auswählen.'; return; }

    btn.disabled = true;
    setProgress('photo', 0, 'Thumbnail wird generiert …');
    showEl('photo-progress');

    try {
        // 1. Thumbnail im Browser generieren
        const thumbBlob = await generateThumbnail(file, 800);
        const ext       = file.name.split('.').pop().toLowerCase();
        const stem      = sanitizeFilename(file.name.replace(/\.[^/.]+$/, ''));
        const fullName  = `${stem}.${ext}`;
        const thumbName = `${stem}.webp`;

        setProgress('photo', 15, 'Presigned URL anfordern …');

        // 2. Presigned URLs für Original + Thumbnail
        const [presignFull, presignThumb] = await Promise.all([
            apiPost('/admin/presign', { userId: state.userId, gallerySlug: state.gallerySlug, filename: fullName, fileType: file.type, folder: 'hd' }).then(r => r.json()),
            apiPost('/admin/presign', { userId: state.userId, gallerySlug: state.gallerySlug, filename: thumbName, fileType: 'image/webp', folder: 'thumbnails' }).then(r => r.json()),
        ]);

        if (presignFull.error)  throw new Error(presignFull.error);
        if (presignThumb.error) throw new Error(presignThumb.error);

        setProgress('photo', 30, 'Originalbild hochladen …');

        // 3. Original hochladen
        await uploadToS3(presignFull.url, file, file.type, p => setProgress('photo', 30 + p * 0.4, 'Originalbild …'));

        setProgress('photo', 70, 'Thumbnail hochladen …');

        // 4. Thumbnail hochladen
        await uploadToS3(presignThumb.url, thumbBlob, 'image/webp', p => setProgress('photo', 70 + p * 0.2, 'Thumbnail …'));

        setProgress('photo', 92, 'In Datenbank eintragen …');

        // 5. In DynamoDB registrieren
        const sortOrder = state.sortCounter++;
        const reg = await apiPost('/admin/image', {
            userId:       state.userId,
            fullSizeUrl:  presignFull.key,
            thumbnailUrl: presignThumb.key,
            caption,
            sortOrder,
        });
        const regData = await reg.json();
        if (!reg.ok) throw new Error(regData.error);

        setProgress('photo', 100, 'Fertig ✓');

        // 6. Element zur Liste hinzufügen
        state.elements.push({
            type:      'image',
            galleryId: regData.galleryId,
            label:     caption || fullName,
            thumbUrl:  `${MEDIA_BASE}${presignThumb.key}`,
            fullUrl:   `${MEDIA_BASE}${presignFull.key}`,
            csvUrl:    null,
        });
        renderElementList();

        // Panel zurücksetzen
        setTimeout(() => {
            hideEl('photo-progress');
            hidePanel('photo-panel');
            fileInput.value = '';
            document.getElementById('photo-caption').value = '';
            document.getElementById('photo-preview').src = '';
            hide('photo-preview-wrap');
            btn.disabled = false;
        }, 800);

    } catch (e) {
        err.textContent = e.message;
        hideEl('photo-progress');
        btn.disabled = false;
    }
}

// ---------------------------------------------------------------------------
// Schritt 2: Flug hinzufügen
// ---------------------------------------------------------------------------

async function uploadFlight() {
    const label   = document.getElementById('flight-label').value.trim();
    const csvFile = document.getElementById('flight-csv').files[0];
    const err     = document.getElementById('flight-error');
    err.textContent = '';

    if (!label) { err.textContent = 'Bitte eine Beschriftung eingeben.'; return; }

    let csvUrl = '';

    if (csvFile) {
        setProgress('flight', 0, 'CSV hochladen …');
        showEl('flight-progress');

        try {
            const csvName   = sanitizeFilename(csvFile.name);
            const presign   = await apiPost('/admin/presign', {
                userId: state.userId, gallerySlug: state.gallerySlug,
                filename: csvName, fileType: 'text/csv', folder: 'flights',
            }).then(r => r.json());

            if (presign.error) throw new Error(presign.error);

            await uploadToS3(presign.url, csvFile, 'text/csv', p => setProgress('flight', p * 0.8, 'CSV …'));
            csvUrl = presign.key;
            setProgress('flight', 85, 'Eintragen …');
        } catch (e) {
            err.textContent = e.message;
            hideEl('flight-progress');
            return;
        }
    }

    try {
        const sortOrder = state.sortCounter++;
        const res  = await apiPost('/admin/flight', {
            userId: state.userId, gallerySlug: state.gallerySlug, csvUrl, label, sortOrder,
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);

        setProgress('flight', 100, 'Fertig ✓');

        state.elements.push({
            type:      'flight',
            galleryId: data.galleryId,
            label,
            thumbUrl:  null,
            fullUrl:   null,
            csvUrl,
        });
        renderElementList();

        setTimeout(() => {
            hideEl('flight-progress');
            hidePanel('flight-panel');
            document.getElementById('flight-label').value = '';
            document.getElementById('flight-csv').value   = '';
        }, 800);

    } catch (e) {
        err.textContent = e.message;
        hideEl('flight-progress');
    }
}

// ---------------------------------------------------------------------------
// Element-Liste rendern
// ---------------------------------------------------------------------------

function renderElementList() {
    const list = document.getElementById('element-list');
    const hint = document.getElementById('thumb-hint');
    const hasImages = state.elements.some(e => e.type === 'image');

    if (hasImages) show('thumb-hint'); else hide('thumb-hint');

    if (state.elements.length === 0) {
        list.innerHTML = '<p style="font-size:0.65rem;color:rgba(255,255,255,0.2);letter-spacing:1px;text-transform:uppercase;text-align:center;padding:20px 0;">Noch keine Elemente hinzugefügt.</p>';
        return;
    }

    list.innerHTML = state.elements.map((el, i) => {
        const isThumb = state.thumbnailGalleryId === el.galleryId;
        const thumbHtml = el.thumbUrl
            ? `<img class="element-thumb" src="${el.thumbUrl}" alt="">`
            : `<div class="element-thumb-placeholder">${el.type === 'flight' ? '✈️' : '🖼'}</div>`;

        const starBtn = el.type === 'image'
            ? `<button class="icon-btn ${isThumb ? 'active' : ''}" title="Als Galerie-Thumbnail" onclick="setThumbnail(${i})">⭐</button>`
            : '';

        return `
            <div class="element-item">
                ${thumbHtml}
                <div class="element-info">
                    <p class="element-name">${el.label || '—'}</p>
                    <p class="element-sub">${el.type === 'image' ? 'Foto' : 'Flugvisualisierung'} · #${i + 1}</p>
                </div>
                <div class="element-actions">
                    ${starBtn}
                    <button class="icon-btn" title="Löschen" onclick="deleteElement(${i})">🗑</button>
                </div>
            </div>`;
    }).join('');
}

async function setThumbnail(index) {
    const el = state.elements[index];
    if (el.type !== 'image') return;
    state.thumbnailGalleryId = el.galleryId;

    // Thumbnail in DynamoDB GALLERY# Item speichern
    const thumbKey = el.thumbUrl.replace(MEDIA_BASE, '');
    await apiPost('/admin/gallery/' + state.gallerySlug, {
        userId: state.userId,
        thumbnailUrl: thumbKey,
    }, true, 'PUT');

    renderElementList();
}

async function deleteElement(index) {
    const el = state.elements[index];
    if (!confirm(`„${el.label}" löschen?`)) return;

    if (el.type === 'image') {
        await apiPost('/admin/image', {
            userId:       state.userId,
            galleryId:    el.galleryId,
            fullSizeUrl:  el.fullUrl?.replace(MEDIA_BASE, '') || '',
            thumbnailUrl: el.thumbUrl?.replace(MEDIA_BASE, '') || '',
        }, true, 'DELETE');
    } else {
        await apiPost('/admin/flight', {
            userId:    state.userId,
            galleryId: el.galleryId,
            csvUrl:    el.csvUrl || '',
        }, true, 'DELETE');
    }

    if (state.thumbnailGalleryId === el.galleryId) state.thumbnailGalleryId = null;
    state.elements.splice(index, 1);
    renderElementList();
}

// ---------------------------------------------------------------------------
// Fertigstellen
// ---------------------------------------------------------------------------

function finishGallery() {
    const slug  = state.gallerySlug;
    const title = state.galleryTitle;
    const count = state.elements.length;

    hide('step-elements');
    show('step-done');

    document.getElementById('done-title').textContent = `„${title}" wurde erstellt!`;
    document.getElementById('done-sub').textContent   = `${count} Element${count !== 1 ? 'e' : ''} hinzugefügt`;
    document.getElementById('done-view-link').href    = `/${state.userId}/${slug}/index.html`;
}

function resetAdmin() {
    state.gallerySlug  = null;
    state.galleryTitle = null;
    state.elements     = [];
    state.thumbnailGalleryId = null;
    state.sortCounter  = 1;
    document.getElementById('gallery-title').value = '';
    document.getElementById('gallery-desc').value  = '';
    document.getElementById('slug-preview').textContent = '';
    hide('step-done');
    hide('step-elements');
    show('step-create');
    renderElementList();
}

// ---------------------------------------------------------------------------
// Panel-Steuerung
// ---------------------------------------------------------------------------

function showPanel(id) {
    document.getElementById('photo-panel').classList.remove('visible');
    document.getElementById('flight-panel').classList.remove('visible');
    document.getElementById(id).classList.add('visible');
}

function hidePanel(id) {
    document.getElementById(id).classList.remove('visible');
}

// ---------------------------------------------------------------------------
// Thumbnail-Generierung (Canvas)
// ---------------------------------------------------------------------------

function generateThumbnail(file, maxPx = 800) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        const url = URL.createObjectURL(file);
        img.onload = () => {
            URL.revokeObjectURL(url);
            const scale  = Math.min(1, maxPx / Math.max(img.width, img.height));
            const canvas = document.createElement('canvas');
            canvas.width  = Math.round(img.width  * scale);
            canvas.height = Math.round(img.height * scale);
            canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
            canvas.toBlob(blob => {
                if (blob) resolve(blob);
                else reject(new Error('Thumbnail-Generierung fehlgeschlagen'));
            }, 'image/webp', 0.82);
        };
        img.onerror = () => reject(new Error('Bild konnte nicht geladen werden'));
        img.src = url;
    });
}

// ---------------------------------------------------------------------------
// S3-Upload via Presigned URL
// ---------------------------------------------------------------------------

function uploadToS3(presignedUrl, blob, contentType, onProgress) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', presignedUrl);
        xhr.setRequestHeader('Content-Type', contentType);
        xhr.upload.onprogress = e => {
            if (e.lengthComputable) onProgress(e.loaded / e.total);
        };
        xhr.onload  = () => (xhr.status >= 200 && xhr.status < 300) ? resolve() : reject(new Error(`S3 Upload Fehler: ${xhr.status}`));
        xhr.onerror = () => reject(new Error('Netzwerkfehler beim Upload'));
        xhr.send(blob);
    });
}

// ---------------------------------------------------------------------------
// API-Hilfsfunktionen
// ---------------------------------------------------------------------------

async function apiPost(path, body, auth = true, method = 'POST') {
    const headers = { 'Content-Type': 'application/json' };
    if (auth && state.token) headers['X-Admin-Token'] = state.token;
    return fetch(`${ADMIN_API}${path}`, {
        method,
        headers,
        body: JSON.stringify(body),
    });
}

// ---------------------------------------------------------------------------
// Dateiname bereinigen
// ---------------------------------------------------------------------------

function sanitizeFilename(name) {
    return name.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_+/g, '_');
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

function setProgress(prefix, pct, label) {
    document.getElementById(`${prefix}-progress-fill`).style.width  = `${pct}%`;
    document.getElementById(`${prefix}-progress-label`).textContent = label;
}

// ---------------------------------------------------------------------------
// UI-Hilfsfunktionen
// ---------------------------------------------------------------------------

function show(id)   { document.getElementById(id).style.display = ''; }
function hide(id)   { document.getElementById(id).style.display = 'none'; }
function showEl(id) { document.getElementById(id).classList.add('visible'); }
function hideEl(id) { document.getElementById(id).classList.remove('visible'); }

// ---------------------------------------------------------------------------
// Init: Token aus localStorage prüfen
// ---------------------------------------------------------------------------

(function init() {
    const saved = localStorage.getItem('hd_admin_token');
    if (saved) {
        state.token = saved;
        showLoggedIn();
    }
})();
