from canvasapi import Canvas
from datetime import datetime
from typing import List
import pytz
import backoff
import requests
import traceback
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from models.assignment import Assignment
from utils.config import CANVAS_URL, CANVAS_TOKEN
import logging

logger = logging.getLogger(__name__)

# CanvasAPI: Handles Canvas LMS integration with retry logic and assignment processing
# Manages course filtering, assignment group weights, and submission status

class CanvasAPI:
    """
    Manages interaction with Canvas LMS API.
    Handles authentication, retry logic, and data transformation.
    """

    def __init__(self):
        """
        Initializes Canvas API client with retry strategy for robust operation.
        Configures automatic retries for common HTTP errors and rate limits.
        """
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
    def _get_current_term(self):
        """
        Determines the current active enrollment term from user's enrolled courses.
        
        Returns:
            int: The ID of the current term, or None if it cannot be determined
        """
        try:
            # Get courses the user is enrolled in - this doesn't require admin permissions
            courses = self.canvas.get_courses(enrollment_state='active')
            
            # Extract all term IDs from active courses
            term_ids = {}
            now = datetime.now(pytz.UTC)
            
            for course in courses:
                term_id = getattr(course, 'enrollment_term_id', None)
                if not term_id:
                    continue
                
                course_start = getattr(course, 'start_at', None)
                course_end = getattr(course, 'end_at', None)
                
                # Parse dates if they're strings
                if isinstance(course_start, str):
                    course_start = datetime.fromisoformat(course_start.replace('Z', '+00:00'))
                if isinstance(course_end, str):
                    course_end = datetime.fromisoformat(course_end.replace('Z', '+00:00'))
                
                # Courses without end dates are considered ongoing
                is_current = True
                if course_end and now > course_end:
                    is_current = False
                
                # Store term info with a flag indicating if it's current
                if term_id not in term_ids:
                    term_ids[term_id] = {
                        'id': term_id,
                        'is_current': is_current,
                        'course_count': 1
                    }
                else:
                    # Update existing term entry
                    term_ids[term_id]['course_count'] += 1
                    # If any course in this term is current, mark the term as current
                    term_ids[term_id]['is_current'] = term_ids[term_id]['is_current'] or is_current
            
            # First try to find a term marked as current
            current_terms = [term for term in term_ids.values() if term['is_current']]
            
            if current_terms:
                # If multiple current terms, take the one with most courses
                current_term = max(current_terms, key=lambda x: x['course_count'])
                logger.info(f"Current term detected: ID {current_term['id']} (from {current_term['course_count']} courses)")
                return current_term['id']
            
            # Fallback: if no current term found, use the one with most courses
            if term_ids:
                most_common_term = max(term_ids.values(), key=lambda x: x['course_count'])
                logger.info(f"Using most common term as fallback: ID {most_common_term['id']}")
                return most_common_term['id']
                
            logger.warning("No terms found in enrolled courses")
            return None
            
        except Exception as e:
            logger.error(f"Error determining current term: {e}")
            return None

    @backoff.on_exception(
        backoff.expo,
        (requests.exceptions.RequestException, ConnectionError),
        max_tries=5
    )
    def get_courses(self):
        """Fetches all available courses for the authenticated user."""
        return self.canvas.get_courses()
    
    @backoff.on_exception(
        backoff.expo,
        (requests.exceptions.RequestException, ConnectionError),
        max_tries=5
    )
    def _get_user_id(self):
        """Retrieves current user's Canvas ID for submission lookups."""
        user = self.canvas.get_current_user()
        return user.id
    
    def _get_assignment_group_weights(self, course):
        """
        Fetches assignment group weights for grade calculation.
        
        Args:
            course: Canvas course object
            
        Returns:
            Dict mapping group IDs to their names and weights
        """
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
        """
        Retrieves assignments updated since last sync.
        
        Features:
        - Filters for current term (Spring 2024)
        - Processes submission status and grades
        - Calculates priority based on group weights
        - Handles timezone conversion
        
        Args:
            last_sync: Optional datetime of last successful sync
            
        Returns:
            List of Assignment objects with updated information
        """
        # Convert last_sync to timezone-aware if it isn't already
        if last_sync and last_sync.tzinfo is None:
            last_sync = last_sync.replace(tzinfo=pytz.UTC)
            logger.debug(f"Made last_sync timezone aware: {last_sync}")
    
        assignments = []
        for course in self.get_courses():
            try:
                # Get current term ID
                current_term = self._get_current_term()
                term_id = getattr(course, 'enrollment_term_id', None)
                if term_id != current_term: 
                    logger.info(f"Skipping course {getattr(course, 'name', course.id)} - not in current term")
                    continue
                    
                course_name = getattr(course, 'name', 'Unnamed Course')
                logger.info(f"Processing course: {course_name}")
                course_assignments = course.get_assignments()
                group_weights = self._get_assignment_group_weights(course)
    
                for assignment in course_assignments:
                    assignment_name = getattr(assignment, 'name', 'Unknown')
                    logger.debug(f"Processing assignment: {assignment_name}")
                    
                    try:
                        # Parse updated_at date with timezone awareness
                        updated_at = getattr(assignment, 'updated_at', None)
                        logger.debug(f"Assignment {assignment_name} raw updated_at: {updated_at}, type: {type(updated_at)}")
                        
                        try:
                            if isinstance(updated_at, str):
                                updated_at = datetime.fromisoformat(updated_at.replace('Z', '+00:00'))
                                logger.debug(f"Converted string updated_at to datetime: {updated_at}")
                            elif updated_at and updated_at.tzinfo is None:
                                updated_at = updated_at.replace(tzinfo=pytz.UTC)
                                logger.debug(f"Added timezone to updated_at: {updated_at}")
                        except Exception as date_error:
                            logger.error(f"Error processing date for {assignment_name}: {date_error}")
                            updated_at = None
        
                        # More explicit check to prevent None comparison errors
                        should_process = False
                        
                        try:
                            if not last_sync:
                                should_process = True
                                logger.debug(f"No last_sync, will process {assignment_name}")
                            elif updated_at is not None and last_sync is not None:
                                should_process = updated_at > last_sync
                                logger.debug(f"Comparing dates for {assignment_name}: updated={updated_at}, last_sync={last_sync}, will process: {should_process}")
                            else:
                                # If we don't have updated_at info, process it anyway to be safe
                                should_process = True
                                logger.debug(f"Missing date info for {assignment_name}, processing anyway")
                        except Exception as compare_error:
                            logger.error(f"Error comparing dates for {assignment_name}: {compare_error}")
                            should_process = True  # Process on error to be safe
                            
                        if should_process:
                            # Always check for submission regardless of graded status
                            submission = None
                            try:
                                # Attempt to get the submission even if not graded yet
                                submission = assignment.get_submission(self.user_id)
                                logger.debug(f"Got submission for {assignment_name}")
                            except Exception as e:
                                logger.warning(f"Could not fetch submission for assignment {assignment_name}: {str(e)}")
                            
                            # Determine status and grade
                            # Initialize status
                            status = "Not started"
                            grade = None

                            if submission:
                                # Log submission details for debugging
                                logger.debug(f"Submission for {assignment_name}: workflow_state={getattr(submission, 'workflow_state', 'N/A')}, "
                                             f"submitted_at={getattr(submission, 'submitted_at', 'N/A')}, "
                                             f"attempt={getattr(submission, 'attempt', 0)}, "
                                             f"submission_type={getattr(submission, 'submission_type', 'N/A')}, "
                                             f"late={getattr(submission, 'late', 'N/A')}")
                                
                                # Extract all relevant submission attributes
                                submission_status = getattr(submission, 'workflow_state', '')
                                submitted_at = getattr(submission, 'submitted_at', None)
                                attempts = getattr(submission, 'attempt', 0)
                                if attempts is None:
                                    attempts = 0  # Safeguard against None values
                                submission_type = getattr(submission, 'submission_type', None)
                                has_submission = getattr(submission, 'has_submission', False)
                                
                                # Comprehensive submission check combining all conditions
                                try:
                                    if submitted_at or submission_status in ['submitted', 'complete', 'graded']:
                                        status = "Submitted"
                                        logger.debug(f"Assignment {assignment_name} marked as submitted based on status")
                                    elif attempts > 0 or submission_type is not None or has_submission:
                                        status = "Submitted"
                                        logger.debug(f"Assignment {assignment_name} marked as submitted based on attempts/type")
                                except Exception as submission_check_error:
                                    logger.error(f"Error checking submission status for {assignment_name}: {submission_check_error}")
                                
                                # Check for grade/score
                                try:
                                    points_possible = getattr(assignment, 'points_possible', 0)
                                    if points_possible is None:
                                        points_possible = 0
                                    
                                    score = getattr(submission, 'score', None)
                                    
                                    if score is not None and points_possible > 0:  # Ensure positive denominator
                                        try:
                                            grade = (float(score) / float(points_possible))
                                            status = "Mark received"
                                            logger.debug(f"Grade calculated for {assignment_name}: {grade}")
                                        except (ValueError, ZeroDivisionError) as calc_error:
                                            logger.error(f"Error calculating grade for {assignment_name}: {calc_error}")
                                            grade = None
                                    elif getattr(submission, 'grade', None) is not None:
                                        status = "Mark received"
                                        grade = getattr(submission, 'grade', None)
                                        logger.debug(f"Grade retrieved for {assignment_name}: {grade}")
                                except Exception as grade_error:
                                    logger.error(f"Error processing grade for {assignment_name}: {grade_error}")

                            logger.debug(f"Final status for {assignment_name}: {status}")

                            # Get group information
                            try:
                                group_id = getattr(assignment, 'assignment_group_id', None)
                                group_info = group_weights.get(group_id, {})
                                group_name = group_info.get('name')
                                group_weight = group_info.get('weight')
                                logger.debug(f"Group info for {assignment_name}: id={group_id}, name={group_name}, weight={group_weight}")

                                priority = None
                                if group_weight is not None:
                                    if float(group_weight) <= 0.10:
                                        priority = "Low"
                                    elif float(group_weight) <= 0.20:
                                        priority = "Medium" 
                                    else:
                                        priority = "High"
                                    logger.debug(f"Priority for {assignment_name}: {priority}")
                            except Exception as group_error:
                                logger.error(f"Error processing group info for {assignment_name}: {group_error}")
                                group_name = None
                                group_weight = None
                                priority = None
                            
                            assignments.append(Assignment(
                                id=getattr(assignment, 'id', None),
                                name=assignment_name,
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
                            logger.debug(f"Added assignment {assignment_name} to result list")
                            
                    except Exception as e:
                        error_message = str(e)
                        logger.error(f"Error processing assignment {assignment_name}: {error_message}")
                        logger.error(f"Stack trace: {traceback.format_exc()}")
                        
                        if "'>' not supported between instances of 'NoneType'" in error_message:
                            logger.error(f"Type comparison error for assignment {assignment_name}")
                            # Debug specific variables that might be causing the issue
                            logger.error(f"assignment.updated_at: {getattr(assignment, 'updated_at', None)}")
                            logger.error(f"updated_at: {updated_at}, type: {type(updated_at) if updated_at is not None else 'None'}")
                            logger.error(f"last_sync: {last_sync}, type: {type(last_sync) if last_sync is not None else 'None'}")
                        
                        continue
                        
            except Exception as e:
                logger.error(f"Error processing course {getattr(course, 'name', course.id)}: {str(e)}")
                continue
                
        return assignments