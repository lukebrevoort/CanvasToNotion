import os
from dotenv import load_dotenv

load_dotenv()

CANVAS_TOKEN = os.getenv('CANVAS_TOKEN')
CANVAS_URL = os.getenv('CANVAS_URL')
NOTION_TOKEN = os.getenv('NOTION_TOKEN')
NOTION_DATABASE_ID = os.getenv('NOTION_DATABASE_ID')
COURSE_DATABASE_ID = os.getenv('COURSE_DATABASE_ID')

# Sync interval in seconds
SYNC_INTERVAL = 300  # 5 minutes