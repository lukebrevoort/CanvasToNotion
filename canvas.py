import os
from dotenv import load_dotenv
from canvasapi import Canvas


load_dotenv()

CANVAS_TOKEN = os.getenv('CANVAS_TOKEN')
CANVAS_URL = os.getenv('CANVAS_URL')

canvas = Canvas(CANVAS_URL, CANVAS_TOKEN)
courses = canvas.get_courses()

for course in courses:
    try:
        # Extract course details with fallbacks
        course_code = getattr(course, 'course_code', 'No course code')
        name = getattr(course, 'name', 'No name')
        original_name = getattr(course, 'original_name', 'No original name')
        workflow_state = getattr(course, 'workflow_state', 'Unknown status')
        term_id = getattr(course, 'enrollment_term_id', 'No term ID')
        created_at = getattr(course, 'created_at', 'No creation date')
        
        print(f"Course Details:\n"
              f"  ID: {course.id}\n"
              f"  Name: {name}\n"
              f"  Term ID: {term_id}")
    except AttributeError as e:
        print(f"Error accessing course {course.id}: {str(e)}")


for course in courses:
    if course.course_code == "79068":
        print(f"Found course: {course.name}")
        break


