#!/usr/bin/env python3
"""
Einmaliges Backfill-Skript: Liest EXIF-Daten aus bestehenden Bildern in S3
und schreibt vollständige DynamoDB-Einträge (inkl. Aperture, ShutterSpeed, ISO).

Ausführen:
    cd backend
    python3 backfill_exif.py
"""

import boto3
import os
import struct

REGION        = 'eu-central-1'
MEDIA_BUCKET  = 'hd-media-highdefinition-galleries-ft-aviationlove'
MEDIA_PREFIX  = 'media/'
USER_ID       = 'koljagrosse'
IMAGE_EXTS    = {'.jpg', '.jpeg', '.png', '.webp', '.gif'}

s3       = boto3.client('s3', region_name=REGION)
dynamodb = boto3.resource('dynamodb', region_name=REGION)
table    = dynamodb.Table('UserGalleries')


# ---------------------------------------------------------------------------
# EXIF-Reader (identisch mit process_image.py – pure Python)
# ---------------------------------------------------------------------------

def _read_exif(data: bytes) -> dict:
    if len(data) < 4 or data[:2] != b'\xff\xd8':
        return {}
    pos = 2
    while pos < len(data) - 3:
        if data[pos] != 0xff:
            break
        marker = data[pos + 1]
        if marker == 0xda:
            break
        seg_len = struct.unpack('>H', data[pos + 2:pos + 4])[0]
        if marker == 0xe1:
            seg = data[pos + 4: pos + 2 + seg_len]
            if seg[:6] == b'Exif\x00\x00':
                return _parse_tiff(seg[6:])
            break
        pos += 2 + seg_len
    return {}

def _parse_tiff(data):
    if len(data) < 8:
        return {}
    e = '<' if data[:2] == b'II' else ('>' if data[:2] == b'MM' else None)
    if not e:
        return {}
    ifd0 = struct.unpack(f'{e}I', data[4:8])[0]
    result = {}
    _read_ifd(data, ifd0, e, result)
    return result

def _read_ifd(data, offset, e, result):
    if offset + 2 > len(data):
        return
    n = struct.unpack(f'{e}H', data[offset:offset + 2])[0]
    pos = offset + 2
    exif_ptr = None
    for _ in range(n):
        if pos + 12 > len(data):
            break
        tag, typ, _ = struct.unpack(f'{e}HHI', data[pos:pos + 8])
        val_raw = data[pos + 8:pos + 12]
        pos += 12
        if tag == 0x8769:
            exif_ptr = struct.unpack(f'{e}I', val_raw)[0]
        elif tag == 0x829a:
            r = _rational(data, val_raw, e)
            if r: result['ShutterSpeed'] = _fmt_shutter(*r)
        elif tag == 0x829d:
            r = _rational(data, val_raw, e)
            if r: result['Aperture'] = f"f/{r[0] / r[1]:.1f}"
        elif tag == 0x8827 and typ == 3:
            result['ISO'] = str(struct.unpack(f'{e}H', val_raw[:2])[0])
    if exif_ptr:
        _read_ifd(data, exif_ptr, e, result)

def _rational(data, val_raw, e):
    off = struct.unpack(f'{e}I', val_raw)[0]
    if off + 8 <= len(data):
        n, d = struct.unpack(f'{e}II', data[off:off + 8])
        if d: return n, d
    return None

def _fmt_shutter(n, d):
    if n == 0: return '0s'
    val = n / d
    return f"{val:.1f}s" if val >= 1 else f"1/{round(d / n)}s"


# ---------------------------------------------------------------------------
# Thumbnail-Map: Dateiname-Stem → url_key (ohne "media/")
# ---------------------------------------------------------------------------

def build_thumbnail_map():
    thumb_map = {}
    pag = s3.get_paginator('list_objects_v2')
    for page in pag.paginate(Bucket=MEDIA_BUCKET, Prefix=f"{MEDIA_PREFIX}{USER_ID}/"):
        for obj in page.get('Contents', []):
            key = obj['Key']
            if '/thumbnails/' not in key:
                continue
            fname = key.split('/')[-1]
            stem  = os.path.splitext(fname)[0].upper()
            thumb_map[stem] = key[len(MEDIA_PREFIX):]
    return thumb_map


# ---------------------------------------------------------------------------
# Hauptlogik
# ---------------------------------------------------------------------------

def main():
    print(f"Backfill EXIF — Bucket: {MEDIA_BUCKET}, User: {USER_ID}\n")

    thumb_map = build_thumbnail_map()
    print(f"  {len(thumb_map)} Thumbnails gefunden\n")

    pag   = s3.get_paginator('list_objects_v2')
    count = 0

    for page in pag.paginate(Bucket=MEDIA_BUCKET, Prefix=f"{MEDIA_PREFIX}{USER_ID}/"):
        for obj in page.get('Contents', []):
            s3_key = obj['Key']

            if '/hd/' not in s3_key:
                continue
            ext = os.path.splitext(s3_key)[1].lower()
            if ext not in IMAGE_EXTS:
                continue

            url_key       = s3_key[len(MEDIA_PREFIX):]
            filename      = s3_key.split('/')[-1]
            stem          = os.path.splitext(filename)[0].upper()
            thumbnail_url = thumb_map.get(stem, url_key.replace('/hd/', '/thumbnails/'))
            caption       = os.path.splitext(filename)[0]

            # EXIF: erste 64 KB des Bildes lesen
            print(f"  {filename} ...", end=' ', flush=True)
            exif = {}
            try:
                resp      = s3.get_object(Bucket=MEDIA_BUCKET, Key=s3_key, Range='bytes=0-65535')
                img_bytes = resp['Body'].read()
                exif      = _read_exif(img_bytes)
                parts = [exif.get('Aperture','—'), exif.get('ShutterSpeed','—')]
                if exif.get('ISO'): parts.append(f"ISO {exif['ISO']}")
                print(' · '.join(parts))
            except Exception as ex:
                print(f"EXIF-Fehler: {ex}")

            item = {
                'UserId':       USER_ID,
                'GalleryId':    f"IMAGE#{url_key}",
                'ThumbnailUrl': thumbnail_url,
                'FullSizeUrl':  url_key,
                'Caption':      caption,
            }
            if exif.get('Aperture'):     item['Aperture']     = exif['Aperture']
            if exif.get('ShutterSpeed'): item['ShutterSpeed'] = exif['ShutterSpeed']
            if exif.get('ISO'):          item['ISO']          = exif['ISO']

            table.put_item(Item=item)
            count += 1

    print(f"\nFertig: {count} Einträge in DynamoDB geschrieben.")


if __name__ == '__main__':
    main()
