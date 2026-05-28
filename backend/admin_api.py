#!/usr/bin/env python3
"""
Admin API Lambda – Gallery Management
--------------------------------------
Routes (all under /admin/):
  POST   /admin/login              – Passwort prüfen, HMAC-Token zurückgeben
  GET    /admin/galleries          – Alle GALLERY# Items eines Users
  POST   /admin/gallery            – Galerie erstellen (DynamoDB + HTML-Seite in S3)
  PUT    /admin/gallery/{slug}     – Galerie aktualisieren (Titel, Beschreibung, Thumbnail)
  DELETE /admin/gallery/{slug}     – Galerie + alle Items + S3-Dateien löschen
  POST   /admin/presign            – Presigned S3-PUT-URL generieren
  POST   /admin/image              – Bild in DynamoDB registrieren
  PUT    /admin/image              – Bild aktualisieren (Caption, SortOrder)
  DELETE /admin/image              – Bild aus DynamoDB + S3 löschen
  POST   /admin/flight             – Flugelement registrieren
  DELETE /admin/flight             – Flugelement löschen
"""

import boto3
import json
import os
import hmac
import hashlib
import time
import unicodedata
import re
from boto3.dynamodb.conditions import Key

REGION         = os.environ.get('AWS_REGION', 'eu-central-1')
MEDIA_BUCKET   = os.environ.get('MEDIA_BUCKET', 'hd-media-highdefinition-galleries-ft-aviationlove')
WEBSITE_BUCKET = os.environ.get('WEBSITE_BUCKET', 'highdefinition-galleries-ft-aviationlove')
ADMIN_PASSWORD = os.environ.get('ADMIN_PASSWORD', '')
MEDIA_PREFIX   = 'media/'

dynamodb = boto3.resource('dynamodb', region_name=REGION)
table    = dynamodb.Table('UserGalleries')
s3       = boto3.client('s3', region_name=REGION)

CORS_HEADERS = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type,X-Admin-Token',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Content-Type': 'application/json',
}

# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

def _token_for_hour(hour: int) -> str:
    return hmac.new(
        ADMIN_PASSWORD.encode(),
        str(hour).encode(),
        hashlib.sha256
    ).hexdigest()


def _verify_token(token: str) -> bool:
    if not ADMIN_PASSWORD or not token:
        return False
    now = int(time.time() // 3600)
    for h in [now, now - 1]:
        if hmac.compare_digest(token, _token_for_hour(h)):
            return True
    return False


def _require_auth(event) -> dict | None:
    token = (event.get('headers') or {}).get('x-admin-token', '')
    if not _verify_token(token):
        return _err(401, 'Unauthorized')
    return None


# ---------------------------------------------------------------------------
# Response helpers
# ---------------------------------------------------------------------------

def _ok(body):
    return {'statusCode': 200, 'headers': CORS_HEADERS, 'body': json.dumps(body, default=str)}


def _err(status, msg):
    return {'statusCode': status, 'headers': CORS_HEADERS, 'body': json.dumps({'error': msg})}


# ---------------------------------------------------------------------------
# Slug
# ---------------------------------------------------------------------------

def _slugify(text: str) -> str:
    text = unicodedata.normalize('NFKD', text).encode('ascii', 'ignore').decode()
    text = re.sub(r'[^\w\s-]', '', text).strip().lower()
    text = re.sub(r'[\s_-]+', '-', text)
    return text


# ---------------------------------------------------------------------------
# HTML-Template für neue Galerie-Seiten
# ---------------------------------------------------------------------------

GALLERY_HTML = """\
<!DOCTYPE html>
<html lang="de">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{title} | high definition</title>
    <link rel="icon" type="image/svg+xml" href="/css/palm.svg">
    <link rel="stylesheet" href="/css/style.css">
    <script>const HD_USER = "{user_id}"; const HD_GALLERY = "{gallery_slug}";</script>
    <script src="https://unpkg.com/globe.gl"></script>
</head>
<body>
    <nav class="back-nav">
        <a href="/{user_id}/index.html" class="back-link">← Alle Galerien</a>
    </nav>
    <main class="gallery-grid" id="gallery"></main>
    <div id="lightbox" class="lightbox">
        <img id="lightbox-img" src="" alt="Vollbild">
    </div>
    <script src="/js/gallery.js"></script>
</body>
</html>
"""

# ---------------------------------------------------------------------------
# Route: Login
# ---------------------------------------------------------------------------

def handle_login(event):
    body     = json.loads(event.get('body') or '{}')
    password = body.get('password', '')
    if not ADMIN_PASSWORD or not hmac.compare_digest(password, ADMIN_PASSWORD):
        return _err(401, 'Falsches Passwort')
    token = _token_for_hour(int(time.time() // 3600))
    return _ok({'token': token})


# ---------------------------------------------------------------------------
# Route: Galerien auflisten
# ---------------------------------------------------------------------------

def handle_list_galleries(event):
    auth = _require_auth(event)
    if auth:
        return auth
    params  = event.get('queryStringParameters') or {}
    user_id = params.get('userId', 'koljagrosse')
    resp = table.query(
        KeyConditionExpression=Key('UserId').eq(user_id) & Key('GalleryId').begins_with('GALLERY#')
    )
    return _ok(resp.get('Items', []))


# ---------------------------------------------------------------------------
# Route: Galerie erstellen
# ---------------------------------------------------------------------------

def handle_create_gallery(event):
    auth = _require_auth(event)
    if auth:
        return auth
    body        = json.loads(event.get('body') or '{}')
    user_id     = body.get('userId', 'koljagrosse')
    title       = body.get('title', '').strip()
    description = body.get('description', '').strip()
    if not title:
        return _err(400, 'Titel fehlt')

    slug = _slugify(title)
    item = {
        'UserId':    user_id,
        'GalleryId': f'GALLERY#{slug}',
        'Slug':      slug,
        'Title':     title,
    }
    if description:
        item['Description'] = description

    table.put_item(Item=item)

    # Galerie-HTML-Seite in S3 ablegen
    html = GALLERY_HTML.format(title=title, user_id=user_id, gallery_slug=slug)
    s3.put_object(
        Bucket=WEBSITE_BUCKET,
        Key=f'{user_id}/{slug}/index.html',
        Body=html.encode('utf-8'),
        ContentType='text/html',
    )

    return _ok({'slug': slug, 'galleryId': f'GALLERY#{slug}'})


# ---------------------------------------------------------------------------
# Route: Galerie aktualisieren
# ---------------------------------------------------------------------------

def handle_update_gallery(event):
    auth = _require_auth(event)
    if auth:
        return auth
    path    = event.get('rawPath', '')
    slug    = path.split('/admin/gallery/', 1)[-1].strip('/')
    body    = json.loads(event.get('body') or '{}')
    user_id = body.get('userId', 'koljagrosse')

    updates = {}
    if 'title'        in body: updates['Title']        = body['title']
    if 'description'  in body: updates['Description']  = body['description']
    if 'thumbnailUrl' in body: updates['ThumbnailUrl'] = body['thumbnailUrl']

    if not updates:
        return _err(400, 'Keine Änderungen übergeben')

    expr   = 'SET ' + ', '.join(f'#{k} = :{k}' for k in updates)
    names  = {f'#{k}': k for k in updates}
    values = {f':{k}': v for k, v in updates.items()}

    table.update_item(
        Key={'UserId': user_id, 'GalleryId': f'GALLERY#{slug}'},
        UpdateExpression=expr,
        ExpressionAttributeNames=names,
        ExpressionAttributeValues=values,
    )
    return _ok({'ok': True})


# ---------------------------------------------------------------------------
# Route: Galerie löschen
# ---------------------------------------------------------------------------

def handle_delete_gallery(event):
    auth = _require_auth(event)
    if auth:
        return auth
    path    = event.get('rawPath', '')
    slug    = path.split('/admin/gallery/', 1)[-1].strip('/')
    body    = json.loads(event.get('body') or '{}')
    user_id = body.get('userId', 'koljagrosse')

    # Alle DynamoDB-Items dieses Users laden und Gallery-Items löschen
    resp = table.query(KeyConditionExpression=Key('UserId').eq(user_id))
    gallery_prefix = f'{user_id}/{slug}/'
    for item in resp.get('Items', []):
        gid = item.get('GalleryId', '')
        is_meta = gid == f'GALLERY#{slug}'
        is_child = len(gid.split('#', 1)) == 2 and gid.split('#', 1)[1].startswith(gallery_prefix)
        if is_meta or is_child:
            table.delete_item(Key={'UserId': user_id, 'GalleryId': gid})

    # S3-Medien löschen
    _delete_s3_prefix(MEDIA_BUCKET, f'{MEDIA_PREFIX}{user_id}/{slug}/')
    try:
        s3.delete_object(Bucket=WEBSITE_BUCKET, Key=f'{user_id}/{slug}/index.html')
    except Exception:
        pass

    return _ok({'ok': True})


def _delete_s3_prefix(bucket, prefix):
    pag = s3.get_paginator('list_objects_v2')
    for page in pag.paginate(Bucket=bucket, Prefix=prefix):
        objects = [{'Key': o['Key']} for o in page.get('Contents', [])]
        if objects:
            s3.delete_objects(Bucket=bucket, Delete={'Objects': objects})


# ---------------------------------------------------------------------------
# Route: Presigned-URL für S3-Upload
# ---------------------------------------------------------------------------

def handle_presign(event):
    auth = _require_auth(event)
    if auth:
        return auth
    body         = json.loads(event.get('body') or '{}')
    user_id      = body.get('userId', 'koljagrosse')
    gallery_slug = body.get('gallerySlug', '')
    filename     = body.get('filename', '')
    file_type    = body.get('fileType', 'image/jpeg')
    folder       = body.get('folder', 'hd')   # 'hd' | 'thumbnails' | 'flights'

    if not gallery_slug or not filename:
        return _err(400, 'gallerySlug und filename sind erforderlich')

    # Sicherheitscheck: Galerie muss existieren
    db_item = table.get_item(Key={'UserId': user_id, 'GalleryId': f'GALLERY#{gallery_slug}'})
    if 'Item' not in db_item:
        return _err(404, 'Galerie nicht gefunden')

    s3_key  = f'{MEDIA_PREFIX}{user_id}/{gallery_slug}/{folder}/{filename}'
    url_key = s3_key[len(MEDIA_PREFIX):]   # ohne 'media/' für DynamoDB

    presigned_url = s3.generate_presigned_url(
        'put_object',
        Params={'Bucket': MEDIA_BUCKET, 'Key': s3_key, 'ContentType': file_type},
        ExpiresIn=3600,
    )
    return _ok({'url': presigned_url, 'key': url_key, 's3Key': s3_key})


# ---------------------------------------------------------------------------
# Route: Bild registrieren
# ---------------------------------------------------------------------------

def handle_register_image(event):
    auth = _require_auth(event)
    if auth:
        return auth
    body          = json.loads(event.get('body') or '{}')
    user_id       = body.get('userId', 'koljagrosse')
    full_size_url = body.get('fullSizeUrl', '')
    thumbnail_url = body.get('thumbnailUrl', '')
    caption       = body.get('caption', '')
    sort_order    = int(body.get('sortOrder', 50))

    if not full_size_url:
        return _err(400, 'fullSizeUrl fehlt')

    gallery_id = f'IMAGE#{full_size_url}'

    # update_item statt put_item: verhindert Race-Condition mit process_image.py (S3-Trigger).
    # EXIF-Felder werden direkt aus dem Browser ausgelesen und hier gesetzt.
    update_expr  = 'SET FullSizeUrl = :f, ThumbnailUrl = :t, Caption = :c, SortOrder = :s'
    expr_values  = {':f': full_size_url, ':t': thumbnail_url, ':c': caption, ':s': sort_order}

    if body.get('aperture'):     update_expr += ', Aperture = :ap';     expr_values[':ap']  = body['aperture']
    if body.get('shutterSpeed'): update_expr += ', ShutterSpeed = :ss'; expr_values[':ss']  = body['shutterSpeed']
    if body.get('iso'):          update_expr += ', ISO = :iso';         expr_values[':iso'] = body['iso']

    table.update_item(
        Key={'UserId': user_id, 'GalleryId': gallery_id},
        UpdateExpression=update_expr,
        ExpressionAttributeValues=expr_values,
    )
    return _ok({'ok': True, 'galleryId': gallery_id})


# ---------------------------------------------------------------------------
# Route: Bild aktualisieren
# ---------------------------------------------------------------------------

def handle_update_image(event):
    auth = _require_auth(event)
    if auth:
        return auth
    body       = json.loads(event.get('body') or '{}')
    user_id    = body.get('userId', 'koljagrosse')
    gallery_id = body.get('galleryId', '')

    updates = {}
    if 'caption'   in body: updates['Caption']   = body['caption']
    if 'label'     in body: updates['Label']     = body['label']
    if 'sortOrder' in body: updates['SortOrder'] = int(body['sortOrder'])

    if not updates or not gallery_id:
        return _err(400, 'galleryId und mind. ein Feld erforderlich')

    expr   = 'SET ' + ', '.join(f'#{k} = :{k}' for k in updates)
    names  = {f'#{k}': k for k in updates}
    values = {f':{k}': v for k, v in updates.items()}

    table.update_item(
        Key={'UserId': user_id, 'GalleryId': gallery_id},
        UpdateExpression=expr,
        ExpressionAttributeNames=names,
        ExpressionAttributeValues=values,
    )
    return _ok({'ok': True})


# ---------------------------------------------------------------------------
# Route: Bild löschen
# ---------------------------------------------------------------------------

def handle_delete_image(event):
    auth = _require_auth(event)
    if auth:
        return auth
    body          = json.loads(event.get('body') or '{}')
    user_id       = body.get('userId', 'koljagrosse')
    gallery_id    = body.get('galleryId', '')
    full_size_url = body.get('fullSizeUrl', '')
    thumbnail_url = body.get('thumbnailUrl', '')

    if gallery_id:
        table.delete_item(Key={'UserId': user_id, 'GalleryId': gallery_id})

    for url_key in [full_size_url, thumbnail_url]:
        if url_key:
            try:
                s3.delete_object(Bucket=MEDIA_BUCKET, Key=f'{MEDIA_PREFIX}{url_key}')
            except Exception:
                pass

    return _ok({'ok': True})


# ---------------------------------------------------------------------------
# Route: Flugelement registrieren
# ---------------------------------------------------------------------------

def handle_register_flight(event):
    auth = _require_auth(event)
    if auth:
        return auth
    body         = json.loads(event.get('body') or '{}')
    user_id      = body.get('userId', 'koljagrosse')
    csv_urls     = body.get('csvUrls', [])
    if not csv_urls and body.get('csvUrl'):     # backward compat
        csv_urls = [body['csvUrl']]
    label        = body.get('label', '')
    sort_order   = int(body.get('sortOrder', 50))
    gallery_slug = body.get('gallerySlug', '')

    flight_key = csv_urls[0] if csv_urls else f'{user_id}/{gallery_slug}/flights/noflight-{int(time.time())}'
    item = {
        'UserId':    user_id,
        'GalleryId': f'FLIGHT#{flight_key}',
        'CsvUrls':   csv_urls,                  # Liste aller Legs
        'CsvUrl':    csv_urls[0] if csv_urls else '',  # backward compat
        'Label':     label,
        'SortOrder': sort_order,
    }
    table.put_item(Item=item)
    return _ok({'ok': True, 'galleryId': item['GalleryId']})


# ---------------------------------------------------------------------------
# Route: Flugelement löschen
# ---------------------------------------------------------------------------

def handle_delete_flight(event):
    auth = _require_auth(event)
    if auth:
        return auth
    body       = json.loads(event.get('body') or '{}')
    user_id    = body.get('userId', 'koljagrosse')
    gallery_id = body.get('galleryId', '')
    csv_urls   = body.get('csvUrls', [])
    if not csv_urls and body.get('csvUrl'):     # backward compat
        csv_urls = [body['csvUrl']]

    if gallery_id:
        table.delete_item(Key={'UserId': user_id, 'GalleryId': gallery_id})
    for url in csv_urls:
        if url:
            try:
                s3.delete_object(Bucket=MEDIA_BUCKET, Key=f'{MEDIA_PREFIX}{url}')
            except Exception:
                pass
    return _ok({'ok': True})


# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------

def handler(event, context):
    method = event.get('requestContext', {}).get('http', {}).get('method', 'GET').upper()
    path   = event.get('rawPath', '').rstrip('/')

    if method == 'OPTIONS':
        return {'statusCode': 204, 'headers': CORS_HEADERS, 'body': ''}

    try:
        if path == '/admin/login'                            and method == 'POST':   return handle_login(event)
        if path == '/admin/galleries'                        and method == 'GET':    return handle_list_galleries(event)
        if path == '/admin/gallery'                          and method == 'POST':   return handle_create_gallery(event)
        if path.startswith('/admin/gallery/')                and method == 'PUT':    return handle_update_gallery(event)
        if path.startswith('/admin/gallery/')                and method == 'DELETE': return handle_delete_gallery(event)
        if path == '/admin/presign'                          and method == 'POST':   return handle_presign(event)
        if path == '/admin/image'                            and method == 'POST':   return handle_register_image(event)
        if path == '/admin/image'                            and method == 'PUT':    return handle_update_image(event)
        if path == '/admin/image'                            and method == 'DELETE': return handle_delete_image(event)
        if path == '/admin/flight'                           and method == 'POST':   return handle_register_flight(event)
        if path == '/admin/flight'                           and method == 'DELETE': return handle_delete_flight(event)
        return _err(404, f'Route nicht gefunden: {method} {path}')
    except Exception as exc:
        import traceback
        traceback.print_exc()
        return _err(500, str(exc))
