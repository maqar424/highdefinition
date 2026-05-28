import json
import boto3
import os
import struct
from urllib.parse import unquote_plus

dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table('UserGalleries')
s3 = boto3.client('s3')

IMAGE_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.webp', '.gif'}
MEDIA_PREFIX = 'media/'


# ---------------------------------------------------------------------------
# Minimaler EXIF-Reader (pure Python, keine externen Bibliotheken nötig)
# Liest Blende, Belichtungszeit und ISO aus JPEG-Dateien.
# ---------------------------------------------------------------------------

def _read_exif(data: bytes) -> dict:
    """Gibt {'Aperture': 'f/2.8', 'ShutterSpeed': '1/500s', 'ISO': '400'} zurück."""
    if len(data) < 4 or data[:2] != b'\xff\xd8':
        return {}
    pos = 2
    while pos < len(data) - 3:
        if data[pos] != 0xff:
            break
        marker = data[pos + 1]
        if marker == 0xda:   # Start of Scan → kein EXIF mehr
            break
        seg_len = struct.unpack('>H', data[pos + 2:pos + 4])[0]
        if marker == 0xe1:   # APP1
            seg = data[pos + 4: pos + 2 + seg_len]
            if seg[:6] == b'Exif\x00\x00':
                return _parse_tiff(seg[6:])
            break
        pos += 2 + seg_len
    return {}

def _parse_tiff(data: bytes) -> dict:
    if len(data) < 8:
        return {}
    e = '<' if data[:2] == b'II' else ('>' if data[:2] == b'MM' else None)
    if not e:
        return {}
    ifd0 = struct.unpack(f'{e}I', data[4:8])[0]
    result = {}
    _read_ifd(data, ifd0, e, result)
    return result

def _read_ifd(data: bytes, offset: int, e: str, result: dict):
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
        if tag == 0x8769:                           # ExifIFD-Pointer
            exif_ptr = struct.unpack(f'{e}I', val_raw)[0]
        elif tag == 0x829a:                         # ExposureTime
            r = _rational(data, val_raw, e)
            if r:
                result['ShutterSpeed'] = _fmt_shutter(*r)
        elif tag == 0x829d:                         # FNumber
            r = _rational(data, val_raw, e)
            if r:
                result['Aperture'] = f"f/{r[0] / r[1]:.1f}"
        elif tag == 0x8827 and typ == 3:            # ISOSpeedRatings
            result['ISO'] = str(struct.unpack(f'{e}H', val_raw[:2])[0])
    if exif_ptr:
        _read_ifd(data, exif_ptr, e, result)

def _rational(data, val_raw, e):
    off = struct.unpack(f'{e}I', val_raw)[0]
    if off + 8 <= len(data):
        n, d = struct.unpack(f'{e}II', data[off:off + 8])
        if d:
            return n, d
    return None

def _fmt_shutter(n, d):
    if n == 0:
        return '0s'
    val = n / d
    return f"{val:.1f}s" if val >= 1 else f"1/{round(d / n)}s"


# ---------------------------------------------------------------------------
# Lambda-Handler
# ---------------------------------------------------------------------------

def handler(event, context):
    """
    S3-Trigger: Neue Datei im Media-Bucket.

    S3-Struktur:
        media/{user}/{gallery}/hd/{datei}         ← Vollbild (verarbeiten)
        media/{user}/{gallery}/thumbnails/{datei} ← Thumbnail (ignorieren)
        media/{user}/{gallery}/flights/*.csv      ← Flugdaten (ignorieren)
    """
    for record in event['Records']:
        bucket  = record['s3']['bucket']['name']
        s3_key  = unquote_plus(record['s3']['object']['key'])

        if '/hd/' not in s3_key:
            print(f"Nicht im /hd/-Ordner, überspringe: {s3_key}")
            continue

        filename = s3_key.split('/')[-1]
        ext = os.path.splitext(filename)[1].lower()
        if ext not in IMAGE_EXTENSIONS:
            print(f"Keine Bilddatei, überspringe: {s3_key}")
            continue

        # Pfade berechnen
        url_key       = s3_key[len(MEDIA_PREFIX):]               # ohne "media/"
        user_id       = url_key.split('/')[0]
        thumbnail_url = url_key.replace('/hd/', '/thumbnails/')
        caption       = os.path.splitext(filename)[0]
        gallery_id    = f"IMAGE#{url_key}"

        # EXIF aus den ersten 64 KB lesen
        exif = {}
        try:
            resp      = s3.get_object(Bucket=bucket, Key=s3_key, Range='bytes=0-65535')
            img_bytes = resp['Body'].read()
            exif      = _read_exif(img_bytes)
            print(f"EXIF: {exif}")
        except Exception as ex:
            print(f"EXIF-Lesefehler für {s3_key}: {ex}")

        # update_item statt put_item:
        # - ThumbnailUrl / FullSizeUrl / Caption: nur setzen, wenn noch nicht vorhanden
        #   (Admin-Tool könnte diese Felder bereits gesetzt haben)
        # - EXIF-Felder: immer setzen (Kameradaten aus dem echten Bild)
        update_expr  = ('SET #ThumbnailUrl = if_not_exists(#ThumbnailUrl, :thumb), '
                        '#FullSizeUrl = if_not_exists(#FullSizeUrl, :full), '
                        '#Caption = if_not_exists(#Caption, :caption), '
                        '#UserId = if_not_exists(#UserId, :uid)')
        expr_names   = {'#ThumbnailUrl': 'ThumbnailUrl', '#FullSizeUrl': 'FullSizeUrl',
                        '#Caption': 'Caption', '#UserId': 'UserId'}
        expr_values  = {':thumb': thumbnail_url, ':full': url_key,
                        ':caption': caption, ':uid': user_id}

        if exif.get('Aperture'):
            update_expr += ', #Aperture = :aperture'
            expr_names['#Aperture']  = 'Aperture'
            expr_values[':aperture'] = exif['Aperture']
        if exif.get('ShutterSpeed'):
            update_expr += ', #ShutterSpeed = :shutter'
            expr_names['#ShutterSpeed']  = 'ShutterSpeed'
            expr_values[':shutter']      = exif['ShutterSpeed']
        if exif.get('ISO'):
            update_expr += ', #ISO = :iso'
            expr_names['#ISO']  = 'ISO'
            expr_values[':iso'] = exif['ISO']

        try:
            table.update_item(
                Key={'UserId': user_id, 'GalleryId': gallery_id},
                UpdateExpression=update_expr,
                ExpressionAttributeNames=expr_names,
                ExpressionAttributeValues=expr_values,
            )
            print(f"Registriert/aktualisiert: {url_key}")
        except Exception as ex:
            print(f"DynamoDB-Fehler für {url_key}: {ex}")
            raise

    return {'statusCode': 200, 'body': json.dumps('OK')}
