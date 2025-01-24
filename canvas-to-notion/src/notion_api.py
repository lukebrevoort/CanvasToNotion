from notion_client import Client
from datetime import datetime
import pytz
from typing import Dict, Optional
from models.assignment import Assignment
from utils.config import NOTION_TOKEN, NOTION_DATABASE_ID, COURSE_DATABASE_ID
from bs4 import BeautifulSoup
import re
import logging
import backoff
from ratelimit import limits, sleep_and_retry

logger = logging.getLogger(__name__)

class NotionAPI:
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
        """Wrapper for Notion API calls with rate limiting"""
        if operation_type == "query_database":
            return self.notion.databases.query(**kwargs)
        elif operation_type == "update_page":
            return self.notion.pages.update(**kwargs)
        elif operation_type == "create_page":
            return self.notion.pages.create(**kwargs)
        raise ValueError(f"Unknown operation type: {operation_type}")

    def _get_course_mapping(self) -> Dict[str, str]:
        """Create mapping of Canvas course IDs to Notion page UUIDs"""
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
        """Clean HTML content and return plain text"""
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
        
        # If time is 11:59 PM/AM, return date only
        if dt.hour == 23 and dt.minute == 59:
            return dt.date()
            
        return dt

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
            
            # Convert course_id to string and look up UUID
            course_id_str = str(assignment.course_id)
            course_uuid = self.course_mapping.get(course_id_str)
            
            # Log course mapping attempt
            logger.debug(f"Looking up course {course_id_str} in mapping: {self.course_mapping}")

            
            if not course_uuid:
                logger.warning(f"No Notion UUID found for course {course_id_str}")
                return
            
            # Parse due date
            due_date = self._parse_date(assignment.due_date)
            
            # Prepare properties
            properties = {
                "Assignment Title": {"title": [{"text": {"content": str(assignment.name)}}]},
                "AssignmentID": {"number": int(assignment.id)},
                "Description": {"rich_text": [{"text": {"content": self._clean_html(assignment.description)}}]},
                "Course": {"relation": [{"id": course_uuid}]},
                "Status": {"status": {"name": str(assignment.status)}},
                "Assignment Group": {"select": {"name": assignment.group_name}} if assignment.group_name else None,
                "Group Weight": {"number": assignment.group_weight} if assignment.group_weight is not None else None
            }

            properties = {k: v for k, v in properties.items() if v is not None}
            
            if due_date:
                properties["Due Date"] = {"date": {"start": due_date.isoformat()}}
            
            if assignment.grade is not None:
                try:
                    properties["Grade (%)"] = {"number": float(assignment.grade)}
                except (ValueError, TypeError):
                    logger.warning(f"Invalid grade format for assignment {assignment.name}: {assignment.grade}")
                    # Also set Mark as property
                    if assignment.mark is not None:
                        try:
                            properties["Status"] = {"status": "Mark received"}
                        except (ValueError, TypeError):
                            logger.warning(f"Invalid mark format for assignment {assignment.name}: {assignment.mark}")

            if existing_page:
                logger.info(f"Updating assignment: {assignment.name}")
                # Get current status from existing page
                current_status = existing_page["properties"]["Status"]["status"]["name"]
                if current_status == "Dont show":
                    logger.info(f"Skipping update for {assignment.name} due to 'Dont show' status")
                    return
                #If current_status is manually put In progress, preserve it and update else
                if current_status == "In progress":
                    logger.info(f"Preserving 'In progress' status for {assignment.name}")
                    # Remove status from properties to keep existing status
                    properties.pop("Status", None)

                self._make_notion_request(
                    "update_page",
                    page_id=existing_page["id"],
                    properties=properties
                )
            else:
                logger.info(f"Creating new assignment: {assignment.name}")
                self._make_notion_request(
                    "create_page",
                    parent={"database_id": self.database_id},
                    properties=properties
                )
                
        except Exception as e:
            logger.error(f"Error syncing assignment {assignment.name} to Notion: {str(e)}")
            raise