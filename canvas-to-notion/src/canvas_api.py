from canvasapi import Canvas
from datetime import datetime
from typing import List
import pytz
import backoff
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from models.assignment import Assignment
from utils.config import CANVAS_URL, CANVAS_TOKEN
import logging

logger = logging.getLogger(__name__)

class CanvasAPI:
    def __init__(self):
        # Configure retry strategy
        retry_strategy = Retry(
            total=5,
            backoff_factor=1,
            status_forcelist=[429, 500, 502, 503, 504],
            allowed_methods=["HEAD", "GET", "PUT", "DELETE", "OPTIONS", "TRACE"]
        )
        
        # Create session with retry strategy
        session = requests.Session()
        adapter = HTTPAdapter(max_retries=retry_strategy)
        session.mount("https://", adapter)
        
        self.canvas = Canvas(CANVAS_URL, CANVAS_TOKEN)
        self.canvas.session = session
        self.user_id = self._get_user_id()

    @backoff.on_exception(
        backoff.expo,
        (requests.exceptions.RequestException, ConnectionError),
        max_tries=5
    )
    def get_courses(self):
        return self.canvas.get_courses()
    
    @backoff.on_exception(
        backoff.expo,
        (requests.exceptions.RequestException, ConnectionError),
        max_tries=5
    )
    def _get_user_id(self):
        user = self.canvas.get_current_user()
        return user.id
    
    def _get_assignment_group_weights(self, course):
        """Get assignment group weights for a course"""
        try:
            groups = course.get_assignment_groups()
            return {
                group.id: {
                    'name': group.name,
                    'weight': group.group_weight / 100 if group.group_weight else None
                }
                for group in groups
            }
        except Exception as e:
            logger.error(f"Error fetching assignment groups for course {course.id}: {e}")
            return {}
        
    @backoff.on_exception(
        backoff.expo,
        (requests.exceptions.RequestException, ConnectionError),
        max_tries=5,
        max_time=300
    )
    def get_updated_assignments(self, last_sync: datetime = None) -> List[Assignment]:
        # Convert last_sync to timezone-aware if it isn't already
        if last_sync and last_sync.tzinfo is None:
            last_sync = last_sync.replace(tzinfo=pytz.UTC)
    
        assignments = []
        for course in self.get_courses():
            try:
                term_id = getattr(course, 'enrollment_term_id', None)
                if term_id != 449:  # Spring 2024 term
                    logger.info(f"Skipping course {getattr(course, 'name', course.id)} - not in current term")
                    continue
                    
                course_name = getattr(course, 'name', 'Unnamed Course')
                logger.info(f"Processing course: {course_name}")
                course_assignments = course.get_assignments()
                group_weights = self._get_assignment_group_weights(course)
    
                for assignment in course_assignments:
                    try:
                        # Parse updated_at date with timezone awareness
                        updated_at = getattr(assignment, 'updated_at', None)
                        if isinstance(updated_at, str):
                            updated_at = datetime.fromisoformat(updated_at.replace('Z', '+00:00'))
                        elif updated_at and updated_at.tzinfo is None:
                            updated_at = updated_at.replace(tzinfo=pytz.UTC)
    
                        if not last_sync or (updated_at and updated_at > last_sync):
                            # Check for submission
                            submission = None
                            if getattr(assignment, 'graded_submissions_exist', False):
                                try:
                                    submission = assignment.get_submission(self.user_id)
                                except Exception as e:
                                    logger.warning(f"Could not fetch submission for assignment {assignment.name}: {str(e)}")
                            
                            # Determine status and grade
                            status = "Not started"
                            grade = None
                            
                            if submission:
                                points_possible = getattr(assignment, 'points_possible', 0)
                                score = getattr(submission, 'score', None)
                                
                                if score is not None and points_possible:
                                    try:
                                        grade = (float(score) / float(points_possible))
                                        status = "Mark received"
                                    except (ValueError, ZeroDivisionError):
                                        grade = None
                                elif getattr(submission, 'grade', None) is not None:
                                    status = "Mark received"
                                    grade = getattr(submission, 'grade', None)
                                else:
                                    status = "Submitted"

                            # Get group information
                            group_id = getattr(assignment, 'assignment_group_id', None)
                            group_info = group_weights.get(group_id, {})
                            group_name = group_info.get('name')
                            group_weight = group_info.get('weight')

                            priority = None
                            if group_weight is not None:
                                if group_weight <= 0.10:
                                    priority = "Low"
                                elif group_weight <= 0.20:
                                    priority = "Medium" 
                                else:
                                    priority = "High"
                            
                            assignments.append(Assignment(
                                id=getattr(assignment, 'id', None),
                                name=getattr(assignment, 'name', 'Unnamed Assignment'),
                                description=getattr(assignment, 'description', ''),
                                due_date=getattr(assignment, 'due_at', None),
                                course_id=getattr(course, 'id', None),
                                course_name=course_name,
                                status=status,
                                grade=grade,
                                group_name=group_name,
                                group_weight=group_weight,
                                priority=priority
                            ))
                            
                    except Exception as e:
                        logger.warning(f"Skipping assignment {getattr(assignment, 'name', 'Unknown')} due to error: {str(e)}")
                        continue
                        
            except Exception as e:
                logger.error(f"Error processing course {getattr(course, 'name', course.id)}: {str(e)}")
                continue
                
        return assignments