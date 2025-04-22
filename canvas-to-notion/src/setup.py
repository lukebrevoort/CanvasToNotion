import os
import logging
from dotenv import load_dotenv, set_key
from notion_client import Client
from canvasapi import Canvas
from utils.notion_setup import NotionSetup

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

def setup_env_file():
    """
    Interactive setup to create a .env file with necessary credentials.
    """
    print("=== Canvas to Notion Sync Setup ===")
    print("This wizard will help you set up the necessary configuration.")
    
    # Check if .env exists
    env_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), '.env')
    env_exists = os.path.exists(env_path)
    
    if env_exists:
        print("\nExisting .env file found. Update it? (y/n)")
        update = input("> ").lower() == 'y'
        if not update:
            print("Keeping existing configuration.")
            return
    
    # Canvas setup
    print("\n== Canvas API Setup ==")
    print("Go to your Canvas account settings to generate an access token.")
    print("URL: https://yourschool.instructure.com/profile/settings")
    canvas_url = input("Canvas URL (e.g., https://yourschool.instructure.com): ").strip()
    canvas_token = input("Canvas API Token: ").strip()
    
    # Test Canvas connection
    try:
        canvas = Canvas(canvas_url, canvas_token)
        user = canvas.get_current_user()
        print(f"✅ Successfully connected to Canvas as: {user.name}")
    except Exception as e:
        print(f"❌ Canvas connection failed: {e}")
        print("Please check your Canvas URL and token and try again.")
        return
    
    # Notion setup
    print("\n== Notion API Setup ==")
    print("1. Go to https://www.notion.so/my-integrations to create a new integration")
    print("2. Give it a name (e.g., 'Canvas Sync')")
    print("3. Set the capabilities: Read content, Update content, Insert content")
    print("4. Copy the 'Internal Integration Token'")
    notion_token = input("Notion API Token: ").strip()
    
    # Test Notion connection
    try:
        notion = Client(auth=notion_token)
        notion.users.me()
        print("✅ Successfully connected to Notion")
    except Exception as e:
        print(f"❌ Notion connection failed: {e}")
        print("Please check your Notion token and try again.")
        return
    
    
    # Get Notion parent page
    print("\nWhich Notion page would you like to add the databases to?")
    print("1. Go to that page in Notion")
    print("2. Share the page with your integration")
    print("3. Copy the URL from your browser")
    print("4. Paste it here")
    print("Note: The integration must have access to this page.")
    notion_page_url = input("Notion page URL: ").strip()
    
    try:
        # Extract page ID from URL
        page_id = notion_page_url.split('-')[-1]
        if 'notion.so' in page_id:
            page_id = page_id.split('/')[-1]
        
        # Verify page access
        notion.pages.retrieve(page_id=page_id)
        print(f"✅ Successfully accessed Notion page")
        
        # Create databases
        setup = NotionSetup(notion_token)
        print("\nCreating Notion databases...")
        course_db_id = setup.create_course_database(page_id)
        assignment_db_id = setup.create_assignment_database(page_id)
        setup.setup_database_relations(assignment_db_id, course_db_id)
        print("✅ Notion databases created successfully")
        
    except Exception as e:
        print(f"❌ Notion page setup failed: {e}")
        print("Make sure your integration has access to this page.")
        print("1. Open the page in Notion")
        print("2. Click 'Share' in the top right")
        print("3. Click 'Invite' and add your integration")
        
        retry = input("\nWould you like to try again after sharing the page? (y/n): ").lower()
        if retry == 'y':
            notion_page_url = input("Notion page URL (same or new): ").strip()
            try:
                # Extract page ID from URL
                page_id = notion_page_url.split('-')[-1]
                if 'notion.so' in page_id:
                    page_id = page_id.split('/')[-1]
                
                # Verify page access
                notion.pages.retrieve(page_id=page_id)
                print(f"✅ Successfully accessed Notion page")
                
                # Create databases
                setup = NotionSetup(notion_token)
                print("\nCreating Notion databases...")
                course_db_id = setup.create_course_database(page_id)
                assignment_db_id = setup.create_assignment_database(page_id)
                setup.setup_database_relations(assignment_db_id, course_db_id)
                print("✅ Notion databases created successfully")
            except Exception as e2:
                print(f"❌ Notion page setup failed again: {e2}")
                return
        else:
            return
    
    # Save configuration
    try:
        with open(env_path, 'w') as f:
            f.write(f"CANVAS_TOKEN={canvas_token}\n")
            f.write(f"CANVAS_URL={canvas_url}\n")
            f.write(f"NOTION_TOKEN={notion_token}\n")
            f.write(f"NOTION_DATABASE_ID={assignment_db_id}\n")
            f.write(f"COURSE_DATABASE_ID={course_db_id}\n")
            f.write(f"USER_ID={user.id}\n")
            f.write(f"SYNC_INTERVAL=900\n")  # 15 minutes default
            
        print("\n✅ Configuration saved successfully")
        print(f"Configuration file: {env_path}")
        
    except Exception as e:
        print(f"❌ Failed to save configuration: {e}")
        
    print("\nSetup complete! You can now run the sync service.")

if __name__ == "__main__":
    setup_env_file()