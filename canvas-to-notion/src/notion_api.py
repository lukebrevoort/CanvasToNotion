from notion_client import Client
from .models.assignment import Assignment
from .utils.config import NOTION_TOKEN, NOTION_DATABASE_ID

class NotionAPI:
    def __init__(self):
        self.notion = Client(auth=NOTION_TOKEN)
        self.database_id = NOTION_DATABASE_ID

    def get_assignment_page(self, assignment_id: int):
        response = self.notion.databases.query(
            database_id=self.database_id,
            filter={
                "property": "AssignmentID",
                "number": {"equals": assignment_id}
            }
        )
        return response.results[0] if response.results else None

    def create_or_update_assignment(self, assignment: Assignment):
        existing_page = self.get_assignment_page(assignment.id)
        
        properties = {
            "Name": {"title": [{"text": {"content": assignment.name}}]},
            "AssignmentID": {"number": assignment.id},
            "Description": {"rich_text": [{"text": {"content": assignment.description}}]},
            "Due Date": {"date": {"start": assignment.due_date.isoformat()}},
            "Course": {"select": {"name": assignment.course_name}},
            "Status": {"select": {"name": assignment.status}},
        }
        
        if assignment.grade is not None:
            properties["Grade"] = {"number": float(assignment.grade)}

        if existing_page:
            self.notion.pages.update(page_id=existing_page["id"], properties=properties)
        else:
            self.notion.pages.create(
                parent={"database_id": self.database_id},
                properties=properties
            )