# Canvas to Notion Assignment Sync

This project automates the transfer of new assignments from Canvas to a Notion database, updating the Notion database with assignment details and statuses based on changes in Canvas.

## Overview

The application connects to the Canvas API to retrieve assignment data and updates a Notion database accordingly. It ensures that any new or updated assignments in Canvas are reflected in Notion, allowing for seamless management of academic tasks.

## Setup Instructions

1. Clone the repository:
   ```
   git clone <repository-url>
   cd canvas-to-notion
   ```

2. Create a virtual environment:
   ```
   python -m venv venv
   source venv/bin/activate  # On Windows use `venv\Scripts\activate`
   ```

3. Install the required dependencies:
   ```
   pip install -r requirements.txt
   ```

4. Create a `.env` file in the root directory and add your API keys and configuration settings:
   ```
   CANVAS_TOKEN=<your_canvas_token>
   CANVAS_URL=<your_canvas_url>
   NOTION_TOKEN=<your_notion_token>
   NOTION_DATABASE_ID=<your_notion_database_id>
   ```

## Usage

To run the synchronization process, execute the following command:
```
python src/sync_service.py
```

## Testing

To run the tests, use:
```
pytest tests/
```

## License

This project is licensed under the MIT License.