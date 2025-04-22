from notion_client import Client
import logging
from utils.config import NOTION_TOKEN

logger = logging.getLogger(__name__)

class NotionSetup:
    """
    Handles initial Notion setup for new users, including:
    - Creating assignment database with required properties
    - Creating course database
    - Setting up relations between databases
    """
    
    def __init__(self, token=NOTION_TOKEN):
        self.notion = Client(auth=token)
        
    def create_assignment_database(self, parent_page_id):
        """
        Creates a new assignment database with required properties.
        
        Args:
            parent_page_id: Notion page ID where the database will be created
            
        Returns:
            str: ID of the created database
        """
        try:
            properties = {
                "Assignment Title": {"title": {}},
                "AssignmentID": {"number": {}},
                "Description": {"rich_text": {}},
                "Due Date": {"date": {}},
                "Status": {"select": {
                    "options": [
                        {"name": "Not started", "color": "gray"},
                        {"name": "In progress", "color": "blue"},
                        {"name": "Submitted", "color": "green"},
                        {"name": "Mark received", "color": "purple"},
                        {"name": "Dont show", "color": "red"}
                    ]
                }},
                "Priority": {"select": {
                    "options": [
                        {"name": "Low", "color": "blue"},
                        {"name": "Medium", "color": "yellow"},
                        {"name": "High", "color": "red"}
                    ]
                }},
                "Grade (%)": {"number": {"format": "percent"}},
                "Assignment Group": {"select": {}},
                "Group Weight": {"number": {}},
                "Course": {"relation": {}} 
            }
            
            response = self.notion.databases.create(
                parent={"page_id": parent_page_id},
                title=[{"type": "text", "text": {"content": "Canvas Assignments"}}],
                properties=properties,
                sorts=[{
                    "property": "Due Date",
                    "direction": "ascending"
                }]
            )
            
            logger.info(f"Created assignment database with ID: {response['id']}")
            return response["id"]
            
        except Exception as e:
            logger.error(f"Failed to create assignment database: {e}")
            raise
            
    def create_course_database(self, parent_page_id):
        """
        Creates a new course database with required properties.
        
        Args:
            parent_page_id: Notion page ID where the database will be created
            
        Returns:
            str: ID of the created database
        """
        try:
            properties = {
                "Course Name": {"title": {}},
                "CourseID": {"multi_select": {}},
                "Term": {"select": {}},
                "Status": {"select": {
                    "options": [
                        {"name": "Active", "color": "green"},
                        {"name": "Archived", "color": "gray"}
                    ]
                }}
            }
            
            response = self.notion.databases.create(
                parent={"page_id": parent_page_id},
                title=[{"type": "text", "text": {"content": "Canvas Courses"}}],
                properties=properties
            )
            
            logger.info(f"Created course database with ID: {response['id']}")
            return response["id"]
            
        except Exception as e:
            logger.error(f"Failed to create course database: {e}")
            raise
    
    def setup_database_relations(self, assignment_db_id, course_db_id):
        """
        Sets up relations between the assignment and course databases.
        
        Args:
            assignment_db_id: ID of the assignment database
            course_db_id: ID of the course database
        """
        try:
            # Add Course relation to assignment database
            self.notion.databases.update(
                database_id=assignment_db_id,
                properties={
                    "Course": {
                        "relation": {
                            "database_id": course_db_id,
                            "single_property": {}
                        }
                    }
                }
            )
            logger.info(f"Added Course relation to assignment database")
            
        except Exception as e:
            logger.error(f"Failed to set up database relations: {e}")
            raise