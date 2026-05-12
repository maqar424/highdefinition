import json

def handler(event, context):
    # Das 'event' enthält Informationen über die hochgeladene Datei
    for record in event['Records']:
        bucket = record['s3']['bucket']['name']
        key = record['s3']['object']['key']
        print(f"Neues Bild erkannt: {key} im Bucket {bucket}")
    
    return {
        'statusCode': 200,
        'body': json.dumps('Event erfolgreich verarbeitet')
    }

