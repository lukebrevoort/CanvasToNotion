from canvasapi import Canvas
from datetime import datetime
from typing import List
from models.assignment import Assignment
from utils.config import CANVAS_URL, CANVAS_TOKEN
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
        
    def get_updated_assignments(self, last_sync: datetime = None) -> List[Assignment]:
        assignments = []
        for course in self.get_courses():
            try:

                term_id = getattr(course, 'enrollment_term_id', None)
                if term_id != 449:  # Spring 2024 term
                    logger.info(f"Skipping course {getattr(course, 'name', course.id)} - not in current term")
                    continue
                course_name=getattr(course, 'name', 'Unnamed Course')
                logger.info(f"Processing course: {course_name}")
                course_assignments = course.get_assignments()
                group_weights = self._get_assignment_group_weights(course)

                for assignment in course_assignments:
                    try:
                        if not last_sync or assignment.updated_at > last_sync:
                            submission = None
                            if assignment.graded_submissions_exist == True:
                                try:
                                    submission = assignment.get_submission(self.user_id)
                                except Exception as e:
                                    logger.warning(f"Could not fetch submission for assignment {assignment.name}: {str(e)}")
                            
                            # Determine status based on submission and grade
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

                            group_id = getattr(assignment, 'assignment_group_id', None)
                            group_info = group_weights.get(group_id, {})
                            group_name = group_info.get('name')
                            group_weight = group_info.get('weight')

                            assignments.append(Assignment(
                                id=getattr(assignment, 'id', None),
                                name=getattr(assignment, 'name', 'Unnamed Assignment'),
                                description=getattr(assignment, 'description', ''),
                                due_date=getattr(assignment, 'due_at', None),
                                course_id=getattr(course, 'id', None),
                                course_name=getattr(course, 'name', 'Unnamed Course'),
                                status=status,
                                grade=grade,
                                group_name=group_name,
                                group_weight=group_weight
                            ))
                    except Exception as e:
                        logger.warning(f"Skipping assignment {assignment.name} due to error: {str(e)}")
                        continue
                        
            except Exception as e:
                logger.error(f"Skipping {getattr(course, 'name', f'Course {course.id}')} due to error: {str(e)}")
        return assignments