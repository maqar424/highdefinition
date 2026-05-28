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
    // Create-Modus
    gallerySlug:        null,
    galleryTitle:       null,
    elements:           [],
    thumbnailGalleryId: null,
    sortCounter:        1,
};

let editState = {
    slug:     null,
    title:    '',
    desc:     '',
    items:    [],      // geladene IMAGE#/FLIGHT# Items
    maxOrder: 0,       // höchste SortOrder für neue Items
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
        // Create-Modus: zeige den richtigen Step
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
    } catch (e) {
        err.textContent = e.message;
    } finally {
        btn.disabled = false; btn.textContent = 'Galerie erstellen';
    }
}

// ---------------------------------------------------------------------------
// Schritt 2: Foto hochladen (Create-Modus)
// ---------------------------------------------------------------------------

function onPhotoSelected() {
    const file = document.getElementById('photo-file').files[0];
    if (!file) return;
    document.getElementById('photo-preview').src = URL.createObjectURL(file);
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
        const result = await _doPhotoUpload(file, caption, state.gallerySlug, state.sortCounter++);

        state.elements.push(result.element);
        renderElementList();

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
// Schritt 2: Flug hinzufügen (Create-Modus)
// ---------------------------------------------------------------------------

async function uploadFlight() {
    const label   = document.getElementById('flight-label').value.trim();
    const csvFile = document.getElementById('flight-csv').files[0];
    const err     = document.getElementById('flight-error');
    err.textContent = '';
    if (!label) { err.textContent = 'Bitte eine Beschriftung eingeben.'; return; }

    const result = await _doFlightUpload(label, csvFile, state.gallerySlug, state.sortCounter++,
        'flight', 'flight-error');

    if (result) {
        state.elements.push(result.element);
        renderElementList();
        setTimeout(() => {
            hidePanel('flight-panel');
            document.getElementById('flight-label').value = '';
            document.getElementById('flight-csv').value   = '';
        }, 800);
    }
}

// ---------------------------------------------------------------------------
// Shared upload helpers
// ---------------------------------------------------------------------------

async function _doPhotoUpload(file, caption, gallerySlug, sortOrder, progressPrefix = 'photo') {
    const thumbBlob = await generateThumbnail(file);     // 2200px / 0.78 WebP
    const ext       = file.name.split('.').pop().toLowerCase();
    const stem      = sanitizeFilename(file.name.replace(/\.[^/.]+$/, ''));
    const fullName  = `${stem}.${ext}`;
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
    const reg = await apiCall('/admin/image', 'POST', {
        userId: state.userId, fullSizeUrl: pFull.key, thumbnailUrl: pThumb.key, caption, sortOrder,
    });
    const regData = await reg.json();
    if (!reg.ok) throw new Error(regData.error);

    setProgress(progressPrefix, 100, 'Fertig ✓');

    return {
        element: {
            type: 'image', galleryId: regData.galleryId, label: caption || fullName,
            thumbUrl: `${MEDIA_BASE}${pThumb.key}`, fullUrl: `${MEDIA_BASE}${pFull.key}`, csvUrl: null,
        },
        galleryId:    regData.galleryId,
        thumbnailUrl: pThumb.key,
    };
}

async function _doFlightUpload(label, csvFile, gallerySlug, sortOrder, progressPrefix, errorId) {
    let csvUrl = '';

    if (csvFile) {
        setProgress(progressPrefix, 0, 'CSV hochladen …');
        showEl(`${progressPrefix}-progress`);
        try {
            const csvName = sanitizeFilename(csvFile.name);
            const presign = await apiCall('/admin/presign', 'POST', {
                userId: state.userId, gallerySlug, filename: csvName, fileType: 'text/csv', folder: 'flights',
            }).then(r => r.json());
            if (presign.error) throw new Error(presign.error);
            await uploadToS3(presign.url, csvFile, 'text/csv', p => setProgress(progressPrefix, p * 80, 'CSV …'));
            csvUrl = presign.key;
            setProgress(progressPrefix, 85, 'Eintragen …');
        } catch (e) {
            document.getElementById(errorId).textContent = e.message;
            hideEl(`${progressPrefix}-progress`);
            return null;
        }
    }

    const res  = await apiCall('/admin/flight', 'POST', { userId: state.userId, gallerySlug, csvUrl, label, sortOrder });
    const data = await res.json();
    if (!res.ok) { document.getElementById(errorId).textContent = data.error; return null; }

    setProgress(progressPrefix, 100, 'Fertig ✓');
    setTimeout(() => hideEl(`${progressPrefix}-progress`), 800);

    return {
        element: { type: 'flight', galleryId: data.galleryId, label, thumbUrl: null, fullUrl: null, csvUrl },
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
            <div class="element-item">
                ${thumbHtml}
                <div class="element-info">
                    <p class="element-name">${el.label || '—'}</p>
                    <p class="element-sub">${el.type === 'image' ? 'Foto' : 'Flugvisualisierung'} · #${i + 1}</p>
                </div>
                <div class="element-actions">
                    ${starBtn}
                    <button class="icon-btn" onclick="deleteElement(${i})">🗑</button>
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

async function deleteElement(index) {
    const el = state.elements[index];
    if (!confirm(`„${el.label}" löschen?`)) return;
    if (el.type === 'image') {
        await apiCall('/admin/image', 'DELETE', {
            userId: state.userId, galleryId: el.galleryId,
            fullSizeUrl:  el.fullUrl?.replace(MEDIA_BASE, '') || '',
            thumbnailUrl: el.thumbUrl?.replace(MEDIA_BASE, '') || '',
        });
    } else {
        await apiCall('/admin/flight', 'DELETE', {
            userId: state.userId, galleryId: el.galleryId, csvUrl: el.csvUrl || '',
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
            const slug    = g.Slug || g.GalleryId?.replace('GALLERY#', '');
            const title   = g.Title || slug;
            const thumbUrl = g.ThumbnailUrl ? `${MEDIA_BASE}${g.ThumbnailUrl}` : null;
            const thumbHtml = thumbUrl
                ? `<img class="gallery-card-thumb" src="${thumbUrl}" alt="">`
                : `<div class="gallery-card-thumb-placeholder"></div>`;
            return `
                <div class="gallery-card">
                    ${thumbHtml}
                    <div class="gallery-card-info">
                        <p class="gallery-card-title">${title}</p>
                        <p class="gallery-card-slug">/${state.userId}/${slug}/</p>
                    </div>
                    <div class="gallery-card-actions">
                        <button class="btn btn-ghost btn-sm" onclick="openGalleryEditor('${slug}')">Bearbeiten</button>
                        <button class="btn btn-danger btn-sm" onclick="deleteGallery('${slug}', '${title}')">Löschen</button>
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
        // Galerie-Items aus der öffentlichen API laden
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
        const isImage   = item.GalleryId.startsWith('IMAGE#');
        const thumbUrl  = item.ThumbnailUrl ? `${MEDIA_BASE}${item.ThumbnailUrl}` : null;
        const thumbHtml = thumbUrl
            ? `<img class="element-thumb" src="${thumbUrl}" alt="">`
            : `<div class="element-thumb-placeholder">${isImage ? '🖼' : '✈️'}</div>`;
        const label = isImage
            ? (item.Caption || item.FullSizeUrl?.split('/').pop() || '—')
            : (item.Label || 'Flug');
        const isFirst = i === 0;
        const isLast  = i === editState.items.length - 1;

        return `
            <div class="element-item" id="eitem-${i}">
                ${thumbHtml}
                <div class="element-info">
                    <p class="element-name">${label}</p>
                    <p class="element-sub">${isImage ? 'Foto' : 'Flug'} · #${i + 1}</p>
                </div>
                <div class="element-actions">
                    ${isImage ? `<button class="icon-btn" onclick="setEditorThumbnail(${i})" title="Als Galerie-Thumbnail">⭐</button>` : ''}
                    <button class="icon-btn" onclick="moveEditorItem(${i}, -1)" ${isFirst ? 'disabled' : ''} title="Nach oben">↑</button>
                    <button class="icon-btn" onclick="moveEditorItem(${i},  1)" ${isLast  ? 'disabled' : ''} title="Nach unten">↓</button>
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
// Item verschieben
// ---------------------------------------------------------------------------

async function moveEditorItem(index, dir) {
    const swapIdx = index + dir;
    if (swapIdx < 0 || swapIdx >= editState.items.length) return;

    const a = editState.items[index];
    const b = editState.items[swapIdx];

    // SortOrders tauschen
    const tmpOrder = a.SortOrder;
    a.SortOrder = b.SortOrder;
    b.SortOrder = tmpOrder;

    // Beide in DynamoDB speichern
    await Promise.all([
        apiCall('/admin/image', 'PUT', { userId: state.userId, galleryId: a.GalleryId, sortOrder: a.SortOrder }),
        apiCall('/admin/image', 'PUT', { userId: state.userId, galleryId: b.GalleryId, sortOrder: b.SortOrder }),
    ]);

    editState.items[index]   = b;
    editState.items[swapIdx] = a;
    renderEditorItems();
}

// ---------------------------------------------------------------------------
// Item löschen
// ---------------------------------------------------------------------------

async function deleteEditorItem(index) {
    const item = editState.items[index];
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
        await apiCall('/admin/flight', 'DELETE', {
            userId: state.userId, galleryId: item.GalleryId, csvUrl: item.CsvUrl || '',
        });
    }
    editState.items.splice(index, 1);
    renderEditorItems();
}

// ---------------------------------------------------------------------------
// Galerie-Thumbnail setzen
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
// Foto zum Editor hinzufügen
// ---------------------------------------------------------------------------

function onEditPhotoSelected() {
    const file = document.getElementById('edit-photo-file').files[0];
    if (!file) return;
    document.getElementById('edit-photo-preview').src = URL.createObjectURL(file);
    show('edit-photo-preview-wrap');
}

async function uploadPhotoEdit() {
    const fileInput = document.getElementById('edit-photo-file');
    const caption   = document.getElementById('edit-photo-caption').value.trim();
    const err       = document.getElementById('edit-photo-error');
    const btn       = document.getElementById('edit-photo-upload-btn');
    err.textContent = '';

    const file = fileInput.files[0];
    if (!file) { err.textContent = 'Bitte eine Datei auswählen.'; return; }

    btn.disabled = true;
    editState.maxOrder += 10;
    const sortOrder = editState.maxOrder;

    setProgress('edit-photo', 0, 'Thumbnail wird generiert …');
    showEl('edit-photo-progress');

    try {
        const result = await _doPhotoUpload(file, caption, editState.slug, sortOrder, 'edit-photo');
        editState.items.push({
            GalleryId:    result.galleryId,
            FullSizeUrl:  result.element.fullUrl.replace(MEDIA_BASE, ''),
            ThumbnailUrl: result.thumbnailUrl,
            Caption:      caption,
            SortOrder:    sortOrder,
        });
        renderEditorItems();
        setTimeout(() => {
            hideEl('edit-photo-progress');
            hidePanel('edit-photo-panel');
            fileInput.value = '';
            document.getElementById('edit-photo-caption').value = '';
            document.getElementById('edit-photo-preview').src = '';
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
// Flug zum Editor hinzufügen
// ---------------------------------------------------------------------------

async function uploadFlightEdit() {
    const label   = document.getElementById('edit-flight-label').value.trim();
    const csvFile = document.getElementById('edit-flight-csv').files[0];
    const err     = document.getElementById('edit-flight-error');
    err.textContent = '';
    if (!label) { err.textContent = 'Bitte eine Beschriftung eingeben.'; return; }

    editState.maxOrder += 10;
    const sortOrder = editState.maxOrder;

    const result = await _doFlightUpload(label, csvFile, editState.slug, sortOrder,
        'edit-flight', 'edit-flight-error');

    if (result) {
        editState.items.push({
            GalleryId: result.element.galleryId,
            CsvUrl:    result.element.csvUrl,
            Label:     label,
            SortOrder: sortOrder,
        });
        renderEditorItems();
        setTimeout(() => {
            hidePanel('edit-flight-panel');
            document.getElementById('edit-flight-label').value = '';
            document.getElementById('edit-flight-csv').value   = '';
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
            // -resize 2200x: Breite auf maxWidth skalieren, Höhe proportional
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
    const fill  = document.getElementById(`${prefix}-progress-fill`);
    const lbl   = document.getElementById(`${prefix}-progress-label`);
    if (fill) fill.style.width   = `${Math.min(100, pct)}%`;
    if (lbl)  lbl.textContent    = label;
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
