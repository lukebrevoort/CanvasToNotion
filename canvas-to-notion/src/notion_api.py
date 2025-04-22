from notion_client import Client
from datetime import datetime
import pytz
from typing import Dict, Optional
from datetime import timezone
from models.assignment import Assignment
from utils.config import NOTION_TOKEN, NOTION_DATABASE_ID, COURSE_DATABASE_ID, USER_ID
from bs4 import BeautifulSoup
import re
import logging
import backoff
from ratelimit import limits, sleep_and_retry

logger = logging.getLogger(__name__)

# NotionAPI: Handles integration between Canvas assignments and Notion database
# Manages rate limiting, error handling, and data transformation

class NotionAPI:
    """
    Manages interaction with Notion API for syncing Canvas assignments.
    Handles rate limiting, retries, and data transformation.
    """
    
    ONE_SECOND = 1
    MAX_REQUESTS_PER_SECOND = 3

    def __init__(self):
        self.notion = Client(auth=NOTION_TOKEN)
        self.database_id = NOTION_DATABASE_ID
        self.course_db_id = COURSE_DATABASE_ID
        self.course_mapping = self._get_course_mapping()

    @sleep_and_retry
    @limits(calls=MAX_REQUESTS_PER_SECOND, period=ONE_SECOND)
    @backoff.on_exception(
        backoff.expo,
        Exception,
        max_tries=5
    )
    def _make_notion_request(self, operation_type: str, **kwargs):
        """
        Rate-limited wrapper for Notion API calls with exponential backoff.
        
        Args:
            operation_type: Type of Notion operation ('query_database', 'update_page', 'create_page')
            **kwargs: Arguments passed to the Notion API call
        
        Returns:
            Response from Notion API
        
        Raises:
            ValueError: If operation_type is invalid
        """
        if operation_type == "query_database":
            return self.notion.databases.query(**kwargs)
        elif operation_type == "update_page":
            return self.notion.pages.update(**kwargs)
        elif operation_type == "create_page":
            return self.notion.pages.create(**kwargs)
        raise ValueError(f"Unknown operation type: {operation_type}")
    
    def _parse_date(self, date_str) -> Optional[datetime]:
        """Helper to parse dates from various formats"""
        if not date_str:
            return None
        if isinstance(date_str, datetime):
            dt = date_str
        else:
            try:
                if 'Z' in date_str:
                    date_str = date_str.replace('Z', '+00:00')
                dt = datetime.fromisoformat(date_str)
            except ValueError as e:
                logger.warning(f"Could not parse date: {date_str}. Error: {e}")
                return None

        dt = dt.astimezone(pytz.timezone('US/Eastern'))
        
        # Optional: If time is exactly 11:59, return date only (adjust as needed)
        if dt.hour == 23 and dt.minute == 59:
            return dt.date()
            
        return dt

    def _get_course_mapping(self) -> Dict[str, str]:
        """
        Maps Canvas course IDs to Notion page UUIDs from the course database.
        
        Returns:
            Dict mapping Canvas course IDs (str) to Notion page UUIDs (str)
        """
        try:
            response = self._make_notion_request(
                "query_database",
                database_id=self.course_db_id,
                page_size=100
            )
            
            mapping = {}
            
            # Debug full response
            logger.debug(f"Full response: {response}")
            
            for page in response['results']:
                try:
                    # Get page ID and properties
                    notion_uuid = page['id']
                    properties = page['properties']
                    
                    # Debug properties
                    logger.debug(f"Page {notion_uuid} properties: {properties}")
                    
                    # Access multi-select values directly
                    canvas_ids = properties['CourseID']['multi_select']
                    logger.debug(f"Canvas IDs found: {canvas_ids}")
                    
                    # Map each selected value to this page
                    for item in canvas_ids:
                        canvas_id = item['name']  # Direct access to name
                        logger.info(f"Mapping Canvas ID {canvas_id} to page {notion_uuid}")
                        mapping[str(canvas_id)] = notion_uuid
                
                except KeyError as e:
                    logger.error(f"Missing property in page {page.get('id')}: {e}")
                    continue
                except Exception as e:
                    logger.error(f"Error processing page {page.get('id')}: {e}")
                    continue
            
            logger.info(f"Final mappings: {mapping}")
            return mapping
            
        except Exception as e:
            logger.error(f"Failed to get course mapping: {e}")
            return {}
        
    def _clean_html(self, html_content: str) -> str:
        """
        Converts HTML content to plain text and truncates to Notion's 2000 char limit.
        
        Args:
            html_content: HTML string to clean
        
        Returns:
            Cleaned and truncated plain text
        """
        if not html_content:
            return ""
        try:
            # Parse HTML and get text
            soup = BeautifulSoup(html_content, 'html.parser')
            text = soup.get_text()
            
            # Clean up whitespace
            text = re.sub(r'\s+', ' ', text).strip()
            
            return text[:2000]  # Notion's limit
        except Exception as e:
            logger.warning(f"Error cleaning HTML content: {e}")
            return html_content[:2000]

    def get_assignment_page(self, assignment_parameter):
        """
        Retrieves existing assignment page from Notion by Canvas assignment ID or name.
        
        Args:
            assignment_parameter: Either Canvas assignment ID (int) or assignment name (str)
        
        Returns:
            Notion page object if found, None otherwise
        """
        try:
            if isinstance(assignment_parameter, int) or (isinstance(assignment_parameter, str) and assignment_parameter.isdigit()):
                # If parameter is an integer or string of digits, treat as assignment ID
                filter_condition = {
                    "property": "AssignmentID",
                    "number": {"equals": int(assignment_parameter)}
                }
            elif isinstance(assignment_parameter, str):
                # If parameter is a string, treat as assignment name
                filter_condition = {
                    "property": "Assignment Title",
                    "title": {"equals": assignment_parameter}
                }
            else:
                logger.warning(f"Invalid parameter type: {type(assignment_parameter)}")
                return None
                
            response = self._make_notion_request(
                "query_database",
                database_id=self.database_id,
                filter=filter_condition
            )
            results = response.get('results', [])
            return results[0] if results else None
            
        except Exception as e:
            logger.error(f"Error fetching assignment ({assignment_parameter}) from Notion: {str(e)}")
            return None
    
    
    def ensure_course_exists(self, course_id, course_name, term_id=None):
        """
        Ensures a course exists in the Notion course database.
        Creates it if it doesn't exist.
        
        Args:
            course_id: Canvas course ID
            course_name: Course name
            term_id: Optional term ID
            
        Returns:
            str: Notion page ID for the course
        """
        try:
            # Check if course exists by ID
            filter_condition = {
                "property": "CourseID",
                "multi_select": {
                    "contains": str(course_id)
                }
            }
            
            response = self._make_notion_request(
                "query_database",
                database_id=self.course_db_id,
                filter=filter_condition
            )
            
            if response.get('results'):
                # Course exists
                course_page_id = response['results'][0]['id']
                logger.debug(f"Found existing course: {course_name} (ID: {course_id})")
                return course_page_id
            
            # Course doesn't exist, create it
            logger.info(f"Creating new course in Notion: {course_name} (ID: {course_id})")
            
            properties = {
                "Course Name": {"title": [{"text": {"content": course_name}}]},
                "CourseID": {"multi_select": [{"name": str(course_id)}]},
                "Status": {"select": {"name": "Active"}}
            }
            
            # Add term if available
            if term_id:
                properties["Term"] = {"select": {"name": f"Term {term_id}"}}
            
            response = self._make_notion_request(
                "create_page",
                parent={"database_id": self.course_db_id},
                properties=properties
            )
            
            # Update course mapping
            self.course_mapping[str(course_id)] = response['id']
            logger.info(f"Created course in Notion: {course_name} (ID: {course_id})")
            
            return response['id']
            
        except Exception as e:
            logger.error(f"Failed to ensure course exists: {e}")
            return None

    def create_or_update_assignment(self, assignment: Assignment):

        """Create or update assignment in Notion"""
        try:
            existing_page = self.get_assignment_page(assignment.id)
            
            # Convert course_id to string and look up UUID
            course_id_str = str(assignment.course_id)
            course_uuid = self.course_mapping.get(course_id_str)
            logger.debug(f"Looking up course {course_id_str} in mapping: {self.course_mapping}")

            if not course_uuid:
                # Try to create the course if it doesn't exist
                course_uuid = self.ensure_course_exists(
                    assignment.course_id, 
                    assignment.course_name
                )
                
                if not course_uuid:
                    logger.warning(f"No Notion UUID found for course {course_id_str} and could not create it")
                    return
            
            # Parse due date using the helper
            due_date = self._parse_date(assignment.due_date)
            
            # Prepare properties
            properties = {
                "Assignment Title": {"title": [{"text": {"content": str(assignment.name)}}]},
                "AssignmentID": {"number": int(assignment.id)},
                "Description": {"rich_text": [{"text": {"content": self._clean_html(assignment.description)}}]},
                "Course": {"relation": [{"id": course_uuid}]},
                "Status": {"status": {"name": str(assignment.status)}},
                "Assignment Group": {"select": {"name": assignment.group_name}} if assignment.group_name else None,
                "Group Weight": {"number": assignment.group_weight} if assignment.group_weight is not None else None,
            }

            # Re-implemented due-date feature using _parse_date
            if due_date:
                # If due_date is a datetime or date instance, isoformat() works for both
                properties["Due Date"] = {"date": {"start": due_date.isoformat()}}

            # Only add Priority if it's a valid value
            VALID_PRIORITIES = ["Low", "Medium", "High"]
            if assignment.priority in VALID_PRIORITIES:
                properties["Priority"] = {"select": {"name": assignment.priority}}
            else:
                properties["Priority"] = {"select": {"name": "Low"}}  # Default to Low if invalid/None

            properties = {k: v for k, v in properties.items() if v is not None}
            
            if assignment.grade is not None:
                try:
                    properties["Grade (%)"] = {"number": float(assignment.grade)}
                except (ValueError, TypeError):
                    logger.warning(f"Invalid grade format for assignment {assignment.name}: {assignment.grade}")
                    if hasattr(assignment, "mark") and assignment.mark is not None:
                        try:
                            properties["Status"] = {"status": {"name": "Mark received"}}
                        except (ValueError, TypeError):
                            logger.warning(f"Invalid mark format for assignment {assignment.name}: {assignment.mark}")

            if existing_page:
                logger.info(f"Updating existing assignment: {assignment.name}")
                current_status = existing_page["properties"]["Status"]["status"]["name"]
                if current_status == "Dont show":
                    logger.info(f"Skipping update for {assignment.name} due to 'Dont show' status")
                    return
                elif current_status == "In progress":
                    logger.info(f"Preserving 'In progress' status for {assignment.name}")
                    properties.pop("Status", None)
                else:
                    if assignment.grade is not None:
                        properties["Status"] = {"status": {"name": "Mark received"}}
                
                self._make_notion_request(
                    "update_page",
                    page_id=existing_page["id"],
                    properties=properties
                )
            else:
                double_check = self.notion.databases.query(
                    database_id=self.database_id,
                    filter={
                        "property": "AssignmentID",
                        "number": {"equals": assignment.id}
                    }
                )
                if double_check.get('results'):
                    logger.warning(f"Duplicate prevention: Found existing assignment with ID {assignment.id}")
                    return self.create_or_update_assignment(assignment)
                
                logger.info(f"Creating new assignment: {assignment.name}")
                self._make_notion_request(
                    "create_page",
                    parent={"database_id": self.database_id},
                    properties=properties
                )
                
        except Exception as e:
            logger.error(f"Error syncing assignment {assignment.name} to Notion: {str(e)}")
            raise
