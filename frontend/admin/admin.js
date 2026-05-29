// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const ADMIN_API    = "https://ejjvnnn1lj.execute-api.eu-central-1.amazonaws.com";
const GALLERY_API  = "https://ejjvnnn1lj.execute-api.eu-central-1.amazonaws.com/gallery";
const MEDIA_BASE   = "https://high-definition.net/media/";
const DEFAULT_USER = "koljagrosse";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let state = {
    token:              null,
    userId:             DEFAULT_USER,
    gallerySlug:        null,
    galleryTitle:       null,
    elements:           [],      // { type, galleryId, label, thumbUrl, fullUrl, csvUrls, sortOrder }
    thumbnailGalleryId: null,
    sortCounter:        1,
};

let editState = {
    slug:     null,
    title:    '',
    desc:     '',
    items:    [],   // DynamoDB IMAGE# / FLIGHT# items
    maxOrder: 0,
};

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// Browser-seitiger EXIF-Parser
// Liest Aperture (FNumber), ShutterSpeed (ExposureTime), ISO aus JPEG-Dateien.
// ---------------------------------------------------------------------------

function readExif(file) {
    return new Promise(resolve => {
        const ext = file.name.split('.').pop().toLowerCase();
        if (ext !== 'jpg' && ext !== 'jpeg') return resolve({});
        const reader = new FileReader();
        reader.onload  = e => { try { resolve(_parseExif(new DataView(e.target.result))); } catch { resolve({}); } };
        reader.onerror = () => resolve({});
        reader.readAsArrayBuffer(file.slice(0, 131072)); // erste 128 KB
    });
}

function _parseExif(dv) {
    if (dv.byteLength < 4 || dv.getUint16(0) !== 0xFFD8) return {};
    let off = 2;
    while (off + 4 <= dv.byteLength) {
        if (dv.getUint8(off) !== 0xFF) break;
        const marker = dv.getUint8(off + 1);
        if (marker === 0xDA) break;                  // Start of Scan
        const segLen = dv.getUint16(off + 2);
        if (marker === 0xE1 && off + 10 <= dv.byteLength) {
            if (dv.getUint32(off + 4) === 0x45786966 && dv.getUint16(off + 8) === 0x0000)
                return _parseTiff(dv, off + 10);
        }
        off += 2 + segLen;
    }
    return {};
}

function _parseTiff(dv, base) {
    if (base + 8 > dv.byteLength) return {};
    const le  = dv.getUint16(base) === 0x4949;      // 'II' = little-endian
    const u16 = o => dv.getUint16(base + o, le);
    const u32 = o => dv.getUint32(base + o, le);
    const rat = o => { const n = u32(o), d = u32(o + 4); return d ? n / d : null; };
    const result = {};
    const readIFD = start => {
        if (start + 2 > dv.byteLength - base) return;
        const n = u16(start);
        for (let i = 0; i < n; i++) {
            const p = start + 2 + i * 12;
            if (base + p + 12 > dv.byteLength) break;
            const tag = u16(p), type = u16(p + 2), v = p + 8;
            if (tag === 0x8769) { readIFD(u32(v)); }                      // ExifIFD pointer
            else if (tag === 0x829A) {                                      // ExposureTime
                const r = rat(u32(v)); if (r !== null)
                    result.ShutterSpeed = r >= 1 ? `${r.toFixed(1)}s` : `1/${Math.round(1/r)}s`;
            } else if (tag === 0x829D) {                                    // FNumber
                const r = rat(u32(v)); if (r !== null)
                    result.Aperture = `f/${r.toFixed(1)}`;
            } else if (tag === 0x8827 && type === 3) {                      // ISO
                result.ISO = String(u16(v));
            }
        }
    };
    readIFD(u32(4));
    return result;
}

// ---------------------------------------------------------------------------
// Legs-Input helpers (Route: FRA — MIA — YUL …)
// ---------------------------------------------------------------------------

// Called on every keystroke in a leg field.
// When the last field reaches 3+ characters a new separator + field is appended.
function onLegInput(event, containerId) {
    const container = document.getElementById(containerId);
    const fields    = Array.from(container.querySelectorAll('.leg-field'));
    const lastField = fields[fields.length - 1];
    if (event.target === lastField && lastField.value.trim().length >= 3) {
        const sep       = document.createElement('span');
        sep.className   = 'leg-sep';
        sep.textContent = '—';
        container.appendChild(sep);

        const newField            = document.createElement('input');
        newField.type             = 'text';
        newField.className        = 'leg-field';
        newField.placeholder      = '???';
        newField.maxLength        = 4;
        newField.setAttribute('oninput', `onLegInput(event,'${containerId}')`);
        container.appendChild(newField);
        newField.focus();
    }
}

// Returns the joined label string, e.g. "FRA — MIA — YUL".
// Empty fields are skipped.
function buildLegsLabel(containerId) {
    const container = document.getElementById(containerId);
    return Array.from(container.querySelectorAll('.leg-field'))
        .map(f => f.value.trim().toUpperCase())
        .filter(Boolean)
        .join(' — ');
}

// Resets a legs-input container back to its initial two-field state.
function resetLegsInput(containerId) {
    const c = document.getElementById(containerId);
    c.innerHTML = `
        <input type="text" class="leg-field" placeholder="FRA" maxlength="4"
               oninput="onLegInput(event,'${containerId}')">
        <span class="leg-sep">—</span>
        <input type="text" class="leg-field" placeholder="MIA" maxlength="4"
               oninput="onLegInput(event,'${containerId}')">`;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

async function doLogin() {
    const pw  = document.getElementById('pw-input').value;
    const err = document.getElementById('login-error');
    err.textContent = '';
    if (!pw) return;

    const btn = document.querySelector('#step-login .btn-primary');
    btn.disabled = true; btn.textContent = '…';

    try {
        const res  = await apiCall('/admin/login', 'POST', { password: pw }, false);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Fehler');
        state.token = data.token;
        localStorage.setItem('hd_admin_token', data.token);
        onLoggedIn();
    } catch (e) {
        err.textContent = e.message;
    } finally {
        btn.disabled = false; btn.textContent = 'Anmelden';
    }
}

function onLoggedIn() {
    show('admin-header');
    show('tab-bar');
    hide('step-login');
    switchTab('create');
}

function logout() {
    localStorage.removeItem('hd_admin_token');
    state.token = null;
    hide('admin-header');
    hide('tab-bar');
    hide('tab-create');
    hide('tab-manage');
    show('step-login');
}

// ---------------------------------------------------------------------------
// Tab-Navigation
// ---------------------------------------------------------------------------

function switchTab(tab) {
    document.getElementById('tab-create-btn').classList.toggle('active', tab === 'create');
    document.getElementById('tab-manage-btn').classList.toggle('active', tab === 'manage');

    if (tab === 'create') {
        show('tab-create');
        hide('tab-manage');
        if (!state.gallerySlug) {
            show('step-create'); hide('step-elements'); hide('step-done');
        }
    } else {
        hide('tab-create');
        show('tab-manage');
        showGalleryList();
        loadGalleryList();
    }
}

// ---------------------------------------------------------------------------
// Slug
// ---------------------------------------------------------------------------

function slugify(text) {
    return text.normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/[\s-]+/g, '-');
}

function updateSlugPreview() {
    const title   = document.getElementById('gallery-title').value;
    const preview = document.getElementById('slug-preview');
    preview.textContent = title.trim() ? `URL: /${state.userId}/${slugify(title)}/` : '';
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

    btn.disabled = true; btn.textContent = 'Erstelle …';
    try {
        const res  = await apiCall('/admin/gallery', 'POST', { userId: state.userId, title, description: desc });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Fehler');
        state.gallerySlug  = data.slug;
        state.galleryTitle = title;
        hide('step-create');
        show('step-elements');
        document.getElementById('elements-heading').textContent = `Elemente für „${title}"`;
        renderElementList();
    } catch (e) {
        err.textContent = e.message;
    } finally {
        btn.disabled = false; btn.textContent = 'Galerie erstellen';
    }
}

// ---------------------------------------------------------------------------
// Schritt 2: Foto hochladen (Create-Modus) – unterstützt mehrere Dateien
// ---------------------------------------------------------------------------

function onPhotoSelected() {
    const files   = document.getElementById('photo-file').files;
    const caption = document.getElementById('photo-caption');
    if (!files.length) return;
    document.getElementById('photo-preview').src = URL.createObjectURL(files[0]);
    show('photo-preview-wrap');
    caption.placeholder = files.length > 1
        ? `${files.length} Bilder – Caption nach dem Upload editierbar`
        : 'z.B. Sonnenuntergang über Miami Beach';
}

async function uploadPhoto() {
    const fileInput = document.getElementById('photo-file');
    const caption   = document.getElementById('photo-caption').value.trim();
    const err       = document.getElementById('photo-error');
    const btn       = document.getElementById('photo-upload-btn');
    err.textContent = '';

    const files = Array.from(fileInput.files);
    if (!files.length) { err.textContent = 'Bitte eine Datei auswählen.'; return; }

    btn.disabled = true;
    showEl('photo-progress');

    try {
        for (let idx = 0; idx < files.length; idx++) {
            const file  = files[idx];
            const cap   = files.length === 1 ? caption : '';
            const order = state.sortCounter++;
            setProgress('photo', 0,
                files.length > 1 ? `Bild ${idx + 1}/${files.length}: Thumbnail …` : 'Thumbnail wird generiert …');
            const result = await _doPhotoUpload(file, cap, state.gallerySlug, order, 'photo');
            state.elements.push({ ...result.element, sortOrder: order });
            renderElementList();
        }

        setTimeout(() => {
            hideEl('photo-progress');
            hidePanel('photo-panel');
            fileInput.value = '';
            document.getElementById('photo-caption').value = '';
            document.getElementById('photo-caption').placeholder = 'z.B. Sonnenuntergang über Miami Beach';
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
// Schritt 2: Flug hinzufügen (Create-Modus)
// ---------------------------------------------------------------------------

async function uploadFlight() {
    const label    = buildLegsLabel('flight-legs');
    const csvFiles = document.getElementById('flight-csv').files;
    const err      = document.getElementById('flight-error');
    err.textContent = '';
    if (!label) { err.textContent = 'Bitte mindestens Start und Ziel eingeben.'; return; }

    const order  = state.sortCounter++;
    const result = await _doFlightUpload(label, csvFiles, state.gallerySlug, order, 'flight', 'flight-error');
    if (result) {
        state.elements.push({ ...result.element, sortOrder: order });
        renderElementList();
        setTimeout(() => {
            hidePanel('flight-panel');
            resetLegsInput('flight-legs');
            document.getElementById('flight-csv').value = '';
        }, 800);
    }
}

// ---------------------------------------------------------------------------
// Shared upload helpers
// ---------------------------------------------------------------------------

async function _doPhotoUpload(file, caption, gallerySlug, sortOrder, progressPrefix = 'photo') {
    const [thumbBlob, exif] = await Promise.all([
        generateThumbnail(file),    // 2200px / 0.78 / WebP
        readExif(file),             // EXIF aus JPEG-Original
    ]);

    const ext      = file.name.split('.').pop().toLowerCase();
    const stem     = sanitizeFilename(file.name.replace(/\.[^/.]+$/, ''));
    const fullName = `${stem}.${ext}`;
    const thumbName = `${stem}.webp`;

    setProgress(progressPrefix, 15, 'Presigned URL anfordern …');

    const [pFull, pThumb] = await Promise.all([
        apiCall('/admin/presign', 'POST', { userId: state.userId, gallerySlug, filename: fullName,  fileType: file.type,    folder: 'hd' }).then(r => r.json()),
        apiCall('/admin/presign', 'POST', { userId: state.userId, gallerySlug, filename: thumbName, fileType: 'image/webp', folder: 'thumbnails' }).then(r => r.json()),
    ]);
    if (pFull.error)  throw new Error(pFull.error);
    if (pThumb.error) throw new Error(pThumb.error);

    setProgress(progressPrefix, 30, 'Originalbild hochladen …');
    await uploadToS3(pFull.url,  file,      file.type,    p => setProgress(progressPrefix, 30 + p * 40, 'Original …'));

    setProgress(progressPrefix, 70, 'Thumbnail hochladen …');
    await uploadToS3(pThumb.url, thumbBlob, 'image/webp', p => setProgress(progressPrefix, 70 + p * 20, 'Thumbnail …'));

    setProgress(progressPrefix, 92, 'In Datenbank eintragen …');

    // EXIF aus Browser-Extraktion mitschicken
    const regBody = { userId: state.userId, fullSizeUrl: pFull.key, thumbnailUrl: pThumb.key, caption, sortOrder };
    if (exif.Aperture)     regBody.aperture     = exif.Aperture;
    if (exif.ShutterSpeed) regBody.shutterSpeed = exif.ShutterSpeed;
    if (exif.ISO)          regBody.iso          = exif.ISO;

    const reg     = await apiCall('/admin/image', 'POST', regBody);
    const regData = await reg.json();
    if (!reg.ok) throw new Error(regData.error);

    setProgress(progressPrefix, 100, 'Fertig ✓');

    return {
        element: {
            type: 'image', galleryId: regData.galleryId, label: caption || fullName,
            thumbUrl: `${MEDIA_BASE}${pThumb.key}`, fullUrl: `${MEDIA_BASE}${pFull.key}`, csvUrls: [],
        },
        galleryId:    regData.galleryId,
        thumbnailUrl: pThumb.key,
    };
}

async function _doFlightUpload(label, csvFiles, gallerySlug, sortOrder, progressPrefix, errorId) {
    const files    = csvFiles ? Array.from(csvFiles) : [];
    const csvUrls  = [];

    if (files.length > 0) {
        showEl(`${progressPrefix}-progress`);
        for (let idx = 0; idx < files.length; idx++) {
            const csvFile = files[idx];
            setProgress(progressPrefix,
                Math.round(idx * 80 / files.length),
                files.length > 1 ? `CSV ${idx + 1}/${files.length} hochladen …` : 'CSV hochladen …');
            try {
                const csvName = sanitizeFilename(csvFile.name);
                const presign = await apiCall('/admin/presign', 'POST', {
                    userId: state.userId, gallerySlug, filename: csvName, fileType: 'text/csv', folder: 'flights',
                }).then(r => r.json());
                if (presign.error) throw new Error(presign.error);
                await uploadToS3(presign.url, csvFile, 'text/csv',
                    p => setProgress(progressPrefix,
                        Math.round(idx * 80 / files.length + p * 80 / files.length),
                        `CSV ${files.length > 1 ? `${idx + 1}/${files.length}` : ''} …`));
                csvUrls.push(presign.key);
            } catch (e) {
                document.getElementById(errorId).textContent = e.message;
                hideEl(`${progressPrefix}-progress`);
                return null;
            }
        }
        setProgress(progressPrefix, 85, 'Eintragen …');
    }

    const res  = await apiCall('/admin/flight', 'POST', { userId: state.userId, gallerySlug, csvUrls, label, sortOrder });
    const data = await res.json();
    if (!res.ok) { document.getElementById(errorId).textContent = data.error; return null; }

    setProgress(progressPrefix, 100, 'Fertig ✓');
    setTimeout(() => hideEl(`${progressPrefix}-progress`), 800);

    return {
        element: { type: 'flight', galleryId: data.galleryId, label, thumbUrl: null, fullUrl: null, csvUrls },
    };
}

// ---------------------------------------------------------------------------
// Element-Liste rendern (Create-Modus)
// ---------------------------------------------------------------------------

function renderElementList() {
    const list     = document.getElementById('element-list');
    const hasImages = state.elements.some(e => e.type === 'image');
    if (hasImages) show('thumb-hint'); else hide('thumb-hint');

    if (state.elements.length === 0) {
        list.innerHTML = '<p class="empty-hint">Noch keine Elemente hinzugefügt.</p>';
        return;
    }

    list.innerHTML = state.elements.map((el, i) => {
        const isThumb  = state.thumbnailGalleryId === el.galleryId;
        const thumbHtml = el.thumbUrl
            ? `<img class="element-thumb" src="${el.thumbUrl}" alt="">`
            : `<div class="element-thumb-placeholder">${el.type === 'flight' ? '✈️' : '🖼'}</div>`;
        const starBtn = el.type === 'image'
            ? `<button class="icon-btn ${isThumb ? 'active' : ''}" title="Als Thumbnail" onclick="setThumbnail(${i})">⭐</button>` : '';
        return `
            <div class="element-item" draggable="true"
                 ondragstart="onDragStart(event,${i},'create')"
                 ondragend="onDragEnd(event)"
                 ondragover="onDragOver(event,${i},'create')"
                 ondragleave="onDragLeave(event)"
                 ondrop="onDrop(event,${i},'create')">
                <div class="drag-handle">⠿</div>
                ${thumbHtml}
                <div class="element-info">
                    <input class="caption-input" type="text" value="${escapeHtml(el.label)}"
                           onblur="updateCreateCaption(${i}, this.value)"
                           placeholder="${el.type === 'image' ? 'Bildunterschrift' : 'Beschriftung'}">
                    <p class="element-sub">${el.type === 'image' ? 'Foto' : 'Flug'} · #${i + 1}</p>
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
    const thumbKey = el.thumbUrl.replace(MEDIA_BASE, '');
    await apiCall('/admin/gallery/' + state.gallerySlug, 'PUT', { userId: state.userId, thumbnailUrl: thumbKey });
    renderElementList();
}

async function updateCreateCaption(index, value) {
    const el = state.elements[index];
    if (!el || el.label === value) return;
    el.label = value;
    if (el.galleryId) {
        const body = el.type === 'flight'
            ? { userId: state.userId, galleryId: el.galleryId, label: value }
            : { userId: state.userId, galleryId: el.galleryId, caption: value };
        apiCall('/admin/image', 'PUT', body); // fire-and-forget
    }
}

async function deleteElement(index) {
    const el = state.elements[index];
    if (!confirm(`„${el.label || el.type}" löschen?`)) return;
    if (el.type === 'image') {
        await apiCall('/admin/image', 'DELETE', {
            userId: state.userId, galleryId: el.galleryId,
            fullSizeUrl:  el.fullUrl?.replace(MEDIA_BASE, '') || '',
            thumbnailUrl: el.thumbUrl?.replace(MEDIA_BASE, '') || '',
        });
    } else {
        await apiCall('/admin/flight', 'DELETE', {
            userId: state.userId, galleryId: el.galleryId, csvUrls: el.csvUrls || [],
        });
    }
    if (state.thumbnailGalleryId === el.galleryId) state.thumbnailGalleryId = null;
    state.elements.splice(index, 1);
    renderElementList();
}

// ---------------------------------------------------------------------------
// Fertigstellen (Create-Modus)
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
    state.gallerySlug = null; state.galleryTitle = null;
    state.elements = []; state.thumbnailGalleryId = null; state.sortCounter = 1;
    document.getElementById('gallery-title').value = '';
    document.getElementById('gallery-desc').value  = '';
    document.getElementById('slug-preview').textContent = '';
    hide('step-done'); hide('step-elements'); show('step-create');
    renderElementList();
}

// ===========================================================================
// GALLERY MANAGER
// ===========================================================================

// ---------------------------------------------------------------------------
// Galerie-Liste laden & rendern
// ---------------------------------------------------------------------------

async function loadGalleryList() {
    const listEl = document.getElementById('gallery-list-items');
    listEl.innerHTML = '<p class="empty-hint">Lade …</p>';
    try {
        const res  = await apiCall('/admin/galleries', 'GET', null, true);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        if (!Array.isArray(data) || data.length === 0) {
            listEl.innerHTML = '<p class="empty-hint">Noch keine Galerien vorhanden.</p>';
            return;
        }
        listEl.innerHTML = data.map(g => {
            const slug     = g.Slug || g.GalleryId?.replace('GALLERY#', '');
            const title    = g.Title || slug;
            const thumbUrl = g.ThumbnailUrl ? `${MEDIA_BASE}${g.ThumbnailUrl}` : null;
            const thumbHtml = thumbUrl
                ? `<img class="gallery-card-thumb" src="${thumbUrl}" alt="">`
                : `<div class="gallery-card-thumb-placeholder"></div>`;
            return `
                <div class="gallery-card">
                    ${thumbHtml}
                    <div class="gallery-card-info">
                        <p class="gallery-card-title">${escapeHtml(title)}</p>
                        <p class="gallery-card-slug">/${state.userId}/${slug}/</p>
                    </div>
                    <div class="gallery-card-actions">
                        <button class="btn btn-ghost btn-sm" onclick="openGalleryEditor('${slug}')">Bearbeiten</button>
                        <button class="btn btn-danger btn-sm" onclick="deleteGallery('${slug}','${escapeHtml(title)}')">Löschen</button>
                    </div>
                </div>`;
        }).join('');
    } catch (e) {
        listEl.innerHTML = `<p class="empty-hint" style="color:rgba(255,100,100,0.7)">${e.message}</p>`;
    }
}

function showGalleryList() {
    show('manage-list-card');
    hide('manage-editor-card');
}

// ---------------------------------------------------------------------------
// Galerie-Editor öffnen
// ---------------------------------------------------------------------------

async function openGalleryEditor(slug) {
    editState.slug = slug;
    document.getElementById('editor-item-list').innerHTML = '<p class="empty-hint">Lade …</p>';
    hide('manage-list-card');
    show('manage-editor-card');
    document.getElementById('editor-gallery-slug').textContent = `/${state.userId}/${slug}/`;
    document.getElementById('edit-meta-msg').textContent = '';

    try {
        const res  = await fetch(`${GALLERY_API}?userId=${state.userId}&galleryId=${slug}`);
        const data = await res.json();

        const meta  = data.find(i => i.GalleryId?.startsWith('GALLERY#'));
        editState.title = meta?.Title || '';
        editState.desc  = meta?.Description || '';
        document.getElementById('edit-title').value = editState.title;
        document.getElementById('edit-desc').value  = editState.desc;

        const rawItems = data
            .filter(i => i.GalleryId?.startsWith('IMAGE#') || i.GalleryId?.startsWith('FLIGHT#'))
            .sort((a, b) => (a.SortOrder ?? 50) - (b.SortOrder ?? 50));

        // SortOrder normalisieren: 10, 20, 30 …
        rawItems.forEach((item, i) => { item.SortOrder = (i + 1) * 10; });
        editState.items    = rawItems;
        editState.maxOrder = rawItems.length * 10;
        renderEditorItems();
    } catch (e) {
        document.getElementById('editor-item-list').innerHTML =
            `<p class="empty-hint" style="color:rgba(255,100,100,0.7)">${e.message}</p>`;
    }
}

// ---------------------------------------------------------------------------
// Editor-Items rendern
// ---------------------------------------------------------------------------

function renderEditorItems() {
    const list = document.getElementById('editor-item-list');
    if (editState.items.length === 0) {
        list.innerHTML = '<p class="empty-hint">Noch keine Elemente in dieser Galerie.</p>';
        return;
    }
    list.innerHTML = editState.items.map((item, i) => {
        const isImage  = item.GalleryId.startsWith('IMAGE#');
        const thumbUrl = item.ThumbnailUrl ? `${MEDIA_BASE}${item.ThumbnailUrl}` : null;
        const thumbHtml = thumbUrl
            ? `<img class="element-thumb" src="${thumbUrl}" alt="">`
            : `<div class="element-thumb-placeholder">${isImage ? '🖼' : '✈️'}</div>`;
        const label = isImage ? (item.Caption || '') : (item.Label || '');
        return `
            <div class="element-item" draggable="true"
                 ondragstart="onDragStart(event,${i},'edit')"
                 ondragend="onDragEnd(event)"
                 ondragover="onDragOver(event,${i},'edit')"
                 ondragleave="onDragLeave(event)"
                 ondrop="onDrop(event,${i},'edit')">
                <div class="drag-handle">⠿</div>
                ${thumbHtml}
                <div class="element-info">
                    <input class="caption-input" type="text" value="${escapeHtml(label)}"
                           onblur="updateEditorCaption(${i}, this.value)"
                           placeholder="${isImage ? 'Bildunterschrift' : 'Beschriftung'}">
                    <p class="element-sub">${isImage ? 'Foto' : 'Flug'} · #${i + 1}</p>
                </div>
                <div class="element-actions">
                    ${isImage ? `<button class="icon-btn" onclick="setEditorThumbnail(${i})" title="Als Thumbnail">⭐</button>` : ''}
                    <button class="icon-btn" onclick="deleteEditorItem(${i})" title="Löschen">🗑</button>
                </div>
            </div>`;
    }).join('');
}

// ---------------------------------------------------------------------------
// Metadaten speichern
// ---------------------------------------------------------------------------

async function saveEditorMeta() {
    const title = document.getElementById('edit-title').value.trim();
    const desc  = document.getElementById('edit-desc').value.trim();
    const msg   = document.getElementById('edit-meta-msg');
    const btn   = document.getElementById('edit-save-btn');
    msg.textContent = ''; msg.style.color = '';
    btn.disabled = true; btn.textContent = '…';
    try {
        const res = await apiCall('/admin/gallery/' + editState.slug, 'PUT', {
            userId: state.userId, title, description: desc,
        });
        if (!res.ok) { const d = await res.json(); throw new Error(d.error); }
        editState.title = title; editState.desc = desc;
        msg.textContent = '✓ Gespeichert'; msg.style.color = 'rgba(100,220,100,0.8)';
        setTimeout(() => { msg.textContent = ''; }, 2500);
    } catch (e) {
        msg.textContent = e.message;
    } finally {
        btn.disabled = false; btn.textContent = 'Speichern';
    }
}

// ---------------------------------------------------------------------------
// Caption / Label im Editor aktualisieren
// ---------------------------------------------------------------------------

async function updateEditorCaption(index, value) {
    const item = editState.items[index];
    if (!item) return;
    if (item.GalleryId.startsWith('IMAGE#')) {
        item.Caption = value;
        apiCall('/admin/image', 'PUT', { userId: state.userId, galleryId: item.GalleryId, caption: value });
    } else {
        item.Label = value;
        apiCall('/admin/image', 'PUT', { userId: state.userId, galleryId: item.GalleryId, label: value });
    }
}

// ---------------------------------------------------------------------------
// Item löschen (Editor)
// ---------------------------------------------------------------------------

async function deleteEditorItem(index) {
    const item  = editState.items[index];
    const label = item.GalleryId.startsWith('IMAGE#')
        ? (item.Caption || item.FullSizeUrl?.split('/').pop()) : item.Label;
    if (!confirm(`„${label}" löschen?`)) return;

    if (item.GalleryId.startsWith('IMAGE#')) {
        await apiCall('/admin/image', 'DELETE', {
            userId: state.userId, galleryId: item.GalleryId,
            fullSizeUrl:  item.FullSizeUrl  || '',
            thumbnailUrl: item.ThumbnailUrl || '',
        });
    } else {
        const csvUrls = item.CsvUrls || (item.CsvUrl ? [item.CsvUrl] : []);
        await apiCall('/admin/flight', 'DELETE', {
            userId: state.userId, galleryId: item.GalleryId, csvUrls,
        });
    }
    editState.items.splice(index, 1);
    renderEditorItems();
}

// ---------------------------------------------------------------------------
// Galerie-Thumbnail setzen (Editor)
// ---------------------------------------------------------------------------

async function setEditorThumbnail(index) {
    const item = editState.items[index];
    if (!item.GalleryId.startsWith('IMAGE#')) return;
    const msg = document.getElementById('edit-meta-msg');
    await apiCall('/admin/gallery/' + editState.slug, 'PUT', {
        userId: state.userId, thumbnailUrl: item.ThumbnailUrl,
    });
    msg.textContent = '⭐ Thumbnail gesetzt'; msg.style.color = 'rgba(240,192,96,0.9)';
    setTimeout(() => { msg.textContent = ''; }, 2500);
}

// ---------------------------------------------------------------------------
// Foto zum Editor hinzufügen (unterstützt mehrere Dateien)
// ---------------------------------------------------------------------------

function onEditPhotoSelected() {
    const files = document.getElementById('edit-photo-file').files;
    if (!files.length) return;
    document.getElementById('edit-photo-preview').src = URL.createObjectURL(files[0]);
    show('edit-photo-preview-wrap');
    const cap = document.getElementById('edit-photo-caption');
    cap.placeholder = files.length > 1
        ? `${files.length} Bilder – Caption nach Upload editierbar`
        : 'z.B. Sonnenuntergang über Miami Beach';
}

async function uploadPhotoEdit() {
    const fileInput = document.getElementById('edit-photo-file');
    const caption   = document.getElementById('edit-photo-caption').value.trim();
    const err       = document.getElementById('edit-photo-error');
    const btn       = document.getElementById('edit-photo-upload-btn');
    err.textContent = '';

    const files = Array.from(fileInput.files);
    if (!files.length) { err.textContent = 'Bitte eine Datei auswählen.'; return; }

    btn.disabled = true;
    showEl('edit-photo-progress');

    try {
        for (let idx = 0; idx < files.length; idx++) {
            const file = files[idx];
            const cap  = files.length === 1 ? caption : '';
            if (files.length > 1) setProgress('edit-photo', 0, `Bild ${idx + 1}/${files.length}: Thumbnail …`);
            else                   setProgress('edit-photo', 0, 'Thumbnail wird generiert …');
            editState.maxOrder += 10;
            const sortOrder = editState.maxOrder;
            const result = await _doPhotoUpload(file, cap, editState.slug, sortOrder, 'edit-photo');
            editState.items.push({
                GalleryId:    result.galleryId,
                FullSizeUrl:  result.element.fullUrl.replace(MEDIA_BASE, ''),
                ThumbnailUrl: result.thumbnailUrl,
                Caption:      cap,
                SortOrder:    sortOrder,
            });
            renderEditorItems();
        }
        setTimeout(() => {
            hideEl('edit-photo-progress');
            hidePanel('edit-photo-panel');
            fileInput.value = '';
            document.getElementById('edit-photo-caption').value = '';
            document.getElementById('edit-photo-preview').src   = '';
            hide('edit-photo-preview-wrap');
            btn.disabled = false;
        }, 800);
    } catch (e) {
        err.textContent = e.message;
        hideEl('edit-photo-progress');
        btn.disabled = false;
    }
}

// ---------------------------------------------------------------------------
// Flug zum Editor hinzufügen (mehrere CSV möglich)
// ---------------------------------------------------------------------------

async function uploadFlightEdit() {
    const label    = buildLegsLabel('edit-flight-legs');
    const csvFiles = document.getElementById('edit-flight-csv').files;
    const err      = document.getElementById('edit-flight-error');
    err.textContent = '';
    if (!label) { err.textContent = 'Bitte mindestens Start und Ziel eingeben.'; return; }

    editState.maxOrder += 10;
    const sortOrder = editState.maxOrder;
    const result = await _doFlightUpload(label, csvFiles, editState.slug, sortOrder, 'edit-flight', 'edit-flight-error');
    if (result) {
        editState.items.push({
            GalleryId: result.element.galleryId,
            CsvUrls:   result.element.csvUrls,
            CsvUrl:    result.element.csvUrls[0] || '',
            Label:     label,
            SortOrder: sortOrder,
        });
        renderEditorItems();
        setTimeout(() => {
            hidePanel('edit-flight-panel');
            resetLegsInput('edit-flight-legs');
            document.getElementById('edit-flight-csv').value = '';
        }, 800);
    }
}

// ---------------------------------------------------------------------------
// Galerie löschen
// ---------------------------------------------------------------------------

async function deleteGallery(slug, title) {
    if (!confirm(`Galerie „${title}" und alle Inhalte wirklich löschen?\n\nDies kann nicht rückgängig gemacht werden.`))
        return;
    await apiCall('/admin/gallery/' + slug, 'DELETE', { userId: state.userId });
    loadGalleryList();
}

async function deleteCurrentGallery() {
    await deleteGallery(editState.slug, editState.title || editState.slug);
    showGalleryList();
}

// ===========================================================================
// DRAG & DROP REORDERING
// ===========================================================================

let _dragSrcIdx  = null;
let _dragSrcMode = null;

function onDragStart(e, index, mode) {
    _dragSrcIdx  = index;
    _dragSrcMode = mode;
    e.dataTransfer.effectAllowed = 'move';
    setTimeout(() => e.target.classList.add('dragging'), 0);
}

function onDragEnd(e) {
    e.target.classList.remove('dragging');
    document.querySelectorAll('.element-item').forEach(el => el.classList.remove('drag-over'));
    _dragSrcIdx = null;
}

function onDragOver(e, index, mode) {
    if (_dragSrcMode !== mode || _dragSrcIdx === index) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    e.currentTarget.classList.add('drag-over');
}

function onDragLeave(e) {
    e.currentTarget.classList.remove('drag-over');
}

async function onDrop(e, targetIdx, mode) {
    e.preventDefault();
    e.currentTarget.classList.remove('drag-over');
    const srcIdx = _dragSrcIdx;
    _dragSrcIdx = null;
    if (srcIdx === null || srcIdx === targetIdx || _dragSrcMode !== mode) return;

    const items = mode === 'create' ? state.elements : editState.items;
    const [moved] = items.splice(srcIdx, 1);
    items.splice(targetIdx, 0, moved);

    // SortOrder neu vergeben
    items.forEach((item, i) => {
        if (mode === 'create') item.sortOrder = (i + 1) * 10;
        else                   item.SortOrder = (i + 1) * 10;
    });
    if (mode === 'edit') editState.maxOrder = items.length * 10;

    if (mode === 'create') renderElementList();
    else                   renderEditorItems();

    // Neue SortOrders in DynamoDB speichern (fire-and-forget)
    items.forEach(item => {
        const gid   = mode === 'create' ? item.galleryId : item.GalleryId;
        const order = mode === 'create' ? item.sortOrder : item.SortOrder;
        if (gid) apiCall('/admin/image', 'PUT', { userId: state.userId, galleryId: gid, sortOrder: order });
    });
}

// ===========================================================================
// THUMBNAIL-GENERIERUNG
// Parameter: -resize 2200x (nach Breite skalieren) | -quality 78 | WebP
// -strip ist implizit: Canvas speichert keine EXIF-Metadaten
// ===========================================================================

function generateThumbnail(file, maxWidth = 2200, quality = 0.78) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        const url = URL.createObjectURL(file);
        img.onload = () => {
            URL.revokeObjectURL(url);
            const scale   = Math.min(1, maxWidth / img.width);
            const canvas  = document.createElement('canvas');
            canvas.width  = Math.round(img.width  * scale);
            canvas.height = Math.round(img.height * scale);
            const ctx = canvas.getContext('2d');
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            canvas.toBlob(blob => {
                if (blob) resolve(blob);
                else reject(new Error('Thumbnail-Generierung fehlgeschlagen'));
            }, 'image/webp', quality);
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
        xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
        xhr.onload  = () => (xhr.status >= 200 && xhr.status < 300) ? resolve() : reject(new Error(`S3 ${xhr.status}`));
        xhr.onerror = () => reject(new Error('Netzwerkfehler'));
        xhr.send(blob);
    });
}

// ---------------------------------------------------------------------------
// API-Helper
// ---------------------------------------------------------------------------

async function apiCall(path, method = 'GET', body = null, auth = true) {
    const headers = { 'Content-Type': 'application/json' };
    if (auth && state.token) headers['X-Admin-Token'] = state.token;
    const opts = { method, headers };
    if (body !== null) opts.body = JSON.stringify(body);
    return fetch(`${ADMIN_API}${path}`, opts);
}

function sanitizeFilename(name) {
    return name.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_+/g, '_');
}

// ---------------------------------------------------------------------------
// Progress / Panel / UI Helpers
// ---------------------------------------------------------------------------

function setProgress(prefix, pct, label) {
    const fill = document.getElementById(`${prefix}-progress-fill`);
    const lbl  = document.getElementById(`${prefix}-progress-label`);
    if (fill) fill.style.width = `${Math.min(100, pct)}%`;
    if (lbl)  lbl.textContent  = label;
}

function showPanel(id) {
    document.querySelectorAll('.add-panel').forEach(p => p.classList.remove('visible'));
    document.getElementById(id)?.classList.add('visible');
}
function hidePanel(id) { document.getElementById(id)?.classList.remove('visible'); }

function show(id)   { const el = document.getElementById(id); if (el) el.style.display = ''; }
function hide(id)   { const el = document.getElementById(id); if (el) el.style.display = 'none'; }
function showEl(id) { document.getElementById(id)?.classList.add('visible'); }
function hideEl(id) { document.getElementById(id)?.classList.remove('visible'); }

// ---------------------------------------------------------------------------
// Init: gespeichertes Token prüfen
// ---------------------------------------------------------------------------

(function init() {
    const saved = localStorage.getItem('hd_admin_token');
    if (saved) { state.token = saved; onLoggedIn(); }
    renderElementList();
})();
