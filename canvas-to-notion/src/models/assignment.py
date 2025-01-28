from dataclasses import dataclass
from datetime import datetime
from typing import Optional

# Assignment: Data model representing a Canvas assignment with Notion-specific attributes

@dataclass
class Assignment:
    """
    Represents a Canvas assignment with additional metadata for Notion integration.
    
    Attributes:
        id: Canvas assignment ID
        name: Assignment title
        description: Assignment description/instructions
        due_date: Assignment due date/time
        course_id: Canvas course ID
        course_name: Course title
        status: Current status ('Not started', 'In progress', 'Submitted', 'Mark received')
        grade: Numerical grade as percentage (0-1.0)
        group_name: Assignment group name in Canvas
        group_weight: Weight of assignment group in final grade (0-1.0)
        priority: Assignment priority ('Low', 'Medium', 'High') based on group weight
    """
    id: int
    name: str
    description: str
    due_date: datetime
    course_id: int
    course_name: str
    status: str = "Not started"
    grade: Optional[float] = None
    group_name: Optional[str] = None
    group_weight: Optional[float] = None
    priority: Optional[str] = "Low"