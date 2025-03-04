# Import relevant functionality
from langchain.chat_models import init_chat_model
from langchain_community.tools.tavily_search import TavilySearchResults
from langchain_core.messages import HumanMessage
from langgraph.checkpoint.memory import MemorySaver
from langgraph.prebuilt import create_react_agent
from notion_client import Client
import sys
import os

sys.path.append(os.path.join(os.path.dirname(os.path.dirname(__file__)), 'canvas-to-notion', 'src'))
from notion_api import NotionAPI
import dotenv

# Load the environment variables
dotenv.load_dotenv()

"""
Lets create a project manager that will seperate specific Notion pulled assignments
into manageable subtasks for completion. The project manager will be able to:
1. Retrive assignments from a given Notion database
2. Create substasks for each assignment
3. Create a Todo item/assignment for each substask
4. update assignment submission status and progress 
5. Estimate total time of completion for each assignment
6. (For the future) generate a schedule/study plan for each project 
"""

#Will add the agent in later, making sure functions work independently first
"""
# Create the agent
memory = MemorySaver()
model = init_chat_model("gpt-4", model_provider="openai")
search = TavilySearchResults(max_results=2)
tools = [search]
agent_executor = create_react_agent(model, tools, checkpointer=memory)
model_with_tools = model.bind_tools(tools)
config = {"configurable": {"thread_id": "abc123"}}
"""


def retireve_assignment(assignment_name: str):
    """
    Retrieve assignments from a given Notion database

    returns a object with all assignment information included
    """
    notion_api = NotionAPI()
    assignment = notion_api.get_assignment_page(assignment_name)
    return assignment



def create_subtasks(assignment):
    """
    Create substasks for each assignment
    """
    pass

def create_assignment_item(subtask):
    """
    Create a Todo item/assignment for each substask
    """
    pass

def update_assignment_status():
    """
    Update assignment submission status and progress
    """
    pass

def estimate_completion_time():
    """
    Estimate total time of completion for each assignment
    """
    pass

def generate_schedule():# For the future
    """
    Generate a schedule/study plan for each project
    """
    pass