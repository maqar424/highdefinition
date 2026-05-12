import boto3
import json
from boto3.dynamodb.conditions import Key

dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table('UserGalleries')

def handler(event, context):
    user_id = "koljagrosse" # Das ist dein Partition Key
    
    try:
        # Wir fragen alle Items für dich ab
        response = table.query(
            KeyConditionExpression=Key('UserId').eq(user_id)
        )
        items = response.get('Items', [])
        
        return {
            'statusCode': 200,
            'headers': {
                'Access-Control-Allow-Origin': '*', # Erlaubt deiner Website den Zugriff
                'Content-Type': 'application/json'
            },
            'body': json.dumps(items) # Hier senden wir die echten Daten
        }
    except Exception as e:
        return {
            'statusCode': 500,
            'body': json.dumps({'error': str(e)})
        }