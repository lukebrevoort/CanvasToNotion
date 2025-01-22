from notion_client import Client
from datetime import datetime
import pytz
from typing import Dict, Optional
from .models.assignment import Assignment
from .utils.config import NOTION_TOKEN, NOTION_DATABASE_ID, COURSE_DATABASE_ID
import logging

logger = logging.getLogger(__name__)

class NotionAPI:
    def __init__(self):
        self.notion = Client(auth=NOTION_TOKEN)
        self.database_id = NOTION_DATABASE_ID
        self.course_db_id = COURSE_DATABASE_ID
        self.course_mapping = self._get_course_mapping()

    def _get_course_mapping(self) -> Dict[str, str]:
        """Create mapping of Canvas course IDs to Notion page UUIDs"""
        try:
            response = self.notion.databases.query(
                database_id=self.course_db_id,
                page_size=100
            )
            
            mapping = {}
            for page in response.get('results', []):
                canvas_id = page['properties'].get('CourseID', {}).get('number')
                if canvas_id:
                    mapping[str(canvas_id)] = page['id']
            
            logger.info(f"Loaded {len(mapping)} course mappings")
            return mapping
        except Exception as e:
            logger.error(f"Failed to get course mapping: {str(e)}")
            return {}

    def _parse_date(self, date_str) -> Optional[datetime]:
        """Helper to parse dates from various formats"""
        if not date_str:
            return None
        if isinstance(date_str, datetime):
            return date_str
        try:
            if 'Z' in date_str:
                date_str = date_str.replace('Z', '+00:00')
            parsed_date = datetime.fromisoformat(date_str)
            return parsed_date.astimezone(pytz.UTC)
        except ValueError as e:
            logger.warning(f"Could not parse date: {date_str}. Error: {e}")
            return None

    def get_assignment_page(self, assignment_id: int):
        """Fetch existing assignment page from Notion"""
        try:
            response = self.notion.databases.query(
                database_id=self.database_id,
                filter={
                    "property": "AssignmentID",
                    "number": {"equals": assignment_id}
                }
            )
            results = response.get('results', [])
            return results[0] if results else None
        except Exception as e:
            logger.error(f"Error fetching assignment {assignment_id} from Notion: {str(e)}")
            return None

    def create_or_update_assignment(self, assignment: Assignment):
        """Create or update assignment in Notion"""
        try:
            existing_page = self.get_assignment_page(assignment.id)
            
            # Get Notion UUID for course
            course_uuid = self.course_mapping.get(str(assignment.course_id))
            if not course_uuid:
                logger.warning(f"No Notion UUID found for course {assignment.course_id}")
                return
            
            # Parse due date
            due_date = self._parse_date(assignment.due_date)
            
            # Prepare properties with proper type handling
            properties = {
                "Assignment Title": {"title": [{"text": {"content": str(assignment.name)}}]},
                "AssignmentID": {"number": int(assignment.id)},
                "Description": {"rich_text": [{"text": {"content": str(assignment.description)[:2000] if assignment.description else ""}}]},
                "Course": {"relation": [{"id": course_uuid}]},
                "Status": {"status": {"name": str(assignment.status)}}
            }
            
            # Only add due date if valid
            if due_date:
                properties["Due Date"] = {"date": {"start": due_date.isoformat()}}
            
            # Only add grade if present
            if assignment.grade is not None:
                try:
                    properties["Grade (%)"] = {"number": float(assignment.grade)}
                except (ValueError, TypeError):
                    logger.warning(f"Invalid grade format for assignment {assignment.name}: {assignment.grade}")

            if existing_page:
                logger.info(f"Updating assignment: {assignment.name}")
                self.notion.pages.update(
                    page_id=existing_page["id"],
                    properties=properties
                )
            else:
                logger.info(f"Creating new assignment: {assignment.name}")
                self.notion.pages.create(
                    parent={"database_id": self.database_id},
                    properties=properties
                )
                
        except Exception as e:
            logger.error(f"Error syncing assignment {assignment.name} to Notion: {str(e)}")
            raise