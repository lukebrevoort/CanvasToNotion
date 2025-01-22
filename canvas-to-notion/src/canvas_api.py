from canvasapi import Canvas
from datetime import datetime
from typing import List
from .models.assignment import Assignment
from .utils.config import CANVAS_URL, CANVAS_TOKEN
import logging
logger = logging.getLogger(__name__)

class CanvasAPI:
    def __init__(self):
        self.canvas = Canvas(CANVAS_URL, CANVAS_TOKEN)
        self.user_id = self._get_user_id()

        
    def get_courses(self):
        return self.canvas.get_courses()
    
    def _get_user_id(self):
        """Get current user's ID from Canvas API"""
        user = self.canvas.get_current_user()
        return user.id
        
    def get_updated_assignments(self, last_sync: datetime = None) -> List[Assignment]:
        assignments = []
        for course in self.get_courses():
            try:
                course_name=getattr(course, 'name', 'Unnamed Course')
                logger.info(f"Processing course: {course_name}")
                course_assignments = course.get_assignments()

                for assignment in course_assignments:
                    try:
                        if not last_sync or assignment.updated_at > last_sync:
                            submission = None
                            if assignment.has_submitted_submissions:
                                try:
                                    submission = assignment.get_submission(self.user_id)
                                except Exception as e:
                                    logger.warning(f"Could not fetch submission for assignment {assignment.name}: {str(e)}")
                            
                            assignments.append(Assignment(
                                id=getattr(assignment, 'id', None),
                                name=getattr(assignment, 'name', 'Unnamed Assignment'),
                                description=getattr(assignment, 'description', ''),
                                due_date=getattr(assignment, 'due_at', None),
                                course_id=getattr(course, 'id', None),
                                course_name=getattr(course, 'name', 'Unnamed Course'),
                                status="submitted" if submission else "not_started",
                                grade=getattr(submission, 'grade', None) if submission else None
                            ))
                    except Exception as e:
                        logger.warning(f"Skipping assignment {assignment.name} due to error: {str(e)}")
                        continue
                        
            except Exception as e:
                logger.error(f"Skipping {getattr(course, 'name', f'Course {course.id}')} due to error: {str(e)}")
        return assignments