import os
from dotenv import load_dotenv
from canvasapi import Canvas
from notion_client import Client
import logging

# Set up logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

def test_canvas_connection():
    try:
        CANVAS_URL = os.getenv('CANVAS_URL')
        CANVAS_TOKEN = os.getenv('CANVAS_TOKEN')
        canvas = Canvas(CANVAS_URL, CANVAS_TOKEN)
        user = canvas.get_current_user()
        logger.info(f"Successfully connected to Canvas as: {user.name}")
        
        courses = canvas.get_courses()
        logger.info(f"Found {len(list(courses))} courses")
        
        # Use course_code or course_name instead of name
        for course in courses:
            logger.info(f"Course: {course.course_code}")  # or course.course_name
            break  # Just test the first course
            
        return True
    except Exception as e:
        logger.error(f"Canvas API test failed: {str(e)}")
        return False

def test_notion_connection():
    try:
        NOTION_TOKEN = os.getenv('NOTION_TOKEN')
        NOTION_DATABASE_ID = os.getenv('NOTION_DATABASE_ID')

        notion = Client(auth=NOTION_TOKEN)
        database_id = NOTION_DATABASE_ID.strip('/')
        
        # First verify database access
        db = notion.databases.retrieve(database_id=database_id)
        logger.info(f"Successfully connected to Notion database: {db['title'][0]['plain_text']}")
        
        # Test querying the database
        pages = notion.databases.query(database_id=database_id)
        
        return True
    except Exception as e:
        logger.error(f"Notion API test failed: {str(e)}")
        return False

def main():
    """Main function to run API tests"""
    # Load environment variables
    load_dotenv()
    
    logger.info("Starting API connectivity tests...")
    
    # Test Canvas
    logger.info("\n=== Testing Canvas API ===")
    canvas_success = test_canvas_connection()
    
    # Test Notion
    logger.info("\n=== Testing Notion API ===")
    notion_success = test_notion_connection()
    
    # Summary
    logger.info("\n=== Test Summary ===")
    logger.info(f"Canvas API: {'✅ Connected' if canvas_success else '❌ Failed'}")
    logger.info(f"Notion API: {'✅ Connected' if notion_success else '❌ Failed'}")

if __name__ == "__main__":
    main()