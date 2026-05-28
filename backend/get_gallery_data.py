import boto3
import json
import os
from boto3.dynamodb.conditions import Key

dynamodb = boto3.resource('dynamodb')
table    = dynamodb.Table('UserGalleries')
s3       = boto3.client('s3')

MEDIA_BUCKET    = os.environ.get('MEDIA_BUCKET', 'hd-media-highdefinition-galleries-ft-aviationlove')
IMAGE_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.webp', '.gif'}
MEDIA_PREFIX    = 'media/'

CORS = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
}


def _ok(items):
    return {'statusCode': 200, 'headers': CORS, 'body': json.dumps(items, default=str)}


def _err(status, msg):
    return {'statusCode': status, 'headers': CORS, 'body': json.dumps({'error': msg})}


def handler(event, context):
    """
    Query-Parameter:
      userId       (default: 'koljagrosse')
      galleryId    Filter auf eine bestimmte Galerie  z.B. '2026Miami'
      galleriesOnly=true  Gibt nur GALLERY#-Items zurück (für Profilseite)

    S3-Struktur:
      media/{user}/{gallery}/hd/{datei}
      media/{user}/{gallery}/thumbnails/{datei}
      media/{user}/{gallery}/flights/flight01.csv

    ThumbnailUrl / FullSizeUrl werden OHNE führendes 'media/' gespeichert,
    weil gallery.js mit MEDIA_BASE_URL = 'https://high-definition.net/media/' prefixed.
    """
    params        = (event.get('queryStringParameters') or {})
    user_id       = params.get('userId', 'koljagrosse')
    gallery_id    = params.get('galleryId')          # z.B. '2026Miami' oder 'miami-2026'
    galleries_only = params.get('galleriesOnly') == 'true'

    try:
        # --- DynamoDB: alle Items dieses Users ---
        db_resp  = table.query(KeyConditionExpression=Key('UserId').eq(user_id))
        db_items = db_resp.get('Items', [])

        # --- galleriesOnly: nur GALLERY# zurückgeben (Profilseite) ---
        if galleries_only:
            galleries = [i for i in db_items if i.get('GalleryId', '').startswith('GALLERY#')]
            return _ok(galleries)

        # --- Hilfsfunktion: gehört Item zur angefragten Galerie? ---
        def belongs(item):
            if not gallery_id:
                return True
            gid = item.get('GalleryId', '')
            if gid.startswith('GALLERY#'):
                return gid == f'GALLERY#{gallery_id}'
            parts = gid.split('#', 1)
            return len(parts) == 2 and parts[1].startswith(f'{user_id}/{gallery_id}/')

        gallery_items = [i for i in db_items if i.get('GalleryId', '').startswith('GALLERY#') and belongs(i)]
        flight_items  = [i for i in db_items if i.get('GalleryId', '').startswith('FLIGHT#')  and belongs(i)]
        image_items   = [i for i in db_items if i.get('GalleryId', '').startswith('IMAGE#')   and belongs(i)]

        db_image_keys = {i.get('FullSizeUrl', '') for i in image_items}

        # --- S3: Thumbnails + hd-Bilder einlesen ---
        s3_prefix = f'{MEDIA_PREFIX}{user_id}/'
        if gallery_id:
            s3_prefix = f'{MEDIA_PREFIX}{user_id}/{gallery_id}/'

        thumbnail_by_stem = {}
        hd_files = []

        paginator = s3.get_paginator('list_objects_v2')
        for page in paginator.paginate(Bucket=MEDIA_BUCKET, Prefix=s3_prefix):
            for obj in page.get('Contents', []):
                s3_key  = obj['Key']
                url_key = s3_key[len(MEDIA_PREFIX):]

                if '/thumbnails/' in s3_key:
                    fname = s3_key.split('/')[-1]
                    stem  = os.path.splitext(fname)[0].upper()
                    thumbnail_by_stem[stem] = url_key
                elif '/hd/' in s3_key:
                    ext = os.path.splitext(s3_key)[1].lower()
                    if ext in IMAGE_EXTENSIONS:
                        hd_files.append((s3_key, url_key))

        # --- S3-Bilder ohne DynamoDB-Eintrag ergänzen ---
        for s3_key, url_key in hd_files:
            if url_key in db_image_keys:
                continue
            fname         = s3_key.split('/')[-1]
            stem          = os.path.splitext(fname)[0].upper()
            thumbnail_url = thumbnail_by_stem.get(stem, url_key.replace('/hd/', '/thumbnails/'))
            image_items.append({
                'UserId':       user_id,
                'GalleryId':    f'IMAGE#{url_key}',
                'ThumbnailUrl': thumbnail_url,
                'FullSizeUrl':  url_key,
                'Caption':      os.path.splitext(fname)[0],
            })

        return _ok(gallery_items + image_items + flight_items)

    except Exception as exc:
        print(f'Fehler: {exc}')
        return _err(500, str(exc))
