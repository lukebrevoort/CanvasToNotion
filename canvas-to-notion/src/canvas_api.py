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
                logger.info(f"Processing course: {course.name}")
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
                                id=assignment.id,
                                name=assignment.name,
                                description=assignment.description,
                                due_date=assignment.due_at,
                                course_id=course.id,
                                course_name=course.name,
                                status="submitted" if submission else "not_started",
                                grade=submission.grade if submission else None
                            ))
                    except Exception as e:
                        logger.warning(f"Skipping assignment {assignment.name} due to error: {str(e)}")
                        continue
                        
            except Exception as e:
                logger.error(f"Skipping {course.name} due to error: {str(e)}")
        return assignments